// Music quiz (PLAN §13) — placeholder until the game is built.
import { Game, fail } from './base.js';

export class Quiz extends Game {
  static type = 'quiz';
  static label = 'Music quiz';
  static exclusive = true;

  start() {
    fail('Music quiz is not available yet.', 'unavailable');
  }
}
