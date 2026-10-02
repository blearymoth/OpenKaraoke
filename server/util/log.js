import { formatWithOptions } from 'node:util';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
let minLevel = LEVELS[(process.env.LOG_LEVEL || 'info').toLowerCase()] ?? 20;
let sink = null;

function stamp() {
  const d = new Date();
  return d.toTimeString().slice(0, 8);
}

function write(level, scope, args) {
  if (LEVELS[level] < minLevel) return;
  const prefix = `${stamp()} ${level.toUpperCase().padEnd(5)} [${scope}]`;
  const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  fn(prefix, ...args);
  if (sink) {
    try {
      sink(`${new Date().toISOString().slice(0, 10)} ${formatWithOptions({ colors: false }, prefix, ...args)}\n`);
    } catch { /* a full disk must not stop the party */ }
  }
}

export function logger(scope) {
  return {
    debug: (...a) => write('debug', scope, a),
    info: (...a) => write('info', scope, a),
    warn: (...a) => write('warn', scope, a),
    error: (...a) => write('error', scope, a),
  };
}

export function setLogLevel(level) {
  if (LEVELS[level] !== undefined) minLevel = LEVELS[level];
}

/** Also hands every log line (with the date) to `fn`, e.g. to keep a log file; null stops it. */
export function setLogSink(fn) {
  sink = typeof fn === 'function' ? fn : null;
}
