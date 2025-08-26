// web/app.js
// ------------------------------------------------------------
// DAW-style stacked stems + real waveforms (Web Audio)
// - Dropbox temp links via /api/link
// - decodeAudioData -> peaks -> cached in localStorage
// - Sticky version tabs, master player, Play All / Stop
// - Track-like rows: left gutter controls, header strip, resizable lanes
// ------------------------------------------------------------

// ------------- tiny DOM/fetch helpers
async function j(url, opts = {}) {
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}
const $  = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
function h(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v;
    else if (k === "html") e.innerHTML = v;
    else e.setAttribute(k, v);
  }
  for (const k of kids) if (k) e.appendChild(k);
  return e;
}
const css = (name) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();

// ------------- Dropbox temp links
const linkCache = new Map();
async function getTempLink(path) {
  if (linkCache.has(path)) return linkCache.get(path);
  const { url } = await j(`/api/link?path=${encodeURIComponent(path)}`);
  linkCache.set(path, url);
  return url;
}

// ------------- Web Audio setup + caching
const AC = typeof AudioContext !== "undefined" ? new AudioContext() : null;
async function ensureAudioContext() {
  if (!AC) throw new Error("Web Audio not available");
  if (AC.state !== "running") {
    try { await AC.resume(); } catch (_) {}
  }
}

function cacheKey(ref) {
  const mod = ref.server_modified || "";
  const sz  = ref.size || 0;
  return `${ref.path}|${sz}|${mod}`;
}
function peaksLoad(key) {
  try {
    const s = localStorage.getItem("avcs:peaks:" + key);
    if (!s) return null;
    const o = JSON.parse(s);
    return { duration: o.d, peaks: new Float32Array(o.p) };
  } catch {
    return null;
  }
}
function peaksSave(key, obj) {
  try {
    const out = {
      d: obj.duration,
      p: Array.from(obj.peaks).map((n) => Math.round(n * 1000) / 1000),
    };
    localStorage.setItem("avcs:peaks:" + key, JSON.stringify(out));
  } catch {}
}

async function fetchAB(url) {
  const r = await fetch(url, { mode: "cors" });
  if (!r.ok) throw new Error("fetch " + r.status);
  return await r.arrayBuffer();
}

async function decodeToPeaks(ab, barsWanted) {
  await ensureAudioContext();
  // Safari-safe promise form
  const buf = await new Promise((res, rej) =>
    AC.decodeAudioData(ab.slice(0), res, rej)
  );

  const ch     = buf.numberOfChannels;
  const frames = buf.length;
  const step   = Math.max(1, Math.floor(frames / barsWanted));

  // Merge to mono by max(abs) across channels per sample window
  const peaks = new Float32Array(Math.ceil(frames / step));
  let p = 0;
  for (let i = 0; i < frames; i += step) {
    let max = 0;
    const end = Math.min(frames, i + step);
    for (let j = i; j < end; j++) {
      let m = 0;
      for (let c = 0; c < ch; c++) {
        const v = buf.getChannelData(c)[j];
        const a = v < 0 ? -v : v;
        if (a > m) m = a;
      }
      if (m > max) max = m;
    }
    peaks[p++] = max;
  }
  return { peaks, duration: buf.duration };
}

// ------------- Waveform canvas (SoundCloud-like bars)
class WaveformView {
  constructor(canvas, { onSeek } = {}) {
    this.canvas   = canvas;
    this.ctx      = canvas.getContext("2d");
    this.peaks    = null;
    this.duration = 0;
    this.progress = 0; // 0..1 of duration
    this.hoverX   = null;
    this.onSeek   = onSeek || (() => {});
    this.accent   = null; // per-row accent
    this.dim      = null;

    this.resizeObs = new ResizeObserver(() => this.redraw());
    this.resizeObs.observe(canvas);

    canvas.addEventListener("mousemove", (e) => {
      const r = canvas.getBoundingClientRect();
      this.hoverX = e.clientX - r.left;
      this.redraw();
    });
    canvas.addEventListener("mouseleave", () => {
      this.hoverX = null;
      this.redraw();
    });
    canvas.addEventListener("click", (e) => {
      const r = canvas.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width;
      this.onSeek(Math.max(0, Math.min(1, x)));
    });
  }

