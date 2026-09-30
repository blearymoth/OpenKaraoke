// Pass the mic (PLAN §13) — placeholder until the game is built.
import { Game, fail } from './base.js';

export class Relay extends Game {
  static type = 'relay';
  static label = 'Pass the mic';
  static exclusive = false;

  start() {
    fail('Pass the mic is not available yet.', 'unavailable');
  }
}
