// Constants shared by the server and the browser apps (isomorphic, no Node/DOM APIs).

export const PLAYER_STATES = ['idle', 'intro', 'ready', 'playing', 'paused'];

/** Channel matrices for multiplex / guide-vocal tracks. */
export const CHANNEL_MODES = ['stereo', 'left', 'right', 'mono', 'vocalcut'];
export const CHANNEL_LABELS = {
  stereo: 'Stereo',
  left: 'Left only',
  right: 'Right only',
  mono: 'Mono',
  vocalcut: 'Vocal cut',
};

export const KEY_MIN = -6;
export const KEY_MAX = 6;
export const TEMPO_MIN = 0.7;
export const TEMPO_MAX = 1.3;
export const TEMPO_STEP = 0.05;

export const REACTIONS = ['👏', '❤️', '🔥', '😂', '🎉', '🤘', '😍', '🙌'];

export const AVATARS = ['🎤', '🦄', '🐯', '🦊', '🐼', '🐸', '🐙', '🦋', '🌵', '🍕', '🚀', '👾', '🎸', '🥁', '🎧', '🌈', '⭐', '🍒', '🐝', '🦖', '🐧', '🦁', '🍩', '💃'];
export const COLORS = ['#ff3d8b', '#ffc94a', '#45e2a6', '#4cc3ff', '#b388ff', '#ff8a3d', '#7cf05a', '#ff6262', '#3de0d0', '#f06bff'];

export function clampKey(k) {
  const n = Math.round(Number(k) || 0);
  return Math.max(KEY_MIN, Math.min(KEY_MAX, n));
}

export function clampTempo(r) {
  const n = Number(r);
  if (!Number.isFinite(n) || n <= 0) return 1;
  return Math.round(Math.max(TEMPO_MIN, Math.min(TEMPO_MAX, n)) * 100) / 100;
}

export function formatKey(k) {
  return k > 0 ? `+${k}` : String(k);
}

export function formatTempo(r) {
  return `${Math.round(r * 100)}%`;
}

/** Why a guest's hello was refused, in words a guest understands. */
export const DENIED_MESSAGES = {
  bad_room: 'This party code does not exist. Scan the QR code on the TV again.',
  banned: 'The host has removed you from this party.',
  guests_closed: 'The host has closed song requests for now.',
  pin_required: 'Enter the host PIN to control the party from this device.',
  host_only: 'The host controls only work on the computer running OpenKaraoke (set a host PIN to allow other devices).',
  pairing_required: 'This screen needs to be paired with the host first.',
  rate_limited: 'Too many new connections from this device — wait a few minutes and try again.',
};

// ---- games (PLAN §13) ------------------------------------------------------------------------

export const GAME_TYPES = ['quiz', 'battle', 'wheel', 'poll', 'relay', 'applause', 'recap'];
export const GAME_LABELS = {
  quiz: 'Music quiz',
  battle: 'Battle',
  wheel: 'Roulette wheel',
  poll: 'What’s next? poll',
  relay: 'Pass the mic',
  applause: 'Applause meter',
  recap: 'Party recap',
};
/**
 * Answer buttons on phones (Kahoot-style colour + shape, so colour-blind players can play).
 * The colours are CSS tokens each skin defines in /css/base.css.
 */
export const ANSWER_COLORS = ['var(--answer-1)', 'var(--answer-2)', 'var(--answer-3)', 'var(--answer-4)'];
export const ANSWER_SHAPES = ['▲', '◆', '●', '■'];

/** Seconds guests have to rate a performance after it ends. */
export const RATING_SECONDS = 40;
