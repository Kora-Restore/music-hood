#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, Manager};

#[cfg(desktop)]
use tauri_plugin_shell::process::CommandEvent;
#[cfg(desktop)]
use tauri_plugin_shell::ShellExt;

use lofty::prelude::*;
use rayon::prelude::*;

#[derive(Debug, Clone, Serialize)]
struct Track {
  path: String,
  name: String,
  playlist: String,
  /// Tag title, or "" when the file has none. The UI keeps showing the filename (folder truth);
  /// tags feed the optional virtual views (artist) only.
  title: String,
  /// Tag artist, or — when the file has no tag — the part after the last " - " of the filename
  /// (the library's "Song - Artist" convention), or "".
  artist: String,
  duration_secs: u64,
}

/// Read title/artist/duration from a file's tags. Never fails: a file without tags
/// (or one lofty cannot parse) just yields empty fields.
fn read_tags(path: &Path) -> (String, String, u64) {
  let Ok(tagged) = lofty::read_from_path(path) else {
    return (String::new(), String::new(), 0);
  };
  let secs = tagged.properties().duration().as_secs();
  let tag = tagged.primary_tag().or_else(|| tagged.first_tag());
  let title = tag.and_then(|t| t.title().map(|s| s.trim().to_string())).unwrap_or_default();
  let artist = tag.and_then(|t| t.artist().map(|s| s.trim().to_string())).unwrap_or_default();
  (title, artist, secs)
}

/// Individual names inside a tag's artist string: "A, B / C feat. D" → [A, B, C, D].
/// Deliberately does NOT split on "&" or "x" ("Earth, Wind & Fire" stays one name after the comma split).
fn split_artists(artist: &str) -> Vec<String> {
  let mut out = Vec::new();
  for part in artist.split(|c| c == ',' || c == '/' || c == ';') {
    let mut piece = part.trim().to_string();
    // strip a trailing " feat. X" / " ft. X" and keep X as its own name
    let lower = piece.to_lowercase();
    for marker in [" feat. ", " feat ", " ft. ", " ft "] {
      if let Some(i) = lower.find(marker) {
        let (main, featured) = piece.split_at(i);
        let featured = featured[marker.len()..].trim().to_string();
        piece = main.trim().to_string();
        if !featured.is_empty() {
          out.push(featured);
        }
        break;
      }
    }
    if !piece.is_empty() {
      out.push(piece);
    }
  }
  out
}

/// For a file WITHOUT an artist tag: derive the artist from the filename, but only accept a
/// name that already exists as a tagged artist elsewhere in the library ("Song - Artist" or
/// "Artist - Song"). Anything else stays "" — better an "(untagged)" bucket than an invented artist.
fn artist_from_filename(name: &str, known: &std::collections::HashSet<String>) -> String {
  let stem = name.rsplit_once('.').map(|(s, _)| s).unwrap_or(name);
  let Some((left, right)) = stem.rsplit_once(" - ") else {
    return String::new();
  };
  for candidate in [right.trim(), left.trim()] {
    if candidate.is_empty() {
      continue;
    }
    if known.contains(&candidate.to_lowercase()) {
      return candidate.to_string();
    }
  }
  String::new()
}

fn is_audio_file(path: &Path) -> bool {
  let Some(ext) = path.extension().and_then(|e| e.to_str()) else {
    return false;
  };
  matches!(
    ext.to_ascii_lowercase().as_str(),
    "mp3" | "m4a" | "aac" | "wav" | "flac" | "ogg" | "opus" | "wma" | "aiff" | "alac"
  )
}

fn first_folder_under_root(root: &Path, file_path: &Path) -> String {
  let Ok(rel) = file_path.strip_prefix(root) else {
    return "(root)".to_string();
  };

  let mut comps = rel.components();
  let first = comps.next();
  let second = comps.next();

  match (first, second) {
    (_, None) => "(root)".to_string(),
    (Some(std::path::Component::Normal(first_dir)), Some(_)) => {
      first_dir.to_string_lossy().to_string()
    }
    _ => "(root)".to_string(),
  }
}

