// Game registry: type → class. Each game lives in its own module (PLAN §13).
import { fail } from './base.js';
import { Poll } from './poll.js';
import { Quiz } from './quiz.js';
import { Battle } from './battle.js';
import { Wheel } from './wheel.js';
import { Relay } from './relay.js';
import { Applause } from './applause.js';
import { Recap } from './recap.js';

export const GAMES = { quiz: Quiz, battle: Battle, wheel: Wheel, poll: Poll, relay: Relay, applause: Applause, recap: Recap };

export function createGame(type, room, config) {
  const G = typeof type === 'string' && Object.hasOwn(GAMES, type) ? GAMES[type] : null;
  if (!G) fail('Unknown game.', 'not_found');
  return new G(room, config);
}
