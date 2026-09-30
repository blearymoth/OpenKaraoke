#!/usr/bin/env node
// OpenKaraoke server entry point: `node server/index.js [--library <folder>] [--port 8080] …`
import { parseArgs, HELP, resolveDataDir, VERSION } from './config.js';
import { createApp } from './app.js';
import { logger, setLogLevel } from './util/log.js';

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 18 || (major === 18 && minor < 17)) {
  console.error(`OpenKaraoke needs Node.js 18.17 or newer (this is ${process.versions.node}).`);
  process.exit(1);
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(HELP);
  process.exit(0);
}
if (args.log) setLogLevel(args.log);
const log = logger('server');

const dataDir = resolveDataDir(args);
const app = await createApp({ dataDir, args, scan: args.noScan ? false : undefined });
const port = Number.isInteger(args.port) && args.port > 0 ? args.port : Number(process.env.PORT) || app.settings.get('server.port');
const host = args.host || app.settings.get('server.host');

try {
  await app.listen(port, host);
} catch (e) {
  if (e.code === 'EADDRINUSE') log.error(`Port ${port} is already in use — is OpenKaraoke already running? Try --port ${port + 1}`);
  else if (e.code === 'EACCES') log.error(`No permission to use port ${port} — pick a port above 1024.`);
  else log.error(e);
  await app.close().catch(() => {});
  process.exit(1);
}

const info = app.info();
const lib = app.library.status();
const line = '─'.repeat(58);
console.log(`\n  🎤  OpenKaraoke ${VERSION} — ${info.name}\n  ${line}`);
console.log(`  Host (this computer) : http://localhost:${app.port}/host`);
console.log(`  TV display           : http://localhost:${app.port}/tv`);
console.log(`  Guests join at       : ${info.joinUrl}   (room ${info.roomCode})`);
if (info.lanUrls.length > 1) console.log(`  Other addresses      : ${info.lanUrls.slice(1).join('  ')}`);
if (!lib.roots.length) {
  console.log('\n  No karaoke folder yet: open the host page → Settings → Library,');
  console.log('  or restart with  --library "/run/media/$USER/<drive>/<folder>"');
} else {
  for (const r of lib.roots) console.log(`  Library              : ${r.path} ${r.online ? '' : '(offline — is the drive plugged in?)'}`);
  console.log(`  Indexed              : ${lib.tracks} tracks, ${lib.songs} songs${lib.scanning ? ' (rescanning in the background…)' : ''}`);
}
console.log(`  Data folder          : ${dataDir}\n  ${line}\n`);

let stopping = false;
const shutdown = async (signal) => {
  if (stopping) {
    log.warn('forced exit');
    process.exit(1);
  }
  stopping = true;
  log.info(`${signal} received, saving and shutting down…`);
  const force = setTimeout(() => process.exit(1), 8000);
  force.unref();
  try {
    await app.close();
  } catch (e) {
    log.error('error during shutdown', e);
  }
  process.exit(0);
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