fn scan_dir(root: &Path, dir: &Path, out: &mut Vec<Track>) -> Result<(), String> {
  let entries = std::fs::read_dir(dir).map_err(|e| e.to_string())?;
  for entry in entries {
    let entry = entry.map_err(|e| e.to_string())?;
    let path = entry.path();
    let file_type = entry.file_type().map_err(|e| e.to_string())?;

    if file_type.is_dir() {
      scan_dir(root, &path, out)?;
      continue;
    }

    if file_type.is_file() && is_audio_file(&path) {
      let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("unknown")
        .to_string();

      let playlist = first_folder_under_root(root, &path);

      out.push(Track {
        path: path.to_string_lossy().to_string(),
        name,
        playlist,
        title: String::new(),
        artist: String::new(),
        duration_secs: 0,
      });
    }
  }
  Ok(())
}

#[tauri::command]
fn scan_music_folder(dir: String) -> Result<Vec<Track>, String> {
  let root = PathBuf::from(&dir);
  if !root.is_dir() {
    return Err("Selected path is not a directory".into());
  }

  let mut tracks = Vec::new();
  scan_dir(&root, &root, &mut tracks)?;

  // Tag pass, in parallel: thousands of files, each a small header read.
  tracks.par_iter_mut().for_each(|t| {
    let (title, artist, secs) = read_tags(Path::new(&t.path));
    t.title = title;
    t.artist = artist;
    t.duration_secs = secs;
  });

  // Untagged files: fall back to the filename only when it names an artist the tags already know.
  let known: std::collections::HashSet<String> = tracks
    .iter()
    .flat_map(|t| split_artists(&t.artist))
    .map(|a| a.to_lowercase())
    .collect();
  for t in tracks.iter_mut() {
    if t.artist.is_empty() {
      t.artist = artist_from_filename(&t.name, &known);
    }
  }

  tracks.sort_by(|a, b| a.playlist.cmp(&b.playlist).then(a.name.cmp(&b.name)));
  Ok(tracks)
}

// ---------- yt-dlp download ----------

#[derive(Debug, Clone, serde::Deserialize)]
struct YtDlpArgs {
  url: String,
  #[serde(alias = "libraryDir")]
  library_dir: Option<String>,
  /// First-level folder under the library root (= a playlist) the file lands in.
  #[serde(default, alias = "targetFolder")]
  target_folder: Option<String>,
}

/// A target folder is a single folder NAME under the library root — never a path.
fn sanitize_folder_name(raw: &str) -> Result<String, String> {
  let name = raw.trim().trim_matches('.').trim();
  if name.is_empty() {
    return Err("Download folder name is empty".into());
  }
  if name.contains(['/', '\\', ':', '*', '?', '"', '<', '>', '|']) {
    return Err(format!("Download folder name contains a character Windows rejects: {name}"));
  }
  Ok(name.to_string())
}

// ---------- playlists as files: <root>/_Playlists/<name>.m3u8 ----------
//
// Membership lives in tiny text files, many-to-many, relative paths from the Music root
// (forward slashes, so the same file works on Windows, Linux and the phone). Folders are
// storage only. The app is the sole writer here and keeps the files consistent on move/delete.

const PLAYLISTS_DIR: &str = "_Playlists";

#[derive(Debug, Clone, Serialize)]
struct Playlist {
  name: String,
  /// relative paths (forward slashes) in play order
  entries: Vec<String>,
}

fn playlists_dir(root: &Path) -> PathBuf {
  root.join(PLAYLISTS_DIR)
}

fn playlist_path(root: &Path, name: &str) -> Result<PathBuf, String> {
  let clean = sanitize_folder_name(name)?;
  Ok(playlists_dir(root).join(format!("{clean}.m3u8")))
}

