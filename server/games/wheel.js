// Roulette wheel (PLAN §13) — placeholder until the game is built.
import { Game, fail } from './base.js';

export class Wheel extends Game {
  static type = 'wheel';
  static label = 'Roulette wheel';
  static exclusive = true;

  start() {
    fail('Roulette wheel is not available yet.', 'unavailable');
  }
}