  setData(peaks, duration) {
    this.peaks = peaks;
    this.duration = duration || 0;
    this.redraw();
  }
  setProgress(ratio) {
    this.progress = Math.max(0, Math.min(1, ratio || 0));
    this.redraw();
  }
  setAccent(color) {
    this.accent = color;
    try {
      const m = color.match(/hsl\((\d+)/);
      this.dim = m ? `hsl(${m[1]} 80% 60% / 0.38)` : null;
    } catch {}
  }

  redraw() {
    const c = this.canvas,
      g = this.ctx;
    if (!g) return;

    const w = c.clientWidth | 0;
    const h = c.clientHeight | 0;
    if (c.width !== w) c.width = w;
    if (c.height !== h) c.height = h;

    // background
    g.clearRect(0, 0, w, h);
    g.fillStyle = css("--wf-bg") || "#0f1217";
    g.fillRect(0, 0, w, h);

    // subtle grid
    g.strokeStyle = css("--line") || "#1f232b";
    g.globalAlpha = 0.35;
    g.lineWidth = 1;
    for (let y = 0; y <= h; y += h / 4) {
      g.beginPath();
      g.moveTo(0, y + 0.5);
      g.lineTo(w, y + 0.5);
      g.stroke();
    }
    g.globalAlpha = 1;

    const accent = this.accent || css("--wf") || "#7fd9ff";
    const dim    = this.dim    || css("--wf-dim") || "rgba(58,169,207,.33)";

    // bars
    const mid = h / 2;
    const maxBar = (h * 0.92) / 2;

    const drawBars = (color) => {
      if (!this.peaks || !this.peaks.length) return;
      const total = this.peaks.length;
      const dx = w / total;
      g.fillStyle = color;
      for (let i = 0; i < total; i++) {
        const amp = this.peaks[i];
        const bar = Math.max(1, amp * maxBar);
        const x = Math.floor(i * dx);
        const bw = Math.max(1, dx * 0.84);
        g.fillRect(x, mid - bar, bw, bar * 2);
      }
    };

    if (this.peaks && this.peaks.length) {
      drawBars(dim);
      // progress overlay
      const cut = Math.floor(this.progress * w);
      if (cut > 0) {
        g.save();
        g.beginPath();
        g.rect(0, 0, cut, h);
        g.clip();
        drawBars(accent);
        g.restore();
      }
    } else {
      // placeholder line
      g.strokeStyle = accent;
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(0, mid);
      g.lineTo(w, mid);
      g.stroke();
    }

    // hover playhead
    if (this.hoverX != null) {
      g.strokeStyle = css("--accent") || "#6fd3ff";
      g.globalAlpha = 0.6;
      g.beginPath();
      g.moveTo(this.hoverX + 0.5, 0);
      g.lineTo(this.hoverX + 0.5, h);
      g.stroke();
      g.globalAlpha = 1;
    }
  }
}

// ------------- unique color per stem (type-aware; fallback hashed)
function colorForStem(name) {
  const up = name.toUpperCase();
  const map = {
    DRUMS: 200,
    KICK: 210,
    SNARE: 220,
    PERC: 195,
    BASS: 165,
    SUB: 150,
    VOCALS: 320,
    VOX: 320,
    BGV: 300,
    GTR: 35,
    GUITAR: 35,
    PIANO: 25,
    SYNTH: 280,
    LEAD: 275,
    PAD: 260,
    FX: 0,
  };
  for (const k in map) if (up.includes(k)) return `hsl(${map[k]} 90% 66%)`;
  // hash to hue
  let h = 2166136261 >>> 0;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `hsl(${(h >>> 0) % 360} 85% 64%)`;
}

// ------------- build versions for tabs
function makeVersions(track) {
  const map = new Map(); // "t1-t2" -> bucket
  (track.stems || []).forEach((s) => {
    const key = `${s.t1}-${s.t2}`;
    const b =
      map.get(key) || {
        t1: s.t1,
        t2: s.t2,
        stems: [],
        mixes: [],
        masterFinal: null,
        masterCandidates: [],
      };
    b.stems.push(...s.stems);
    map.set(key, b);
  });
  (track.mixes || []).forEach((m) => {
    const key = `${m.t1}-${m.t2}`;
    const b =
      map.get(key) || {
        t1: m.t1,
        t2: m.t2,
        stems: [],
        mixes: [],
        masterFinal: null,
        masterCandidates: [],
      };
    b.mixes.push(m.file);
    map.set(key, b);
  });
  (track.masters || []).forEach((ms) => {
    const key = `${ms.t1}-${ms.t2}`;
    const b =
      map.get(key) || {
        t1: ms.t1,
        t2: ms.t2,
        stems: [],
        mixes: [],
        masterFinal: null,
        masterCandidates: [],
      };
    if (ms.final) b.masterFinal = ms.final;
    b.masterCandidates.push(...(ms.candidates || []));
    map.set(key, b);
  });

  return [...map.values()].sort((a, b) =>
    a.t1 === b.t1 ? (a.t2 < b.t2 ? -1 : 1) : a.t1 < b.t1 ? -1 : 1
  );
}

// ------------- tabs rendering (sticky)
function renderVersionTabs(versions, onSelect) {
  const bar = $("#versionTabs");
  if (!bar) return;
  bar.innerHTML = "";
  versions.forEach((v, i) => {
    const b = h(
      "button",
      { class: "tab" + (i === 0 ? " active" : "") },
      document.createTextNode(`${v.t1} — ${v.t2}`)
    );
    b.onclick = () => {
      $$(".tab", bar).forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      onSelect(v);
    };
    bar.appendChild(b);
  });
}

// ------------- draw waveform from cache/decoded data
async function drawRealWaveform(view, ref, url, canvasEl) {
  const key = cacheKey(ref);
  const targetBars = Math.max(
    1200,
    Math.floor((canvasEl?.clientWidth || 1200))
  );
  let cached = peaksLoad(key);
  // refresh if cache is missing or very low resolution
  if (!cached || (cached.peaks && cached.peaks.length < targetBars * 0.6)) {
    const ab = await fetchAB(url);
    cached = await decodeToPeaks(ab, targetBars);
    peaksSave(key, cached);
  }
  view.setData(cached.peaks, cached.duration);
}

// ------------- DAW-style row builder
function iconBtn(label) {
  const b = document.createElement("button");
  b.className = "icon-btn";
  b.type = "button";
  b.textContent = label; // swap to SVG later if desired
  return b;
}

async function buildStemRow(ref, index) {
  const accent = colorForStem(ref.name);

  const root = h("div", { class: "stem-row", "data-path": ref.path });

  // left gutter
  const gutter = h("div", { class: "row-gutter" });
  const idx = h("div", { class: "track-idx" }, document.createTextNode(String(index + 1)));
  const ctrls = h("div", { class: "row-ctrls" });
  const bPlay = iconBtn("▶"); bPlay.dataset.act = "play";
  const bMute = iconBtn("M"); bMute.dataset.act = "mute";
  const bSolo = iconBtn("S"); bSolo.dataset.act = "solo";
  ctrls.append(bPlay, bMute, bSolo);
  gutter.append(idx, ctrls);

  // header strip
  const header = h("div", { class: "row-header" });
  const dot = h("span", { class: "stem-dot" });
  dot.style.background = accent;
  const title = h("span", {}, document.createTextNode(ref.name));
  header.append(dot, title);

  // wave area
  const waveWrap = h("div", { class: "row-wave" });
  const canvas = h("canvas", { class: "wave", height: 110 });
  waveWrap.append(canvas);

  // resize handle
  const handle = h("div", { class: "resize-handle" });

  // assemble
  root.append(gutter, header, waveWrap, handle);

  // audio + waveform
  const audio = new Audio();
  audio.preload = "metadata";
  const url = await getTempLink(ref.path);
  audio.src = url;

  const wf = new WaveformView(canvas, {
    onSeek: (r) => {
      if (audio.duration) audio.currentTime = r * audio.duration;
    },
  });
  wf.setAccent(accent);

  await drawRealWaveform(wf, ref, url, canvas);
  audio.addEventListener("timeupdate", () => {
    if (audio.duration) wf.setProgress(audio.currentTime / audio.duration);
  });
  audio.addEventListener("loadedmetadata", () =>
    setStemMeta(ref, audio.duration)
  );

  // controls behavior
  ctrls.addEventListener("click", async (ev) => {
    const act = ev.target.dataset.act;
    if (!act) return;
    if (act === "play") {
      await ensureAudioContext();
      if (audio.paused) {
        await audio.play();
        ev.target.classList.add("active");
        root.classList.add("selected");
      } else {
        audio.pause();
        ev.target.classList.remove("active");
      }
    } else if (act === "mute") {
      audio.muted = !audio.muted;
      ev.target.classList.toggle("active", audio.muted);
    } else if (act === "solo") {
      const on = !ev.target.classList.contains("active");
      // clear solos, unmute all
      $$('.stem-row .row-ctrls [data-act="solo"]').forEach((b) =>
        b.classList.remove("active")
      );
      $$(".stem-row").forEach((r) => {
        if (r._audio) {
          r._audio.muted = false;
          const m = r.querySelector('[data-act="mute"]');
          m && m.classList.remove("active");
        }
      });
      if (on) {
        $$(".stem-row").forEach((r) => {
          if (r !== root && r._audio) {
            r._audio.muted = true;
            const m = r.querySelector('[data-act="mute"]');
            m && m.classList.add("active");
          }
        });
        ev.target.classList.add("active");
      }
    }
  });

  // click row to show metadata
  root.addEventListener("click", (e) => {
    if (e.target.closest(".row-ctrls") || e.target.classList.contains("resize-handle")) return;
    $$(".stem-row").forEach((r) => r.classList.remove("selected"));
    root.classList.add("selected");
    setStemMeta(ref, audio.duration || 0);
  });

  // drag-resize canvas height
  let drag = false,
    startY = 0,
    startH = canvas.clientHeight;
  const minH = 70,
    maxH = 220;
  handle.addEventListener("mousedown", (ev) => {
    drag = true;
    startY = ev.clientY;
    startH = canvas.clientHeight;
    document.body.style.cursor = "ns-resize";
  });
  window.addEventListener("mousemove", (ev) => {
    if (!drag) return;
    const dy = ev.clientY - startY;
    const nh = Math.max(minH, Math.min(maxH, startH + dy));
    canvas.style.height = nh + "px";
    wf.redraw();
  });
  window.addEventListener("mouseup", () => {
    if (drag) {
      drag = false;
      document.body.style.cursor = "";
    }
  });

  // expose for group transport
  root._audio = audio;
  return { root, audio, wf };
}

// ------------- master + stems rendering
function formatTime(sec) {
  sec = Math.max(0, sec | 0);
  const m = (sec / 60) | 0;
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}
function setStemMeta(ref, duration) {
  const box = $("#stemMeta");
  if (!box) return;
  box.innerHTML = "";
  const row = (k, v) =>
    h(
      "div",
      { class: "kv" },
      h("div", { class: "k", html: k }),
      h("div", { class: "v", html: v })
    );
  box.appendChild(row("Name", ref.name));
  box.appendChild(row("Path", `<code>${ref.path}</code>`));
  box.appendChild(
    row(
      "Size",
      typeof ref.size === "number" ? (ref.size / 1048576).toFixed(1) + " MB" : "—"
    )
  );
  box.appendChild(
    row(
      "Modified",
      ref.server_modified ? new Date(ref.server_modified).toLocaleString() : "—"
    )
  );
  box.appendChild(row("Duration", duration ? formatTime(duration) : "—"));
}

async function renderVersion(track, ver) {
  const main = $("#versionMain");
  if (!main) return;
  main.innerHTML = "";

  // Master card (FINAL → candidate → first mix)
  const masterRef =
    ver.masterFinal || ver.masterCandidates[0] || ver.mixes[0] || null;

  const masterCard = h("div", { class: "card master" });
  masterCard.appendChild(
    h(
      "div",
      { class: "card-head" },
      document.createTextNode(masterRef ? "Master" : "Master (not available — showing first mix if any)")
    )
  );
  const mCanvas = h("canvas", { class: "wave", height: 96 });
  const mBar = h(
    "div",
    { class: "player" },
    h("button", { class: "btn", id: "masterBtn" }, document.createTextNode("Play"))
  );
  masterCard.append(mCanvas, mBar);
  main.appendChild(masterCard);

  const mWF = new WaveformView(mCanvas, {
    onSeek: (r) => {
      if (mAudio.duration) mAudio.currentTime = r * mAudio.duration;
    },
  });
  const mAudio = new Audio();
  mAudio.preload = "metadata";
  if (masterRef) {
    const u = await getTempLink(masterRef.path);
    mAudio.src = u;
    await drawRealWaveform(mWF, masterRef, u, mCanvas);
  }
  mAudio.addEventListener("timeupdate", () => {
    if (mAudio.duration) mWF.setProgress(mAudio.currentTime / mAudio.duration);
  });
  $("#masterBtn").onclick = async () => {
    try {
      await ensureAudioContext();
      if (mAudio.paused) {
        await mAudio.play();
        $("#masterBtn").textContent = "Pause";
      } else {
        mAudio.pause();
        $("#masterBtn").textContent = "Play";
      }
    } catch (e) {
      alert("Playback failed: " + e);
    }
  };

  // Transport
  const tb = h(
    "div",
    { class: "toolbar" },
    h("button", { class: "btn", id: "playAll" }, document.createTextNode("Play All Stems")),
    h("button", { class: "btn", id: "stopAll" }, document.createTextNode("Stop"))
  );
  main.appendChild(tb);

  // Stacked lanes
  const stack = h("div", { class: "stack" });
  main.appendChild(stack);

  const stems = [...(ver.stems || [])].sort((a, b) =>
    a.name.localeCompare(b.name)
  );
  const rows = [];
  for (let i = 0; i < stems.length; i++) {
    const row = await buildStemRow(stems[i], i);
    rows.push(row);
    stack.appendChild(row.root);
  }

  $("#playAll").onclick = async () => {
    await ensureAudioContext();
    for (const r of rows) {
      try {
        r.audio.currentTime = 0;
        await r.audio.play();
      } catch {}
    }
  };
  $("#stopAll").onclick = () => {
    for (const r of rows) {
      r.audio.pause();
      r.audio.currentTime = 0;
    }
  };
}

// ------------- track/tab flow
async function showTrack(name) {
  const paneTitle = $(".pane-head .title");
  if (paneTitle) paneTitle.textContent = name;

  const track = await j(`/api/tracks/${encodeURIComponent(name)}`);
  const versions = makeVersions(track);

  renderVersionTabs(versions, (v) => renderVersion(track, v));
  if (versions.length) renderVersion(track, versions[0]);
  else {
    const main = $("#versionMain");
    if (main) {
      main.innerHTML = "";
      main.appendChild(
        h(
          "div",
          { class: "empty-state" },
          h("p", { html: "No versions (stems/mixes/masters) found for this track." })
        )
      );
    }
  }
}

async function loadTracks() {
  const ul = $("#trackList");
  if (!ul) return;
  ul.innerHTML = "";
  let tracks = await j("/api/tracks");
  if (!Array.isArray(tracks)) tracks = [];
  const q = $("#filter")?.value?.toLowerCase().trim();

  tracks.forEach((t) => {
    if (q && !t.name.toLowerCase().includes(q)) return;
    const li = h(
      "li",
      {},
      document.createTextNode(t.name)
    );
    li.onclick = () => showTrack(t.name);
    ul.appendChild(li);
  });

  if (!ul.children.length) {
    ul.appendChild(
      h("li", {}, document.createTextNode("No tracks found."))
    );
  }
}

// ------------- wire up header controls + boot
$("#refresh")?.addEventListener("click", async () => {
  try {
    await j("/api/reindex", { method: "POST" });
    await loadTracks();
  } catch (e) {
    alert("Reindex failed: " + e);
  }
});
$("#filter")?.addEventListener("input", () => loadTracks());

loadTracks().catch(console.error);

