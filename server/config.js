import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { JsonDoc, deepMerge, isPlainObject } from './util/jsonfile.js';
import { THEMES, DEFAULT_THEME, ACCENT_RE, normalizeAccent, normalizeAppearance } from '../shared/themes.js';

export const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PUBLIC_DIR = path.join(APP_ROOT, 'public');
export const SHARED_DIR = path.join(APP_ROOT, 'shared');
export const VERSION = JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'package.json'), 'utf8')).version;

/**
 * The usual port (6527 spells OKAR on a phone keypad). Many programs use 8080, which was the
 * default before: when the port is taken, the server picks the next free one and keeps it in
 * the settings (server/start.js), so the join address and printed QR codes stay the same.
 */
export const DEFAULT_PORT = 6527;
/** The default port until the desktop app came: a stored 8080 is moved to DEFAULT_PORT. */
export const LEGACY_PORT = 8080;

/** Every user-editable setting with its default. */
export const DEFAULT_SETTINGS = {
  server: {
    port: DEFAULT_PORT,
    host: '0.0.0.0',
    publicUrl: '', // e.g. http://192.168.1.20:6527 - overrides the auto-detected join URL
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
    // The party hotspot (PLAN §20): this PC's own Wi-Fi through NetworkManager. Empty name →
    // OpenKaraoke-<room code>; empty password → one is made up the first time.
    hotspot: { enabled: false, ssid: '', password: '', band: 'auto', ifname: '' },
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
    guestVocals: true, // guests choose a guide vocal / backing vocals when queueing, and switch the guide on their own song
  },
  playback: {
    countdown: 10,
    startPaused: false,
    autoStart: true, // start the first song as soon as it is queued (when a TV display is on)
    autoAdvance: true,
    volume: 0.9,
    normalize: true,
    defaultChannelMode: 'stereo',
    leadVocal: 0, // the guide singer's level on multiplex tracks at the start of a song (0 = off … 100)
    findGuideVocal: true, // the TV may find multiplex tracks by their sound (not only by the file name)
    fadeSeconds: 1.5,
    lyricOffsetMs: 0,
    ratingAfterSong: true,
    whenQueueEmpty: 'lobby', // 'lobby' | 'autoplay' (a popular sing-along for everyone after autoplayAfter s)
    autoplayAfter: 45,
    // Quiet music on the TV while nobody sings: backing tracks from the library (matching the
    // next song's genre/decade) or songs from a music folder.
    breakMusic: { enabled: true, source: 'library', folder: '', volume: 0.35, matchNext: true },
  },
  appearance: {
    theme: DEFAULT_THEME, // 'studio' | 'party' (shared/themes.js): the look of every screen
    accent: '', // '#rrggbb' replaces the skin's accent colour; '' = the skin's own
  },
  display: {
    background: 'art', // 'art' | 'visualizer' | 'photos' | 'plain'
    fanart: true, // artist photos (from TheAudioDB / Fanart.tv) instead of the blurred cover when there are some
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
  },
  artwork: {
    enabled: true, // look up covers & metadata online (the only outgoing traffic)
    crawl: true, // look up the whole library in the background, popular songs first
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
    else if (a === '--setup') out.setup = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (!a.startsWith('-')) out.library.push(a);
  }
  return out;
}

export const HELP = `OpenKaraoke - self-hosted karaoke party server

Usage: node server/index.js [options] [library folder ...]

Options:
  -l, --library <dir>   karaoke folder (can be repeated); replaces the folders kept in
                        Settings, and is kept there for the next start
  -p, --port <n>        HTTP port; only this one (without it: the one in Settings, 6527 at
                        first, or the next free one when another program has it)
      --host <addr>     bind address (default 0.0.0.0 = whole network)
      --data <dir>      where settings, the library index and art cache live
      --pin <pin>       set the host PIN (kept in Settings for the next start)
      --no-scan         don't rescan the library on start
      --log <level>     debug | info | warn | error
      --setup           only keep --library/--pin in the settings, pick the port, print
                        "<port> <address>" and exit (bin/install-service.sh)

Environment: OPENKARAOKE_DATA, PORT, LOG_LEVEL`;

