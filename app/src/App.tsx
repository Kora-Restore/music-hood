import { Store } from "@tauri-apps/plugin-store";
import { useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

type Track = {
  path: string;
  name: string;
  playlist: string;
  title: string;
  artist: string;
  duration_secs: number;
};

const UNTAGGED = "(untagged)";
const NEW_PLAYLIST_SENTINEL = "__newpl__";

type PlaylistFile = { name: string; entries: string[] };

// Absolute path → the key used inside playlist files: relative to the Music root, forward slashes.
function relKey(root: string, abs: string): string {
  const r = root.replace(/[\\/]+$/, "");
  let rel = abs.startsWith(r) ? abs.slice(r.length) : abs;
  rel = rel.replace(/^[\\/]+/, "");
  return rel.replace(/\\/g, "/");
}

// "Schrotthagen, Giovanni Berg" / "A feat. B" → the individual names. Mirrors the Rust side:
// no splitting on "&" or "x", so "Earth, Wind & Fire" survives as "Earth" + "Wind & Fire" at worst.
// A track with no artist at all lands in the "(untagged)" bucket so it stays reachable.
function splitArtists(artist: string): string[] {
  if (!artist) return [UNTAGGED];
  return artist
    .split(/\s*(?:,|\/|;|\bfeat\.?\s|\bft\.?\s)\s*/i)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// One settings store, one key per setting. (An earlier edit had two store
// instances writing two different keys to the same file — Import broke on it.)
const storePromise = Store.load("music-hood.json");
const KEY_LIBRARY_DIR = "library_dir";
const KEY_DOWNLOAD_TARGET = "download_target";
const DEFAULT_DOWNLOAD_TARGET = "Downloads";
const NEW_FOLDER_SENTINEL = "__new__";

const KEY_VOLUME = "volume";
const KEY_SORT = "sort";
const KEY_DOWNLOAD_PLAYLISTS = "download_playlists";

// Track-list sort orders. "natural" = playlist order inside a playlist, filename order elsewhere.
const SORT_MODES = ["Natural order", "Title A→Z", "Title Z→A", "Artist A→Z", "Longest first", "Shortest first"] as const;
type SortMode = (typeof SORT_MODES)[number];

const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });

function sortTracks(list: Track[], mode: SortMode): Track[] {
  if (mode === "Natural order") return list;
  const title = (t: Track) => t.title || displayName(t.name);
  const artist = (t: Track) => t.artist || "￿"; // untagged last
  const out = [...list];
  switch (mode) {
    case "Title A→Z": out.sort((a, b) => collator.compare(title(a), title(b))); break;
    case "Title Z→A": out.sort((a, b) => collator.compare(title(b), title(a))); break;
    case "Artist A→Z": out.sort((a, b) => collator.compare(artist(a), artist(b)) || collator.compare(title(a), title(b))); break;
    case "Longest first": out.sort((a, b) => b.duration_secs - a.duration_secs); break;
    case "Shortest first": out.sort((a, b) => a.duration_secs - b.duration_secs); break;
  }
  return out;
}

// Shuffle icon: two straight parallel arrows when off, crossing arrows when on.
function ShuffleIcon({ on }: { on: boolean }) {
  const s = { fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" } as const;
  return on ? (
    <svg width="20" height="20" viewBox="0 0 24 24" {...s} aria-hidden="true">
      <path d="M3 7h3.5c1.6 0 3 .8 3.9 2.1L14.6 15c.9 1.3 2.3 2.1 3.9 2.1H21" />
      <path d="M3 17h3.5c1.6 0 3-.8 3.9-2.1l4.2-5.9C15.5 7.8 16.9 7 18.5 7H21" />
      <path d="M18.5 4.5L21 7l-2.5 2.5" />
      <path d="M18.5 14.6L21 17.1l-2.5 2.5" />
    </svg>
  ) : (
    <svg width="20" height="20" viewBox="0 0 24 24" {...s} aria-hidden="true">
      <path d="M3 8h18" />
      <path d="M3 16h18" />
      <path d="M18.5 5.5L21 8l-2.5 2.5" />
      <path d="M18.5 13.5L21 16l-2.5 2.5" />
    </svg>
  );
}

function PencilIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 20h4l10.5-10.5a2.1 2.1 0 0 0-3-3L5 17v3z" />
      <path d="M13.5 6.5l3 3" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 7h16" />
      <path d="M10 11v6M14 11v6" />
      <path d="M6 7l1 13h10l1-13" />
      <path d="M9 7V4h6v3" />
    </svg>
  );
}

// Filename without extension — what the user should read as the title.
function displayName(fileName: string) {
  return fileName.replace(/\.[^./\\]+$/, "");
}

// In-app dropdown. The native <select> popup is drawn by Windows/WebView2 and
// ignores the app's dark theme (light grey on light grey — unreadable), so we draw our own.
type DropdownProps = {
  value: string;
  options: string[];
  onSelect: (v: string) => void;
  placeholder?: string;
  extra?: { label: string; value: string };
  up?: boolean;
  className?: string;
  title?: string;
};

