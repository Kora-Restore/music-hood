import { Store } from "@tauri-apps/plugin-store";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

const settingsStore = new Store("music-hood.json");
const STORE_KEY = "libraryDir";

type Track = {
  path: string;
  name: string;
  playlist: string;
};

const storePromise = Store.load("music-hood.json");

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
  const [query, setQuery] = useState<string>("");

  const [currentPath, setCurrentPath] = useState<string>("");
  const [currentName, setCurrentName] = useState<string>("");
  const [currentPlaylist, setCurrentPlaylist] = useState<string>("");

  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [progress, setProgress] = useState<number>(0);
  const [duration, setDuration] = useState<number>(0);
  const [shuffle, setShuffle] = useState<boolean>(false);

  // Manual download box
  const [downloadUrl, setDownloadUrl] = useState<string>("");
  const [dlBusy, setDlBusy] = useState<boolean>(false);
  const [dlLogs, setDlLogs] = useState<string>("");

  // IMPORTANT: avoid duplicate ytdlp listeners in dev/hmr by using a ref for latest folder
  const folderRef = useRef<string>("");
  useEffect(() => {
    folderRef.current = folder;
  }, [folder]);

  const playlists = useMemo(() => {
    const set = new Set<string>();
    for (const t of allTracks) set.add(t.playlist || "(root)");
    const arr = Array.from(set);
    arr.sort((a, b) => a.localeCompare(b));
    return ["(all)", ...arr.filter((x) => x !== "(all)")];
  }, [allTracks]);

  const filteredTracks = useMemo(() => {
    const q = query.trim().toLowerCase();
    return allTracks.filter((t) => {
      if (playlist !== "(all)" && (t.playlist || "(root)") !== playlist) return false;
      if (!q) return true;
      return t.name.toLowerCase().includes(q);
    });
  }, [allTracks, playlist, query]);

  const shownCount = filteredTracks.length;

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

  async function importFolder() {
    try {
      const picked = await open({ directory: true, multiple: false });
      if (!picked || typeof picked !== "string") return;
      
      await settingsStore.set(STORE_KEY, picked);
      await settingsStore.save();

      setFolder(picked);
      setStatus("Scanning…");

      // persist selection
      const store = await storePromise;
      await store.set("library_dir", picked);
      await store.save();

      const found = await invoke<Track[]>("scan_music_folder", { dir: picked });

      async function loadLibrary(dir: string) {
          setFolder(dir);
          setStatus("Scanning…");
          setAllTracks([]);
          setPlaylist("(all)");
          setQuery("");

          try {
            const found: Track[] = await invoke("scan_music_folder", { dir });
            setAllTracks(found);
            setStatus(`Found ${found.length} tracks`);
          } catch (e) {
            setStatus(`Scan failed: ${String(e)}`);
          }
        }

        useEffect(() => {
          (async () => {
            try {
              const saved = (await settingsStore.get(STORE_KEY)) as string | null;
              if (saved && typeof saved === "string" && saved.length > 0) {
                await loadLibrary(saved);
              }
            } catch (e) {
              setStatus(`Auto-load failed: ${String(e)}`);
            }
          })();
        }, []);

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

    setDlBusy(true);
    setDlLogs("");

    try {
      // pass the current selected library folder to Rust
      const lib = folderRef.current || "";
      await invoke("ytdlp_download_audio", { args: { url, libraryDir: lib || null } });
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
    setCurrentName(t.name);
    setCurrentPlaylist(t.playlist || "(root)");

    audio.onloadedmetadata = () => {
      setDuration(audio.duration || 0);
      setProgress(0);
      audio.play().then(() => setIsPlaying(true)).catch(() => setIsPlaying(false));
    };
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
        const saved = await store.get<string>("library_dir");
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
        }
        .panelHeader{
          padding:12px 14px;
          font-weight:700;
          border-bottom:1px solid var(--border);
          background: rgba(255,255,255,0.03);
        }
        .list{
          padding:10px;
          overflow:auto;
          max-height:100%;
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
        .searchRow{
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
        .trackRow.active{
          border-color: rgba(140,25,255,0.35);
          background: rgba(140,25,255,0.10);
        }

        .player{
          border-top:1px solid var(--border);
          padding: 12px 16px;
          background: rgba(0,0,0,0.25);
          display:flex;
          align-items:center;
          justify-content:space-between;
          gap: 16px;
        }
        .nowPlaying{
          display:flex;
          flex-direction:column;
          gap: 2px;
          min-width: 260px;
        }
        .npTitle{ font-weight:800; }
        .npSub{ color: var(--textDim); font-size: 12px; }
        .controls{
          display:flex;
          align-items:center;
          gap: 10px;
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
        .timeline{
          flex:1;
          display:flex;
          align-items:center;
          gap: 10px;
        }
        .time{ color: var(--textDim); font-size: 12px; min-width: 44px; text-align:center; }
        .range{ width: 100%; }
        .rightInfo{
          display:flex;
          align-items:center;
          gap: 10px;
          color: var(--textDim);
          font-size: 12px;
          min-width: 140px;
          justify-content:flex-end;
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
          <div className="panelHeader">Playlists</div>
          <div className="list">
            {playlists.map((p) => (
              <div
                key={p}
                className={`pill ${p === playlist ? "active" : ""}`}
                onClick={() => setPlaylist(p)}
              >
                {p}
              </div>
            ))}
          </div>
        </div>

        <div className="panel">
          <div className="panelHeader">Tracks</div>
          <div className="searchRow">
            <input
              className="search"
              placeholder="Search…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <button className="btn" onClick={() => setShuffle((s) => !s)}>
              {shuffle ? "Shuffle: on" : "Shuffle: off"}
            </button>
          </div>
          <div className="list">
            {filteredTracks.map((t) => (
              <div
                key={t.path}
                className={`trackRow ${t.path === currentPath ? "active" : ""}`}
                onClick={() => loadAndPlay(t)}
              >
                {t.name}
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="player">
        <div className="nowPlaying">
          <div className="npTitle">{currentName || "Nothing playing"}</div>
          <div className="npSub">
            {currentPlaylist ? `All playlists • ${allTracks.length} tracks` : `All playlists • ${allTracks.length} tracks`}
          </div>
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
          <div>{shuffle ? "Shuffle on" : "Shuffle off"}</div>
          <div style={{ opacity: 0.35 }}>•</div>
          <div>{currentIndex >= 0 ? `${currentIndex + 1}/${shownCount}` : `0/${shownCount}`}</div>
        </div>

        <audio ref={audioRef} preload="metadata" />
      </div>
    </div>
  );
}