/**
 * Keeps --library / --pin in the settings. They are one-off changes, like the same change
 * made in Settings: a service must not pass them on every start (that would undo later
 * changes made in Settings), so bin/install-service.sh applies them once with --setup.
 */
export function applyArgs(settings, args) {
  if (args.library?.length) settings.update({ library: { paths: [...new Set(args.library.map((p) => path.resolve(p)))] } });
  if (args.pin !== undefined) settings.update({ party: { adminPin: String(args.pin) } });
}

/**
 * Where the server listens: --port / --host, then $PORT, then the settings. `fixed` when the
 * port was asked for (--port or $PORT): only that one will do. A port from the settings may
 * move to a free one when another program has it (server/start.js).
 */
export function listenAddress(args, settings, env = process.env) {
  const asked = Number.isInteger(args.port) && args.port > 0 ? args.port : Number.parseInt(env.PORT, 10) > 0 ? Number.parseInt(env.PORT, 10) : 0;
  const saved = Number(settings.get('server.port'));
  const port = asked || (Number.isInteger(saved) && saved > 0 && saved <= 65535 ? saved : DEFAULT_PORT);
  const host = args.host || settings.get('server.host');
  return { port, host, fixed: asked > 0 };
}

export function resolveDataDir(args) {
  const dir = args.data || process.env.OPENKARAOKE_DATA || path.join(APP_ROOT, 'data');
  fs.mkdirSync(dir, { recursive: true });
  return path.resolve(dir);
}

export class Settings extends JsonDoc {
  constructor(dataDir) {
    super(path.join(dataDir, 'settings.json'), DEFAULT_SETTINGS, { pretty: true, debounceMs: 300 });
  }

  async load() {
    await super.load();
    if (migrateSettings(this.data)) this.save();
    return this.data;
  }

  get(pathStr) {
    return pathStr.split('.').reduce((o, k) => (o == null ? undefined : o[k]), this.data);
  }

  /** Applies a (partial) settings object, only for keys that exist in the defaults. */
  update(patch) {
    const clean = sanitize(patch, DEFAULT_SETTINGS);
    const look = clean.appearance;
    // An unknown skin or a malformed colour is ignored (the current one stays), never "fixed".
    if (look?.theme !== undefined && !(typeof look.theme === 'string' && Object.hasOwn(THEMES, look.theme))) delete look.theme;
    if (look?.accent !== undefined) {
      if (look.accent && !ACCENT_RE.test(look.accent)) delete look.accent;
      else look.accent = normalizeAccent(look.accent);
    }
    deepMerge(this.data, clean);
    this.save();
    return clean;
  }
}

/** The accent colour every party had before skins existed (display.accent's old default). */
export const LEGACY_ACCENT = '#ff3d8b';

/**
 * Brings settings saved by an older version up to date, in place. Returns true when something
 * changed. display.accent became appearance.accent: a colour the owner picked is kept, the old
 * default is dropped (so existing parties get the default skin with its own accent).
 */
export function migrateSettings(data) {
  let changed = false;
  if (!isPlainObject(data.appearance)) {
    data.appearance = structuredClone(DEFAULT_SETTINGS.appearance);
    changed = true;
  }
  if (isPlainObject(data.display) && Object.hasOwn(data.display, 'accent')) {
    const legacy = normalizeAccent(data.display.accent);
    if (legacy && legacy !== LEGACY_ACCENT && !data.appearance.accent) data.appearance.accent = legacy;
    delete data.display.accent;
    changed = true;
  }
  // 8080 was the default before, and many programs use it: parties move to the new default.
  if (isPlainObject(data.server) && data.server.port === LEGACY_PORT) {
    data.server.port = DEFAULT_PORT;
    changed = true;
  }
  const look = normalizeAppearance(data.appearance);
  if (look.theme !== data.appearance.theme || look.accent !== data.appearance.accent) {
    Object.assign(data.appearance, look);
    changed = true;
  }
  return changed;
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
