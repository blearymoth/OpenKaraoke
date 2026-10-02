#!/usr/bin/env node
// OpenKaraoke server entry point: `node server/index.js [--library <folder>] [--port 6527] …`
import { parseArgs, HELP, resolveDataDir, VERSION } from './config.js';
import { startServer, StartError } from './start.js';
import { logger, setLogLevel } from './util/log.js';
import { localAddressFor } from './util/net.js';

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

// Keep the party going: log unexpected errors instead of exiting.
process.on('unhandledRejection', (e) => log.error('unhandled promise rejection', e));
process.on('uncaughtException', (e) => log.error('uncaught exception', e));

const dataDir = resolveDataDir(args);
let started;
try {
  started = await startServer({ dataDir, args, log, appOptions: { scan: args.noScan ? false : undefined } });
} catch (e) {
  if (!(e instanceof StartError)) throw e;
  log.error(e.message);
  // 78 (EX_CONFIG): the systemd unit written by bin/install-service.sh doesn't restart the
  // server after it — it won't work until someone changes something.
  process.exit(e.exitCode);
}
if (started.setup) {
  console.log(`${started.port} ${localAddressFor(started.host)}`);
  process.exit(0);
}
const { app } = started;

const info = app.info();
const lib = app.library.status();
const line = '─'.repeat(58);
console.log(`\n  🎤  OpenKaraoke ${VERSION} — ${info.name}\n  ${line}`);
if (started.moved) console.log(`  (port ${started.wanted} is used by another program — this time and from now on: ${app.port})`);
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
    await started.close();
  } catch (e) {
    log.error('error during shutdown', e);
  }
  process.exit(0);
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGHUP', () => shutdown('SIGHUP')); // the terminal of bin/openkaraoke.sh was closed
