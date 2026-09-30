// Applause meter (PLAN §13) — placeholder until the game is built.
import { Game, fail } from './base.js';

export class Applause extends Game {
  static type = 'applause';
  static label = 'Applause meter';
  static exclusive = true;

  start() {
    fail('Applause meter is not available yet.', 'unavailable');
  }
}
