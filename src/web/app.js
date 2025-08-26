async function j(url, opts={}) {
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

async function loadTracks() {
  const list = document.getElementById('trackList');
  list.innerHTML = '';
  const tracks = await j('/api/tracks');
  for (const t of tracks) {
    const li = document.createElement('li');
    li.textContent = t.name;
    li.onclick = () => loadTrack(t.name);
    list.appendChild(li);
  }
}

function el(tag, attrs={}, children=[]) {
  const e = document.createElement(tag);
  for (const [k,v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v; else if (k === 'html') e.innerHTML = v; else e.setAttribute(k, v);
  }
  for (const c of children) e.appendChild(c);
  return e;
}

async function tempLink(p) {
  const { url } = await j(`/api/link?path=${encodeURIComponent(p)}`);
  return url;
}

function fileRow(ref) {
  const row = el('div', { class: 'row' });
  const name = el('div', { class: 'cell grow', html: ref.name });
  const btnPlay = el('button', { class: 'btn' });
  btnPlay.textContent = 'Play';
  const audio = el('audio', { controls: true });
  btnPlay.onclick = async () => {
    btnPlay.disabled = true;
    try { audio.src = await tempLink(ref.path); audio.play(); }
    catch (e) { alert('Failed: '+e); }
    finally { btnPlay.disabled = false; }
  };
  const btnLink = el('a', { class: 'btn', href: '#', title: 'Open link', });
  btnLink.textContent = 'Open';
  btnLink.onclick = async (ev) => { ev.preventDefault(); window.open(await tempLink(ref.path), '_blank'); };
  row.appendChild(name); row.appendChild(btnPlay); row.appendChild(btnLink); row.appendChild(audio);
  return row;
}

function groupHeader(title) { return el('h3', { html: title }); }

async function loadTrack(name) {
  const d = document.getElementById('detail');
  d.innerHTML = '';
  const t = await j(`/api/tracks/${encodeURIComponent(name)}`);
  d.appendChild(el('h2', { html: t.name }));

  // Ableton
  if (t.ableton?.length) {
    d.appendChild(groupHeader('Ableton Saves & Bounces'));
    for (const s of t.ableton) {
      const wrap = el('div', { class: 'card' });
      wrap.appendChild(el('div', { class: 'pill', html: `T1 ${s.t1}` }));
      if (s.als) wrap.appendChild(fileRow(s.als));
      if (s.wav) wrap.appendChild(fileRow(s.wav));
      if (s.mp3) wrap.appendChild(fileRow(s.mp3));
      d.appendChild(wrap);
    }
  }

  // Stems
  if (t.stems?.length) {
    d.appendChild(groupHeader('Stem Sets'));
    for (const set of t.stems) {
      const wrap = el('div', { class: 'card' });
      wrap.appendChild(el('div', { class: 'pill', html: `T1 ${set.t1} — T2 ${set.t2}` }));
      for (const st of set.stems) wrap.appendChild(fileRow(st));
      d.appendChild(wrap);
    }
  }

  // Mixes (Unmastered)
  if (t.mixes?.length) {
    d.appendChild(groupHeader('Unmastered Mixes'));
    for (const m of t.mixes) {
      const wrap = el('div', { class: 'card' });
      wrap.appendChild(el('div', { class: 'pill', html: `T1 ${m.t1} — T2 ${m.t2}` }));
      wrap.appendChild(fileRow(m.file));
      d.appendChild(wrap);
    }
  }

  // Masters
  if (t.masters?.length) {
    d.appendChild(groupHeader('Masters'));
    for (const ms of t.masters) {
      const wrap = el('div', { class: 'card' });
      wrap.appendChild(el('div', { class: 'pill', html: `T1 ${ms.t1} — T2 ${ms.t2}` }));
      if (ms.final) {
        const finalHdr = el('div', { class: 'sub', html: 'FINAL' });
        wrap.appendChild(finalHdr);
        wrap.appendChild(fileRow(ms.final));
      }
      if (ms.candidates?.length) {
        wrap.appendChild(el('div', { class: 'sub', html: 'Candidates' }));
        for (const c of ms.candidates) wrap.appendChild(fileRow(c));
      }
      d.appendChild(wrap);
    }
  }
}

document.getElementById('refresh').onclick = async () => {
  try { await j('/api/reindex', { method: 'POST' }); await loadTracks(); }
  catch (e) { alert('Reindex failed: '+e); }
};

loadTracks();

