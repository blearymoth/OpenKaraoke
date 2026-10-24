// A disc's words (PLAN §31.16), host side: Song details → a version with a vocal (multiplex, or
// separated) → "Find the words" → this dialog (paste the lyrics, or let them be looked up, or what
// Whisper hears) → the job, followed live on the version's row and in Settings → Karaoke maker →
// then "Edit lyrics" (the lyrics editor) and the TV writes them in two lines and scrolling.
import { html, useState } from '../vendor/preact.js';
import { Icon } from '../lib/icons.js';
import { useStore } from '../lib/store.js';
import { Modal, Spinner, go, clearFetchCache } from '../lib/components.js';
import { store, act, closeDialog, openDialog, toast } from './state.js';

const ACTIVE = new Set(['vocal', 'waiting', 'queued', 'working']);
const FROM = { typed: 'from the lyrics you pasted', whisper: 'from what Whisper heard — check them' };

const fromText = (j) => (j.lyricsFrom ? FROM[j.lyricsFrom] || `from ${j.lyricsFrom}` : '');

/**
 * The version row's words: "Edit lyrics" when it has them, the job while they are being found,
 * "Find the words" when they can be. v: the version from /api/songs/:id (v.lyrics, v.words).
 */
export function WordsButton({ v, songId }) {
  const { state } = useStore(store);
  const job = (state.words || []).find((j) => j.trackId === v.id);
  const edit = (kind, edited) => html`<button class="btn small ghost" title=${kind === 'words' ? 'The words found for this disc: fix their timing' : edited ? 'You edited these lyrics' : 'Fix the timing of autokaraoke’s lyrics'}
    onClick=${() => { closeDialog(); go(`/lyrics/${v.id}`); }}><${Icon} name="edit" size=${14} /> ${edited ? 'Lyrics (edited)' : 'Edit lyrics'}</button>`;
  if (v.lyrics) return edit(v.lyrics.kind, v.lyrics.edited);
  if (job?.state === 'done') return edit('words', false);
  if (job && ACTIVE.has(job.state)) {
    return html`<span class="pill words-state" title=${job.label}><${Spinner} /> ${job.label}</span>
      <button class="btn small ghost danger" onClick=${() => act('words.cancel', { trackId: v.id })}>Stop</button>`;
  }
  if (!v.words || v.words.problem) return null;
  return html`<button class="btn small ghost" title=${job?.state === 'failed' ? job.error : 'Time this disc’s words against its singer, so the TV can write them and you can fix them'}
    onClick=${() => openDialog({ type: 'words', trackId: v.id, songId })}><${Icon} name="sparkles" size=${14} /> ${job?.state === 'failed' ? 'Find the words again' : 'Find the words'}</button>`;
}

/** Find a version's words: the lyrics to time, or let them be looked up. */
export function WordsDialog({ trackId, songId }) {
  const { state } = useStore(store);
  const [lyrics, setLyrics] = useState('');
  const [lookup, setLookup] = useState(state.settings.maker?.lookupLyrics !== false);
  const [busy, setBusy] = useState(false);
  const canLookUp = !!state.maker?.checks?.features?.lookup;
  const back = () => (songId ? openDialog({ type: 'song', songId }) : closeDialog());
  const start = async () => {
    setBusy(true);
    const r = await act('words.find', { trackId, lyrics, lookup: canLookUp && lookup });
    setBusy(false);
    if (!r) return;
    toast('Finding the words — follow it on the version, or in Settings → Karaoke maker', 'ok');
    clearFetchCache();
    back();
  };
  const lines = lyrics.split('\n').filter((l) => l.trim()).length;
  return html`<${Modal} title="Find the words" onClose=${back} footer=${html`
      <button class="btn ghost" onClick=${back}>Cancel</button>
      <button class="btn primary" disabled=${busy} onClick=${start}><${Icon} name="sparkles" size=${16} /> Find the words</button>`}>
    <div class="words-dialog">
      <p class="muted">The Karaoke maker listens to this version’s singer and times each word. The disc’s own lyrics screens are not changed: in <b>two lines</b> and <b>scrolling</b> the TV writes these words instead, and you can fix them in the lyrics editor.</p>
      <label class="field"><span>Lyrics ${lines ? `· ${lines} lines` : '(recommended)'}</span>
        <textarea class="input" rows="9" value=${lyrics} placeholder="Paste the lyrics, one sung line per line." onInput=${(e) => setLyrics(e.currentTarget.value)}></textarea></label>
      ${!lyrics.trim() && (canLookUp ? html`<label class="check-row"><input type="checkbox" checked=${lookup} onChange=${(e) => setLookup(e.currentTarget.checked)} />
          <span>None pasted: look them up online (${(state.settings.maker?.lyricsSources || []).join(', ') || 'lrclib'}), else Whisper writes down what it hears</span></label>`
        : html`<p class="hint">None pasted: Whisper writes down what it hears (it mishears songs — check them after).</p>`)}
      <p class="hint">A multiplex version’s singer is separated first (a minute or two). On a PC without a graphics card it waits for the song on stage to end.</p>
    </div>
  </${Modal}>`;
}

/** Settings → Karaoke maker: the discs whose words are being found, or were lately. */
export function WordJobsList({ jobs }) {
  if (!jobs?.length) return null;
  return html`<div class="words-jobs">
    <h3 class="section-title">Words for discs</h3>
    ${jobs.map((j) => html`<div class=${`mk-card words-job ${j.state}`} key=${j.trackId} data-words=${j.trackId}>
      <div class="mk-job-head"><b class="ellipsis">${j.artist ? `${j.artist} – ` : ''}${j.title || 'A version'}</b>
        <span class=${`pill mk-state ${j.state === 'working' ? 'running' : j.state}`}>${ACTIVE.has(j.state) && j.state !== 'waiting' ? html`<${Spinner} /> ` : ''}${j.label}</span></div>
      ${j.state === 'done' && html`<p class="hint">${j.lines} lines${fromText(j) ? `, ${fromText(j)}` : ''}. The TV writes them in two lines and scrolling.</p>`}
      ${j.state === 'failed' && html`<p class="warn-text">${j.error}</p>`}
      <div class="mk-row">
        ${j.state === 'done' && html`<button class="btn small" onClick=${() => go(`/lyrics/${j.trackId}`)}><${Icon} name="edit" size=${14} /> Edit lyrics</button>`}
        ${ACTIVE.has(j.state) ? html`<button class="btn small ghost danger" onClick=${() => act('words.cancel', { trackId: j.trackId })}>Stop</button>`
          : html`<button class="btn small ghost" onClick=${() => act('words.dismiss', { trackId: j.trackId })}>Remove from the list</button>`}
      </div>
    </div>`)}
  </div>`;
}
