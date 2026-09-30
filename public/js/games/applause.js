// applause — placeholder until the game is built (PLAN §13).
import { html } from '../vendor/preact.js';
import { ComingSoon } from './common.js';

export const icon = '👏';
export const blurb = 'The TV computer’s microphone measures the cheering.';
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
