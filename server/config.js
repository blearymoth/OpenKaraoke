import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { JsonDoc, deepMerge, isPlainObject } from './util/jsonfile.js';

export const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PUBLIC_DIR = path.join(APP_ROOT, 'public');
export const SHARED_DIR = path.join(APP_ROOT, 'shared');
export const VERSION = JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'package.json'), 'utf8')).version;

/** Every user-editable setting with its default. */
export const DEFAULT_SETTINGS = {
  server: {
    port: 8080,
    host: '0.0.0.0',
    publicUrl: '', // e.g. http://192.168.1.20:8080 - overrides the auto-detected join URL
  },
  library: {
    paths: [],
    rescanOnStart: true,
    brandPriority: [], // preferred karaoke labels, e.g. ["SF", "#Z", "SC"]
  },
  party: {
    name: 'Karaoke Night',
    roomCode: '',
    adminPin: '',
    trustLocalhost: true, // the computer running OpenKaraoke never needs the PIN
    guestsEnabled: true,
    wifi: { ssid: '', password: '', security: 'WPA', hidden: false, show: false },
  },
  queue: {
    mode: 'rotation', // 'rotation' (fair round-robin) or 'fifo'
    newcomersFirst: true,
    requireApproval: false,
    maxPerGuest: 3, // queued songs per guest, 0 = unlimited
    maxDuration: 0, // seconds, 0 = unlimited
    allowRepeats: false, // same song twice in one party
    explicitFilter: false,
    guestCanRemoveOwn: true,
    guestsSeeQueue: true,
    guestKeyChange: true,
  },
  playback: {
    countdown: 10,
    startPaused: false,
    autoAdvance: true,
    volume: 0.9,
    normalize: true,
    defaultChannelMode: 'stereo',
    fadeSeconds: 1.5,
    lyricOffsetMs: 0,
    ratingAfterSong: true,
    whenQueueEmpty: 'lobby', // 'lobby' | 'break' | 'autoplay'
    breakMusic: { enabled: true, source: 'library', folder: '', volume: 0.35, matchNext: true },
  },
  display: {
    background: 'art', // 'art' | 'visualizer' | 'photos' | 'plain'
    visualizer: 'aurora',
    cdgSmoothing: true,
    cdgTransparent: true,
    showQr: true,
    showTicker: true,
    tickerMessage: '',
    showTitleCard: true,
    showUpNext: true,
    showProgress: true,
    showReactions: true,
    accent: '#ff3d8b',
  },
  artwork: {
    enabled: true,
    crawl: true, // look up the whole library in the background (popular songs first)
    background: true,
    providers: { deezer: true, itunes: false, musicbrainz: true, theaudiodb: true, fanarttv: false },
    theaudiodbKey: '123',
    fanartKey: '',
    maxCacheMB: 3072,
  },
  guests: {
    reactions: true,
    photos: true,
    photoApproval: true,
    games: true,
  },
};

const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

export function makeRoomCode() {
  let s = '';
  for (let i = 0; i < 4; i++) s += ROOM_ALPHABET[crypto.randomInt(ROOM_ALPHABET.length)];
  return s;
}

export function parseArgs(argv) {
  const out = { library: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--port' || a === '-p') out.port = Number(next());
    else if (a === '--host') out.host = next();
    else if (a === '--data') out.data = next();
    else if (a === '--library' || a === '-l') out.library.push(next());
    else if (a === '--pin') out.pin = next();
    else if (a === '--log') out.log = next();
    else if (a === '--no-scan') out.noScan = true;
    else if (a === '--no-crawl') out.noCrawl = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (!a.startsWith('-')) out.library.push(a);
  }
  return out;
}

export const HELP = `OpenKaraoke - self-hosted karaoke party server

Usage: node server/index.js [options] [library folder ...]

Options:
  -l, --library <dir>   add a karaoke folder (can be repeated)
  -p, --port <n>        HTTP port (default 8080)
      --host <addr>     bind address (default 0.0.0.0 = whole network)
      --data <dir>      where settings, the library index and art cache live
      --pin <pin>       set the host PIN
      --no-scan         don't rescan the library on start
      --no-crawl        don't look up artwork for the whole library in the background
      --log <level>     debug | info | warn | error

Environment: OPENKARAOKE_DATA, PORT, LOG_LEVEL`;

export function resolveDataDir(args) {
  const dir = args.data || process.env.OPENKARAOKE_DATA || path.join(APP_ROOT, 'data');
  fs.mkdirSync(dir, { recursive: true });
  return path.resolve(dir);
}

export class Settings extends JsonDoc {
  constructor(dataDir) {
    super(path.join(dataDir, 'settings.json'), DEFAULT_SETTINGS, { pretty: true, debounceMs: 300 });
  }

  get(pathStr) {
    return pathStr.split('.').reduce((o, k) => (o == null ? undefined : o[k]), this.data);
  }

  /** Applies a (partial) settings object, only for keys that exist in the defaults. */
  update(patch) {
    const clean = sanitize(patch, DEFAULT_SETTINGS);
    deepMerge(this.data, clean);
    this.save();
    return clean;
  }
}

function sanitize(patch, schema) {
  if (!isPlainObject(patch)) return {};
  const out = {};
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in schema)) continue;
    const def = schema[k];
    if (isPlainObject(def)) {
      if (isPlainObject(v)) out[k] = sanitize(v, def);
    } else if (Array.isArray(def)) {
      if (Array.isArray(v)) out[k] = v.filter((x) => typeof x === 'string' || typeof x === 'number').slice(0, 500);
    } else if (typeof def === 'number') {
      const n = Number(v);
      if (Number.isFinite(n)) out[k] = n;
    } else if (typeof def === 'boolean') {
      out[k] = !!v;
    } else if (typeof def === 'string') {
      if (v != null) out[k] = String(v).slice(0, 2000);
    }
  }
  return out;
}

export function defaultMusicDirs() {
  const user = os.userInfo().username;
  return [`/run/media/${user}`, `/media/${user}`, '/media', '/mnt', path.join(os.homedir(), 'Music')];
}