/// Absolute path under root → "Folder/Song - Artist.m4a" (forward slashes).
fn rel_key(root: &Path, abs: &Path) -> Option<String> {
  let rel = abs.strip_prefix(root).ok()?;
  Some(rel.to_string_lossy().replace('\\', "/"))
}

fn read_playlist_file(path: &Path) -> Vec<String> {
  let Ok(text) = std::fs::read_to_string(path) else { return Vec::new() };
  text
    .lines()
    .map(|l| l.trim_start_matches('\u{feff}').trim())
    .filter(|l| !l.is_empty() && !l.starts_with('#'))
    .map(|l| l.replace('\\', "/"))
    .collect()
}

fn write_playlist_file(path: &Path, entries: &[String]) -> Result<(), String> {
  if let Some(dir) = path.parent() {
    std::fs::create_dir_all(dir).map_err(|e| format!("Cannot create {}: {e}", dir.display()))?;
  }
  let mut out = String::from("#EXTM3U\n");
  for e in entries {
    out.push_str(e);
    out.push('\n');
  }
  // write-then-rename so a crash never leaves a half-written playlist
  let tmp = path.with_extension("m3u8.tmp");
  std::fs::write(&tmp, out).map_err(|e| format!("Cannot write {}: {e}", tmp.display()))?;
  std::fs::rename(&tmp, path).map_err(|e| format!("Cannot replace {}: {e}", path.display()))
}

fn load_playlists(root: &Path) -> Vec<Playlist> {
  let dir = playlists_dir(root);
  let Ok(rd) = std::fs::read_dir(&dir) else { return Vec::new() };
  let mut out: Vec<Playlist> = rd
    .flatten()
    .map(|e| e.path())
    .filter(|p| p.extension().and_then(|x| x.to_str()).map(|x| x.eq_ignore_ascii_case("m3u8") || x.eq_ignore_ascii_case("m3u")).unwrap_or(false))
    .map(|p| Playlist {
      name: p.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default(),
      entries: read_playlist_file(&p),
    })
    .collect();
  out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
  out
}

#[tauri::command]
fn list_playlists(library_dir: String) -> Result<Vec<Playlist>, String> {
  Ok(load_playlists(Path::new(library_dir.trim())))
}

#[derive(Debug, Clone, serde::Deserialize)]
struct PlaylistEditArgs {
  #[serde(alias = "libraryDir")]
  library_dir: String,
  name: String,
  /// absolute paths of tracks
  #[serde(default)]
  paths: Vec<String>,
}

/// Add tracks (absolute paths) to a playlist; creates the playlist if needed; no duplicates.
#[tauri::command]
fn playlist_add(args: PlaylistEditArgs) -> Result<Playlist, String> {
  let root = PathBuf::from(args.library_dir.trim());
  let file = playlist_path(&root, &args.name)?;
  let mut entries = read_playlist_file(&file);
  for p in &args.paths {
    if let Some(key) = rel_key(&root, Path::new(p)) {
      if !entries.iter().any(|e| e.eq_ignore_ascii_case(&key)) {
        entries.push(key);
      }
    }
  }
  write_playlist_file(&file, &entries)?;
  Ok(Playlist { name: sanitize_folder_name(&args.name)?, entries })
}

/// Remove tracks (absolute paths) from a playlist. The file stays on disk.
#[tauri::command]
fn playlist_remove(args: PlaylistEditArgs) -> Result<Playlist, String> {
  let root = PathBuf::from(args.library_dir.trim());
  let file = playlist_path(&root, &args.name)?;
  let keys: Vec<String> = args.paths.iter().filter_map(|p| rel_key(&root, Path::new(p))).collect();
  let mut entries = read_playlist_file(&file);
  entries.retain(|e| !keys.iter().any(|k| k.eq_ignore_ascii_case(e)));
  write_playlist_file(&file, &entries)?;
  Ok(Playlist { name: sanitize_folder_name(&args.name)?, entries })
}

