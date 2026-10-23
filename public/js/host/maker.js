// Settings → Karaoke maker (PLAN §31): autokaraoke's windows, in OpenKaraoke. Make a karaoke
// track from a song on this computer, an upload or a link (the lyrics pasted in), follow each job
// step by step, then queue the new song; the maker's settings; and autokaraoke on this computer —
// the checks, installing it from ~/Projects/autokaraoke, downloading the models. The work runs on
// the server (server/maker/); this page only asks and shows state.maker.
import { html, useRef, useState } from '../vendor/preact.js';
import { Icon } from '../lib/icons.js';
import { Switch, Spinner } from '../lib/components.js';
import { act, toast, openDialog, chooseFolder, chooseSongFile, saveSetting } from './state.js';

const LANGUAGES = [['en', 'English'], ['fi', 'Finnish'], ['sv', 'Swedish'], ['no', 'Norwegian'], ['da', 'Danish'], ['de', 'German'],
  ['nl', 'Dutch'], ['fr', 'French'], ['es', 'Spanish'], ['it', 'Italian'], ['pt', 'Portuguese'], ['pl', 'Polish'], ['ja', 'Japanese'], ['ko', 'Korean'], ['zh', 'Chinese']];
const THEMES = [['classic', 'Classic (amber)'], ['blue', 'Blue'], ['green', 'Green']];
const WHISPER = [['small', 'Small — 0.5 GB, quickest'], ['medium', 'Medium — 1.5 GB (recommended)'], ['turbo', 'Turbo — 1.6 GB'], ['large-v3', 'Large — 3.1 GB, best on hard songs (≈10 GB of graphics memory)']];
const DEMUCS = [['htdemucs', 'Standard (recommended)'], ['htdemucs_ft', 'Fine-tuned — cleaner, about 4× slower']];
const STEPS = [['download', 'Download'], ['separate', 'Remove the singer'], ['timing', 'Time the lyrics'], ['cdg', 'Draw the lyrics'], ['done', 'Done']];
const STATUS = { queued: 'Waiting its turn', waiting: 'Waiting for the song to end', running: 'Working', done: 'Done', failed: 'Didn’t work', cancelled: 'Cancelled' };
const ACCEPT = '.mp3,.m4a,.aac,.flac,.wav,.ogg,.opus,.wma,.aiff,.aif,.mp4,.m4v,.mkv,.webm,.mov,audio/*';

// The form survives a trip to another settings page (not a reload).
const draft = { mode: 'file', path: '', url: '', upload: null, artist: '', title: '', lyrics: '', language: '', theme: '' };

