# Screen List (Exact)

## 0. First Launch: Library Setup
- Choose one or more root folders
- Toggle: "Watch for changes" (filesystem watcher)
- Toggle: "Treat folders as collections"
- Optional: "Enable import tools" (points to yt-dlp + ffmpeg paths)

## 1. Main Player (Home)
- Now Playing (art, title, artist, album)
- Playback controls + volume
- Queue panel (collapsible)
- Left navigation:
  - Folders
  - Artists
  - Albums
  - Playlists
  - Search

## 2. Folder View
- Breadcrumb: Root / … / Current folder
- Track list
- Actions: Play, Add to Queue, Shuffle, Save as Playlist, Edit Tags

## 3. Artist View
- Artist header + stats
- Album list (if tags exist)
- Track list fallback if albums missing

## 4. Album View
- Album header + track list
- Disc grouping if present
- Actions: Play, Add to Queue, Edit album tags

## 5. Playlist View
- Playlist list
- Playlist editor:
  - reorder, multi-select remove
  - export/import playlist file (m3u8)
  - smart playlists (later)

## 6. Import Screen (Optional Feature)
- Input: clipboard link or paste
- Preset: "Audio (m4a)" / "Audio (opus)" etc
- Target folder picker
- Naming preview
- Tagging preview
- Buttons: "Import", "Import as Playlist Folder" (if playlist link)

## 7. Tag Editor
- Single track edit
- Multi-track batch edit
- Album-level edits (apply to selection)
- Normalizer rules (title cleanup)

## 8. Settings
- Library roots
- Watcher settings
- Audio output settings
- Import tool paths + presets
- Keyboard shortcuts editor
- Privacy settings (telemetry off by default)