/// Create an empty playlist (or leave an existing one untouched).
#[tauri::command]
fn playlist_create(args: PlaylistEditArgs) -> Result<Playlist, String> {
  let root = PathBuf::from(args.library_dir.trim());
  let file = playlist_path(&root, &args.name)?;
  if !file.exists() {
    write_playlist_file(&file, &[])?;
  }
  Ok(Playlist { name: sanitize_folder_name(&args.name)?, entries: read_playlist_file(&file) })
}

/// Delete a playlist FILE (to the Recycle Bin). Tracks are untouched.
#[tauri::command]
fn playlist_delete(args: PlaylistEditArgs) -> Result<(), String> {
  let root = PathBuf::from(args.library_dir.trim());
  let file = playlist_path(&root, &args.name)?;
  if !file.is_file() {
    return Err(format!("No playlist named {}", args.name));
  }
  send_to_bin(&file)
}

/// One-time migration: one playlist file per existing first-level folder, in filename order.
/// Never overwrites a playlist that already exists. Returns the resulting playlists.
#[tauri::command]
fn playlists_from_folders(library_dir: String) -> Result<Vec<Playlist>, String> {
  let root = PathBuf::from(library_dir.trim());
  if !root.is_dir() {
    return Err("Music folder not found".into());
  }
  let mut tracks = Vec::new();
  scan_dir(&root, &root, &mut tracks)?;
  tracks.sort_by(|a, b| a.playlist.cmp(&b.playlist).then(a.name.to_lowercase().cmp(&b.name.to_lowercase())));

  let mut by_folder: std::collections::BTreeMap<String, Vec<String>> = std::collections::BTreeMap::new();
  for t in &tracks {
    if t.playlist == "(root)" || t.playlist == PLAYLISTS_DIR {
      continue;
    }
    if let Some(key) = rel_key(&root, Path::new(&t.path)) {
      by_folder.entry(t.playlist.clone()).or_default().push(key);
    }
  }
  for (folder, entries) in &by_folder {
    let file = match playlist_path(&root, folder) {
      Ok(f) => f,
      Err(_) => continue,
    };
    if file.exists() {
      continue;
    }
    write_playlist_file(&file, entries)?;
  }
  Ok(load_playlists(&root))
}

/// Keep every playlist consistent after a file moved (or was deleted: `to == None`).
fn update_playlists_for_path(root: &Path, from: &Path, to: Option<&Path>) {
  let Some(from_key) = rel_key(root, from) else { return };
  let to_key = to.and_then(|t| rel_key(root, t));
  for pl in load_playlists(root) {
    if !pl.entries.iter().any(|e| e.eq_ignore_ascii_case(&from_key)) {
      continue;
    }
    let entries: Vec<String> = pl
      .entries
      .iter()
      .filter_map(|e| {
        if e.eq_ignore_ascii_case(&from_key) { to_key.clone() } else { Some(e.clone()) }
      })
      .collect();
    if let Ok(file) = playlist_path(root, &pl.name) {
      let _ = write_playlist_file(&file, &entries);
    }
  }
}

// ---------- move a track to another playlist folder ----------

#[derive(Debug, Clone, serde::Deserialize)]
struct MoveArgs {
  path: String,
  #[serde(alias = "libraryDir")]
  library_dir: String,
  #[serde(alias = "targetFolder")]
  target_folder: String,
}

