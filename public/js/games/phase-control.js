// Host controls that move a game to its next phase (PLAN §7: game.action with the game's `step`).
import { useEffect, useRef, useState } from '../vendor/preact.js';
import { GAME_SETTLE_MS } from '/shared/protocol.js';

/**
 * `[busy, run]`: `run(body)` sends a phase control with the step the screen was drawn for.
 * `busy` stays true while it is on its way and for GAME_SETTLE_MS after the answer — about
 * when the next phase's buttons appear under the pointer — so the second click of a double
 * click hits a disabled button (the server ignores it too, see Game.control).
 */
export function usePhaseControl(game, act) {
  const [busy, setBusy] = useState(false);
  const timer = useRef(0);
  useEffect(() => () => clearTimeout(timer.current), []);
  const run = async (body) => {
    clearTimeout(timer.current);
    setBusy(true);
    await act('game.action', { ...body, step: game.step });
    timer.current = setTimeout(() => setBusy(false), GAME_SETTLE_MS);
  };
  return [busy, run];
}
