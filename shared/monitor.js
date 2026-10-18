// The host's headphone monitor (PLAN §29), the parts without a browser: where the TV is in the
// song, what the monitor does to stay with it, and the mix it plays (isomorphic, pure).

export const MONITOR_TOLERANCE = 0.06; // seconds the monitor may be off before it jumps to the TV
export const MONITOR_SEEK_GAP = 1500; // ms between two jumps (a jump takes a moment to settle)
export const MAX_DELAY_MS = 500; // the delay slider: ± this much
export const STALE_MS = 3000; // a TV report older than this isn't extrapolated further

/**
 * The TV's heard position now, from its last report `{ pos, playing, at }` (`at`: the server's
 * clock when it was received) and the server clock now. A song at another tempo moves that
 * much faster. Null without a report.
 */
export function tvPosition(time, serverNow, tempo = 1) {
  if (!time || !Number.isFinite(time.pos)) return null;
  if (!time.playing) return time.pos;
  const ms = Math.min(Math.max(0, serverNow - time.at), STALE_MS);
  return time.pos + (ms / 1000) * (tempo || 1);
}

/** The delay slider's value (ms), clamped; positive: the headphones are late, so the monitor plays that much ahead. */
export function clampDelay(ms) {
  const n = Math.round(Number(ms));
  return Number.isFinite(n) ? Math.max(-MAX_DELAY_MS, Math.min(MAX_DELAY_MS, n)) : 0;
}

/**
 * One step of following the TV: `{ action: 'play' | 'pause' | 'seek' | null, to, err }`.
 * @param {object} o
 * @param {number|null} o.tv the TV's heard position now (tvPosition)
 * @param {boolean} o.tvPlaying the song plays on the TV
 * @param {number} o.position the monitor's heard position
 * @param {boolean} o.playing the monitor plays
 * @param {number} o.delayMs the delay slider
 * @param {number} o.now ms (any clock), and `lastSeekAt` on the same clock
 */
export function monitorStep({ tv, tvPlaying, position, playing, delayMs = 0, now, lastSeekAt = -Infinity }) {
  if (!tvPlaying || tv === null || tv === undefined) return { action: playing ? 'pause' : null };
  const target = tv + clampDelay(delayMs) / 1000;
  if (!playing) return { action: 'play', to: target };
  const err = position - target;
  if (Math.abs(err) > MONITOR_TOLERANCE && now - lastSeekAt >= MONITOR_SEEK_GAP) return { action: 'seek', to: target, err };
  return { action: null, err };
}

/**
 * What the monitor's channel matrix is made of: the room's channels, and on a multiplex track
 * (the guide singer adjustable) the monitor's own guide level — `lead` null: the room's.
 */
export function monitorMix(player, lead = null) {
  const vocals = player?.vocals || null;
  if (vocals?.adjustable) return { channel: player.channel || 'stereo', vocals, lead: lead ?? player.lead ?? 0 };
  return { channel: player?.channel || 'stereo', vocals: null, lead: 0 };
}

/**
 * The media the monitor loads for a song: the separated stems (PLAN §30), decoded audio (CDG
 * tracks) or the video's sound, else null.
 */
export function monitorSource(media) {
  if (media?.kind === 'cdg' && media.stems?.music && media.stems.vocal) return { mode: 'stems', url: media.stems.music, vocal: media.stems.vocal };
  if (media?.kind === 'cdg' && media.audio) return { mode: 'buffer', url: media.audio };
  if (media?.kind === 'video' && media.video) return { mode: 'element', url: media.video };
  return null; // (a video still being converted)
}