function Dropdown({ value, options, onSelect, placeholder, extra, up, className, title }: DropdownProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function pick(v: string) {
    setOpen(false);
    onSelect(v);
  }

  return (
    <div className={`dd ${className ?? ""}`} ref={ref}>
      <button type="button" className={`ddBtn ${open ? "open" : ""}`} title={title} onClick={() => setOpen((o) => !o)}>
        <span className="ddLabel">{value || placeholder || ""}</span>
        <span className="ddChevron">{up ? "▴" : "▾"}</span>
      </button>
      {open ? (
        <div className={`ddMenu ${up ? "up" : ""}`}>
          {options.map((o) => (
            <div key={o} className={`ddItem ${o === value ? "active" : ""}`} onClick={() => pick(o)}>
              {o}
            </div>
          ))}
          {extra ? (
            <div className="ddItem ddExtra" onClick={() => pick(extra.value)}>
              {extra.label}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// Multi-choice dropdown: stays open while ticking; the button shows a summary.
type MultiDropdownProps = {
  values: string[];
  options: string[];
  onChange: (next: string[]) => void;
  placeholder: string;
  title?: string;
  className?: string;
};

function MultiDropdown({ values, options, onChange, placeholder, title, className }: MultiDropdownProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function toggle(o: string) {
    onChange(values.includes(o) ? values.filter((v) => v !== o) : [...values, o]);
  }

  const label =
    values.length === 0 ? placeholder : values.length === 1 ? values[0] : `${values.length} playlists`;

  return (
    <div className={`dd ${className ?? ""}`} ref={ref}>
      <button type="button" className={`ddBtn ${open ? "open" : ""} ${values.length ? "hasValues" : ""}`} title={title} onClick={() => setOpen((o) => !o)}>
        <span className="ddLabel">{label}</span>
        <span className="ddChevron">▾</span>
      </button>
      {open ? (
        <div className="ddMenu">
          {options.length === 0 ? <div className="ddItem dimText">No playlists yet</div> : null}
          {options.map((o) => {
            const on = values.includes(o);
            return (
              <div key={o} className={`ddItem ddCheck ${on ? "active" : ""}`} onClick={() => toggle(o)}>
                <span className="ddBox">{on ? "✓" : ""}</span>
                {o}
              </div>
            );
          })}
          {values.length ? (
            <div className="ddItem ddExtra" onClick={() => onChange([])}>Clear</div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

const COLORS = {
  bg0: "#0f0f0f",
  bg1: "#212121",
  accent: "#00ffbf",
  accent2: "#8c19ff",
  text: "rgba(255,255,255,0.92)",
  textDim: "rgba(255,255,255,0.65)",
  panel: "rgba(255,255,255,0.05)",
  border: "rgba(255,255,255,0.10)",
};

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function formatTime(sec: number) {
  if (!isFinite(sec) || sec < 0) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

export default function App() {
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const [folder, setFolder] = useState<string>("");
  // "windows" | "linux" | "macos" | "android" | "ios" (from Rust). Phones: no folder picker, no Recycle Bin.
  const [platform, setPlatform] = useState<string>("");
  const isMobile = platform === "android" || platform === "ios";
  const [pathInput, setPathInput] = useState<string>("");
  const [status, setStatus] = useState<string>("Idle");
  const [allTracks, setAllTracks] = useState<Track[]>([]);

  const [playlist, setPlaylist] = useState<string>("(all)");
  // Left panel: playlist FILES (membership, many-to-many) · Artists (from tags) · Folders (storage).
  const [sideTab, setSideTab] = useState<"playlists" | "artists" | "folders">("playlists");
  const [artistView, setArtistView] = useState<string>("");
  // The playlist file being viewed ("" = none). Exactly one of artistView / plView / folder is active.
  const [plView, setPlView] = useState<string>("");
  const [playlistFiles, setPlaylistFiles] = useState<PlaylistFile[]>([]);
  const [plQuery, setPlQuery] = useState<string>("");
  const [newPlaylistMode, setNewPlaylistMode] = useState<boolean>(false);
  const [newPlaylistName, setNewPlaylistName] = useState<string>("");
  const [confirmDeletePlaylist, setConfirmDeletePlaylist] = useState<string>("");
  const [artistQuery, setArtistQuery] = useState<string>("");
  const [playlistQuery, setPlaylistQuery] = useState<string>("");
  const [query, setQuery] = useState<string>("");
  const [sortMode, setSortMode] = useState<SortMode>("Natural order");

  const [currentPath, setCurrentPath] = useState<string>("");
  // Single click selects (highlight only); double click plays. Selection is what "Move selected" acts on.
  // Multi-select: a set of paths. Click = single, Ctrl+click = toggle, Shift+click = range, Ctrl+A = all listed.
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(() => new Set());
  const anchorRef = useRef<string>("");
  // Track awaiting delete confirmation (the in-app "are you sure" box).
  const [confirmDelete, setConfirmDelete] = useState<Track[] | null>(null);
  // Tag editor (single track) and the batch "tags from filenames" confirmation.
  const [editTags, setEditTags] = useState<{ track: Track; title: string; artist: string } | null>(null);
  const [confirmFix, setConfirmFix] = useState<boolean>(false);
  const [fixBusy, setFixBusy] = useState<boolean>(false);
  const [fixReport, setFixReport] = useState<{ updated: number; skipped: number; failed: string[] } | null>(null);
  const [currentName, setCurrentName] = useState<string>("");
  const [currentPlaylist, setCurrentPlaylist] = useState<string>("");

  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [progress, setProgress] = useState<number>(0);
  const [duration, setDuration] = useState<number>(0);
  const [shuffle, setShuffle] = useState<boolean>(false);
  const [volume, setVolume] = useState<number>(1);
  const settingsLoadedRef = useRef<boolean>(false);

  // Volume: apply to the player immediately, persist a moment after the slider stops moving
  // (but never before the saved value has been read, or we'd overwrite it with the default).
  useEffect(() => {
    const audio = audioRef.current;
    if (audio) audio.volume = volume;
    if (!settingsLoadedRef.current) return;
    const t = setTimeout(async () => {
      try {
        const store = await storePromise;
        await store.set(KEY_VOLUME, volume);
        await store.save();
      } catch {
        /* non-fatal */
      }
    }, 400);
    return () => clearTimeout(t);
  }, [volume]);

  // Manual download box
  const [downloadUrl, setDownloadUrl] = useState<string>("");
  const [dlBusy, setDlBusy] = useState<boolean>(false);
  const [dlLogs, setDlLogs] = useState<string>("");

  // Where downloads land: a first-level folder under the Music root (= a playlist).
  const [dlTarget, setDlTarget] = useState<string>(DEFAULT_DOWNLOAD_TARGET);
  const [newFolderName, setNewFolderName] = useState<string>("");
  const [newFolderMode, setNewFolderMode] = useState<boolean>(false);
  // Playlists a finished download is added to (remembered between downloads).
  const [dlPlaylists, setDlPlaylists] = useState<string[]>([]);
  const dlPlaylistsRef = useRef<string[]>([]);
  useEffect(() => {
    dlPlaylistsRef.current = dlPlaylists;
  }, [dlPlaylists]);
  const lastDownloadRef = useRef<string>("");

  async function chooseDlPlaylists(next: string[]) {
    setDlPlaylists(next);
    try {
      const store = await storePromise;
      await store.set(KEY_DOWNLOAD_PLAYLISTS, next);
      await store.save();
    } catch {
      /* non-fatal */
    }
  }

  // IMPORTANT: avoid duplicate ytdlp listeners in dev/hmr by using a ref for latest folder
  const folderRef = useRef<string>("");
  useEffect(() => {
    folderRef.current = folder;
  }, [folder]);

  // Folders offered as download targets: every existing playlist folder + the default.
  const targetOptions = useMemo(() => {
    const set = new Set<string>([DEFAULT_DOWNLOAD_TARGET]);
    for (const t of allTracks) {
      if (t.playlist && t.playlist !== "(root)") set.add(t.playlist);
    }
    if (dlTarget) set.add(dlTarget);
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [allTracks, dlTarget]);

  async function chooseTarget(name: string) {
    const clean = name.trim();
    if (!clean) return;
    setDlTarget(clean);
    setNewFolderMode(false);
    setNewFolderName("");
    try {
      const store = await storePromise;
      await store.set(KEY_DOWNLOAD_TARGET, clean);
      await store.save();
    } catch {
      /* non-fatal: the choice still applies for this session */
    }
  }

  const playlists = useMemo(() => {
    const set = new Set<string>();
    for (const t of allTracks) set.add(t.playlist || "(root)");
    const arr = Array.from(set);
    arr.sort((a, b) => a.localeCompare(b));
    return ["(all)", ...arr.filter((x) => x !== "(all)")];
  }, [allTracks]);

  // Artist index: every artist named in a tag (collaborations count under each name) → track count.
  const artists = useMemo(() => {
    const counts = new Map<string, number>();
    for (const t of allTracks) {
      for (const a of splitArtists(t.artist)) counts.set(a, (counts.get(a) ?? 0) + 1);
    }
    return Array.from(counts.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => {
        if (a.name === UNTAGGED) return 1; // always last
        if (b.name === UNTAGGED) return -1;
        return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
      });
  }, [allTracks]);

  const shownPlaylists = useMemo(() => {
    const q = playlistQuery.trim().toLowerCase();
    return q ? playlists.filter((p) => p === "(all)" || p.toLowerCase().includes(q)) : playlists;
  }, [playlists, playlistQuery]);

  const shownArtists = useMemo(() => {
    const q = artistQuery.trim().toLowerCase();
    return q ? artists.filter((a) => a.name.toLowerCase().includes(q)) : artists;
  }, [artists, artistQuery]);

  // Tracks by their playlist-file key, for resolving m3u8 entries.
  const tracksByKey = useMemo(() => {
    const m = new Map<string, Track>();
    const root = folder;
    if (!root) return m;
    for (const t of allTracks) m.set(relKey(root, t.path).toLowerCase(), t);
    return m;
  }, [allTracks, folder]);

  const currentPlaylistFile = useMemo(
    () => (plView ? playlistFiles.find((p) => p.name === plView) ?? null : null),
    [playlistFiles, plView]
  );

  const shownPlaylistFiles = useMemo(() => {
    const q = plQuery.trim().toLowerCase();
    return q ? playlistFiles.filter((p) => p.name.toLowerCase().includes(q)) : playlistFiles;
  }, [playlistFiles, plQuery]);

  const filteredTracks = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matches = (t: Track) => !q || t.name.toLowerCase().includes(q) || t.artist.toLowerCase().includes(q);

    if (plView) {
      // playlist FILE: entries in their own order; entries whose file is gone are skipped
      const pl = currentPlaylistFile;
      if (!pl) return [];
      const out: Track[] = [];
      for (const e of pl.entries) {
        const t = tracksByKey.get(e.toLowerCase());
        if (t && matches(t)) out.push(t);
      }
      return sortTracks(out, sortMode);
    }
    const out = allTracks.filter((t) => {
      if (artistView) {
        // virtual playlist: every track by this artist, whatever folder it lives in
        if (!splitArtists(t.artist).includes(artistView)) return false;
      } else if (playlist !== "(all)" && (t.playlist || "(root)") !== playlist) {
        return false;
      }
      return matches(t);
    });
    return sortTracks(out, sortMode);
  }, [allTracks, playlist, artistView, plView, currentPlaylistFile, tracksByKey, query, sortMode]);

  async function chooseSort(mode: SortMode) {
    setSortMode(mode);
    try {
      const store = await storePromise;
      await store.set(KEY_SORT, mode);
      await store.save();
    } catch {
      /* non-fatal */
    }
  }

  // Is the selected track already in a given playlist file?
  function inPlaylist(pl: PlaylistFile, t: Track) {
    const k = relKey(folder, t.path).toLowerCase();
    return pl.entries.some((e) => e.toLowerCase() === k);
  }

  async function loadPlaylists(lib: string) {
    try {
      const pls = await invoke<PlaylistFile[]>("list_playlists", { libraryDir: lib });
      setPlaylistFiles(pls);
    } catch (err) {
      setStatus(`Playlists: ${String(err)}`);
    }
  }

  async function createPlaylistsFromFolders() {
    const lib = folderRef.current;
    if (!lib) return;
    try {
      const pls = await invoke<PlaylistFile[]>("playlists_from_folders", { libraryDir: lib });
      setPlaylistFiles(pls);
      setStatus(`Created ${pls.length} playlist files in _Playlists`);
    } catch (err) {
      setStatus(`Playlists: ${String(err)}`);
    }
  }

  async function addToPlaylist(name: string, tracks: Track[]) {
    const lib = folderRef.current;
    if (!lib || !name || tracks.length === 0) return;
    try {
      const pl = await invoke<PlaylistFile>("playlist_add", {
        args: { libraryDir: lib, name, paths: tracks.map((t) => t.path) },
      });
      setPlaylistFiles((prev) => {
        const i = prev.findIndex((p) => p.name === pl.name);
        const next = i >= 0 ? prev.map((p) => (p.name === pl.name ? pl : p)) : [...prev, pl];
        return next.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
      });
      setStatus(`Added to ${pl.name}`);
    } catch (err) {
      setStatus(`Add failed: ${String(err)}`);
    }
  }

  async function removeFromPlaylist(name: string, tracks: Track[]) {
    const lib = folderRef.current;
    if (!lib || !name || tracks.length === 0) return;
    try {
      const pl = await invoke<PlaylistFile>("playlist_remove", {
        args: { libraryDir: lib, name, paths: tracks.map((t) => t.path) },
      });
      setPlaylistFiles((prev) => prev.map((p) => (p.name === pl.name ? pl : p)));
      setStatus(`Removed from ${pl.name}`);
    } catch (err) {
      setStatus(`Remove failed: ${String(err)}`);
    }
  }

  async function createPlaylist(name: string) {
    const lib = folderRef.current;
    const clean = name.trim();
    if (!lib || !clean) return;
    try {
      const pl = await invoke<PlaylistFile>("playlist_create", { args: { libraryDir: lib, name: clean } });
      setPlaylistFiles((prev) =>
        prev.some((p) => p.name === pl.name)
          ? prev
          : [...prev, pl].sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()))
      );
      setNewPlaylistMode(false);
      setNewPlaylistName("");
      openPlaylistView(pl.name);
    } catch (err) {
      setStatus(`Create failed: ${String(err)}`);
    }
  }

  async function deletePlaylist(name: string) {
    const lib = folderRef.current;
    if (!lib || !name) return;
    try {
      await invoke("playlist_delete", { args: { libraryDir: lib, name } });
      setPlaylistFiles((prev) => prev.filter((p) => p.name !== name));
      if (plView === name) setPlView("");
      setStatus(`Playlist "${name}" moved to the Recycle Bin (tracks untouched)`);
    } catch (err) {
      setStatus(`Delete failed: ${String(err)}`);
    } finally {
      setConfirmDeletePlaylist("");
    }
  }

  function openPlaylistView(name: string) {
    setArtistView("");
    setPlaylist("(all)");
    setPlView(name);
  }

  const shownCount = filteredTracks.length;

  const currentTrack = useMemo(
    () => (currentPath ? allTracks.find((t) => t.path === currentPath) ?? null : null),
    [allTracks, currentPath]
  );

  // Selected tracks in list order (only those currently listed count).
  const selectedTracks = useMemo(
    () => (selectedPaths.size ? filteredTracks.filter((t) => selectedPaths.has(t.path)) : []),
    [filteredTracks, selectedPaths]
  );
  const selectedTrack = selectedTracks.length === 1 ? selectedTracks[0] : null;

  function onRowClick(e: ReactMouseEvent, t: Track) {
    const paths = filteredTracks.map((x) => x.path);
    setSelectedPaths((prev) => {
      const next = new Set(prev);
      if (e.shiftKey && anchorRef.current) {
        const a = paths.indexOf(anchorRef.current);
        const b = paths.indexOf(t.path);
        if (a >= 0 && b >= 0) {
          if (!e.ctrlKey && !e.metaKey) next.clear();
          for (let i = Math.min(a, b); i <= Math.max(a, b); i++) next.add(paths[i]);
          return next;
        }
      }
      if (e.ctrlKey || e.metaKey) {
        if (next.has(t.path)) next.delete(t.path);
        else next.add(t.path);
      } else if (next.size === 1 && next.has(t.path)) {
        next.clear();
      } else {
        next.clear();
        next.add(t.path);
      }
      anchorRef.current = t.path;
      return next;
    });
  }

  // Ctrl+A selects everything listed (unless typing in a field); Escape clears the selection.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
        e.preventDefault();
        setSelectedPaths(new Set(filteredTracks.map((t) => t.path)));
      } else if (e.key === "Escape") {
        setSelectedPaths(new Set());
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [filteredTracks]);

  const currentIndex = useMemo(() => {
    if (!currentPath) return -1;
    return filteredTracks.findIndex((t) => t.path === currentPath);
  }, [filteredTracks, currentPath]);

  function pickNextIndex(delta: number) {
    const n = filteredTracks.length;
    if (n === 0) return -1;
    if (shuffle) return Math.floor(Math.random() * n);
    const base = currentIndex >= 0 ? currentIndex : 0;
    return (base + delta + n) % n;
  }

  // Re-read the current Music folder (after renames/moves done outside the app).
  async function rescanLibrary() {
    const lib = folderRef.current;
    if (!lib) return;
    try {
      setStatus("Scanning…");
      const found = await invoke<Track[]>("scan_music_folder", { dir: lib });
      setAllTracks(found);
      setStatus(`Found ${found.length} tracks`);
      await loadPlaylists(lib);
    } catch (err) {
      setStatus(`Scan error: ${String(err)}`);
    }
  }

  // Mobile: type the folder path instead of picking it.
  async function importFolderPath(path: string) {
    const dir = path.trim();
    if (!dir) return;
    try {
      setFolder(dir);
      setStatus("Scanning…");
      const store = await storePromise;
      await store.set(KEY_LIBRARY_DIR, dir);
      await store.save();
      const found = await invoke<Track[]>("scan_music_folder", { dir });
      setAllTracks(found);
      setPlaylist("(all)");
      setPlView("");
      setArtistView("");
      setQuery("");
      setStatus(`Found ${found.length} tracks`);
      await loadPlaylists(dir);
    } catch (err) {
      setStatus(`Scan error: ${String(err)}`);
    }
  }

  async function importFolder() {
    try {
      const picked = await open({ directory: true, multiple: false });
      if (!picked || typeof picked !== "string") return;

      setFolder(picked);
      setStatus("Scanning…");

      // persist selection
      const store = await storePromise;
      await store.set(KEY_LIBRARY_DIR, picked);
      await store.save();

      const found = await invoke<Track[]>("scan_music_folder", { dir: picked });

      setAllTracks(found);
      setPlaylist("(all)");
      setPlView("");
      setArtistView("");
      setQuery("");
      setStatus(`Found ${found.length} tracks`);
      await loadPlaylists(picked);
    } catch (err) {
      setStatus(`Scan error: ${String(err)}`);
    }
  }

  async function startManualDownload() {
    const url = downloadUrl.trim();
    if (!url || dlBusy) return;

    // Never download "somewhere": without a Music root there is no playlist to land in.
    const lib = folderRef.current || "";
    if (!lib) {
      setDlLogs("[error] Pick your Music folder first (Import) — downloads land in a playlist folder under it.\n");
      return;
    }

    setDlBusy(true);
    setDlLogs("");

    try {
      await invoke("ytdlp_download_audio", {
        args: { url, libraryDir: lib, targetFolder: dlTarget },
      });
    } catch (err) {
      setDlBusy(false);
      setDlLogs((prev) => prev + `\n[error] ${String(err)}\n`);
    }
  }

  function loadAndPlay(t: Track) {
    const audio = audioRef.current;
    if (!audio) return;

    const src = convertFileSrc(t.path);
    audio.src = src;
    audio.load();

    setCurrentPath(t.path);
    setCurrentName(displayName(t.name));
    setCurrentPlaylist(t.playlist || "(root)");

    audio.onloadedmetadata = () => {
      setDuration(audio.duration || 0);
      setProgress(0);
      audio.play().then(() => setIsPlaying(true)).catch(() => setIsPlaying(false));
    };
  }

  // Move any track into another playlist folder. If it is the one playing, the player
  // is re-pointed at the new path without losing the position; otherwise playback is untouched.
  async function moveTrackTo(fromPath: string, target: string) {
    const lib = folderRef.current;
    if (!fromPath || !lib || !target) return;

    try {
      const moved = await invoke<Track>("move_track", {
        args: { path: fromPath, libraryDir: lib, targetFolder: target },
      });

      setAllTracks((prev) =>
        prev.map((t) => (t.path === fromPath ? { ...moved, artist: moved.artist || t.artist } : t))
      );
      setSelectedPaths((prev) => {
        if (!prev.has(fromPath)) return prev;
        const next = new Set(prev);
        next.delete(fromPath);
        next.add(moved.path);
        return next;
      });
      setStatus(`Moved "${displayName(moved.name)}" to ${moved.playlist}`);
      await loadPlaylists(lib); // playlist files were updated on the Rust side

      if (fromPath !== currentPath) return;

      setCurrentPath(moved.path);
      setCurrentPlaylist(moved.playlist);

      // Re-point the player at the new path, keeping the position.
      const audio = audioRef.current;
      if (audio) {
        const pos = audio.currentTime;
        const wasPlaying = !audio.paused;
        audio.src = convertFileSrc(moved.path);
        audio.load();
        audio.onloadedmetadata = () => {
          setDuration(audio.duration || 0);
          audio.currentTime = pos;
          setProgress(pos);
          if (wasPlaying) audio.play().then(() => setIsPlaying(true)).catch(() => setIsPlaying(false));
        };
      }
    } catch (err) {
      setStatus(`Move failed: ${String(err)}`);
    }
  }

  // Send a track to the Recycle Bin (after the confirmation box). Stops it if it was playing.
  async function deleteTracks(tracks: Track[]) {
    const lib = folderRef.current;
    if (!lib || tracks.length === 0) return;
    const done: string[] = [];
    const failed: string[] = [];
    for (const t of tracks) {
      try {
        await invoke("delete_track", { args: { path: t.path, libraryDir: lib } });
        done.push(t.path);
      } catch (err) {
        failed.push(`${displayName(t.name)}: ${String(err)}`);
      }
    }
    if (done.includes(currentPath)) {
      const audio = audioRef.current;
      if (audio) {
        audio.pause();
        audio.removeAttribute("src");
        audio.load();
      }
      setIsPlaying(false);
      setCurrentPath("");
      setCurrentName("");
      setCurrentPlaylist("");
      setProgress(0);
      setDuration(0);
    }
    const gone = new Set(done);
    setSelectedPaths((prev) => new Set([...prev].filter((p) => !gone.has(p))));
    setAllTracks((prev) => prev.filter((x) => !gone.has(x.path)));
    setStatus(
      done.length === 1 && failed.length === 0
        ? `Moved "${displayName(tracks[0].name)}" to the Recycle Bin`
        : `Recycle Bin: ${done.length} moved${failed.length ? `, ${failed.length} failed — ${failed[0]}` : ""}`
    );
    await loadPlaylists(lib);
    setConfirmDelete(null);
  }

  // Move several files (Folders view). Each move keeps playlists consistent on the Rust side.
  async function moveTracksTo(tracks: Track[], target: string) {
    for (const t of tracks) {
      if ((t.playlist || "(root)") !== target) await moveTrackTo(t.path, target);
    }
  }

  // Escape closes whichever box is open.
  useEffect(() => {
    if (!confirmDelete && !editTags && !confirmFix && !confirmDeletePlaylist) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setConfirmDelete(null);
        setEditTags(null);
        setConfirmFix(false);
        setConfirmDeletePlaylist("");
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [confirmDelete, editTags, confirmFix, confirmDeletePlaylist]);

  // "Song - Artist" from a filename — the library convention.
  function titleArtistFromName(name: string): { title: string; artist: string } {
    const stem = displayName(name);
    const i = stem.lastIndexOf(" - ");
    if (i > 0 && i < stem.length - 3) {
      return { title: stem.slice(0, i).trim(), artist: stem.slice(i + 3).trim() };
    }
    return { title: stem.trim(), artist: "" };
  }

  function openTagEditor(t: Track) {
    setEditTags({ track: t, title: t.title, artist: t.artist });
  }

  async function saveTags() {
    const lib = folderRef.current;
    if (!editTags || !lib) return;
    try {
      const updated = await invoke<Track>("write_tags", {
        args: { path: editTags.track.path, libraryDir: lib, title: editTags.title, artist: editTags.artist },
      });
      setAllTracks((prev) => prev.map((t) => (t.path === updated.path ? updated : t)));
      setStatus(`Tags saved: ${displayName(updated.name)}`);
      setEditTags(null);
    } catch (err) {
      setStatus(`Tag write failed: ${String(err)}`);
    }
  }

  // Batch: rewrite title/artist tags of every track currently listed, from their filenames.
  async function fixTagsFromFilenames() {
    const lib = folderRef.current;
    if (!lib || filteredTracks.length === 0) return;
    setFixBusy(true);
    setStatus(`Writing tags for ${filteredTracks.length} files…`);
    try {
      const report = await invoke<{ updated: Track[]; skipped: number; failed: string[] }>("fix_tags_from_filenames", {
        args: { paths: filteredTracks.map((t) => t.path), libraryDir: lib },
      });
      const byPath = new Map(report.updated.map((t) => [t.path, t] as const));
      setAllTracks((prev) => prev.map((t) => byPath.get(t.path) ?? t));
      setStatus(`Tags: ${report.updated.length} updated, ${report.skipped} kept`);
      setFixReport({ updated: report.updated.length, skipped: report.skipped, failed: report.failed });
    } catch (err) {
      setStatus(`Tag write failed: ${String(err)}`);
    } finally {
      setFixBusy(false);
      setConfirmFix(false);
    }
  }

  function togglePlay() {
    const audio = audioRef.current;
    if (!audio) return;

    if (isPlaying) {
      audio.pause();
      setIsPlaying(false);
    } else {
      audio.play().then(() => setIsPlaying(true)).catch(() => setIsPlaying(false));
    }
  }

  function playPrev() {
    const idx = pickNextIndex(-1);
    if (idx >= 0) loadAndPlay(filteredTracks[idx]);
  }

  function playNext() {
    const idx = pickNextIndex(1);
    if (idx >= 0) loadAndPlay(filteredTracks[idx]);
  }

  // Auto-load last imported library on startup
  useEffect(() => {
    (async () => {
      try {
        const store = await storePromise;

        let os = "";
        try {
          os = await invoke<string>("platform");
          setPlatform(os);
        } catch {
          /* older backend */
        }

        const savedTarget = await store.get<string>(KEY_DOWNLOAD_TARGET);
        if (savedTarget && typeof savedTarget === "string") setDlTarget(savedTarget);

        const savedDlPl = await store.get<string[]>(KEY_DOWNLOAD_PLAYLISTS);
        if (Array.isArray(savedDlPl)) setDlPlaylists(savedDlPl.filter((x) => typeof x === "string"));

        const savedSort = await store.get<string>(KEY_SORT);
        if (savedSort && (SORT_MODES as readonly string[]).includes(savedSort)) setSortMode(savedSort as SortMode);

        const savedVolume = await store.get<number>(KEY_VOLUME);
        if (typeof savedVolume === "number" && savedVolume >= 0 && savedVolume <= 1) setVolume(savedVolume);
        settingsLoadedRef.current = true;

        let saved = await store.get<string>(KEY_LIBRARY_DIR);
        // Android: no folder picker (it returns content URIs, not paths) — start from the standard Music folder.
        if ((!saved || typeof saved !== "string") && os === "android") {
          saved = "/storage/emulated/0/Music";
          await store.set(KEY_LIBRARY_DIR, saved);
          await store.save();
        }
        if (!saved || typeof saved !== "string") return;

        setFolder(saved);
        setStatus("Scanning…");

        const found = await invoke<Track[]>("scan_music_folder", { dir: saved });

        setAllTracks(found);
        setPlaylist("(all)");
        setQuery("");
        setStatus(`Found ${found.length} tracks`);
        await loadPlaylists(saved);
      } catch (err) {
        setStatus(`Auto-load failed: ${String(err)}`);
      }
    })();
  }, []);

  // Keep progress updated
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const onTime = () => setProgress(audio.currentTime || 0);
    const onEnded = () => {
      setIsPlaying(false);
      playNext();
    };

    audio.addEventListener("timeupdate", onTime);
    audio.addEventListener("ended", onEnded);

    return () => {
      audio.removeEventListener("timeupdate", onTime);
      audio.removeEventListener("ended", onEnded);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filteredTracks, currentIndex, shuffle]);

  // yt-dlp listeners (robust against React StrictMode + HMR)
  useEffect(() => {
    let active = true;

    let unlistenOut: (() => void) | undefined;
    let unlistenErr: (() => void) | undefined;
    let unlistenDone: (() => void) | undefined;
    let unlistenFile: (() => void) | undefined;

    const setup = async () => {
      const uOut = await listen<string>("ytdlp:stdout", (e) => {
        // add newline if missing, to keep logs readable
        const chunk = e.payload.endsWith("\n") ? e.payload : e.payload + "\n";
        setDlLogs((prev) => prev + chunk);
      });

      const uErr = await listen<string>("ytdlp:stderr", (e) => {
        const chunk = e.payload.endsWith("\n") ? e.payload : e.payload + "\n";
        setDlLogs((prev) => prev + chunk);
      });

      const uFile = await listen<string>("ytdlp:file", (e) => {
        lastDownloadRef.current = e.payload;
      });

      const uDone = await listen<number>("ytdlp:done", async (e) => {
        setDlBusy(false);
        setDlLogs((prev) => prev + `\n[done] exit code: ${e.payload}\n`);

        // Refresh library so the new file appears, then file it into the chosen playlists
        const lib = folderRef.current;
        if (lib) {
          try {
            setStatus("Refreshing…");
            const found = await invoke<Track[]>("scan_music_folder", { dir: lib });
            setAllTracks(found);
            setStatus(`Found ${found.length} tracks`);
            await loadPlaylists(lib);

            const filePath = lastDownloadRef.current;
            lastDownloadRef.current = "";
            const targets = dlPlaylistsRef.current;
            if (e.payload === 0 && filePath && targets.length) {
              const t = found.find((x) => x.path === filePath);
              if (t) {
                for (const name of targets) {
                  await invoke<PlaylistFile>("playlist_add", { args: { libraryDir: lib, name, paths: [t.path] } });
                }
                await loadPlaylists(lib);
                setDlLogs((prev) => prev + `[music-hood] added to: ${targets.join(", ")}\n`);
                setStatus(`Downloaded and added to ${targets.length} playlist${targets.length === 1 ? "" : "s"}`);
              }
            }
          } catch (err) {
            setStatus(`Refresh error: ${String(err)}`);
          }
        }
      });

      // If StrictMode unmounted us before the awaits finished, immediately unlisten.
      if (!active) {
        uOut();
        uErr();
        uFile();
        uDone();
        return;
      }

      unlistenOut = uOut;
      unlistenErr = uErr;
      unlistenFile = uFile;
      unlistenDone = uDone;
    };

    setup();

    return () => {
      active = false;
      unlistenOut?.();
      unlistenErr?.();
      unlistenFile?.();
      unlistenDone?.();
    };
  }, []);


  return (
    <div className="app">
      <style>{`
        :root{
          --bg0:${COLORS.bg0};
          --bg1:${COLORS.bg1};
          --accent:${COLORS.accent};
          --accent2:${COLORS.accent2};
          --text:${COLORS.text};
          --textDim:${COLORS.textDim};
          --panel:${COLORS.panel};
          --border:${COLORS.border};
        }
        *{ box-sizing:border-box; }
        body,html,#root{ height:100%; margin:0; background:var(--bg0); color:var(--text); font-family:system-ui,-apple-system,Segoe UI,Roboto; }
        .app{
          height:100%;
          display:flex;
          flex-direction:column;
          background: radial-gradient(1200px 600px at 20% 0%, rgba(0,255,191,0.10), transparent 60%),
                      radial-gradient(900px 600px at 80% 10%, rgba(140,25,255,0.10), transparent 60%),
                      linear-gradient(180deg, rgba(255,255,255,0.02), transparent 40%),
                      var(--bg0);
        }
        .topbar{
          display:flex;
          align-items:center;
          justify-content:space-between;
          padding:16px;
        }
        .brand{
          display:flex;
          align-items:center;
          gap:12px;
          font-weight:800;
          letter-spacing:0.2px;
          font-size:22px;
        }
        .btn{
          border:1px solid var(--border);
          background: rgba(255,255,255,0.06);
          color: var(--text);
          padding: 8px 12px;
          border-radius: 12px;
          cursor:pointer;
        }
        .btn:disabled{ opacity:0.45; cursor:not-allowed; }
        .status{
          padding: 8px 12px;
          border:1px solid var(--border);
          border-radius: 14px;
          background: rgba(0,0,0,0.25);
          color: var(--textDim);
          font-size: 13px;
        }

        .downloadBar{
          display:flex;
          align-items:center;
          gap: 10px;
          padding: 0 16px 12px 16px;
        }
        .downloadInput{
          flex: 1;
          border: 1px solid var(--border);
          background: rgba(0,0,0,0.25);
          color: var(--text);
          padding: 10px 12px;
          border-radius: 14px;
          outline:none;
        }
        .downloadInput:focus{
          border-color: rgba(0,255,191,0.45);
          box-shadow: 0 0 0 3px rgba(0,255,191,0.08);
        }
        .targetLabel{ color: var(--textDim); font-size: 13px; white-space: nowrap; }
        .targetNew{ width: 220px; flex: none; }

        /* In-app dropdown */
        .dd{ position: relative; }
        .ddBtn{
          display:flex; align-items:center; gap: 8px;
          border: 1px solid var(--border);
          background: rgba(0,0,0,0.25);
          color: var(--text);
          padding: 10px 12px;
          border-radius: 14px;
          cursor: pointer;
          max-width: 260px;
          font: inherit;
        }
        .ddBtn.open, .ddBtn:focus{
          border-color: rgba(0,255,191,0.45);
          box-shadow: 0 0 0 3px rgba(0,255,191,0.08);
          outline: none;
        }
        .ddLabel{ overflow:hidden; text-overflow: ellipsis; white-space: nowrap; }
        .ddChevron{ color: var(--textDim); font-size: 12px; }
        .ddMenu{
          position: absolute; z-index: 50;
          top: calc(100% + 6px); left: 0;
          min-width: 100%; width: max-content; max-width: 340px;
          max-height: 340px; overflow: auto;
          padding: 6px;
          border-radius: 14px;
          border: 1px solid var(--border);
          background: #1a1a1a;
          box-shadow: 0 14px 40px rgba(0,0,0,0.65);
        }
        .ddMenu.up{ top: auto; bottom: calc(100% + 6px); }
        .player{ position: relative; z-index: 5; }  /* popups from the bar float above the panels */
        .ddItem{
          padding: 8px 10px;
          border-radius: 10px;
          cursor: pointer;
          color: var(--text);
          white-space: nowrap;
          border: 1px solid transparent;
        }
        .ddItem:hover{ background: rgba(255,255,255,0.06); }
        .ddItem.active{ border-color: rgba(0,255,191,0.35); background: rgba(0,255,191,0.10); }
        .ddExtra{ color: var(--accent); margin-top: 4px; }
        .ddSmall{ margin-top: 6px; }
        .ddSmall .ddBtn{ padding: 5px 10px; font-size: 12px; border-radius: 10px; color: var(--textDim); }

        .shuffleBtn{
          display:grid; place-items:center;
          width: 38px; height: 38px;
          border-radius: 12px;
          border: 1px solid var(--border);
          background: rgba(255,255,255,0.04);
          color: rgba(255,255,255,0.45);
          cursor: pointer;
          transition: color .15s, border-color .15s, background .15s, transform .1s;
        }
        .shuffleBtn:hover{ color: var(--text); background: rgba(255,255,255,0.08); }
        .shuffleBtn:active{ transform: scale(0.94); }
        .shuffleBtn.on{
          color: var(--accent);
          border-color: rgba(0,255,191,0.45);
          background: rgba(0,255,191,0.10);
          box-shadow: 0 0 0 3px rgba(0,255,191,0.08);
        }
        .iconBtn{
          display:grid; place-items:center;
          width: 40px; height: 40px; flex:none;
          border-radius: 12px;
          border: 1px solid var(--border);
          background: rgba(255,255,255,0.04);
          color: var(--textDim);
          cursor: pointer;
        }
        .iconBtn:hover{ color: var(--text); background: rgba(255,255,255,0.08); }
        .iconBtn.danger:hover{ color: #ff5c7a; border-color: rgba(255,92,122,0.45); background: rgba(255,92,122,0.10); }
        .iconBtn.small{ width: 30px; height: 30px; border-radius: 9px; }
        .sortDd .ddBtn{ color: var(--textDim); font-size: 13px; }
        .ddBtn.hasValues{ color: var(--accent); border-color: rgba(0,255,191,0.35); }
        .ddCheck{ display:flex; align-items:center; gap: 8px; }
        .ddBox{
          width: 16px; height: 16px; flex:none;
          border: 1px solid var(--border); border-radius: 5px;
          display:grid; place-items:center; font-size: 11px; color: var(--accent);
        }
        .ddCheck.active .ddBox{ border-color: rgba(0,255,191,0.6); background: rgba(0,255,191,0.12); }
        .selCount{ color: var(--accent); font-size: 13px; white-space: nowrap; display:flex; align-items:center; gap: 6px; }
        .linkBtn{ background: none; border: none; color: var(--textDim); font: inherit; font-size: 12px; cursor: pointer; text-decoration: underline; padding: 0; }
        .linkBtn:hover{ color: var(--text); }
        .headerRow{ display:flex; align-items:center; justify-content:space-between; gap: 10px; }
        .migrateBox{
          margin: 4px 4px 12px;
          padding: 12px;
          border: 1px dashed rgba(0,255,191,0.35);
          border-radius: 14px;
          background: rgba(0,255,191,0.05);
        }
        .migrateBox code{ color: var(--accent); font-size: 12px; }

        /* Confirmation box */
        .modalBackdrop{
          position: fixed; inset: 0; z-index: 100;
          background: rgba(0,0,0,0.55);
          display:grid; place-items:center;
        }
        .modal{
          width: min(440px, 90vw);
          border: 1px solid var(--border);
          border-radius: 18px;
          background: #181818;
          box-shadow: 0 24px 60px rgba(0,0,0,0.7);
          padding: 18px;
        }
        .modalTitle{ font-weight: 800; font-size: 16px; margin-bottom: 10px; }
        .modalTrack{ font-weight: 700; word-break: break-word; }
        .modalHint{ color: var(--textDim); font-size: 12px; margin-top: 6px; }
        .modalActions{ display:flex; justify-content:flex-end; gap: 10px; margin-top: 18px; }
        .primaryBtn{ border-color: rgba(0,255,191,0.45); background: rgba(0,255,191,0.12); color: var(--accent); }
        .primaryBtn:hover{ background: rgba(0,255,191,0.20); }
        .fieldLabel{ display:block; color: var(--textDim); font-size: 12px; margin: 10px 0 4px; }
        .fieldInput{ width: 100%; }
        .dangerBtn{ border-color: rgba(255,92,122,0.45); background: rgba(255,92,122,0.12); color: #ff8aa0; }
        .dangerBtn:hover{ background: rgba(255,92,122,0.22); }
        .volume{ display:flex; align-items:center; gap: 6px; }
        .volRange{ width: 90px; }
        .downloadLogs{
          margin: 0 16px 12px 16px;
          border: 1px solid var(--border);
          background: rgba(0,0,0,0.25);
          border-radius: 14px;
          max-height: 180px;
          overflow:auto;
        }
        .downloadLogs pre{
          margin: 0;
          padding: 10px 12px;
          font-size: 12px;
          color: var(--textDim);
          white-space: pre-wrap;
          word-break: break-word;
        }

        .pathLine{
          padding: 0 16px 12px 16px;
          color: var(--textDim);
          font-size: 13px;
        }
        .content{
          flex:1;
          display:grid;
          grid-template-columns: 320px 1fr;
          gap:16px;
          padding: 0 16px 16px 16px;
          min-height: 0;
        }
        .panel{
          border:1px solid var(--border);
          background: rgba(0,0,0,0.22);
          border-radius: 18px;
          overflow:hidden;
          min-height:0;
          display:flex;
          flex-direction:column;
        }
        .panelHeader{
          flex:none;
          padding:12px 14px;
          font-weight:700;
          border-bottom:1px solid var(--border);
          background: rgba(255,255,255,0.03);
        }
        /* The list takes whatever height is left AFTER the header/search row —
           sizing it to the whole panel hid the last item under the panel edge. */
        .list{
          flex:1;
          min-height:0;
          padding:10px;
          overflow:auto;
        }
        .pill{
          padding:10px 12px;
          border-radius: 14px;
          cursor:pointer;
          border:1px solid transparent;
          color: var(--text);
          margin-bottom: 8px;
          background: rgba(255,255,255,0.03);
        }
        .pill.active{
          border-color: rgba(0,255,191,0.35);
          background: rgba(0,255,191,0.10);
        }
        .panelHeader.tabs{ display:flex; gap: 6px; padding: 8px 10px; }
        .tab{
          border: 1px solid transparent;
          background: transparent;
          color: var(--textDim);
          font: inherit; font-weight: 700;
          padding: 5px 10px;
          border-radius: 10px;
          cursor: pointer;
        }
        .tab.active{ color: var(--text); background: rgba(255,255,255,0.06); border-color: var(--border); }
        .tabCount{ color: var(--textDim); font-weight: 500; font-size: 12px; margin-left: 4px; }
        .artistPill{ display:flex; justify-content:space-between; align-items:center; gap: 10px; }
        .artistName{ overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
        .artistCount{ color: var(--textDim); font-size: 12px; flex:none; }
        .accentText{ color: var(--accent); }
        .dimText{ color: var(--textDim); font-weight: 500; }
        .searchRow{
          flex:none;
          padding: 10px;
          border-bottom:1px solid var(--border);
          display:flex;
          gap:10px;
          align-items:center;
          background: rgba(0,0,0,0.10);
        }
        .search{
          flex:1;
          border:1px solid var(--border);
          background: rgba(0,0,0,0.18);
          color: var(--text);
          padding: 10px 12px;
          border-radius: 14px;
          outline:none;
        }
        .trackRow{
          padding:10px 12px;
          border-radius: 14px;
          cursor:pointer;
          border:1px solid transparent;
          background: rgba(255,255,255,0.02);
          margin-bottom:8px;
        }
        .trackRow{ user-select: none; }
        .trackRow.selected{
          border-color: rgba(255,255,255,0.18);
          background: rgba(255,255,255,0.07);
        }
        .trackRow.active{
          border-color: rgba(140,25,255,0.35);
          background: rgba(140,25,255,0.10);
        }
        .trackRow.active.selected{
          border-color: rgba(140,25,255,0.6);
        }

        .player{
          border-top:1px solid var(--border);
          padding: 12px 16px;
          background: rgba(0,0,0,0.25);
          display:flex;
          align-items:center;
          justify-content:space-between;
          gap: 16px;
          flex-wrap: wrap;
        }
        /* Now-playing never grows with the title: fixed share of the bar, one line, ellipsis. */
        .nowPlaying{
          display:flex;
          flex-direction:column;
          gap: 2px;
          flex: 0 1 280px;
          min-width: 180px;
          max-width: 34%;
          /* no overflow:hidden here — it would clip the "Move to…" popup; the children clip themselves */
        }
        .npTitle{ font-weight:800; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; }
        .npSub{ color: var(--textDim); font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .controls{
          display:flex;
          align-items:center;
          gap: 10px;
          flex: none;
        }
        .circle{
          width: 44px;
          height: 44px;
          border-radius: 999px;
          border:1px solid var(--border);
          background: rgba(255,255,255,0.06);
          color: var(--text);
          display:grid;
          place-items:center;
          cursor:pointer;
        }
        /* The timeline always keeps a usable width; it never gets crushed by its neighbours. */
        .timeline{
          flex: 1 1 260px;
          min-width: 260px;
          display:flex;
          align-items:center;
          gap: 10px;
        }
        .time{ color: var(--textDim); font-size: 12px; min-width: 44px; text-align:center; flex:none; }
        .range{ width: 100%; min-width: 0; }
        .rightInfo{
          display:flex;
          align-items:center;
          gap: 10px;
          color: var(--textDim);
          font-size: 12px;
          flex: none;
          white-space: nowrap;
          justify-content:flex-end;
        }
        /* Narrow window: the timeline takes a full second row under the other controls. */
        @media (max-width: 980px){
          .timeline{ order: 10; flex: 1 1 100%; min-width: 0; }
          .nowPlaying{ max-width: 46%; }
        }
        /* Scrollbars */
        * {
          scrollbar-width: thin;
          scrollbar-color: rgba(255,255,255,0.18) rgba(0,0,0,0.25);
        }

        *::-webkit-scrollbar { width: 10px; height: 10px; }
        *::-webkit-scrollbar-track {
          background: rgba(0,0,0,0.25);
          border-radius: 999px;
        }
        *::-webkit-scrollbar-thumb {
          background: rgba(255,255,255,0.16);
          border-radius: 999px;
          border: 2px solid rgba(0,0,0,0.25);
        }
        *::-webkit-scrollbar-thumb:hover {
          background: rgba(255,255,255,0.24);
        }
      `}</style>

      <div className="topbar">
        <div className="brand">
          <div>music-hood</div>
          {isMobile ? (
            <>
              <input
                className="downloadInput targetNew"
                placeholder="/storage/emulated/0/Music"
                value={pathInput}
                onChange={(e) => setPathInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") importFolderPath(pathInput); }}
              />
              <button className="btn" onClick={() => importFolderPath(pathInput)} disabled={!pathInput.trim()}>Use</button>
            </>
          ) : (
            <button className="btn" onClick={importFolder}>Import</button>
          )}
          {folder ? (
            <button className="btn" onClick={rescanLibrary} title="Re-read the Music folder">
              Rescan
            </button>
          ) : null}
        </div>
        <div className="status">Status: {status}</div>
      </div>

      <div className="pathLine">
        {folder ? `Folder: ${folder}` : "Pick a folder to begin."}
      </div>

      <div className="downloadBar">
        <input
          className="downloadInput"
          placeholder="Paste a YouTube URL and hit Download…"
          value={downloadUrl}
          onChange={(e) => setDownloadUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") startManualDownload();
          }}
        />
        <span className="targetLabel">into</span>
        {newFolderMode ? (
          <>
            <input
              className="downloadInput targetNew"
              placeholder="New playlist folder…"
              autoFocus
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") chooseTarget(newFolderName);
                if (e.key === "Escape") setNewFolderMode(false);
              }}
            />
            <button className="btn" onClick={() => chooseTarget(newFolderName)} disabled={!newFolderName.trim()}>
              OK
            </button>
          </>
        ) : (
          <Dropdown
            value={dlTarget}
            options={targetOptions}
            title="Playlist folder the download lands in"
            extra={{ label: "+ New folder…", value: NEW_FOLDER_SENTINEL }}
            onSelect={(v) => {
              if (v === NEW_FOLDER_SENTINEL) setNewFolderMode(true);
              else chooseTarget(v);
            }}
          />
        )}
        <span className="targetLabel">+ playlists</span>
        <MultiDropdown
          values={dlPlaylists}
          options={playlistFiles.map((p) => p.name)}
          onChange={chooseDlPlaylists}
          placeholder="none"
          title="Playlists the downloaded track is added to (remembered)"
        />
        <button className="btn" onClick={startManualDownload} disabled={dlBusy || !downloadUrl.trim()}>
          {dlBusy ? "Downloading…" : "Download"}
        </button>
        <button className="btn" onClick={() => setDlLogs("")} disabled={!dlLogs}>
          Clear logs
        </button>
      </div>

      {dlLogs ? (
        <div className="downloadLogs">
          <pre>{dlLogs}</pre>
        </div>
      ) : null}

      <div className="content">
        <div className="panel">
          <div className="panelHeader tabs">
            <button className={`tab ${sideTab === "playlists" ? "active" : ""}`} onClick={() => setSideTab("playlists")}>
              Playlists <span className="tabCount">{playlistFiles.length}</span>
            </button>
            <button className={`tab ${sideTab === "artists" ? "active" : ""}`} onClick={() => setSideTab("artists")}>
              Artists <span className="tabCount">{artists.length}</span>
            </button>
            <button className={`tab ${sideTab === "folders" ? "active" : ""}`} onClick={() => setSideTab("folders")} title="Where the files are stored">
              Folders
            </button>
          </div>

          {sideTab === "playlists" ? (
            <>
              <div className="searchRow">
                {newPlaylistMode ? (
                  <>
                    <input
                      className="search"
                      placeholder="New playlist name…"
                      autoFocus
                      value={newPlaylistName}
                      onChange={(e) => setNewPlaylistName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") createPlaylist(newPlaylistName);
                        if (e.key === "Escape") setNewPlaylistMode(false);
                      }}
                    />
                    <button className="btn" onClick={() => createPlaylist(newPlaylistName)} disabled={!newPlaylistName.trim()}>OK</button>
                  </>
                ) : (
                  <>
                    <input
                      className="search"
                      placeholder="Filter playlists…"
                      value={plQuery}
                      onChange={(e) => setPlQuery(e.target.value)}
                    />
                    <button className="btn" title="New playlist" onClick={() => setNewPlaylistMode(true)} disabled={!folder}>+</button>
                  </>
                )}
              </div>
              <div className="list">
                {playlistFiles.length === 0 && folder ? (
                  <div className="migrateBox">
                    <div className="modalTrack">No playlist files yet</div>
                    <div className="modalHint" style={{ margin: "6px 0 10px" }}>
                      Playlists now live as small <code>.m3u8</code> files in <code>{folder}\_Playlists</code>, so a song can be in several at once.
                      Create one per existing folder to start from what you have — nothing moves on disk.
                    </div>
                    <button className="btn primaryBtn" onClick={createPlaylistsFromFolders}>Create playlists from folders</button>
                  </div>
                ) : null}
                <div
                  className={`pill ${!plView && !artistView && playlist === "(all)" ? "active" : ""}`}
                  onClick={() => { setPlView(""); setArtistView(""); setPlaylist("(all)"); }}
                >
                  (all)
                </div>
                {shownPlaylistFiles.map((p) => (
                  <div
                    key={p.name}
                    className={`pill artistPill ${p.name === plView ? "active" : ""}`}
                    onClick={() => (plView === p.name ? setPlView("") : openPlaylistView(p.name))}
                  >
                    <span className="artistName">{p.name}</span>
                    <span className="artistCount">{p.entries.length}</span>
                  </div>
                ))}
              </div>
            </>
          ) : sideTab === "folders" ? (
            <>
              <div className="searchRow">
                <input
                  className="search"
                  placeholder="Filter folders…"
                  value={playlistQuery}
                  onChange={(e) => setPlaylistQuery(e.target.value)}
                />
              </div>
              <div className="list">
                {shownPlaylists.map((p) => (
                  <div
                    key={p}
                    className={`pill ${!artistView && !plView && p === playlist ? "active" : ""}`}
                    onClick={() => {
                      setArtistView("");
                      setPlView("");
                      setPlaylist(p);
                    }}
                  >
                    {p}
                  </div>
                ))}
              </div>
            </>
          ) : (
            <>
              <div className="searchRow">
                <input
                  className="search"
                  placeholder="Filter artists…"
                  value={artistQuery}
                  onChange={(e) => setArtistQuery(e.target.value)}
                />
              </div>
              <div className="list">
                {shownArtists.map((a) => (
                  <div
                    key={a.name}
                    className={`pill artistPill ${a.name === artistView ? "active" : ""}`}
                    onClick={() => { setPlView(""); setArtistView((cur) => (cur === a.name ? "" : a.name)); }}
                    title={`All ${a.count} track${a.count === 1 ? "" : "s"} by ${a.name}, across every folder`}
                  >
                    <span className="artistName">{a.name}</span>
                    <span className="artistCount">{a.count}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>

        <div className="panel">
          <div className="panelHeader headerRow">
            <span>
              {plView ? (
                <>
                  <span className="accentText">{plView}</span>
                  <span className="dimText"> · playlist · {currentPlaylistFile?.entries.length ?? 0}</span>
                </>
              ) : artistView ? (
                <>
                  Tracks · <span className="accentText">{artistView}</span>
                  <span className="dimText"> · all folders</span>
                </>
              ) : playlist !== "(all)" ? (
                <>
                  <span className="accentText">{playlist}</span>
                  <span className="dimText"> · folder</span>
                </>
              ) : (
                "Tracks"
              )}
            </span>
            {plView ? (
              <button
                className="iconBtn danger small"
                title={`Delete the playlist "${plView}" (the songs stay)`}
                onClick={() => setConfirmDeletePlaylist(plView)}
              >
                <TrashIcon />
              </button>
            ) : null}
          </div>
          <div className="searchRow">
            <input
              className="search"
              placeholder="Search…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <Dropdown
              className="sortDd"
              value={sortMode}
              options={[...SORT_MODES]}
              title="Sort the track list"
              onSelect={(v) => chooseSort(v as SortMode)}
            />
            {selectedTracks.length > 1 ? (
              <span className="selCount" title="Esc clears the selection">
                {selectedTracks.length} selected
                <button className="linkBtn" onClick={() => setSelectedPaths(new Set())}>clear</button>
              </span>
            ) : null}
            {selectedTracks.length > 0 ? (
              <Dropdown
                value=""
                placeholder={selectedTracks.length > 1 ? `Add ${selectedTracks.length} to playlist…` : "Add to playlist…"}
                title="Add the selected track(s) to a playlist"
                options={playlistFiles
                  .filter((p) => !selectedTracks.every((t) => inPlaylist(p, t)))
                  .map((p) => p.name)}
                extra={{ label: "+ New playlist…", value: NEW_PLAYLIST_SENTINEL }}
                onSelect={(v) => {
                  if (v === NEW_PLAYLIST_SENTINEL) {
                    setSideTab("playlists");
                    setNewPlaylistMode(true);
                  } else addToPlaylist(v, selectedTracks);
                }}
              />
            ) : null}
            {selectedTracks.length > 0 && plView && currentPlaylistFile && selectedTracks.some((t) => inPlaylist(currentPlaylistFile, t)) ? (
              <button
                className="btn"
                title={`Remove the selected track(s) from ${plView} (the files stay)`}
                onClick={() => removeFromPlaylist(plView, selectedTracks)}
              >
                Remove{selectedTracks.length > 1 ? ` ${selectedTracks.length}` : ""} from playlist
              </button>
            ) : null}
            {selectedTracks.length > 0 && sideTab === "folders" ? (
              <Dropdown
                value=""
                placeholder={selectedTracks.length > 1 ? `Move ${selectedTracks.length} files to…` : "Move file to…"}
                title="Move the selected file(s) to another folder (playlists follow)"
                options={targetOptions.filter((name) => !selectedTracks.every((t) => (t.playlist || "(root)") === name))}
                onSelect={(target) => moveTracksTo(selectedTracks, target)}
              />
            ) : null}
            {selectedTrack ? (
              <button
                className="iconBtn"
                title={`Edit the tags of "${displayName(selectedTrack.name)}"`}
                onClick={() => openTagEditor(selectedTrack)}
              >
                <PencilIcon />
              </button>
            ) : null}
            {selectedTracks.length > 0 ? (
              <button
                className="iconBtn danger"
                title={selectedTracks.length > 1 ? `Delete ${selectedTracks.length} tracks (to the Recycle Bin)` : `Delete "${displayName(selectedTracks[0].name)}" (to the Recycle Bin)`}
                onClick={() => setConfirmDelete(selectedTracks)}
              >
                <TrashIcon />
              </button>
            ) : null}
            <button
              className="btn"
              disabled={fixBusy || filteredTracks.length === 0}
              title="Rewrite the title/artist tags of every track listed here from its 'Song - Artist' filename"
              onClick={() => setConfirmFix(true)}
            >
              {fixBusy ? "Writing…" : "Tags ← names"}
            </button>
            <button
              className={`shuffleBtn ${shuffle ? "on" : ""}`}
              onClick={() => setShuffle((s) => !s)}
              title={shuffle ? "Shuffle is on — click to play in order" : "Shuffle is off — click to shuffle"}
              aria-pressed={shuffle}
            >
              <ShuffleIcon on={shuffle} />
            </button>
          </div>
          <div className="list">
            {filteredTracks.map((t) => (
              <div
                key={t.path}
                className={`trackRow ${t.path === currentPath ? "active" : ""} ${selectedPaths.has(t.path) ? "selected" : ""}`}
                onClick={(e) => onRowClick(e, t)}
                onDoubleClick={() => loadAndPlay(t)}
                title="Click to select · Ctrl+click adds · Shift+click ranges · double-click plays"
              >
                {displayName(t.name)}
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="player">
        <div className="nowPlaying">
          <div className="npTitle">{currentName || "Nothing playing"}</div>
          <div className="npSub">
            {currentPlaylist
              ? `${currentTrack?.artist ? currentTrack.artist + " • " : ""}${currentPlaylist}`
              : `All playlists • ${allTracks.length} tracks`}
          </div>
          {currentPath ? (
            <Dropdown
              className="ddSmall"
              up
              value=""
              placeholder="Add to playlist…"
              title="Add the playing track to a playlist"
              options={playlistFiles.filter((p) => !(currentTrack && inPlaylist(p, currentTrack))).map((p) => p.name)}
              onSelect={(name) => { if (currentTrack) addToPlaylist(name, [currentTrack]); }}
            />
          ) : null}
        </div>

        <div className="controls">
          <button className="circle" onClick={playPrev} title="Previous">⏮</button>
          <button className="circle" onClick={togglePlay} title="Play/Pause">{isPlaying ? "⏸" : "▶"}</button>
          <button className="circle" onClick={playNext} title="Next">⏭</button>
        </div>

        <div className="timeline">
          <div className="time">{formatTime(progress)}</div>
          <input
            className="range"
            type="range"
            min={0}
            max={duration || 0}
            step={0.25}
            value={clamp(progress, 0, duration || 0)}
            onChange={(e) => {
              const audio = audioRef.current;
              if (!audio) return;
              const v = Number(e.target.value);
              audio.currentTime = clamp(v, 0, audio.duration || 0);
              setProgress(audio.currentTime);
            }}
          />
          <div className="time">{formatTime(duration)}</div>
        </div>

        <div className="rightInfo">
          <div className="volume" title={`Volume ${Math.round(volume * 100)}%`}>
            <span>{volume === 0 ? "🔇" : volume < 0.5 ? "🔉" : "🔊"}</span>
            <input
              className="range volRange"
              type="range"
              min={0}
              max={1}
              step={0.02}
              value={volume}
              onChange={(e) => setVolume(Number(e.target.value))}
            />
          </div>
          <div style={{ opacity: 0.35 }}>•</div>
          <button
            className={`shuffleBtn ${shuffle ? "on" : ""}`}
            onClick={() => setShuffle((s) => !s)}
            title={shuffle ? "Shuffle is on — click to play in order" : "Shuffle is off — click to shuffle"}
            aria-pressed={shuffle}
          >
            <ShuffleIcon on={shuffle} />
          </button>
          <div style={{ opacity: 0.35 }}>•</div>
          <div>{currentIndex >= 0 ? `${currentIndex + 1}/${shownCount}` : `0/${shownCount}`}</div>
        </div>

        <audio ref={audioRef} preload="metadata" />
      </div>

      {editTags ? (
        <div className="modalBackdrop" onMouseDown={() => setEditTags(null)}>
          <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
            <div className="modalTitle">Edit tags</div>
            <div className="modalHint" style={{ marginBottom: 12 }}>{editTags.track.name}</div>
            <label className="fieldLabel">Title</label>
            <input
              className="downloadInput fieldInput"
              value={editTags.title}
              autoFocus
              onChange={(e) => setEditTags({ ...editTags, title: e.target.value })}
              onKeyDown={(e) => { if (e.key === "Enter") saveTags(); }}
            />
            <label className="fieldLabel">Artist</label>
            <input
              className="downloadInput fieldInput"
              value={editTags.artist}
              onChange={(e) => setEditTags({ ...editTags, artist: e.target.value })}
              onKeyDown={(e) => { if (e.key === "Enter") saveTags(); }}
            />
            <div className="modalActions">
              <button
                className="btn"
                title="Fill both fields from the filename ('Song - Artist')"
                onClick={() => setEditTags({ ...editTags, ...titleArtistFromName(editTags.track.name) })}
              >
                From filename
              </button>
              <span style={{ flex: 1 }} />
              <button className="btn" onClick={() => setEditTags(null)}>Cancel</button>
              <button className="btn primaryBtn" onClick={saveTags}>Save</button>
            </div>
          </div>
        </div>
      ) : null}

      {confirmFix ? (
        <div className="modalBackdrop" onMouseDown={() => setConfirmFix(false)}>
          <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
            <div className="modalTitle">Write tags from filenames?</div>
            <div className="modalBody">
              <div className="modalTrack">{filteredTracks.length} track{filteredTracks.length === 1 ? "" : "s"} currently listed</div>
              <div className="modalHint">
                Conservative: a file's title/artist tag is replaced from its "Song - Artist" name only when the tag is <b>empty</b> or looks like raw YouTube output
                ("(Official Video)", "[Lyric Video]", "| Channel", a video id…). Curated tags — even ones that differ from a shortened filename — are kept.
                This edits the files themselves; the phone and other players will show the result.
              </div>
            </div>
            <div className="modalActions">
              <button className="btn" onClick={() => setConfirmFix(false)} autoFocus>Cancel</button>
              <button className="btn primaryBtn" onClick={fixTagsFromFilenames} disabled={fixBusy}>Write tags</button>
            </div>
          </div>
        </div>
      ) : null}

      {fixReport ? (
        <div className="modalBackdrop" onMouseDown={() => setFixReport(null)}>
          <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
            <div className="modalTitle">Tags written</div>
            <div className="modalBody">
              <div className="modalTrack">
                {fixReport.updated} updated · {fixReport.skipped} kept as they were
                {fixReport.failed.length ? ` · ${fixReport.failed.length} failed` : ""}
              </div>
              {fixReport.failed.length ? (
                <div className="modalHint" style={{ whiteSpace: "pre-wrap" }}>{fixReport.failed.slice(0, 8).join("\n")}</div>
              ) : null}
            </div>
            <div className="modalActions">
              <button className="btn primaryBtn" onClick={() => setFixReport(null)} autoFocus>OK</button>
            </div>
          </div>
        </div>
      ) : null}

      {confirmDeletePlaylist ? (
        <div className="modalBackdrop" onMouseDown={() => setConfirmDeletePlaylist("")}>
          <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
            <div className="modalTitle">Delete this playlist?</div>
            <div className="modalBody">
              <div className="modalTrack">{confirmDeletePlaylist}</div>
              <div className="modalHint">Only the playlist file goes to the Recycle Bin. The songs stay exactly where they are.</div>
            </div>
            <div className="modalActions">
              <button className="btn" onClick={() => setConfirmDeletePlaylist("")} autoFocus>Cancel</button>
              <button className="btn dangerBtn" onClick={() => deletePlaylist(confirmDeletePlaylist)}>Delete playlist</button>
            </div>
          </div>
        </div>
      ) : null}

      {confirmDelete ? (
        <div className="modalBackdrop" onMouseDown={() => setConfirmDelete(null)}>
          <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
            <div className="modalTitle">{confirmDelete.length > 1 ? `Delete ${confirmDelete.length} tracks?` : "Delete this track?"}</div>
            <div className="modalBody">
              <div className="modalTrack" style={{ maxHeight: 160, overflow: "auto" }}>
                {confirmDelete.slice(0, 12).map((t) => (
                  <div key={t.path}>{displayName(t.name)}</div>
                ))}
                {confirmDelete.length > 12 ? <div className="dimText">…and {confirmDelete.length - 12} more</div> : null}
              </div>
              <div className="modalHint">
                {isMobile
                  ? "On the phone there is no Recycle Bin: the files are deleted for real. Playlists are updated."
                  : "The files go to the Windows Recycle Bin, so this can be undone from there. Playlists are updated."}
              </div>
            </div>
            <div className="modalActions">
              <button className="btn" onClick={() => setConfirmDelete(null)} autoFocus>Cancel</button>
              <button className="btn dangerBtn" onClick={() => deleteTracks(confirmDelete)}>
                {confirmDelete.length > 1 ? `Delete ${confirmDelete.length}` : "Delete"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
