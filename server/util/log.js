const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
let minLevel = LEVELS[(process.env.LOG_LEVEL || 'info').toLowerCase()] ?? 20;

function stamp() {
  const d = new Date();
  return d.toTimeString().slice(0, 8);
}

function write(level, scope, args) {
  if (LEVELS[level] < minLevel) return;
  const prefix = `${stamp()} ${level.toUpperCase().padEnd(5)} [${scope}]`;
  const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  fn(prefix, ...args);
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
