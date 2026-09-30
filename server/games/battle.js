// Battle (PLAN §13) — placeholder until the game is built.
import { Game, fail } from './base.js';

export class Battle extends Game {
  static type = 'battle';
  static label = 'Battle';
  static exclusive = true;

  start() {
    fail('Battle is not available yet.', 'unavailable');
  }
}
