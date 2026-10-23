// The lyrics editor (#/lyrics/<trackId>, PLAN §31.5): the word timings of a song autokaraoke
// made. Play the song (on the headphones chosen for previews), watch the lyrics wipe as on the TV,
// fix a word's start and end (keys or buttons), shift a line, tap along (hold T, or the Tap
// button, while each word is sung), or edit the words as text — autokaraoke's matching keeps the
// times. Save: the server keeps the edit and autokaraoke draws the lyrics again; the TV shows them.
import { html, useEffect, useRef, useState } from '../vendor/preact.js';
import { Icon } from '../lib/icons.js';
import { Spinner, apiGet, apiPost, go } from '../lib/components.js';
import { formatTime } from '../lib/store.js';
import { toast } from './state.js';
import { storedSink } from './preview.js';
import {
  readTiming, timingJson, timingText, parseLyrics, transferTiming, flatWords, wordAt, stepWord,
  setWord, nudgeWord, shiftLines, tapDown, tapUp, deleteWord,
} from '/shared/timing.js';

const NUDGE = 0.05;
const BIG_NUDGE = 0.25;
const SPEEDS = [[0.5, '½×'], [0.75, '¾×'], [1, '1×']];
const MAX_UNDO = 100;

const fmt = (t) => {
  const m = Math.floor(t / 60);
  return `${m}:${(t - m * 60).toFixed(2).padStart(5, '0')}`;
};
const same = (a, b) => !!a && !!b && a.li === b.li && a.wi === b.wi;

/** The current line and the next, wiping word by word as the TV does (updated outside Preact, 60 times a second). */
function Preview({ song, previewRef }) {
  return html`<div class="le-preview" ref=${previewRef} aria-hidden="true">
    <div class="le-pline" data-row="0"></div>
    <div class="le-pline next" data-row="1"></div>
    ${!song.lines.length && html`<div class="le-pline">…</div>`}
  </div>`;
}

/** Fills the preview's two rows for time `t`. */
function paintPreview(el, song, t) {
  if (!el) return;
  const now = wordAt(song, t);
  let li = now ? now.li : 0;
  const line = song.lines[li];
  if (line && t > line.words.at(-1).end + 0.4 && song.lines[li + 1]) li++; // (between lines: the next one)
  const rows = el.querySelectorAll('.le-pline');
  [song.lines[li], song.lines[li + 1]].forEach((l, k) => {
    const row = rows[k];
    if (!row) return;
    const key = l ? `${li + k}:${l.words.map((w) => w.text).join(' ')}` : '';
    if (row.dataset.key !== key) {
      row.dataset.key = key;
      row.textContent = '';
      for (const w of l?.words || []) {
        const s = document.createElement('span');
        s.textContent = `${w.text} `;
        row.append(s);
      }
    }
    l?.words.forEach((w, i) => {
      const p = t <= w.start ? 0 : t >= w.end ? 100 : ((t - w.start) / Math.max(0.01, w.end - w.start)) * 100;
      row.children[i]?.style.setProperty('--p', `${p.toFixed(1)}%`);
    });
  });
}