/// Moves one file into `<library root>/<target folder>/` (same name). Returns the updated Track.
#[tauri::command]
fn move_track(args: MoveArgs) -> Result<Track, String> {
  let root = PathBuf::from(args.library_dir.trim());
  let src = PathBuf::from(&args.path);
  if !src.is_file() {
    return Err(format!("File not found: {}", src.display()));
  }
  if !src.starts_with(&root) {
    return Err("Track is outside the Music folder".into());
  }
  let target = sanitize_folder_name(&args.target_folder)?;
  let dest_dir = root.join(&target);
  std::fs::create_dir_all(&dest_dir)
    .map_err(|e| format!("Failed to create folder {}: {e}", dest_dir.display()))?;

  let file_name = src.file_name().ok_or_else(|| "Bad file name".to_string())?.to_os_string();
  let dest = dest_dir.join(&file_name);
  if dest.exists() {
    return Err(format!("{} already exists in {target}", file_name.to_string_lossy()));
  }
  std::fs::rename(&src, &dest).map_err(|e| format!("Move failed: {e}"))?;
  update_playlists_for_path(&root, &src, Some(&dest));

  let name = file_name.to_string_lossy().to_string();
  let (title, artist, secs) = read_tags(&dest);
  // (untagged files keep the artist the UI already had for them — the frontend patches this in)
  Ok(Track {
    path: dest.to_string_lossy().to_string(),
    playlist: target,
    name,
    title,
    artist,
    duration_secs: secs,
  })
}

// ---------- tag writing ----------

#[derive(Debug, Clone, serde::Deserialize)]
struct WriteTagsArgs {
  path: String,
  #[serde(alias = "libraryDir")]
  library_dir: String,
  title: String,
  artist: String,
}

/// Writes title + artist into the file's primary tag (created if the file has none).
/// Returns the re-read Track so the UI can update without a rescan.
#[tauri::command]
fn write_tags(args: WriteTagsArgs) -> Result<Track, String> {
  let root = PathBuf::from(args.library_dir.trim());
  let path = PathBuf::from(&args.path);
  if !path.is_file() {
    return Err(format!("File not found: {}", path.display()));
  }
  if !path.starts_with(&root) {
    return Err("Track is outside the Music folder".into());
  }
  write_title_artist(&path, args.title.trim(), args.artist.trim())?;

  let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
  let playlist = first_folder_under_root(&root, &path);
  let (title, artist, secs) = read_tags(&path);
  Ok(Track { path: path.to_string_lossy().to_string(), name, playlist, title, artist, duration_secs: secs })
}

fn write_title_artist(path: &Path, title: &str, artist: &str) -> Result<(), String> {
  let mut tagged = lofty::read_from_path(path).map_err(|e| format!("Cannot read tags: {e}"))?;
  if tagged.primary_tag().is_none() {
    let kind = tagged.primary_tag_type();
    tagged.insert_tag(lofty::tag::Tag::new(kind));
  }
  let tag = tagged.primary_tag_mut().ok_or_else(|| "No writable tag".to_string())?;
  if title.is_empty() { tag.remove_title(); } else { tag.set_title(title.to_string()); }
  if artist.is_empty() { tag.remove_artist(); } else { tag.set_artist(artist.to_string()); }
  tagged
    .save_to_path(path, lofty::config::WriteOptions::default())
    .map_err(|e| format!("Cannot write tags: {e}"))
}

/// "Song - Artist.m4a" → (Song, Artist); "Song.m4a" → (Song, "").
fn title_artist_from_filename(name: &str) -> (String, String) {
  let stem = name.rsplit_once('.').map(|(s, _)| s).unwrap_or(name);
  match stem.rsplit_once(" - ") {
    Some((song, artist)) if !song.trim().is_empty() && !artist.trim().is_empty() => {
      (song.trim().to_string(), artist.trim().to_string())
    }
    _ => (stem.trim().to_string(), String::new()),
  }
}

#[derive(Debug, Clone, serde::Deserialize)]
struct FixTagsArgs {
  paths: Vec<String>,
  #[serde(alias = "libraryDir")]
  library_dir: String,
}

#[derive(Debug, Clone, Serialize)]
struct FixTagsReport {
  updated: Vec<Track>,
  skipped: usize,
  failed: Vec<String>,
}

