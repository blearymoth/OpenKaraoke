// Party recap (PLAN §13) — placeholder until the game is built.
import { Game, fail } from './base.js';

export class Recap extends Game {
  static type = 'recap';
  static label = 'Party recap';
  static exclusive = true;

  start() {
    fail('Party recap is not available yet.', 'unavailable');
  }
}