export function LyricsEditor({ trackId }) {
  const [info, setInfo] = useState(null);
  const [error, setError] = useState(null);
  const [song, setSongState] = useState(null);
  const [sel, setSel] = useState({ li: 0, wi: 0 });
  const [nowWord, setNowWord] = useState(null);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [guide, setGuide] = useState(false);
  const [tap, setTap] = useState(false);
  const [textMode, setTextMode] = useState(null); // the text being edited, or null
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState('');
  const [dur, setDur] = useState(0);
  const audio = useRef(null);
  const vocal = useRef(null);
  const undo = useRef([]);
  const redo = useRef([]);
  const songRef = useRef(null);
  const selRef = useRef(sel);
  const tapping = useRef(null); // the word whose key is held down
  const previewRef = useRef(null);
  const timeRef = useRef(null);
  const seekRef = useRef(null);
  const listRef = useRef(null);
  songRef.current = song;
  selRef.current = sel;

  /** A change: kept for undo. */
  const change = (next) => {
    if (!next || next === songRef.current) return;
    undo.current.push(songRef.current);
    if (undo.current.length > MAX_UNDO) undo.current.shift();
    redo.current = [];
    songRef.current = next;
    setSongState(next);
    setDirty(true);
  };
  const back = (from, to) => {
    const s = from.current.pop();
    if (!s) return;
    to.current.push(songRef.current);
    songRef.current = s;
    setSongState(s);
    setDirty(true);
  };

  const load = async () => {
    setError(null);
    try {
      const d = await apiGet(`/api/lyrics/${encodeURIComponent(trackId)}`);
      setInfo(d);
      const s = readTiming(d.timing);
      songRef.current = s;
      setSongState(s);
      undo.current = [];
      redo.current = [];
      setDirty(false);
      setSel({ li: 0, wi: 0 });
    } catch (e) {
      setError(e.message);
    }
  };
  useEffect(() => { load(); }, [trackId]);

  // The song on the preview headphones (Song details → Choose headphones…), if chosen.
  useEffect(() => {
    const a = audio.current;
    if (!a || !info) return undefined;
    const sink = storedSink();
    if (sink && a.setSinkId) a.setSinkId(sink).catch(() => a.setSinkId('').catch(() => {}));
    const onMeta = () => setDur(a.duration || 0);
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    a.addEventListener('loadedmetadata', onMeta);
    a.addEventListener('play', onPlay);
    a.addEventListener('pause', onPause);
    a.addEventListener('ended', onPause);
    return () => {
      a.pause();
      a.removeEventListener('loadedmetadata', onMeta);
      a.removeEventListener('play', onPlay);
      a.removeEventListener('pause', onPause);
      a.removeEventListener('ended', onPause);
    };
  }, [info?.trackId]);

  // 60 times a second: the preview's wipe, the time, the seek bar; the word being sung (a render only when it changes).
  useEffect(() => {
    let raf = 0;
    let last = null;
    const frame = () => {
      raf = requestAnimationFrame(frame);
      const a = audio.current;
      const s = songRef.current;
      if (!a || !s) return;
      const t = a.currentTime || 0;
      paintPreview(previewRef.current, s, t);
      if (timeRef.current) timeRef.current.textContent = `${fmt(t)} / ${formatTime(a.duration || 0)}`;
      if (seekRef.current && document.activeElement !== seekRef.current) seekRef.current.value = String(t);
      const w = a.paused ? null : wordAt(s, t);
      const key = w && t <= s.lines[w.li].words[w.wi].end + 0.15 ? `${w.li}:${w.wi}` : '';
      if (key !== last) {
        last = key;
        setNowWord(key ? w : null);
      }
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, []);

  useEffect(() => { if (audio.current) audio.current.playbackRate = speed; }, [speed]);

  // The guide vocal (the song's separated vocals, kept when it was made): follows the song.
  useEffect(() => {
    const a = audio.current;
    const v = vocal.current;
    if (!a || !v || !guide) {
      v?.pause();
      return undefined;
    }
    const sync = () => {
      v.playbackRate = a.playbackRate;
      if (Math.abs(v.currentTime - a.currentTime) > 0.08) v.currentTime = a.currentTime;
      if (a.paused !== v.paused) {
        if (a.paused) v.pause();
        else v.play().catch(() => {});
      }
    };
    const events = ['play', 'pause', 'seeked', 'ratechange'];
    for (const e of events) a.addEventListener(e, sync);
    const timer = setInterval(sync, 500);
    sync();
    return () => {
      for (const e of events) a.removeEventListener(e, sync);
      clearInterval(timer);
      v.pause();
    };
  }, [guide, info?.vocal]);

  // The selected word stays in view.
  useEffect(() => {
    listRef.current?.querySelector('.le-word.sel')?.scrollIntoView({ block: 'nearest' });
  }, [sel.li, sel.wi]);

  // Unsaved changes: the browser asks before leaving the page.
  useEffect(() => {
    if (!dirty) return undefined;
    const warn = (e) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const t = () => audio.current?.currentTime || 0;
  const playPause = () => {
    const a = audio.current;
    if (!a) return;
    if (a.paused) a.play().catch(() => toast('The song can’t play here', 'error'));
    else a.pause();
  };
  const seek = (to) => {
    if (audio.current) audio.current.currentTime = Math.max(0, to);
  };
  const playFrom = (li, wi = 0) => {
    const w = songRef.current?.lines[li]?.words[wi];
    if (!w) return;
    seek(w.start - 1);
    audio.current?.play().catch(() => {});
  };
  const select = (li, wi) => setSel({ li, wi });
  const move = (dir) => {
    const s = songRef.current;
    const n = s && stepWord(s, selRef.current.li, selRef.current.wi, dir);
    if (n) setSel(n);
  };
  const moveLine = (dir) => {
    const s = songRef.current;
    const li = Math.max(0, Math.min(s.lines.length - 1, selRef.current.li + dir));
    setSel({ li, wi: 0 });
  };

  // Tap along: key down as a word begins, up as it ends; then on to the next word.
  const tapStart = () => {
    const s = songRef.current;
    const at = selRef.current;
    if (!s || tapping.current || !s.lines[at.li]?.words[at.wi]) return;
    tapping.current = at;
    change(tapDown(s, at.li, at.wi, t()));
  };
  const tapEnd = () => {
    const at = tapping.current;
    if (!at) return;
    tapping.current = null;
    const s = songRef.current;
    const next = tapUp(s, at.li, at.wi, t());
    songRef.current = next; // (the same change as the key going down: one undo for both)
    setSongState(next);
    move(1);
  };

  // Keys (before the host page's own shortcuts, which then leave them alone).
  useEffect(() => {
    const onKey = (e) => {
      const el = document.activeElement;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)) return;
      if (document.querySelector('.scrim')) return;
      const s = songRef.current;
      if (!s || textMode !== null) return;
      const { li, wi } = selRef.current;
      const k = e.key;
      const step = e.shiftKey ? BIG_NUDGE : NUDGE;
      let done = true;
      if ((e.ctrlKey || e.metaKey) && (k === 'z' || k === 'Z')) {
        if (e.shiftKey) back(redo, undo);
        else back(undo, redo);
      } else if ((e.ctrlKey || e.metaKey) && (k === 'y' || k === 'Y')) back(redo, undo);
      else if (e.ctrlKey || e.metaKey || e.altKey) done = false;
      else if (k === ' ') playPause();
      else if (k === 't' || k === 'T') {
        if (!e.repeat) tapStart();
      } else if (k === 'ArrowRight') move(1);
      else if (k === 'ArrowLeft') move(-1);
      else if (k === 'ArrowDown') moveLine(1);
      else if (k === 'ArrowUp') moveLine(-1);
      else if (k === 'Enter') playFrom(li, wi);
      else if (k === '[' || k === '{') change(nudgeWord(s, li, wi, 'start', -step));
      else if (k === ']' || k === '}') change(nudgeWord(s, li, wi, 'start', step));
      else if (k === ',' || k === '<') change(nudgeWord(s, li, wi, 'end', -step));
      else if (k === '.' || k === '>') change(nudgeWord(s, li, wi, 'end', step));
      else if (k === 's' || k === 'S') change(setWord(s, li, wi, { start: t() }));
      else if (k === 'e' || k === 'E') change(setWord(s, li, wi, { end: t() }));
      else done = false;
      if (done) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    const onUp = (e) => {
      if ((e.key === 't' || e.key === 'T') && tapping.current) {
        e.preventDefault();
        tapEnd();
      }
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('keyup', onUp, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('keyup', onUp, true);
    };
  }, [textMode]);

  const save = async () => {
    setBusy('save');
    try {
      const s = songRef.current;
      const d = await apiPost(`/api/lyrics/${encodeURIComponent(trackId)}`, { timing: timingJson({ ...s, title: info.timing.title, artist: info.timing.artist, language: info.timing.language, duration: info.timing.duration }) });
      setInfo(d);
      setDirty(false);
      if (d.error) toast(d.error, 'error', 8000);
      else toast('Saved — the TV shows the new lyrics', 'ok');
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setBusy('');
    }
  };
  const revert = async () => {
    if (!confirm('Go back to autokaraoke’s own timing? Your edit is thrown away.')) return;
    setBusy('revert');
    try {
      await apiPost(`/api/lyrics/${encodeURIComponent(trackId)}/revert`);
      await load();
      toast('Back to autokaraoke’s timing', 'ok');
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setBusy('');
    }
  };
  const writeBack = async () => {
    if (!confirm('Write this edit into the song’s own folder (its timing, lyrics and LRC files)? The originals are kept once, as .orig files.')) return;
    setBusy('write');
    try {
      const d = await apiPost(`/api/lyrics/${encodeURIComponent(trackId)}/write`);
      setInfo(d);
      toast('Written into the song’s folder', 'ok');
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setBusy('');
    }
  };
  const leave = () => {
    if (dirty && !confirm('Leave without saving your changes?')) return;
    setDirty(false);
    if (history.length > 1) history.back();
    else go('/');
  };
  const removeWord = () => {
    const next = deleteWord(song, sel.li, sel.wi);
    change(next);
    const line = next.lines[sel.li];
    if (line?.words[sel.wi]) return;
    setSel(line ? { li: sel.li, wi: line.words.length - 1 } : { li: Math.max(0, Math.min(sel.li, next.lines.length - 1)), wi: 0 });
  };
  const applyText = () => {
    const lines = parseLyrics(textMode);
    if (!lines.length) return toast('There are no words', 'error');
    const s = songRef.current;
    const next = transferTiming(lines, flatWords(s).map((x) => x.w));
    change({ ...s, lines: next });
    setTextMode(null);
    setSel({ li: 0, wi: 0 });
    return undefined;
  };

  if (error) return html`<div class="page"><header class="page-head"><div><h1>Edit lyrics</h1></div></header>
    <p class="warn-text">${error}</p><button class="btn" onClick=${() => history.back()}>Back</button></div>`;
  if (!info || !song) return html`<div class="page"><${Spinner} /></div>`;

  const w = song.lines[sel.li]?.words[sel.wi];
  const flat = flatWords(song).length;
  return html`<div class="page lyrics-editor">
    <header class="page-head">
      <div class="grow">
        <h1>Edit lyrics</h1>
        <p class="muted ellipsis">${info.artist} – ${info.title}${info.label ? ` · ${info.label}` : ''} · ${song.lines.length} lines, ${flat} words</p>
      </div>
      <div class="btn-row le-actions">
        <button class="btn ghost" onClick=${leave}>Close</button>
        ${info.edited && html`<button class="btn ghost" disabled=${!!busy} onClick=${revert}>Revert</button>`}
        ${info.edited && info.drawn && !dirty && html`<button class="btn" disabled=${!!busy} onClick=${writeBack}>Write into the song’s folder</button>`}
        <button class="btn primary" disabled=${!!busy || (!dirty && info.drawn)} onClick=${save}>${busy === 'save' ? 'Saving…' : 'Save'}</button>
      </div>
    </header>
    <p class=${`le-state ${dirty ? 'dirty' : ''}`}>${dirty ? 'Unsaved changes.' : info.edited ? (info.drawn ? 'Your edit — the TV shows it.' : 'Your edit is saved, but not drawn yet.') : 'autokaraoke’s own timing.'}
      ${!info.renderer && html` <span class="warn-text">autokaraoke isn’t installed, so saved lyrics can’t be drawn (Settings → Karaoke maker).</span>`}</p>

    <audio ref=${audio} src=${info.audio} preload="auto"></audio>
    ${info.vocal && html`<audio ref=${vocal} src=${info.vocal} preload="auto"></audio>`}
    <div class="le-transport">
      <button class="icon-btn le-play" aria-label=${playing ? 'Pause' : 'Play'} onClick=${playPause}><${Icon} name=${playing ? 'pause' : 'play'} size=${22} /></button>
      <span class="le-time mono" ref=${timeRef}>0:00.00 / 0:00</span>
      <input class="le-seek" ref=${seekRef} type="range" min="0" max=${Math.max(1, dur || info.timing.duration || 1)} step="0.01" aria-label="Position in the song"
        onInput=${(e) => seek(Number(e.currentTarget.value))} />
      ${info.vocal && html`<button class=${`btn small ${guide ? 'primary' : 'ghost'}`} aria-pressed=${guide} title="The singer, separated when the song was made, to time the words by" onClick=${() => setGuide(!guide)}><${Icon} name="mic" size=${14} /> Guide vocal</button>`}
      <div class="segmented" role="group" aria-label="Speed">${SPEEDS.map(([v, l]) => html`<button class=${speed === v ? 'on' : ''} onClick=${() => setSpeed(v)}>${l}</button>`)}</div>
      <button class="icon-btn" aria-label="Undo" title="Undo (Ctrl+Z)" disabled=${!undo.current.length} onClick=${() => back(undo, redo)}><${Icon} name="history" size=${18} /></button>
    </div>
    <${Preview} song=${song} previewRef=${previewRef} />

    <div class="le-tools">
      <button class=${`btn ${tap ? 'primary' : ''}`} aria-pressed=${tap} onClick=${() => setTap(!tap)}><${Icon} name="mic" size=${16} /> Tap along</button>
      <button class="btn" onClick=${() => setTextMode(textMode === null ? timingText(song) : null)}><${Icon} name="edit" size=${16} /> ${textMode === null ? 'Edit the words' : 'Cancel'}</button>
      <span class="hint grow">Space play/pause · ←→ word · ↑↓ line · [ ] start · , . end (Shift: ¼ s) · S/E start/end at the play head · Enter play from the word · Ctrl+Z undo</span>
    </div>
    ${tap && html`<div class="le-tap">
      <p>Play the song and <b>hold T</b> (or the button) while <b>“${w?.text || '…'}”</b> is sung — it moves on to the next word by itself.</p>
      <button class="btn primary le-tap-btn" onPointerDown=${(e) => { e.preventDefault(); e.currentTarget.setPointerCapture?.(e.pointerId); tapStart(); }}
        onPointerUp=${tapEnd} onPointerCancel=${tapEnd}>Tap</button>
      <button class="btn" onClick=${() => playFrom(sel.li, sel.wi)}>Play from this word</button>
    </div>`}

    ${textMode !== null ? html`<div class="le-text">
      <p class="hint">One sung line per line. The times stay with the words that are still there; new words are fitted in between.</p>
      <textarea class="input" rows="16" value=${textMode} onInput=${(e) => setTextMode(e.currentTarget.value)}></textarea>
      <div class="btn-row"><button class="btn primary" onClick=${applyText}>Use these words</button><button class="btn ghost" onClick=${() => setTextMode(null)}>Cancel</button></div>
    </div>` : html`
    ${w && html`<div class="le-word-tools">
      <label class="field le-wtext"><span>Word</span><input class="input" value=${w.text} maxlength="80" onChange=${(e) => change(setWord(song, sel.li, sel.wi, { text: e.currentTarget.value }))} /></label>
      <label class="field le-wtime"><span>Starts</span><input class="input mono" type="number" step="0.01" min="0" value=${w.start.toFixed(2)}
        onChange=${(e) => change(setWord(song, sel.li, sel.wi, { start: Number(e.currentTarget.value) }))} /></label>
      <div class="le-nudge"><button class="btn small" onClick=${() => change(nudgeWord(song, sel.li, sel.wi, 'start', -NUDGE))}>−0.05</button><button class="btn small" onClick=${() => change(nudgeWord(song, sel.li, sel.wi, 'start', NUDGE))}>+0.05</button></div>
      <label class="field le-wtime"><span>Ends</span><input class="input mono" type="number" step="0.01" min="0" value=${w.end.toFixed(2)}
        onChange=${(e) => change(setWord(song, sel.li, sel.wi, { end: Number(e.currentTarget.value) }))} /></label>
      <div class="le-nudge"><button class="btn small" onClick=${() => change(nudgeWord(song, sel.li, sel.wi, 'end', -NUDGE))}>−0.05</button><button class="btn small" onClick=${() => change(nudgeWord(song, sel.li, sel.wi, 'end', NUDGE))}>+0.05</button></div>
      <button class="btn small ghost danger" onClick=${() => removeWord()}>Delete word</button>
    </div>`}
    <ol class="le-lines" ref=${listRef}>
      ${song.lines.map((l, li) => html`<li key=${li} class=${`le-line ${li === sel.li ? 'on' : ''}`}>
        <button class="icon-btn small" aria-label=${`Play line ${li + 1}`} onClick=${() => playFrom(li)}><${Icon} name="play" size=${14} /></button>
        <span class="le-at mono">${fmt(l.words[0].start)}</span>
        <div class="le-words">${l.words.map((x, wi) => html`<button key=${wi} class=${`le-word ${same(sel, { li, wi }) ? 'sel' : ''} ${same(nowWord, { li, wi }) ? 'now' : ''}`}
          onClick=${() => select(li, wi)} onDblClick=${() => playFrom(li, wi)} title=${`${x.start.toFixed(2)}–${x.end.toFixed(2)} s`}>${x.text}</button>`)}</div>
        <div class="le-shift">
          <button class="btn small ghost" title="The whole line 0.1 s earlier" onClick=${() => change(shiftLines(song, li, li, -0.1))}>−0.1</button>
          <button class="btn small ghost" title="The whole line 0.1 s later" onClick=${() => change(shiftLines(song, li, li, 0.1))}>+0.1</button>
          <button class="btn small ghost" title="This line and every one after it 0.5 s later" onClick=${() => change(shiftLines(song, li, song.lines.length - 1, 0.5))}>+0.5 →</button>
        </div>
      </li>`)}
    </ol>`}
  </div>`;
}
