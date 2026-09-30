#!/usr/bin/env node
// OpenKaraoke server entry point: node server/index.js [--library <dir>] [--port 8080] …
import { parseArgs, HELP, resolveDataDir, VERSION } from './config.js';
import { createApp } from './app.js';
import { logger, setLogLevel } from './util/log.js';

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(HELP);
  process.exit(0);
}
if (args.log) setLogLevel(args.log);
const log = logger('server');

const major = Number(process.versions.node.split('.')[0]);
const minor = Number(process.versions.node.split('.')[1]);
if (major < 18 || (major === 18 && minor < 17)) {
  console.error(`OpenKaraoke needs Node.js 18.17 or newer (this is ${process.version}).`);
  process.exit(1);
}

const dataDir = resolveDataDir(args);
const app = await createApp({ dataDir, args, log });
try {
  await app.listen();
} catch (e) {
  if (e.code === 'EADDRINUSE') {
    console.error(`Port ${app.port} is already in use. Is OpenKaraoke already running? Try --port 8081.`);
    process.exit(1);
  }
  throw e;
}
await app.start();

const info = app.info();
const lib = app.library.status();
console.log(`
  🎤 OpenKaraoke ${VERSION} — "${info.name}"

  Host (this PC):  http://localhost:${app.port}/host
  TV display:      http://localhost:${app.port}/tv
  Guests join:     ${info.joinUrl}   (room ${info.roomCode})
${info.lanUrls.slice(1).map((u) => `                   ${u}/j/${info.roomCode}\n`).join('')}
  Data folder:     ${dataDir}
  Library:         ${lib.roots.length ? lib.roots.map((r) => `${r.path}${r.online === false ? '  (OFFLINE)' : ''}`).join('\n                   ') : 'not set — add a folder in Settings or start with --library <folder>'}
  Index:           ${lib.tracks} tracks, ${lib.songs} songs${app.library.scanning ? ' (rescanning in the background…)' : ''}
`);

let closing = false;
async function shutdown(sig) {
  if (closing) process.exit(1);
  closing = true;
  log.info(`${sig} received, saving state…`);
  const force = setTimeout(() => process.exit(0), 4000);
  force.unref();
  try { await app.close(); } catch (e) { log.error('shutdown error', e); }
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
