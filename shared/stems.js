// A vocal stem for multiplex tracks (isomorphic: no Node APIs). The room and the TV keep
// the channel matrix in shared/vocals.js. Ordinary tracks are not separated, and this file
// has no level controls — the headphone preview plays the vocal as it was separated.

/**
 * Whether a headphone output may play a separated vocal for this track.
 * Only multiplex: a file named multiplex, a host side (mpxL / mpxR), or a resolved
 * multiplex (adjustable, the host still being asked which side, or named so).
 * The host's "ordinary stereo" correction wins, even when the file name says multiplex.
 * A suggestion from the sound alone, a "Con Voz" mix, and ordinary stereo are not separated.
 * `vocals` is the object from resolveVocals (shared/vocals.js); it may be null.
 */
export function vocalStemAllowed({ flags = {}, override = 'auto', vocals = null } = {}) {
  if (override === 'stereo') return false;
  if (override === 'mpxL' || override === 'mpxR') return true;
  if (flags?.mpx) return true;
  if (vocals?.adjustable || vocals?.ask) return true;
  if (vocals?.source === 'file') return true;
  return false;
}

/** The song dialog offers the vocal stem for this version. The server still decides. */
export function wantsVocalPreview(version) {
  const lead = version?.vocals?.lead;
  return !!(version?.flags?.mpx || lead === 'adjustable' || lead === 'multiplex');
}

/**
 * What the headphone preview plays after `vocal.prepare`. A ready stem uses its URL.
 * Separating or failed plays nothing (the host sees `error`). Anything else, including
 * a separator that is turned off, keeps the full audio file.
 */
export function vocalPreviewTarget(trackId, result) {
  const full = `/media/${encodeURIComponent(trackId)}/audio`;
  if (!result) return { src: '', error: '' };
  if (result.status === 'ready' && result.url) return { src: result.url, error: '' };
  if (result.status === 'separating') return { src: '', error: 'Separating the guide vocal for headphones… press Vocal again in a moment.' };
  if (result.status === 'failed') return { src: '', error: 'Could not separate the guide vocal for headphones.' };
  return { src: full, error: '' };
}
