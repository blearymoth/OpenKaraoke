// recap — placeholder until the game is built (PLAN §13).
import { html } from '../vendor/preact.js';
import { ComingSoon } from './common.js';

export const icon = '🏆';
export const blurb = 'Tonight’s highlights on the TV: top singers, best rated, most sung.';
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
