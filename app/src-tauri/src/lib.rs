#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, Manager};

use tauri_plugin_shell::process::{CommandEvent};
use tauri_plugin_shell::ShellExt;

#[derive(Debug, Clone, Serialize)]
struct Track {
  path: String,
  name: String,
  playlist: String,
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

  tracks.sort_by(|a, b| a.playlist.cmp(&b.playlist).then(a.name.cmp(&b.name)));
  Ok(tracks)
}

// ---------- yt-dlp download ----------

#[derive(Debug, Clone, serde::Deserialize)]
struct YtDlpArgs {
  url: String,
  #[serde(alias = "libraryDir")]
  library_dir: Option<String>,
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

  // Prefer user-selected library dir; fallback to OS Music dir.
  let base_dir: PathBuf = if let Some(ld) = args.library_dir {
    let ld = ld.trim().to_string();
    if !ld.is_empty() {
      PathBuf::from(ld)
    } else {
      app
        .path()
        .audio_dir()
        .map_err(|e| format!("Failed to get audio dir: {e}"))?
    }
  } else {
    app
      .path()
      .audio_dir()
      .map_err(|e| format!("Failed to get audio dir: {e}"))?
  };

  let out_dir = base_dir.join("Downloads");
  std::fs::create_dir_all(&out_dir).map_err(|e| format!("Failed to create Downloads dir: {e}"))?;

  let output_template = out_dir
    .join("%(title).200s.%(ext)s")
    .to_string_lossy()
    .to_string();

  // Wire yt-dlp to the bundled Deno runtime (fixes the “No supported JavaScript runtime” warning).
  let bin_dir = sidecar_bin_dir(&app)?;
  let deno_path = find_bin_by_prefix(&bin_dir, "deno-")
    .ok_or_else(|| format!("Could not find bundled deno in: {}", bin_dir.display()))?;

  let js_runtime_arg = format!("deno:{}", deno_path.to_string_lossy());

  let mut cmd = app
    .shell()
    .sidecar("yt-dlp")
    .map_err(|e| format!("Could not create yt-dlp sidecar: {e}"))?
    .args([
      "--no-playlist",
      "--js-runtimes",
      js_runtime_arg.as_str(),

      "-f",
      "bestaudio[ext=m4a]/bestaudio",
      "-o",
      output_template.as_str(),

      "--embed-metadata",
      "--embed-thumbnail",
      "--add-metadata",
      "--restrict-filenames",
      "--windows-filenames",
      "--trim-filenames",
      "200",

      "--extract-audio",
      "--audio-format",
      "m4a",

      "--no-progress",
      "--console-title",

      url.as_str(),
    ])
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
    .invoke_handler(tauri::generate_handler![scan_music_folder, ytdlp_download_audio])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
