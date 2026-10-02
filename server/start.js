// Starts the OpenKaraoke server for server/index.js (the command line) and desktop/main.mjs
// (the desktop app): one server per data folder (util/datalock.js), on the port asked for with
// --port / $PORT (only that one), or else on the one in the settings — and when another program
// has that one, on the next free port, which is kept in the settings so that the join address
// and printed QR codes stay the same next time.
import { Settings, applyArgs, listenAddress } from './config.js';
import { createApp } from './app.js';
import { acquireDataLock } from './util/datalock.js';
import { probePort, findFreePort } from './util/net.js';
import { systemRunner, HOTSPOT_ADDRESS } from './net/nmcli.js';
import { fetchHealth } from './net/hotspot.js';

/** A port problem a free port can solve (as opposed to e.g. EADDRNOTAVAIL: a wrong --host). */
const MOVABLE = new Set(['EADDRINUSE', 'EACCES']);

/** Why the server could not start: `code` is RUNNING, EADDRINUSE, EACCES or another listen error. */
export class StartError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.code = code;
    Object.assign(this, extra);
  }

  /** sysexits EX_CONFIG: "won't work until someone changes something" — the systemd unit doesn't retry it. */
  get exitCode() {
    return this.code === 'RUNNING' || MOVABLE.has(this.code) ? 78 : 1;
  }
}

export function portProblem(code, port, fixed = true) {
  if (code === 'EADDRINUSE') {
    return fixed
      ? `Port ${port} is already in use. Pick another one with --port, or leave --port out and OpenKaraoke picks a free one.`
      : `Port ${port} is already in use.`;
  }
  if (code === 'EACCES') return `No permission to use port ${port} — pick a port above 1024.`;
  return null;
}

/**
 * @param {object} opts
 * @param {string} opts.dataDir
 * @param {object} [opts.args] parsed command-line arguments (port, host, library, pin, setup)
 * @param {object} [opts.env] for $PORT
 * @param {object} [opts.appOptions] passed on to createApp (scan, watch, fetch, crawl)
 * @param {{ warn: Function }} [opts.log]
 * @returns {Promise<{ setup: true, port: number, host: string } |
 *   { app: object, port: number, host: string, wanted: number, moved: boolean, close: Function }>}
 */
export async function startServer({ dataDir, args = {}, env = process.env, appOptions = {}, log } = {}) {
  // First, before the library is loaded (seconds for a big one) and before any file is
  // written: a second copy on the same data folder stops at once.
  const lock = await acquireDataLock(dataDir);
  if (!lock.ok) {
    const where = lock.holder.port ? ` at http://localhost:${lock.holder.port}/host` : '';
    throw new StartError('RUNNING', `OpenKaraoke is already running with this data folder (${dataDir})${where}.`, { holder: lock.holder });
  }
  let settings = null;
  try {
    settings = new Settings(dataDir);
    await settings.load();
    const { port: wanted, host, fixed } = listenAddress(args, settings, env);
    let port = wanted;
    const busy = await probePort(port, host);
    if (busy) {
      if (fixed || !MOVABLE.has(busy)) throw new StartError(busy, portProblem(busy, port, fixed) || `Cannot listen on ${host}:${port} (${busy})`, { port });
      port = await findFreePort(host, wanted + 1);
      log?.warn(`Port ${wanted} is used by another program: OpenKaraoke uses ${port} instead (and keeps it for next time).`);
      settings.update({ server: { port } });
    }
    if (args.setup) {
      applyArgs(settings, args);
      await settings.flush();
      await lock.release();
      return { setup: true, port, host };
    }
    await settings.flush(); // createApp reads the settings again (with the port picked here)

    const app = await createApp({ dataDir, args, ...appOptions, hotspot: { ...(await hotspotOptions(log)), ...appOptions.hotspot } });
    for (let attempt = 1; ; attempt++) {
      try {
        await app.listen(port, host);
        break;
      } catch (e) {
        // Taken between the check and now: by another program (pick the next free port), or —
        // when only this port will do — tell why. Nothing is saved over files on disk.
        if (fixed || e.code !== 'EADDRINUSE' || attempt >= 3) {
          await app.close({ save: false }).catch(() => {});
          throw new StartError(e.code || 'ERROR', portProblem(e.code, port, fixed) || `Cannot listen on ${host}:${port} (${e.message})`, { port });
        }
        port = await findFreePort(host, port + 1);
        log?.warn(`The port was taken meanwhile: OpenKaraoke uses ${port} instead.`);
        app.settings.update({ server: { port } });
      }
    }
    await lock.update({ port: app.port, host });
    let closed = null;
    return {
      app,
      port: app.port,
      host,
      wanted,
      moved: app.port !== wanted,
      /** Saves everything and stops; the data folder is free for the next start. */
      close: (opts) => (closed ||= (async () => {
        try {
          await app.close(opts);
        } finally {
          await lock.release();
        }
      })()),
    };
  } catch (e) {
    settings?.discard(); // e.g. an upgraded settings format: not written by a server that didn't start
    await lock.release();
    throw e;
  }
}

/**
 * How the party hotspot reaches NetworkManager: the real nmcli (through execFile), or the fake
 * of scripts/fake-nmcli.mjs with OPENKARAOKE_FAKE_NMCLI=<scenario> for trying the hotspot without
 * Wi-Fi (the fake is not part of the desktop app's files: it is only loaded when asked for; its
 * pretend address 10.42.0.1 is checked at this computer instead). Always the process's own
 * environment (PATH), whatever `env` the caller gave for the config.
 */
async function hotspotOptions(log) {
  const scenario = process.env.OPENKARAOKE_FAKE_NMCLI;
  if (scenario) {
    try {
      const { run } = (await import('../scripts/fake-nmcli.mjs')).fakeNmcli(scenario);
      const pretend = `http://${HOTSPOT_ADDRESS.split('/')[0]}:`;
      log?.warn(`party hotspot: a pretend NetworkManager (scenario “${scenario}”) — no real Wi-Fi changes`);
      return { run, health: (url) => fetchHealth(url.startsWith(pretend) ? url.replace(pretend, 'http://127.0.0.1:') : url) };
    } catch (e) {
      log?.warn(`OPENKARAOKE_FAKE_NMCLI ignored: ${e.message}`);
    }
  }
  return { run: systemRunner({ env: process.env }) };
}