/// Does this tag value look like raw YouTube output rather than a curated tag?
fn looks_like_youtube_junk(s: &str) -> bool {
  let l = s.to_lowercase();
  let markers = [
    "official", "lyric", "visuali", "(audio)", "[audio]", "4k", "(hd)", "[hd]", "music video", "(video)", "[video]",
    " | ", " ｜ ", "full album", "remaster)", "_-_",
  ];
  markers.iter().any(|m| l.contains(m))
    || regex_like_ytid(&l)
}
/// crude "[dQw4w9WgXcQ]" detector without pulling in a regex crate
fn regex_like_ytid(l: &str) -> bool {
  if let Some(open) = l.rfind('[') {
    if let Some(close) = l[open..].find(']') {
      let inner = &l[open + 1..open + close];
      return inner.len() == 11 && inner.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
    }
  }
  false
}

/// Batch: write title/artist tags from the "Song - Artist" filename convention — CONSERVATIVELY.
/// A file is rewritten only when its current tag is empty or looks like raw YouTube output;
/// a curated tag that merely differs from the (possibly truncated) filename is KEPT.
/// (Learned 2026-09-08: the unconditional version truncated 349 good Spotify-era tags.)
#[tauri::command]
fn fix_tags_from_filenames(args: FixTagsArgs) -> Result<FixTagsReport, String> {
  let root = PathBuf::from(args.library_dir.trim());
  let mut updated = Vec::new();
  let mut failed = Vec::new();
  let mut skipped = 0usize;

  for p in &args.paths {
    let path = PathBuf::from(p);
    if !path.is_file() || !path.starts_with(&root) {
      failed.push(format!("{}: not a file inside the Music folder", path.display()));
      continue;
    }
    let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let (want_title, want_artist) = title_artist_from_filename(&name);
    let (cur_title, cur_artist, _) = read_tags(&path);

    // Decide per field: only empty or junk-looking values get replaced.
    let new_title = if cur_title.is_empty() || looks_like_youtube_junk(&cur_title) { want_title } else { cur_title.clone() };
    let artist = if !want_artist.is_empty() && (cur_artist.is_empty() || looks_like_youtube_junk(&cur_artist)) {
      want_artist
    } else {
      cur_artist.clone()
    };
    // Never replace a value with a strict truncation of itself (a filename cut at 55 chars).
    let truncates = |old: &str, new: &str| !old.is_empty() && new.len() < old.len() && old.to_lowercase().starts_with(&new.to_lowercase());
    let new_title = if truncates(&cur_title, &new_title) { cur_title.clone() } else { new_title };
    let artist = if truncates(&cur_artist, &artist) { cur_artist.clone() } else { artist };

    if cur_title == new_title && cur_artist == artist {
      skipped += 1;
      continue;
    }
    let want_title = new_title;
    match write_title_artist(&path, &want_title, &artist) {
      Ok(()) => {
        let (title, artist, secs) = read_tags(&path);
        updated.push(Track {
          path: path.to_string_lossy().to_string(),
          playlist: first_folder_under_root(&root, &path),
          name,
          title,
          artist,
          duration_secs: secs,
        });
      }
      Err(e) => failed.push(format!("{name}: {e}")),
    }
  }
  Ok(FixTagsReport { updated, skipped, failed })
}

// ---------- delete a track (to the Recycle Bin) ----------

#[derive(Debug, Clone, serde::Deserialize)]
struct DeleteArgs {
  path: String,
  #[serde(alias = "libraryDir")]
  library_dir: String,
}

/// Sends one file inside the library root to the Recycle Bin. Never a hard delete.
#[tauri::command]
fn delete_track(args: DeleteArgs) -> Result<(), String> {
  let root = PathBuf::from(args.library_dir.trim());
  let src = PathBuf::from(&args.path);
  if !src.is_file() {
    return Err(format!("File not found: {}", src.display()));
  }
  if !src.starts_with(&root) {
    return Err("Track is outside the Music folder".into());
  }
  send_to_bin(&src)?;
  update_playlists_for_path(&root, &src, None);
  Ok(())
}

