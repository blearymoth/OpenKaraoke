// Versions of a song (host and guest): their names, what they say about the vocals, how often
// they were sung here and the thumbs up / down that choose the default version (PLAN §22).
import { html, useState } from '../vendor/preact.js';
import { Icon } from './icons.js';
import { formatTime } from './store.js';

/** "Sunfly · Duet" — the label and variant of a version. */
export function versionName(v) {
  return [v?.brandName || v?.brand || 'Unknown label', v?.variant].filter(Boolean).join(' · ');
}

/** What a version says about its vocals ("lead vocal adjustable", "no backing vocals"). */
export function vocalsNote(v) {
  const notes = [];
  if (v.vocals?.lead === 'adjustable') notes.push('lead vocal adjustable');
  else if (v.vocals?.lead === 'multiplex') notes.push('multiplex: lead vocal adjustable once played');
  else if (v.vocals?.lead === 'mixed') notes.push('original singer mixed in');
  if (v.vocals?.bgv === 'without') notes.push('no backing vocals');
  else if (v.vocals?.bgv === 'with') notes.push('with backing vocals');
  return notes.join(', ');
}

/** For a <select>: "Sunfly · lead vocal adjustable (3:41) · sung 4× · 👍2 👎0". */
export function versionLabel(v, { stats = false } = {}) {
  const note = vocalsNote(v);
  let s = `${[versionName(v), note].filter(Boolean).join(' · ')} (${formatTime(v.dur)})`;
  if (stats) {
    if (v.plays) s += ` · sung ${v.plays}×`;
    if (v.up || v.down) s += ` · 👍${v.up || 0} 👎${v.down || 0}`;
    if (v.status === 'avoided') s += ' · avoided';
  }
  return s;
}

/** Pressing your own vote again takes it back. */
export const nextVote = (mine, dir) => (mine === dir ? 0 : dir);

/** Thumbs up / down with their counts. `onVote(value)` gets 1, -1 or 0. */
export function VersionVote({ v, onVote, disabled = false, label }) {
  const [busy, setBusy] = useState(false);
  const up = v.up || 0;
  const down = v.down || 0;
  const press = async (dir) => {
    if (busy) return;
    setBusy(true);
    try {
      await onVote(nextVote(v.mine || 0, dir));
    } finally {
      setBusy(false);
    }
  };
  const title = disabled ? 'You can vote once it has been played tonight' : 'Votes choose the version that plays by default';
  return html`<span class="vote" role="group" aria-label=${label || 'Votes for this version'}>
    <button type="button" class="vote-btn up" aria-pressed=${v.mine === 1} disabled=${disabled || busy} title=${title} onClick=${() => press(1)}
      aria-label=${`Good version, ${up} ${up === 1 ? 'vote' : 'votes'}`}><${Icon} name="thumbUp" size=${16} /><span class="num">${up}</span></button>
    <button type="button" class="vote-btn down" aria-pressed=${v.mine === -1} disabled=${disabled || busy} title=${title} onClick=${() => press(-1)}
      aria-label=${`Bad version (wrong key, sound or lyrics), ${down} ${down === 1 ? 'vote' : 'votes'}`}><${Icon} name="thumbDown" size=${16} /><span class="num">${down}</span></button>
  </span>`;
}
