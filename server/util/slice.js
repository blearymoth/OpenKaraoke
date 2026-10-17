// Long loops on the server's thread, in slices: `await tick()` between pieces of work yields to
// the event loop once `budgetMs` have gone by, so requests keep being answered.

/** A function to await between pieces of work. It throws an AbortError once `signal` fires. */
export function slicer(signal = null, budgetMs = 8) {
  let since = performance.now();
  return async (now = false) => {
    if (signal?.aborted) throw abortError();
    if (!now && performance.now() - since < budgetMs) return;
    await new Promise((resolve) => setImmediate(resolve));
    if (signal?.aborted) throw abortError();
    since = performance.now();
  };
}

export function abortError(message = 'Stopped') {
  const e = new Error(message);
  e.name = 'AbortError';
  return e;
}
