#!/usr/bin/env node
// OpenKaraoke server entry point: `node server/index.js [--library <folder>] [--port 8080] …`
import { parseArgs, HELP, resolveDataDir, VERSION, Settings, applyArgs, listenAddress } from './config.js';
import { createApp } from './app.js';
import { logger, setLogLevel } from './util/log.js';
import { probePort, localAddressFor } from './util/net.js';

// "Won't work until someone changes something" (sysexits EX_CONFIG): the systemd unit
// written by bin/install-service.sh doesn't restart the server after this exit code.
const EX_CONFIG = 78;

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

const portProblem = (code, port) => {
  if (code === 'EADDRINUSE') return `Port ${port} is already in use — is OpenKaraoke already running? Try --port ${port + 1}`;
  if (code === 'EACCES') return `No permission to use port ${port} — pick a port above 1024.`;
  return null;
};
const exitCodeFor = (code) => (code === 'EADDRINUSE' || code === 'EACCES' ? EX_CONFIG : 1);

const dataDir = resolveDataDir(args);
// The port is checked before the library is loaded (seconds for a big one) and before any
// file is written: a second copy on a taken port (a service started next to
// bin/openkaraoke.sh) stops at once instead of reloading everything and saving old settings.
const settings = new Settings(dataDir);
await settings.load();
const { port, host } = listenAddress(args, settings);
const busy = await probePort(port, host);
if (busy) {
  log.error(portProblem(busy, port) || `Cannot listen on ${host}:${port} (${busy})`);
  process.exit(exitCodeFor(busy));
}
if (args.setup) {
  if (args.library.length || args.pin !== undefined) {
    applyArgs(settings, args);
    await settings.flush();
  }
  console.log(`${port} ${localAddressFor(host)}`);
  process.exit(0);
}

const app = await createApp({ dataDir, args, scan: args.noScan ? false : undefined });
try {
  await app.listen(port, host);
} catch (e) {
  log.error(portProblem(e.code, port) || e);
  // Taken meanwhile: maybe by another OpenKaraoke on this data folder, whose files stay as they are.
  await app.close({ save: false }).catch(() => {});
  process.exit(exitCodeFor(e.code));
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
process.on('SIGHUP', () => shutdown('SIGHUP')); // the terminal of bin/openkaraoke.sh was closed
