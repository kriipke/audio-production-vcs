// --- tiny fetch helper
async function j(url, opts={}) { const r = await fetch(url, opts); if (!r.ok) throw new Error(await r.text()); return r.json(); }

// --- caches
const linkCache = new Map(); // path -> temp link
const audioPool = new Map(); // path -> HTMLAudioElement

// --- utilities
function $(s, el=document){ return el.querySelector(s); }
function $all(s, el=document){ return [...el.querySelectorAll(s)]; }
function h(tag, attrs={}, ...children){
  const e = document.createElement(tag);
  for (const [k,v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k === 'html') e.innerHTML = v;
    else e.setAttribute(k, v);
  }
  for (const c of children) if (c) e.appendChild(c);
  return e;
}

// Deterministic pseudo-random for dummy waveforms
function seedRand(str){
  let h = 2166136261 >>> 0; for (let i=0;i<str.length;i++){ h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return () => { h += 0x6D2B79F5; let t = Math.imul(h ^ h>>>15, 1 | h); t ^= t + Math.imul(t ^ t>>>7, 61 | t); return ((t ^ t>>>14) >>> 0) / 4294967296; };
}

function drawWaveform(canvas, key){
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height; ctx.clearRect(0,0,w,h);
  const rnd = seedRand(key);
  ctx.lineWidth = 2; ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--wf');
  ctx.beginPath();
  let y = h/2; ctx.moveTo(0, y);
  for (let x=0; x<w; x++) {
    const amp = (rnd()*2-1) * (h*0.35) * (0.6 + 0.4*Math.sin(x/37));
    y = h/2 + amp;
    ctx.lineTo(x, y);
  }
  ctx.stroke();
}

async function getTempLink(path){
  if (linkCache.has(path)) return linkCache.get(path);
  const { url } = await j(`/api/link?path=${encodeURIComponent(path)}`);
  linkCache.set(path, url); return url;
}

function buildVersions(track){
  // Map key = `${t1}-${t2}` -> { stems:[], mixes:[], masterFinal:null, masterCandidates:[] }
  const map = new Map();
  for (const s of (track.stems||[])){
    const key = `${s.t1}-${s.t2}`;
    const ent = map.get(key) || { t1:s.t1, t2:s.t2, stems:[], mixes:[], masterFinal:null, masterCandidates:[] };
    for (const st of s.stems) ent.stems.push(st);
    map.set(key, ent);
  }
  for (const m of (track.mixes||[])){
    const key = `${m.t1}-${m.t2}`;
    const ent = map.get(key) || { t1:m.t1, t2:m.t2, stems:[], mixes:[], masterFinal:null, masterCandidates:[] };
    ent.mixes.push(m.file); map.set(key, ent);
  }
  for (const ms of (track.masters||[])){
    const key = `${ms.t1}-${ms.t2}`;
    const ent = map.get(key) || { t1:ms.t1, t2:ms.t2, stems:[], mixes:[], masterFinal:null, masterCandidates:[] };
    if (ms.final) ent.masterFinal = ms.final;
    for (const c of (ms.candidates||[])) ent.masterCandidates.push(c);
    map.set(key, ent);
  }
  return [...map.values()].sort((a,b)=> a.t1===b.t1 ? (a.t2<b.t2?-1:1) : (a.t1<b.t1?-1:1));
}

async function loadTracks(){
  const listEl = $('#trackList'); listEl.innerHTML = '';
  let tracks = await j('/api/tracks'); if (!Array.isArray(tracks)) tracks = [];
  const filter = $('#filter').value?.trim().toLowerCase();
  for (const t of tracks){
    if (filter && !t.name.toLowerCase().includes(filter)) continue;
    const li = h('li', {class:'item'});
    li.appendChild(h('button', {class:'link'}, document.createTextNode(t.name)));
    li.querySelector('button').onclick = () => showTrack(t.name);
    listEl.appendChild(li);
  }
  if (!listEl.children.length) listEl.appendChild(h('li', {class:'muted'}, document.createTextNode('No tracks found.')));
}

$('#filter').addEventListener('input', () => loadTracks());
$('#refresh').onclick = async () => { try { await j('/api/reindex', {method:'POST'}); await loadTracks(); } catch(e){ alert('Reindex failed: '+e); } };

async function showTrack(name){
  const pane = $('#versionPane'); pane.innerHTML = '';
  const t = await j(`/api/tracks/${encodeURIComponent(name)}`);
  const versions = buildVersions(t);

  const head = h('div', {class:'pane-head'}, h('div', {class:'title'}, document.createTextNode(t.name)));
  pane.appendChild(head);

  if (!versions.length){
    pane.appendChild(h('div', {class:'empty-state'}, h('p', {html:'No versions (stems/mixes/masters) found for this track.'}))); return;
  }

  // version selector tabs
  const tabs = h('div', {class:'tabs'});
  versions.forEach((v,i)=>{
    const btn = h('button', {class:'tab'+(i===0?' active':'')}, document.createTextNode(`${v.t1} — ${v.t2}`));
    btn.onclick = () => { $all('.tab', tabs).forEach(b=>b.classList.remove('active')); btn.classList.add('active'); renderVersion(pane, t, v); };
    tabs.appendChild(btn);
  });
  pane.appendChild(tabs);

  // grid
  const wrap = h('div', {class:'version-grid'});
  wrap.appendChild(h('div', {class:'version-main', id:'versionMain'}));
  wrap.appendChild(h('aside', {class:'version-aside', id:'versionAside'},
    h('h3', {html:'Stem Info'}),
    h('div', {class:'meta', id:'stemMeta'}, h('p', {class:'muted', html:'Select a stem to see details.'}))
  ));
  pane.appendChild(wrap);

  renderVersion(pane, t, versions[0]);
}

function setStemMeta(ref, duration){
  const box = $('#stemMeta'); box.innerHTML = '';
  const row = (k,v)=> h('div',{class:'kv'}, h('div',{class:'k',html:k}), h('div',{class:'v',html:v}));
  box.appendChild(row('Name', ref.name));
  box.appendChild(row('Path', `<code>${ref.path}</code>`));
  box.appendChild(row('Size', typeof ref.size==='number'? (ref.size/1048576).toFixed(1)+' MB':'—'));
  box.appendChild(row('Modified', ref.server_modified? new Date(ref.server_modified).toLocaleString(): '—'));
  box.appendChild(row('Duration', duration? formatTime(duration): '—'));
}

function formatTime(sec){ sec = Math.max(0, sec|0); const m = (sec/60)|0; const s = sec%60; return `${m}:${s.toString().padStart(2,'0')}`; }

async function renderVersion(pane, track, ver){
  const main = $('#versionMain'); main.innerHTML='';

  // ---- Master player (FINAL if exists, else first candidate, else first mix)
  let masterRef = ver.masterFinal || (ver.masterCandidates[0]||null) || (ver.mixes[0]||null);
  const masterCard = h('div', {class:'card master'});
  masterCard.appendChild(h('div', {class:'card-head'}, document.createTextNode(masterRef? 'Master':'Master (not available — showing first mix if any)')));
  const masterControls = h('div', {class:'player'});
  const masterCanvas = h('canvas', {width: 900, height: 84, class:'wave'});
  drawWaveform(masterCanvas, masterRef? masterRef.path : `${track.name}-${ver.t1}-${ver.t2}-master`);
  const masterBtn = h('button', {class:'btn'}, document.createTextNode('Play'));
  const masterAudio = new Audio(); masterAudio.preload = 'metadata';
  if (masterRef){ getTempLink(masterRef.path).then(u=> masterAudio.src = u); }
  masterBtn.onclick = async ()=>{ try { if (masterAudio.paused) { await masterAudio.play(); masterBtn.textContent = 'Pause'; } else { masterAudio.pause(); masterBtn.textContent = 'Play'; } } catch(e){ alert('Playback failed: '+e); } };
  masterControls.appendChild(masterBtn); masterControls.appendChild(masterCanvas);
  masterCard.appendChild(masterControls);
  main.appendChild(masterCard);

  // ---- Stems toolbar
  const tb = h('div', {class:'toolbar'},
    h('button', {class:'btn', id:'playAll'}, document.createTextNode('Play All Stems')),
    h('button', {class:'btn', id:'stopAll'}, document.createTextNode('Stop'))
  );
  main.appendChild(tb);

  // ---- Stacked stems
  const stack = h('div', {class:'stack'});
  main.appendChild(stack);

  const stems = [...(ver.stems||[])].sort((a,b)=> a.name.localeCompare(b.name));
  stems.forEach(ref=>{
    const row = h('div', {class:'stem-row'});
    const label = h('div', {class:'stem-label'}, document.createTextNode(ref.name));
    const canvas = h('canvas', {class:'wave', width: 900, height: 54}); drawWaveform(canvas, ref.path);
    const btnPlay = h('button', {class:'btn sm'}, document.createTextNode('Play'));
    const btnMute = h('button', {class:'btn sm'}, document.createTextNode('Mute'));
    const btnSolo = h('button', {class:'btn sm'}, document.createTextNode('Solo'));

    row.appendChild(label); row.appendChild(canvas); row.appendChild(btnPlay); row.appendChild(btnMute); row.appendChild(btnSolo);
    stack.appendChild(row);

    // audio element per stem (lazy)
    let audio = audioPool.get(ref.path);
    if (!audio){
      audio = new Audio(); audio.preload = 'metadata'; audioPool.set(ref.path, audio);
      getTempLink(ref.path).then(u=>{ audio.src = u; });
      audio.addEventListener('loadedmetadata', ()=> setStemMeta(ref, audio.duration));
    }

    row.onclick = (ev)=>{ if (ev.target.tagName === 'BUTTON') return; setStemMeta(ref, audio.duration||0); };

    btnPlay.onclick = async ()=>{
      try{
        if (audio.paused) { await audio.play(); btnPlay.textContent='Pause'; }
        else { audio.pause(); btnPlay.textContent='Play'; }
      } catch(e){ alert('Playback failed: '+e); }
    };

    btnMute.onclick = ()=>{ audio.muted = !audio.muted; btnMute.classList.toggle('active', audio.muted); };
    btnSolo.onclick = ()=>{
      const isSolo = !btnSolo.classList.contains('active');
      // clear all solos first
      $all('.stem-row .btn.sm:nth-child(5)').forEach(b=> b.classList.remove('active'));
      // unmute all
      stems.forEach(s=>{ const a = audioPool.get(s.path); if (a) a.muted = false; });
      if (isSolo){
        // solo this: mute others
        stems.forEach(s=>{ const a = audioPool.get(s.path); if (a && s.path !== ref.path) a.muted = true; });
        btnSolo.classList.add('active');
      }
    };
  });

  // global play/stop
  $('#playAll').onclick = async ()=>{
    for (const ref of stems){
      const a = audioPool.get(ref.path); if (!a) continue;
      try { a.currentTime = 0; await a.play(); } catch(_) {}
    }
  };
  $('#stopAll').onclick = ()=>{ stems.forEach(ref=>{ const a = audioPool.get(ref.path); if (a) { a.pause(); a.currentTime = 0; } }); };
}

// boot
loadTracks().catch(e=> console.error(e));

