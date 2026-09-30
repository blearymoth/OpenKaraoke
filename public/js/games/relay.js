// relay — placeholder until the game is built (PLAN §13).
import { html } from '../vendor/preact.js';
import { ComingSoon } from './common.js';

export const icon = '🎤';
export const blurb = 'During a song the mic is passed around — the TV says who’s next.';
export const comingSoon = true;

export function Setup() {
  return html`<${ComingSoon} />`;
}

export function Control() {
  return null;
}

export function Tv() {
  return null;
}

export function Guest() {
  return null;
}