/// Desktop: Recycle Bin / Trash. Mobile has none, so the file is removed for real
/// (the confirmation box says so on the phone).
fn send_to_bin(path: &Path) -> Result<(), String> {
  #[cfg(desktop)]
  {
    trash::delete(path).map_err(|e| format!("Could not move to Recycle Bin: {e}"))
  }
  #[cfg(mobile)]
  {
    std::fs::remove_file(path).map_err(|e| format!("Could not delete: {e}"))
  }
}

/// Newest audio file in `dir` modified at/after `since` (with a little slack for clock granularity).
#[cfg(desktop)]
fn newest_audio_since(dir: &Path, since: std::time::SystemTime) -> Option<PathBuf> {
  let floor = since.checked_sub(std::time::Duration::from_secs(5)).unwrap_or(since);
  let mut best: Option<(std::time::SystemTime, PathBuf)> = None;
  for e in std::fs::read_dir(dir).ok()?.flatten() {
    let p = e.path();
    if !p.is_file() || !is_audio_file(&p) {
      continue;
    }
    let Ok(m) = e.metadata().and_then(|m| m.modified()) else { continue };
    if m < floor {
      continue;
    }
    if best.as_ref().map(|(t, _)| m > *t).unwrap_or(true) {
      best = Some((m, p));
    }
  }
  best.map(|(_, p)| p)
}

#[cfg(desktop)]
fn find_bin_by_prefix(dir: &Path, prefix: &str) -> Option<PathBuf> {
  let entries = std::fs::read_dir(dir).ok()?;
  for e in entries.flatten() {
    let p = e.path();
    if !p.is_file() {
      continue;
    }
    let name = p.file_name()?.to_string_lossy();
    if name.starts_with(prefix) {
      return Some(p);
    }
  }
  None
}

#[cfg(desktop)]
fn sidecar_bin_dir(app: &AppHandle) -> Result<PathBuf, String> {
  // Dev: binaries are in src-tauri/bin
  if cfg!(debug_assertions) {
    return Ok(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("bin"));
  }

  // Release: binaries are in resources/bin
  let res = app
    .path()
    .resource_dir()
    .map_err(|e| format!("Failed to get resource dir: {e}"))?;
  Ok(res.join("bin"))
}

#[cfg(mobile)]
#[tauri::command]
async fn ytdlp_download_audio(_app: AppHandle, _args: YtDlpArgs) -> Result<(), String> {
  Err("Downloading is not available on the phone yet — it lands with the on-device downloader.".into())
}

