// Music quiz (PLAN §13.1): round types and scoring, shared by the server game
// (server/games/quiz.js) and its screens (public/js/games/quiz.js). Isomorphic: no Node/DOM APIs.

/** Round types in the order the host's setup form lists them. */
export const QUIZ_ROUNDS = ['intro', 'snippet', 'artist', 'lyrics', 'cover', 'helium', 'slowmo', 'reverse', 'year'];

/**
 * label/icon: shown on the TV, phones and the host form; prompt: the question on screen;
 * hint: what the host form explains; ask: what the four answers are (songs, artists or decades).
 */
export const QUIZ_ROUND_INFO = {
  intro: { label: 'Intro', icon: '🎬', ask: 'song', prompt: 'Name that intro!', hint: 'The first seconds of the backing track' },
  snippet: { label: 'Snippet', icon: '🎵', ask: 'song', prompt: 'Which song is this?', hint: 'A few seconds from the middle of the song' },
  artist: { label: 'Name the artist', icon: '🎤', ask: 'artist', prompt: 'Who sings this?', hint: 'A snippet — the answers are artists' },
  lyrics: { label: 'Lyrics peek', icon: '📝', ask: 'song', prompt: 'Which song are these lyrics from?', hint: 'One lyrics screen, no sound' },
  cover: { label: 'Cover zoom', icon: '🖼️', ask: 'song', prompt: 'Which song is behind this cover?', hint: 'Cover art slowly zooming out (songs with artwork)' },
  helium: { label: 'Helium', icon: '🎈', ask: 'song', prompt: 'Helium voices! Which song is this?', hint: 'A snippet seven semitones higher' },
  slowmo: { label: 'Slow-mo', icon: '🐢', ask: 'song', prompt: 'In slow motion: which song is this?', hint: 'A snippet at 70 % speed' },
  reverse: { label: 'Backwards', icon: '⏪', ask: 'song', prompt: 'Played backwards: which song is this?', hint: 'A snippet played in reverse' },
  year: { label: 'Decade', icon: '📅', ask: 'decade', prompt: 'When was this song released?', hint: 'The answers are decades (songs with a known year)' },
};

export const QUIZ_QUESTIONS = { min: 5, max: 30, def: 10 };
export const QUIZ_SECONDS = { min: 10, max: 30, def: 20 };
export const QUIZ_STREAK_BONUS = 100;
/** A leaderboard is shown after every this many questions. */
export const QUIZ_LEADERBOARD_EVERY = 3;

/**
 * Points for a right answer given `ms` after the question opened, with `seconds` to answer:
 * 500 + 500·(1 − t/T), so 1000 for an instant answer and 500 at the buzzer.
 */
export function quizPoints(ms, seconds) {
  const total = Math.max(1, seconds * 1000);
  const t = Math.min(total, Math.max(0, Number(ms) || 0));
  return Math.round(500 + 500 * (1 - t / total));
}
