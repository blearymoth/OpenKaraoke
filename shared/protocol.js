// Constants shared by the server and the browser apps (WebSocket protocol, PLAN §7).

export const CHANNEL_MODES = ['stereo', 'left', 'right', 'mono', 'vocalcut'];
export const CHANNEL_LABELS = { stereo: 'Stereo', left: 'Left only', right: 'Right only', mono: 'Mono', vocalcut: 'Vocal cut' };

export const KEY_MIN = -6;
export const KEY_MAX = 6;
export const TEMPO_MIN = 0.7;
export const TEMPO_MAX = 1.3;

export const REACTIONS = ['👏', '❤️', '🔥', '😂', '🎉', '🤘', '😍', '🥳'];
export const SINGER_EMOJIS = ['🎤', '🦄', '🐱', '🦊', '🐼', '🐸', '🦁', '🐙', '🌟', '🔥', '🌈', '🍕', '👑', '🎸', '🚀', '🍀', '🐝', '🦋', '🐧', '🌵', '🍉', '🎩', '🤖', '👽'];
export const SINGER_COLORS = ['#ff3d8b', '#8b5cff', '#22d3ee', '#2bd98f', '#ffb020', '#ff6b3d', '#3d8bff', '#e14cff', '#9be15d', '#ff5470', '#00c2a8', '#f7d51d'];

export const PLAYER_STATES = ['idle', 'intro', 'playing', 'paused'];

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const clampKey = (k) => clamp(Math.round(Number(k) || 0), KEY_MIN, KEY_MAX);
export const clampTempo = (t) => clamp(Math.round((Number(t) || 1) * 100) / 100, TEMPO_MIN, TEMPO_MAX);

/** "+2" / "−1" / "0" for key display. */
export function formatKey(k) {
  if (!k) return '0';
  return k > 0 ? `+${k}` : `−${-k}`;
}

/** "100 %" style tempo display. */
export function formatTempo(t) {
  return `${Math.round((t || 1) * 100)} %`;
}

/** Media URLs of a track for the TV player. */
export function mediaUrls(trackId, kind) {
  const base = `/media/${encodeURIComponent(trackId)}`;
  if (kind === 'video') return { video: `${base}/video` };
  if (kind === 'zipvideo') return { video: `${base}/video` };
  return { audio: `${base}/audio`, cdg: `${base}/cdg` };
}
