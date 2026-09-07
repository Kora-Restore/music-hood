#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, Manager};

use tauri_plugin_shell::process::{CommandEvent};
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
  trash::delete(&src).map_err(|e| format!("Could not move to Recycle Bin: {e}"))
}

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
          let _ = app.emit("ytdlp:done", code);
        }
        _ => {}
      }
    }
  });

  Ok(())
}

pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_shell::init())
    .plugin(tauri_plugin_store::Builder::default().build())
    .invoke_handler(tauri::generate_handler![scan_music_folder, ytdlp_download_audio, move_track, delete_track])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
