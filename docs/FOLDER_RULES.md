# Folder Navigation Rules

## Core rules
1. **User is the source of truth**: the app never restructures user folders.
2. **Folders are browsable as-is**: hierarchy preserved.
3. **Folder = Collection** (optional): treat each folder as a logical “playlist/album” without changing tags.
4. **Tags provide virtual views**: Artists/Albums views are derived from metadata, not folder names.

## Library roots
- User picks one or more roots.
- Roots are indexed independently.
- Same track appearing in multiple roots: detect duplicates via file hash (optional).

## Scanning
- Initial scan builds:
  - File path index
  - Tag index (artist/album/title/trackno)
  - Artwork cache references
- Watch mode:
  - react to create/delete/rename
  - periodic rescan fallback

## File naming tolerance
- Filenames can be messy; UI should prefer tags.
- If tags missing, fallback order:
  1) filename
  2) folder name
  3) “Unknown”

## Import target behavior (yt-dlp pipeline)
- If user imports a single track:
  - saves into selected target folder (no auto artist subfolders unless explicitly chosen)
- If user imports a playlist:
  - creates folder: `<Target>\<PlaylistName>\`
  - each track saved inside it
- Users can switch off “Create playlist folder” and dump flat into target.

## Conflict resolution (“latest wins”)
- Default: never auto overwrite.
- On conflict (same filename):
  - create unique name (suffix) OR prompt depending on setting.
- For sync-friendliness, prefer deterministic names + IDs in metadata, not filenames.
