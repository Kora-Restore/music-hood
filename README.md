# Music-Hood 🎧🧅

A local, folder-first desktop music player inspired by Musicolet’s UX, with optional one-click audio import from supported sources (e.g., YouTube via yt-dlp as an external dependency).

## Principles (non-negotiable)
- **Local-first**: works perfectly with plain folders, no account, no cloud required.
- **Library = folders**: user owns structure, app never forces it.
- **Fast & quiet**: instant search, instant queueing, no bloat.
- **Keyboard-native**: everything usable without a mouse.
- **Truthful metadata**: tags are editable, visible, and never “mystery meat”.
- **Respect user boundaries**: no telemetry by default; explicit opt-in only.
- **Legal sanity**: the app does not ship copyrighted content; import features rely on user-provided links and user-installed tools; users are responsible for rights/ToS compliance.

## Scope v0 (MVP)
- Library scan of selected folders
- Music playback with queue
- Tag editor (basic)
- Playlist management (local)
- Import pipeline (optional): yt-dlp + ffmpeg integration, post-process naming/tagging presets

## Docs
- UX mapping: `docs/UX_MAPPING.md`
- Screens: `docs/SCREENS.md`
- Shortcuts: `docs/SHORTCUTS.md`
- Folder/navigation rules: `docs/FOLDER_RULES.md`