#[cfg(desktop)]
#[tauri::command]
async fn ytdlp_download_audio(app: AppHandle, args: YtDlpArgs) -> Result<(), String> {
  let url = args.url;

  // The library root is REQUIRED. No silent fallback to the OS Music folder —
  // that is how downloads used to vanish into a folder the app never scans.
  let base_dir: PathBuf = match args.library_dir.as_deref().map(str::trim) {
    Some(ld) if !ld.is_empty() => PathBuf::from(ld),
    _ => return Err("No Music folder selected — click Import first.".into()),
  };
  if !base_dir.is_dir() {
    return Err(format!("Music folder does not exist: {}", base_dir.display()));
  }

  let target = sanitize_folder_name(args.target_folder.as_deref().unwrap_or("Downloads"))?;
  let out_dir = base_dir.join(&target);
  std::fs::create_dir_all(&out_dir)
    .map_err(|e| format!("Failed to create folder {}: {e}", out_dir.display()))?;

  // Filename = "Track - Artist" (Matteo's library convention) when YouTube knows both,
  // else the cleaned video title. `mh_name` is set by --parse-metadata below only when
  // track AND artist are present (a missing field renders as "NA", which the lookaheads reject).
  let output_template = out_dir
    .join("%(mh_name,title)s.%(ext)s")
    .to_string_lossy()
    .to_string();
  const TITLE_JUNK: &str = r"(?i)\s*[\(\[][^\)\]]*\b(official|lyrics?|audio|visuali[sz]er|4k|hd|hq|music video|video|clip|full album|full)\b[^\)\]]*[\)\]]";
  const MH_NAME_PARSE: &str = r"%(track)s - %(artist)s:(?P<mh_name>(?!NA - ).+ - (?!NA$).+)";

  // Wire yt-dlp to the bundled Deno runtime (fixes the “No supported JavaScript runtime” warning).
  let bin_dir = sidecar_bin_dir(&app)?;
  let deno_path = find_bin_by_prefix(&bin_dir, "deno-")
    .ok_or_else(|| format!("Could not find bundled deno in: {}", bin_dir.display()))?;
  let js_runtime_arg = format!("deno:{}", deno_path.to_string_lossy());

  // ffmpeg: use a bundled one if it ever lands in bin/, else whatever is on PATH.
  let ffmpeg_args: Vec<String> = match find_bin_by_prefix(&bin_dir, "ffmpeg") {
    Some(p) => vec!["--ffmpeg-location".into(), p.to_string_lossy().to_string()],
    None => vec![],
  };

  let mut argv: Vec<String> = vec![
    "--no-playlist".into(),
    "--js-runtimes".into(),
    js_runtime_arg,
  ];
  argv.extend(ffmpeg_args);
  argv.extend(
    [
      "-f",
      "bestaudio[ext=m4a]/bestaudio",
      // title cleaning + name assembly (order matters: clean first, then parse)
      "--replace-in-metadata", "title", TITLE_JUNK, "",
      "--replace-in-metadata", "title", r"\s{2,}", " ",
      "--parse-metadata", MH_NAME_PARSE,
      "-o", output_template.as_str(),
      "--windows-filenames",
      "--trim-filenames", "200",
      "--embed-metadata",
      "--embed-thumbnail",
      "--extract-audio",
      "--audio-format", "m4a",
      "--no-progress",
      "--console-title",
      url.as_str(),
    ]
    .iter()
    .map(|s| s.to_string()),
  );

  let _ = app.emit("ytdlp:stdout", format!("[music-hood] saving into: {}", out_dir.display()));

  let cmd = app
    .shell()
    .sidecar("yt-dlp")
    .map_err(|e| format!("Could not create yt-dlp sidecar: {e}"))?
    .args(argv)
    .current_dir(out_dir.clone());

  let started = std::time::SystemTime::now();
  let (mut rx, _child) = cmd.spawn().map_err(|e| format!("Failed to spawn yt-dlp: {e}"))?;

  tauri::async_runtime::spawn(async move {
    while let Some(event) = rx.recv().await {
      match event {
        CommandEvent::Stdout(line) => {
          let text = String::from_utf8_lossy(&line).to_string();
          let _ = app.emit("ytdlp:stdout", text);
        }
        CommandEvent::Stderr(line) => {
          let text = String::from_utf8_lossy(&line).to_string();
          let _ = app.emit("ytdlp:stderr", text);
        }
        CommandEvent::Terminated(payload) => {
          let code = payload.code.unwrap_or(1);
          // Tell the UI which file this download produced: the newest audio file in the
          // target folder written since we started (no log parsing).
          if code == 0 {
            if let Some(p) = newest_audio_since(&out_dir, started) {
              let _ = app.emit("ytdlp:file", p.to_string_lossy().to_string());
            }
          }
          let _ = app.emit("ytdlp:done", code);
        }
        _ => {}
      }
    }
  });

  Ok(())
}

/// "windows" | "linux" | "macos" | "android" | "ios" — lets the UI adapt (paths, layout, what is available).
#[tauri::command]
fn platform() -> String {
  std::env::consts::OS.to_string()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_shell::init())
    .plugin(tauri_plugin_store::Builder::default().build())
    .invoke_handler(tauri::generate_handler![
      scan_music_folder,
      ytdlp_download_audio,
      move_track,
      delete_track,
      write_tags,
      fix_tags_from_filenames,
      list_playlists,
      playlist_add,
      playlist_remove,
      playlist_create,
      playlist_delete,
      playlists_from_folders,
      platform
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
