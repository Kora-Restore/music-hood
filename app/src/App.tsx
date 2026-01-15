import { useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { readDir } from "@tauri-apps/plugin-fs";

type Track = {
  path: string;          // absolute path
  name: string;          // filename
  playlist: string;      // first folder level (or "(root)")
};

const COLORS = {
  bg0: "#0f0f0f",
  bg1: "#212121",
  accent: "#00ffbf",
  accent2: "#8c19ff",
  text: "rgba(255,255,255,0.92)",
  textDim: "rgba(255,255,255,0.65)",
  panel: "rgba(255,255,255,0.06)",
  panel2: "rgba(255,255,255,0.04)",
  border: "rgba(255,255,255,0.10)",
};

function isAudioFile(filename: string) {
  const f = filename.toLowerCase();
  return (
    f.endsWith(".mp3") ||
    f.endsWith(".m4a") ||
    f.endsWith(".aac") ||
    f.endsWith(".wav") ||
    f.endsWith(".ogg") ||
    f.endsWith(".flac")
  );
}

function joinPath(base: string, name: string) {
  // Preserve Windows-style separators if base looks like Windows
  const isWindows = base.includes("\\") || /^[A-Za-z]:\\/.test(base);
  const sep = isWindows ? "\\" : "/";
  if (base.endsWith(sep)) return base + name;
  return base + sep + name;
}

function getRelativeFirstFolder(root: string, abs: string) {
  // Very defensive: handles Windows + unicode + spaces
  const normRoot = root.replace(/\//g, "\\");
  const normAbs = abs.replace(/\//g, "\\");
  if (!normAbs.toLowerCase().startsWith(normRoot.toLowerCase())) return "(unknown)";

  const rel = normAbs.slice(normRoot.length).replace(/^\\+/, "");
  if (!rel) return "(root)";

  const first = rel.split("\\")[0];
  return first?.trim() ? first : "(root)";
}

function formatDisplayName(filename: string) {
  // Keep your raw filenames, but make them less “filesystem” when displayed
  return filename.replace(/\.(mp3|m4a|aac|wav|ogg|flac)$/i, "");
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
  const [shuffle, setShuffle] = useState<boolean>(false);

  const [progress, setProgress] = useState<number>(0); // seconds
  const [duration, setDuration] = useState<number>(0); // seconds

  // playlists from first folder level (no nesting for now)
  const playlists = useMemo(() => {
    const set = new Set<string>();
    for (const t of allTracks) set.add(t.playlist);
    const list = Array.from(set).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
    // keep "(root)" near the top but after (all) if present
    const rootIdx = list.indexOf("(root)");
    if (rootIdx > -1) {
      list.splice(rootIdx, 1);
      list.unshift("(root)");
    }
    return ["(all)", ...list];
  }, [allTracks]);

  const filteredTracks = useMemo(() => {
    const q = query.trim().toLowerCase();

    return allTracks.filter((t) => {
      if (playlist !== "(all)" && t.playlist !== playlist) return false;
      if (!q) return true;
      return (
        t.name.toLowerCase().includes(q) ||
        t.playlist.toLowerCase().includes(q)
      );
    });
  }, [allTracks, playlist, query]);

  // Pick a "current index" based on filtered list
  const currentIndex = useMemo(() => {
    if (!currentPath) return -1;
    return filteredTracks.findIndex((t) => t.path === currentPath);
  }, [filteredTracks, currentPath]);

  function pickRandomIndex(excluding?: number) {
    const n = filteredTracks.length;
    if (n <= 0) return -1;
    if (n === 1) return 0;
    let idx = Math.floor(Math.random() * n);
    if (typeof excluding === "number" && excluding >= 0) {
      while (idx === excluding) idx = Math.floor(Math.random() * n);
    }
    return idx;
  }

  async function importFolder() {
    try {
      const selected = await open({ directory: true, multiple: false });
      if (!selected || typeof selected !== "string") return;

      setFolder(selected);
      setStatus("Scanning…");
      setAllTracks([]);
      setPlaylist("(all)");
      setQuery("");

      const found: Track[] = [];

      async function scan(dir: string) {
        const entries: any[] = (await readDir(dir)) as any[];

        for (const e of entries) {
          // plugin-fs readDir entries often look like:
          // { name, isDirectory, isFile, isSymlink } (no "path")
          const name = e?.name;
          if (!name || typeof name !== "string") continue;

          const childPath = joinPath(dir, name);

          if (e?.isDirectory) {
            await scan(childPath);
          } else if (e?.isFile) {
            if (isAudioFile(name)) {
              const pl = getRelativeFirstFolder(selected, childPath);
              found.push({ path: childPath, name, playlist: pl });
            }
          }
        }
      }

      await scan(selected);

      // Sort: playlist then name (stable-ish)
      found.sort((a, b) => {
        const p = a.playlist.localeCompare(b.playlist, undefined, { sensitivity: "base" });
        if (p !== 0) return p;
        return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
      });

      setAllTracks(found);
      setStatus(`Found ${found.length} tracks`);
    } catch (err: any) {
      setStatus(`Scan error: ${String(err?.message ?? err)}`);
      console.error(err);
    }
  }

  function loadAndPlay(t: Track) {
    setCurrentPath(t.path);
    setCurrentName(t.name);
    setCurrentPlaylist(t.playlist);

    const audio = audioRef.current;
    if (!audio) return;

    // IMPORTANT: use Tauri asset URL so the <audio> element can load local files
    const src = convertFileSrc(t.path);

    // Stop the current load cleanly
    audio.pause();
    audio.currentTime = 0;
    setProgress(0);
    setDuration(0);

    audio.src = src;
    audio.load();

    const playPromise = audio.play();
    if (playPromise && typeof playPromise.catch === "function") {
      playPromise.catch((e) => {
        console.warn("audio.play() failed:", e);
        setIsPlaying(false);
      });
    }
  }

  function togglePlayPause() {
    const audio = audioRef.current;
    if (!audio) return;

    if (audio.paused) {
      const p = audio.play();
      if (p && typeof p.catch === "function") p.catch(() => setIsPlaying(false));
    } else {
      audio.pause();
    }
  }

  function nextTrack() {
    if (filteredTracks.length === 0) return;

    const idx = currentIndex;
    let nextIdx = -1;

    if (shuffle) {
      nextIdx = pickRandomIndex(idx);
    } else {
      nextIdx = idx >= 0 ? (idx + 1) % filteredTracks.length : 0;
    }

    const t = filteredTracks[nextIdx];
    if (t) loadAndPlay(t);
  }

  function prevTrack() {
    if (filteredTracks.length === 0) return;

    const idx = currentIndex;
    let prevIdx = -1;

    if (shuffle) {
      prevIdx = pickRandomIndex(idx);
    } else {
      prevIdx = idx >= 0 ? (idx - 1 + filteredTracks.length) % filteredTracks.length : 0;
    }

    const t = filteredTracks[prevIdx];
    if (t) loadAndPlay(t);
  }

  function clamp(n: number, min: number, max: number) {
    return Math.max(min, Math.min(max, n));
  }

  function formatTime(sec: number) {
    if (!isFinite(sec) || sec < 0) return "0:00";
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${String(s).padStart(2, "0")}`;
  }

  // Keep progress updated
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const onTime = () => setProgress(audio.currentTime || 0);
    const onMeta = () => setDuration(audio.duration || 0);
    const onPlay = () => setIsPlaying(true);
    const onPause = () => setIsPlaying(false);
    const onEnded = () => nextTrack();

    audio.addEventListener("timeupdate", onTime);
    audio.addEventListener("loadedmetadata", onMeta);
    audio.addEventListener("durationchange", onMeta);
    audio.addEventListener("play", onPlay);
    audio.addEventListener("pause", onPause);
    audio.addEventListener("ended", onEnded);

    return () => {
      audio.removeEventListener("timeupdate", onTime);
      audio.removeEventListener("loadedmetadata", onMeta);
      audio.removeEventListener("durationchange", onMeta);
      audio.removeEventListener("play", onPlay);
      audio.removeEventListener("pause", onPause);
      audio.removeEventListener("ended", onEnded);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentPath, shuffle, playlist, query, filteredTracks.length, currentIndex]);

  // Spacebar only. No J/K. No legend. Spotify vibe assumes you know the buttons.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // Don’t steal keys while typing
      const el = document.activeElement;
      const isTyping =
        el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement ||
        (el instanceof HTMLElement && el.isContentEditable);

      if (isTyping) return;

      if (e.code === "Space") {
        e.preventDefault();
        togglePlayPause();
      }
    };

    window.addEventListener("keydown", onKeyDown, { passive: false });
    return () => window.removeEventListener("keydown", onKeyDown as any);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Media keys (best effort): Media Session API
    useEffect(() => {
    const ms: any = (navigator as any).mediaSession;
    if (!ms) return;

    const title = currentName ? formatDisplayName(currentName) : "music-hood";
    const album = currentPlaylist || "";

    const MM: any = (window as any).MediaMetadata;
    if (typeof MM === "function") {
      ms.metadata = new MM({
        title,
        artist: "",
        album,
      });
    } else {
      // fallback if MediaMetadata isn't available
      ms.metadata = { title, artist: "", album };
    }

    try {
      ms.setActionHandler("play", () => togglePlayPause());
      ms.setActionHandler("pause", () => togglePlayPause());
      ms.setActionHandler("previoustrack", () => prevTrack());
      ms.setActionHandler("nexttrack", () => nextTrack());
      ms.setActionHandler("seekto", (details: any) => {
        const audio = audioRef.current;
        if (!audio) return;
        if (typeof details?.seekTime === "number") {
          audio.currentTime = clamp(details.seekTime, 0, audio.duration || 0);
        }
      });
    } catch {
      // Some webviews are picky; ignore.
    }

    ms.playbackState = isPlaying ? "playing" : "paused";
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentName, currentPlaylist, isPlaying]);


  const nowPlayingLabel = useMemo(() => {
    if (!currentName) return "Nothing playing";
    const n = formatDisplayName(currentName);
    const p = currentPlaylist ? ` (${currentPlaylist})` : "";
    return `${n}${p}`;
  }, [currentName, currentPlaylist]);

  const shownCount = filteredTracks.length;

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
          --panel2:${COLORS.panel2};
          --border:${COLORS.border};
        }

        *{ box-sizing:border-box; }
        html,body{ height:100%; margin:0; background:var(--bg0); color:var(--text); }
        body{ font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, "Apple Color Emoji","Segoe UI Emoji"; }

        /* Scrollbars: slim, modern, no track blocks, no arrows */
        *::-webkit-scrollbar{ width:10px; height:10px; }
        *::-webkit-scrollbar-track{ background:transparent; }
        *::-webkit-scrollbar-thumb{
          background: linear-gradient(180deg, rgba(0,255,191,0.55), rgba(140,25,255,0.55));
          border-radius: 999px;
          border: 2px solid transparent;
          background-clip: padding-box;
        }
        *::-webkit-scrollbar-corner{ background:transparent; }
        *::-webkit-scrollbar-button{ width:0; height:0; display:none; }

        .app{
          height:100vh;
          display:flex;
          flex-direction:column;
          background:
            radial-gradient(1000px 600px at 20% 0%, rgba(0,255,191,0.12), transparent 60%),
            radial-gradient(900px 600px at 80% 10%, rgba(140,25,255,0.10), transparent 55%),
            linear-gradient(180deg, rgba(255,255,255,0.02), transparent 30%),
            linear-gradient(180deg, var(--bg0), var(--bg0));
        }

        .topbar{
          display:flex;
          align-items:center;
          gap:14px;
          padding:14px 16px;
        }

        .brand{
          font-weight:800;
          letter-spacing:-0.02em;
          font-size:22px;
          opacity:0.95;
        }

        .pill{
          border: 1px solid var(--border);
          background: rgba(255,255,255,0.04);
          color: var(--text);
          padding: 8px 10px;
          border-radius: 12px;
          display:flex;
          align-items:center;
          gap:8px;
          backdrop-filter: blur(10px);
        }

        .btn{
          border: 1px solid var(--border);
          background: rgba(255,255,255,0.06);
          color: var(--text);
          padding: 8px 12px;
          border-radius: 12px;
          cursor:pointer;
          transition: transform 120ms ease, background 120ms ease;
          user-select:none;
        }
        .btn:hover{ background: rgba(255,255,255,0.09); transform: translateY(-1px); }
        .btn:active{ transform: translateY(0px) scale(0.99); }

        .statusRow{
          margin-left:auto;
          display:flex;
          align-items:center;
          gap:10px;
          color: var(--textDim);
          font-size: 13px;
        }

        .pathLine{
          padding: 0 16px 10px 16px;
          color: var(--textDim);
          font-size: 12px;
          white-space: nowrap;
          overflow:hidden;
          text-overflow: ellipsis;
        }

        .content{
          flex:1;
          display:grid;
          grid-template-columns: 320px 1fr;
          gap: 14px;
          padding: 0 16px 110px 16px; /* reserve for bottom player */
          min-height:0;
        }

        .panel{
          border: 1px solid var(--border);
          background: linear-gradient(180deg, rgba(255,255,255,0.06), rgba(255,255,255,0.03));
          border-radius: 18px;
          backdrop-filter: blur(12px);
          box-shadow: 0 10px 30px rgba(0,0,0,0.35);
          min-height:0;
        }

        .panelHeader{
          padding: 14px 14px 10px 14px;
          font-weight: 700;
          color: var(--text);
          display:flex;
          align-items:center;
          justify-content:space-between;
        }

        .list{
          padding: 8px;
          height: calc(100% - 52px);
          overflow:auto;
        }

        .plItem{
          display:flex;
          align-items:center;
          gap:10px;
          padding: 10px 10px;
          border-radius: 12px;
          cursor:pointer;
          color: var(--text);
          border: 1px solid transparent;
        }
        .plItem:hover{ background: rgba(255,255,255,0.06); }
        .plItem.active{
          background: rgba(0,255,191,0.08);
          border-color: rgba(0,255,191,0.28);
        }

        .tracksTop{
          display:flex;
          align-items:center;
          gap: 12px;
          width:100%;
        }

        .search{
          flex:1;
          border: 1px solid var(--border);
          background: rgba(0,0,0,0.25);
          color: var(--text);
          padding: 10px 12px;
          border-radius: 14px;
          outline:none;
        }
        .search:focus{
          border-color: rgba(0,255,191,0.45);
          box-shadow: 0 0 0 3px rgba(0,255,191,0.08);
        }

        .count{
          color: var(--textDim);
          font-size: 13px;
          white-space: nowrap;
        }

        .trackRow{
          display:flex;
          align-items:center;
          justify-content:space-between;
          gap: 10px;
          padding: 10px 10px;
          border-radius: 12px;
          cursor:pointer;
          border: 1px solid transparent;
        }
        .trackRow:hover{ background: rgba(255,255,255,0.05); }
        .trackRow.active{
          background: rgba(140,25,255,0.10);
          border-color: rgba(140,25,255,0.28);
        }

        .tName{
          color: var(--text);
          font-size: 14px;
          line-height: 1.25;
          overflow:hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .tMeta{
          color: var(--textDim);
          font-size: 12px;
          white-space: nowrap;
          margin-left: 10px;
          opacity:0.95;
        }

        /* Spotify-ish bottom bar */
        .playerBar{
          position: fixed;
          left: 12px;
          right: 12px;
          bottom: 12px;
          height: 86px;
          border-radius: 18px;
          border: 1px solid var(--border);
          background:
            linear-gradient(180deg, rgba(255,255,255,0.06), rgba(255,255,255,0.03));
          backdrop-filter: blur(14px);
          box-shadow: 0 20px 60px rgba(0,0,0,0.50);
          display:grid;
          grid-template-columns: 1fr 360px 1fr;
          align-items:center;
          padding: 12px 14px;
          gap: 14px;
        }

        .nowPlaying{
          min-width:0;
          display:flex;
          flex-direction:column;
          gap: 4px;
        }
        .npTitle{
          font-weight: 650;
          color: var(--text);
          font-size: 13px;
          overflow:hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .npSub{
          color: var(--textDim);
          font-size: 12px;
          overflow:hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .controls{
          display:flex;
          flex-direction:column;
          align-items:center;
          justify-content:center;
          gap: 8px;
        }

        .btnRow{
          display:flex;
          align-items:center;
          justify-content:center;
          gap: 12px;
        }

        .iconBtn{
          width: 36px;
          height: 36px;
          border-radius: 999px;
          border: 1px solid var(--border);
          background: rgba(255,255,255,0.05);
          color: var(--text);
          display:flex;
          align-items:center;
          justify-content:center;
          cursor:pointer;
          transition: transform 120ms ease, background 120ms ease, border-color 120ms ease;
          user-select:none;
        }
        .iconBtn:hover{ background: rgba(255,255,255,0.08); transform: translateY(-1px); }
        .iconBtn:active{ transform: translateY(0px) scale(0.99); }

        .playBtn{
          width: 44px;
          height: 44px;
          background: rgba(255,255,255,0.92);
          color: #111;
          border-color: rgba(255,255,255,0.45);
        }

        .shuffleOn{
          border-color: rgba(0,255,191,0.55);
          box-shadow: 0 0 0 3px rgba(0,255,191,0.10);
        }

        .timeline{
          display:flex;
          align-items:center;
          gap: 10px;
          width: 100%;
        }

        .time{
          width: 44px;
          text-align:center;
          font-size: 12px;
          color: var(--textDim);
          font-variant-numeric: tabular-nums;
        }

        .range{
          flex:1;
          appearance:none;
          height: 4px;
          border-radius: 999px;
          background: rgba(255,255,255,0.12);
          outline:none;
        }
        .range::-webkit-slider-thumb{
          appearance:none;
          width: 14px;
          height: 14px;
          border-radius: 999px;
          background: linear-gradient(180deg, var(--accent), var(--accent2));
          border: 2px solid rgba(0,0,0,0.35);
          cursor:pointer;
        }

        .rightInfo{
          display:flex;
          align-items:center;
          justify-content:flex-end;
          color: var(--textDim);
          font-size: 12px;
          gap: 10px;
          white-space: nowrap;
        }

        @media (max-width: 980px){
          .content{ grid-template-columns: 280px 1fr; }
          .playerBar{ grid-template-columns: 1fr 300px 1fr; }
        }

        @media (max-width: 820px){
          .content{ grid-template-columns: 1fr; }
          .playerBar{ grid-template-columns: 1fr; height: 120px; }
          .rightInfo{ display:none; }
          .controls{ align-items:stretch; }
        }
      `}</style>

      <div className="topbar">
        <div className="brand">music-hood</div>
        <button className="btn" onClick={importFolder}>Import</button>

        <div className="statusRow">
          <div className="pill">Status: {status}</div>
        </div>
      </div>

      <div className="pathLine">
        {folder ? `Folder: ${folder}` : "Pick a folder to begin."}
      </div>

      <div className="content">
        <div className="panel">
          <div className="panelHeader">
            <div>Playlists</div>
          </div>

          <div className="list">
            {playlists.map((p) => (
              <div
                key={p}
                className={"plItem " + (p === playlist ? "active" : "")}
                onClick={() => setPlaylist(p)}
                title={p}
              >
                <div style={{ fontWeight: 650, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {p}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="panel">
          <div className="panelHeader">
            <div className="tracksTop">
              <div style={{ fontWeight: 750 }}>Tracks</div>
              <input
                className="search"
                placeholder="Search…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <div className="count">{shownCount} shown</div>
            </div>
          </div>

          <div className="list">
            {filteredTracks.map((t) => {
              const active = t.path === currentPath;
              return (
                <div
                  key={t.path}
                  className={"trackRow " + (active ? "active" : "")}
                  onClick={() => loadAndPlay(t)}
                  title={t.path}
                >
                  <div className="tName">{formatDisplayName(t.name)}</div>
                  <div className="tMeta">{t.playlist}</div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <div className="playerBar">
        <div className="nowPlaying">
          <div className="npTitle">{nowPlayingLabel}</div>
          <div className="npSub">
            {playlist === "(all)" ? "All playlists" : `Filtered: ${playlist}`} • {allTracks.length} tracks
          </div>
        </div>

        <div className="controls">
          <div className="btnRow">
            <button className="iconBtn" onClick={prevTrack} title="Previous">
              ⏮
            </button>

            <button className="iconBtn playBtn" onClick={togglePlayPause} title="Play/Pause">
              {isPlaying ? "⏸" : "▶"}
            </button>

            <button className="iconBtn" onClick={nextTrack} title="Next">
              ⏭
            </button>

            <button
              className={"iconBtn " + (shuffle ? "shuffleOn" : "")}
              onClick={() => setShuffle((s) => !s)}
              title="Shuffle"
            >
              🔀
            </button>
          </div>

          <div className="timeline">
            <div className="time">{formatTime(progress)}</div>
            <input
              className="range"
              type="range"
              min={0}
              max={Math.max(0, duration || 0)}
              value={clamp(progress, 0, duration || 0)}
              step={0.25}
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
        </div>

        <div className="rightInfo">
          <div>{shuffle ? "Shuffle on" : "Shuffle off"}</div>
          <div style={{ opacity: 0.35 }}>•</div>
          <div>{currentIndex >= 0 ? `${currentIndex + 1}/${shownCount}` : `0/${shownCount}`}</div>
        </div>

        {/* Hidden audio element driven by Tauri asset URLs */}
        <audio ref={audioRef} preload="metadata" />
      </div>
    </div>
  );
}