/** A song file from this browser → the server (XHR for the progress). */
function uploadFile(file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/maker/upload');
    xhr.setRequestHeader('content-type', 'application/octet-stream');
    xhr.setRequestHeader('x-file-name', encodeURIComponent(file.name));
    const token = localStorage.getItem('ok.hostToken');
    if (token) xhr.setRequestHeader('authorization', `Bearer ${token}`);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    xhr.onload = () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText); } catch { /* not JSON */ }
      if (xhr.status === 200 && data.upload) resolve(data.upload);
      else reject(new Error(data.error || `Upload failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error('The upload did not finish.'));
    xhr.send(file);
  });
}

const sizeText = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`);
const baseName = (p) => String(p || '').split('/').pop();
function guessNames(file) {
  const stem = baseName(file).replace(/\.[^.]+$/, '');
  const i = stem.indexOf(' - ');
  return i > 0 ? { artist: stem.slice(0, i).trim(), title: stem.slice(i + 3).trim() } : { artist: '', title: stem.trim() };
}

function MakeForm({ settings }) {
  const [f, setF] = useState(() => ({ ...draft, language: draft.language || settings.language, theme: draft.theme || settings.theme }));
  const [upPct, setUpPct] = useState(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef(null);
  const lyricsRef = useRef(null);
  const set = (patch) => setF((cur) => {
    const next = { ...cur, ...patch };
    Object.assign(draft, next);
    return next;
  });
  /** A song was picked: fill in artist and title from "Artist - Title.mp3" when they are empty. */
  const named = (name, patch) => {
    const g = guessNames(name);
    set({ ...patch, ...(!f.artist && !f.title ? g : {}) });
  };
  const upload = async (file) => {
    if (!file) return;
    setUpPct(0);
    try {
      const up = await uploadFile(file, setUpPct);
      named(up.name, { upload: up, mode: 'upload' });
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setUpPct(null);
      if (fileRef.current) fileRef.current.value = '';
    }
  };
  const loadLyrics = (file) => {
    if (!file) return;
    file.text().then((text) => set({ lyrics: text.slice(0, 50000) }), () => toast('Could not read that file', 'error'));
    if (lyricsRef.current) lyricsRef.current.value = '';
  };
  const song = f.mode === 'upload' ? (f.upload ? { upload: f.upload.id } : null)
    : f.mode === 'link' ? (f.url.trim() ? { url: f.url.trim() } : null)
      : (f.path ? { path: f.path } : null);
  const make = async () => {
    if (!song) return toast(f.mode === 'link' ? 'Paste a link first' : 'Choose a song first', 'error');
    setBusy(true);
    const r = await act('maker.make', { song, artist: f.artist, title: f.title, language: f.language, theme: f.theme, lyrics: f.lyrics });
    setBusy(false);
    if (!r) return undefined;
    toast(`Making “${r.title || r.label}”…`, 'ok');
    set({ path: '', url: '', upload: null, artist: '', title: '', lyrics: '' });
    return undefined;
  };
  return html`<div class="mk-card mk-form">
    <h3 class="mk-title"><${Icon} name="sparkles" size=${18} /> Make a karaoke track</h3>
    <div class="mk-field">
      <span class="mk-label">Song</span>
      <div class="segmented" role="group" aria-label="Where the song is">
        ${[['file', 'On this computer'], ['upload', 'Upload'], ['link', 'Link']].map(([id, label]) => html`<button class=${f.mode === id ? 'on' : ''} onClick=${() => set({ mode: id })}>${label}</button>`)}
      </div>
      ${f.mode === 'file' && html`<div class="mk-pick">
        <span class=${`mk-chosen ellipsis ${f.path ? '' : 'muted'}`}>${f.path ? baseName(f.path) : 'No song chosen'}</span>
        <button class="btn" onClick=${() => chooseSongFile((p) => named(p, { path: p }))}><${Icon} name="folder" size=${16} /> Choose…</button>
      </div>`}
      ${f.mode === 'upload' && html`<div class="mk-pick">
        <span class=${`mk-chosen ellipsis ${f.upload ? '' : 'muted'}`}>${upPct !== null ? `Uploading… ${Math.round(upPct * 100)} %` : f.upload ? `${f.upload.name} · ${sizeText(f.upload.size)}` : 'From this device: an MP3, M4A, FLAC, WAV…'}</span>
        <label class=${`btn ${upPct !== null ? 'disabled' : ''}`}><${Icon} name="download" size=${16} /> Upload…
          <input ref=${fileRef} type="file" accept=${ACCEPT} hidden disabled=${upPct !== null} onChange=${(e) => upload(e.currentTarget.files?.[0])} /></label>
      </div>`}
      ${f.mode === 'link' && html`<input class="input" type="url" value=${f.url} placeholder="https://www.youtube.com/watch?v=…" aria-label="Link to the song"
        onInput=${(e) => set({ url: e.currentTarget.value })} />
        <p class="hint">Only songs you have the right to use — your own uploads, or music whose owner allows it (YouTube’s terms restrict downloading).</p>`}
    </div>
    <div class="row-2">
      <label class="field"><span>Artist</span><input class="input" value=${f.artist} maxlength="120" onInput=${(e) => set({ artist: e.currentTarget.value })} /></label>
      <label class="field"><span>Title</span><input class="input" value=${f.title} maxlength="120" onInput=${(e) => set({ title: e.currentTarget.value })} /></label>
    </div>
    <div class="row-2">
      <label class="field"><span>Language of the lyrics</span>
        <select class="select" value=${f.language} onChange=${(e) => set({ language: e.currentTarget.value })}>
          ${LANGUAGES.map(([v, l]) => html`<option value=${v}>${l}</option>`)}
        </select></label>
      <label class="field"><span>Lyrics colours</span>
        <select class="select" value=${f.theme} onChange=${(e) => set({ theme: e.currentTarget.value })}>
          ${THEMES.map(([v, l]) => html`<option value=${v}>${l}</option>`)}
        </select></label>
    </div>
    <label class="field mk-lyrics"><span>Lyrics</span>
      <textarea class="input" rows="8" value=${f.lyrics} placeholder=${'One sung line per line.\nWrite repeats out in full. Lines like [Chorus] are skipped.'}
        onInput=${(e) => set({ lyrics: e.currentTarget.value })}></textarea></label>
    <div class="mk-row">
      <label class="btn small ghost"><${Icon} name="edit" size=${14} /> Load a lyrics file…
        <input ref=${lyricsRef} type="file" accept=".txt,text/plain" hidden onChange=${(e) => loadLyrics(e.currentTarget.files?.[0])} /></label>
      <span class="hint grow">${f.lyrics.trim() ? `${f.lyrics.trim().split('\n').filter((l) => l.trim()).length} lines` : 'Empty: autokaraoke writes down what it hears — check it afterwards.'}</span>
    </div>
    <div class="btn-row">
      <button class="btn primary" disabled=${busy || !song || upPct !== null} onClick=${make}><${Icon} name="sparkles" size=${16} /> Make karaoke</button>
    </div>
  </div>`;
}

function JobSteps({ job }) {
  const steps = STEPS.filter(([id]) => id !== 'download' || job.kind === 'url');
  const at = steps.findIndex(([id]) => id === job.stage);
  return html`<ol class="mk-steps">${steps.map(([id, label], i) => {
    const state = job.status === 'done' || i < at ? 'done' : i === at && job.status === 'running' ? 'now' : i === at && job.status === 'failed' ? 'bad' : '';
    return html`<li class=${state}><span class="mk-dot">${state === 'done' ? html`<${Icon} name="check" size=${12} />` : i + 1}</span>${label}</li>`;
  })}</ol>`;
}

function Job({ job, songs }) {
  const finished = !!job.finishedAt;
  const name = job.title ? `${job.artist ? `${job.artist} – ` : ''}${job.title}` : job.label;
  const r = job.result;
  const song = r?.songId && songs !== false;
  return html`<div class=${`mk-card mk-job ${job.status}`} data-job=${job.id}>
    <div class="mk-job-head">
      <b class="ellipsis">${name}</b>
      <span class=${`pill mk-state ${job.status}`}>${STATUS[job.status] || job.status}</span>
    </div>
    <${JobSteps} job=${job} />
    ${job.status === 'running' && html`<div class="mk-bar" role="progressbar" aria-valuenow=${job.percent} aria-valuemin="0" aria-valuemax="100"><i style=${`width:${Math.max(3, job.percent)}%`}></i></div>`}
    ${job.status === 'running' && job.bar && html`<p class="hint mono ellipsis">${job.bar}</p>`}
    ${job.status === 'waiting' && html`<p class="hint">This computer has no graphics card, so the room’s sound comes first: it starts when the song ends.</p>`}
    ${job.status === 'failed' && html`<p class="warn-text">${job.error || 'autokaraoke stopped.'}</p>`}
    ${job.status === 'done' && r && html`<div class="mk-result">
      ${r.scanning ? html`<span class="hint"><${Spinner} /> Adding it to the library…</span>`
        : song ? html`<span class="hint">In the library now.</span>
          <button class="btn small primary" onClick=${() => openDialog({ type: 'add', songId: r.songId, trackId: r.trackId })}><${Icon} name="plus" size=${14} /> Queue it</button>
          <button class="btn small" onClick=${() => openDialog({ type: 'song', songId: r.songId })}>Song details</button>`
          : html`<span class="hint">Saved in ${job.out}.</span>`}
    </div>`}
    <div class="mk-row">
      <details class="mk-log-box"><summary>What autokaraoke said</summary><pre class="mk-log">${job.lines.join('\n') || '…'}</pre></details>
      ${job.status === 'waiting' && html`<button class="btn small" onClick=${() => act('maker.now', { id: job.id })}>Start now</button>`}
      ${!finished && html`<button class="btn small ghost danger" onClick=${() => act('maker.cancel', { id: job.id })}>Cancel</button>`}
      ${finished && html`<button class="btn small ghost" onClick=${() => act('maker.dismiss', { id: job.id })}>Remove</button>`}
    </div>
  </div>`;
}

function Check({ ok, title, children }) {
  const cls = ok === true ? 'ok' : ok === false ? 'fail' : 'warn';
  return html`<li class=${cls}><span class="hs-mark"><${Icon} name=${ok === true ? 'check' : 'alert'} size=${13} /></span><div><b>${title}</b>${children && html`<p class="hint">${children}</p>`}</div></li>`;
}

/** What this computer has, and autokaraoke's models (the installer window's checks). */
function Checks({ m }) {
  const c = m.checks;
  if (!c) return html`<p class="hint">${m.checking ? 'Looking at this computer…' : 'Not checked yet.'}</p>`;
  const ff = { ready: [true, 'Ready, with the MP3 encoder.'], 'no-mp3': [false, 'This FFmpeg has no MP3 encoder (libmp3lame). Fedora: install ffmpeg from RPM Fusion.'],
    missing: [false, 'Not installed. Ubuntu: sudo apt install ffmpeg · Fedora: sudo dnf install ffmpeg-free'] }[c.ffmpeg] || [null, ''];
  return html`<ul class="hs-checks mk-checks">
    <${Check} ok=${m.where?.installed ? true : m.where?.hasRoot ? null : false} title="autokaraoke">
      ${m.where?.installed ? `${c.version || 'Installed'} in ${m.where.root}` : m.where?.hasRoot ? `Found in ${m.where.root}, not installed yet.` : `Not found in ${m.where?.root || '~/Projects/autokaraoke'}.`}
    </${Check}>
    <${Check} ok=${!!c.python} title="Python">${c.python ? `${c.python}` : 'Python 3.10 or newer is needed.'}</${Check}>
    <${Check} ok=${ff[0]} title="FFmpeg">${ff[1]}</${Check}>
    <${Check} ok=${c.gpu ? true : null} title="Graphics card">${c.gpu || 'No NVIDIA graphics card found: the processor does the work, a few minutes a song.'}</${Check}>
    ${c.setup?.models.map((x) => html`<${Check} ok=${x.ready} title=${`${x.kind === 'demucs' ? 'Vocal remover' : 'Lyric timer'} · ${x.name}`}>${x.ready ? `Downloaded${x.size ? `, ${x.size}` : ''}.` : 'Not downloaded yet (needs the internet once).'}</${Check}>`)}
    ${c.setup && html`<${Check} ok=${c.setup.offline ? true : null} title="Space used">${`Models ${c.setup.total || '—'}${c.setup.software ? ` · Python environment ${c.setup.software}` : ''}. ${c.setup.offline ? 'Works without the internet (except links).' : ''}`}</${Check}>`}
  </ul>`;
}

/** Installing or downloading: its progress and log. */
function Task({ task }) {
  if (!task) return null;
  const word = { install: 'Installing autokaraoke', setup: 'Downloading the models' }[task.kind];
  const done = { done: 'Done.', failed: 'It didn’t work — the details are below.', cancelled: 'Cancelled.' }[task.status];
  return html`<div class=${`mk-card mk-task ${task.status}`}>
    <div class="mk-job-head"><b>${word}</b><span class=${`pill mk-state ${task.status}`}>${task.status === 'running' ? 'Working' : done}</span></div>
    ${task.status === 'running' && html`<div class="mk-bar indeterminate"><i></i></div>`}
    ${task.bar && task.status === 'running' && html`<p class="hint mono ellipsis">${task.bar}</p>`}
    <pre class="mk-log">${task.lines.join('\n') || '…'}</pre>
    ${task.status === 'running' && html`<div class="btn-row"><button class="btn small ghost danger" onClick=${() => act('maker.cancelTask')}>Cancel</button></div>`}
  </div>`;
}

function InstallBlock({ m }) {
  const gpu = !!m.checks?.gpu;
  const [onGpu, setOnGpu] = useState(gpu);
  const [youtube, setYoutube] = useState(true);
  const running = m.task?.status === 'running';
  if (!m.where?.hasRoot) {
    return html`<div class="mk-card">
      <h3 class="mk-title"><${Icon} name="alert" size=${18} /> autokaraoke is not on this computer</h3>
      <p>The Karaoke maker uses your copy of autokaraoke (the SongGetter repository) in <code>${m.where?.root || '~/Projects/autokaraoke'}</code>. Put it there, then check again.</p>
      <div class="btn-row"><button class="btn" disabled=${m.checking} onClick=${() => act('maker.check')}><${Icon} name="refresh" size=${16} /> Check again</button></div>
    </div>`;
  }
  return html`<div class="mk-card">
    <h3 class="mk-title"><${Icon} name="download" size=${18} /> Install autokaraoke</h3>
    <p class="hint">It downloads the vocal remover and the lyric timer once — about ${onGpu ? '8' : '4'} GB, and the internet is needed this one time. Everything stays in <code>${m.where.root}</code>.</p>
    <div class="setting">
      <div class="setting-text"><b>Remove the singer on</b><p class="hint">${gpu ? `The graphics card (${m.checks.gpu}) is much quicker.` : 'No NVIDIA graphics card was found.'}</p></div>
      <div class="setting-control"><select class="select" value=${onGpu ? 'gpu' : 'cpu'} disabled=${!gpu} onChange=${(e) => setOnGpu(e.currentTarget.value === 'gpu')}>
        <option value="gpu">The graphics card</option><option value="cpu">The processor only</option></select></div>
    </div>
    <div class="setting bool">
      <div class="setting-text"><b>Songs from YouTube links</b></div>
      <div class="setting-control"><${Switch} checked=${youtube} label="Songs from YouTube links" onChange=${setYoutube} /></div>
    </div>
    <div class="btn-row"><button class="btn primary" disabled=${running || m.checks?.ffmpeg === 'missing' || !m.checks?.python} onClick=${() => act('maker.install', { gpu: onGpu, youtube })}>
      <${Icon} name="download" size=${16} /> Install</button></div>
  </div>`;
}

function MakerSettings({ settings, m }) {
  const save = (key, value) => saveSetting(`maker.${key}`, value);
  return html`
    <h3 class="section-title">Making songs</h3>
    <div class="setting">
      <div class="setting-text"><b>Save new songs in</b><p class="hint mono ellipsis">${m.out}</p></div>
      <div class="setting-control"><button class="btn" onClick=${() => chooseFolder((p) => save('out', p))}><${Icon} name="folder" size=${16} /> Change…</button></div>
    </div>
    <div class="setting bool">
      <div class="setting-text"><b>Add them to the library</b><p class="hint">The folder becomes one of your karaoke folders and is scanned after each new song.</p></div>
      <div class="setting-control"><${Switch} checked=${settings.addToLibrary} label="Add them to the library" onChange=${(v) => save('addToLibrary', v)} /></div>
    </div>
    <div class="setting">
      <div class="setting-text"><b>Lyric timer</b><p class="hint">A bigger model times hard songs better, and is slower.</p></div>
      <div class="setting-control"><select class="select" value=${settings.whisperModel} onChange=${(e) => save('whisperModel', e.currentTarget.value)}>${WHISPER.map(([v, l]) => html`<option value=${v}>${l}</option>`)}</select></div>
    </div>
    <div class="setting">
      <div class="setting-text"><b>Vocal remover</b></div>
      <div class="setting-control"><select class="select" value=${settings.demucsModel} onChange=${(e) => save('demucsModel', e.currentTarget.value)}>${DEMUCS.map(([v, l]) => html`<option value=${v}>${l}</option>`)}</select></div>
    </div>
    ${!m.checks?.gpu && html`<div class="setting bool">
      <div class="setting-text"><b>Make songs while someone sings</b><p class="hint">Without a graphics card it takes the processor’s time from the TV: off, a new song waits for the one on stage to end (you can still start it at once).</p></div>
      <div class="setting-control"><${Switch} checked=${settings.duringSongs} label="Make songs while someone sings" onChange=${(v) => save('duringSongs', v)} /></div>
    </div>`}`;
}

export function MakerSection({ state }) {
  const m = state.maker;
  const settings = state.settings.maker;
  if (!m?.enabled) return html`<p class="muted">The Karaoke maker isn’t available on this server.</p>`;
  const installed = !!m.where?.installed;
  const missing = m.checks?.setup?.models.filter((x) => !x.ready) || [];
  const running = m.task?.status === 'running';
  return html`<div class="maker">
    <p class="muted mk-intro">Turn any song into a karaoke track with autokaraoke: it removes the singer, times the lyrics you paste, draws the lyrics screen and adds the song to the library.</p>
    ${installed && missing.length > 0 && html`<div class="banner warn mk-banner"><${Icon} name="alert" size=${18} />
      <div class="grow"><b>The models aren’t downloaded yet.</b><p class="hint">${missing.map((x) => x.name).join(', ')} — needed once, then songs are made without the internet.</p></div>
      <button class="btn small" disabled=${running} onClick=${() => act('maker.setup', {})}>Download</button></div>`}
    ${installed ? html`<${MakeForm} settings=${settings} />` : html`<${InstallBlock} m=${m} />`}
    <${Task} task=${m.task} />
    ${m.jobs.length > 0 && html`<div class="mk-jobs">${[...m.jobs].reverse().map((j) => html`<${Job} key=${j.id} job=${j} />`)}</div>`}
    ${installed && html`<${MakerSettings} settings=${settings} m=${m} />`}
    <h3 class="section-title">autokaraoke on this computer</h3>
    <${Checks} m=${m} />
    <div class="btn-row">
      <button class="btn" disabled=${m.checking || running} onClick=${() => act('maker.check')}><${Icon} name="refresh" size=${16} /> ${m.checking ? 'Checking…' : 'Check again'}</button>
      ${installed && missing.length > 0 && html`<button class="btn" disabled=${running} onClick=${() => act('maker.setup', {})}><${Icon} name="download" size=${16} /> Download the models</button>`}
    </div>
  </div>`;
}
