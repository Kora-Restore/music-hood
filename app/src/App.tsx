import { Store } from "@tauri-apps/plugin-store";
import { useEffect, useMemo, useRef, useState } from "react";
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

// "Schrotthagen, Giovanni Berg" / "A & B" / "A feat. B" → the individual names.
function splitArtists(artist: string): string[] {
  if (!artist) return [];
  return artist
    .split(/\s*(?:,|\/|&|;|\bfeat\.?\b|\bft\.?\b|\bx\b|\bvs\.?\b)\s*/i)
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
  const [status, setStatus] = useState<string>("Idle");
  const [allTracks, setAllTracks] = useState<Track[]>([]);

  const [playlist, setPlaylist] = useState<string>("(all)");
  // Left panel: folder playlists (the truth) or the virtual per-artist view (from tags).
  const [sideTab, setSideTab] = useState<"playlists" | "artists">("playlists");
  const [artistView, setArtistView] = useState<string>("");
  const [artistQuery, setArtistQuery] = useState<string>("");
  const [query, setQuery] = useState<string>("");

  const [currentPath, setCurrentPath] = useState<string>("");
  // Single click selects (highlight only); double click plays. Selection is what "Move selected" acts on.
  const [selectedPath, setSelectedPath] = useState<string>("");
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
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  }, [allTracks]);

  const shownArtists = useMemo(() => {
    const q = artistQuery.trim().toLowerCase();
    return q ? artists.filter((a) => a.name.toLowerCase().includes(q)) : artists;
  }, [artists, artistQuery]);

  const filteredTracks = useMemo(() => {
    const q = query.trim().toLowerCase();
    return allTracks.filter((t) => {
      if (artistView) {
        // virtual playlist: every track by this artist, whatever folder it lives in
        if (!splitArtists(t.artist).includes(artistView)) return false;
      } else if (playlist !== "(all)" && (t.playlist || "(root)") !== playlist) {
        return false;
      }
      if (!q) return true;
      return t.name.toLowerCase().includes(q) || t.artist.toLowerCase().includes(q);
    });
  }, [allTracks, playlist, artistView, query]);

  const shownCount = filteredTracks.length;

  const currentTrack = useMemo(
    () => (currentPath ? allTracks.find((t) => t.path === currentPath) ?? null : null),
    [allTracks, currentPath]
  );

  const selectedTrack = useMemo(
    () => (selectedPath ? allTracks.find((t) => t.path === selectedPath) ?? null : null),
    [allTracks, selectedPath]
  );

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
      setQuery("");
      setStatus(`Found ${found.length} tracks`);
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

      setAllTracks((prev) => prev.map((t) => (t.path === fromPath ? moved : t)));
      if (selectedPath === fromPath) setSelectedPath(moved.path);
      setStatus(`Moved "${displayName(moved.name)}" to ${moved.playlist}`);

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

        const savedTarget = await store.get<string>(KEY_DOWNLOAD_TARGET);
        if (savedTarget && typeof savedTarget === "string") setDlTarget(savedTarget);

        const savedVolume = await store.get<number>(KEY_VOLUME);
        if (typeof savedVolume === "number" && savedVolume >= 0 && savedVolume <= 1) setVolume(savedVolume);
        settingsLoadedRef.current = true;

        const saved = await store.get<string>(KEY_LIBRARY_DIR);
        if (!saved || typeof saved !== "string") return;

        setFolder(saved);
        setStatus("Scanning…");

        const found = await invoke<Track[]>("scan_music_folder", { dir: saved });

        setAllTracks(found);
        setPlaylist("(all)");
        setQuery("");
        setStatus(`Found ${found.length} tracks`);
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

      const uDone = await listen<number>("ytdlp:done", async (e) => {
        setDlBusy(false);
        setDlLogs((prev) => prev + `\n[done] exit code: ${e.payload}\n`);

        // Refresh library so the new file appears
        const lib = folderRef.current;
        if (lib) {
          try {
            setStatus("Refreshing…");
            const found = await invoke<Track[]>("scan_music_folder", { dir: lib });
            setAllTracks(found);
            setStatus(`Found ${found.length} tracks`);
          } catch (err) {
            setStatus(`Refresh error: ${String(err)}`);
          }
        }
      });

      // If StrictMode unmounted us before the awaits finished, immediately unlisten.
      if (!active) {
        uOut();
        uErr();
        uDone();
        return;
      }

      unlistenOut = uOut;
      unlistenErr = uErr;
      unlistenDone = uDone;
    };

    setup();

    return () => {
      active = false;
      unlistenOut?.();
      unlistenErr?.();
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
          overflow: hidden;
        }
        .npTitle{ font-weight:800; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
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
          <button className="btn" onClick={importFolder}>Import</button>
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
            <button
              className={`tab ${sideTab === "playlists" ? "active" : ""}`}
              onClick={() => setSideTab("playlists")}
            >
              Playlists
            </button>
            <button
              className={`tab ${sideTab === "artists" ? "active" : ""}`}
              onClick={() => setSideTab("artists")}
            >
              Artists <span className="tabCount">{artists.length}</span>
            </button>
          </div>

          {sideTab === "playlists" ? (
            <div className="list">
              {playlists.map((p) => (
                <div
                  key={p}
                  className={`pill ${!artistView && p === playlist ? "active" : ""}`}
                  onClick={() => {
                    setArtistView("");
                    setPlaylist(p);
                  }}
                >
                  {p}
                </div>
              ))}
            </div>
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
                    onClick={() => setArtistView((cur) => (cur === a.name ? "" : a.name))}
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
          <div className="panelHeader">
            {artistView ? (
              <>
                Tracks · <span className="accentText">{artistView}</span>
                <span className="dimText"> · all folders</span>
              </>
            ) : (
              "Tracks"
            )}
          </div>
          <div className="searchRow">
            <input
              className="search"
              placeholder="Search…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {selectedTrack ? (
              <Dropdown
                value=""
                placeholder="Move selected to…"
                title={`Move "${displayName(selectedTrack.name)}" to another playlist folder`}
                options={targetOptions.filter((name) => name !== (selectedTrack.playlist || "(root)"))}
                onSelect={(target) => moveTrackTo(selectedTrack.path, target)}
              />
            ) : null}
            <button className="btn" onClick={() => setShuffle((s) => !s)}>
              {shuffle ? "Shuffle: on" : "Shuffle: off"}
            </button>
          </div>
          <div className="list">
            {filteredTracks.map((t) => (
              <div
                key={t.path}
                className={`trackRow ${t.path === currentPath ? "active" : ""} ${t.path === selectedPath ? "selected" : ""}`}
                onClick={() => setSelectedPath((p) => (p === t.path ? "" : t.path))}
                onDoubleClick={() => loadAndPlay(t)}
                title="Click to select · double-click to play"
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
              placeholder="Move to…"
              title="Move this track to another playlist folder"
              options={targetOptions.filter((name) => name !== currentPlaylist)}
              onSelect={(target) => moveTrackTo(currentPath, target)}
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
          <div>{shuffle ? "Shuffle on" : "Shuffle off"}</div>
          <div style={{ opacity: 0.35 }}>•</div>
          <div>{currentIndex >= 0 ? `${currentIndex + 1}/${shownCount}` : `0/${shownCount}`}</div>
        </div>

        <audio ref={audioRef} preload="metadata" />
      </div>
    </div>
  );
}
