// A Room with fake WebSocket clients (no network): shared by the room and game tests.
//
//   const { app, room, connect, guest, req, song, flush, s } = await setupRoom({ playback: { countdown: 0 } });
//   const host = await connect('host');  const tv = await connect('tv');  const ana = await guest('Ana');
//   await req(host, 'queue.add', { songId: song('hello').id });
//
// Clients record what they receive in `c.inbox` (and the last state in the welcome).
import crypto from 'node:crypto';
import { createApp } from '../server/app.js';
import { tmpDir, writeTree } from './helpers.js';
import { offlineFetch } from './fake-art.js';

export const SONGS = [
  'Adele - Hello [SF Karaoke]',
  'Adele - Hello [ZM Karaoke]',
  'Queen - Bohemian Rhapsody [SF Karaoke]',
  'Queen - Killer Queen (Explicit) [SF Karaoke]',
  'Blondie - Call Me [SC Karaoke]',
  'ABBA - Waterloo [SF Karaoke]',
  'Blondie - Rapture (Explicit) [SF Karaoke]',
  'Blondie - Rapture [SC Karaoke]',
];

/** Extra songs for games that need a bigger pool (quiz distractors, polls, wheels). */
export const MORE_SONGS = [
  'ABBA - Dancing Queen [SF Karaoke]',
  'ABBA - Mamma Mia [SC Karaoke]',
  'Toto - Africa [SF Karaoke]',
  'Journey - Don\'t Stop Believin\' [SC Karaoke]',
  'Whitney Houston - I Wanna Dance With Somebody [SF Karaoke]',
  'Bon Jovi - Livin\' On A Prayer [SF Karaoke]',
  'Cyndi Lauper - Girls Just Want To Have Fun [SC Karaoke]',
  'Elton John & Kiki Dee - Don\'t Go Breaking My Heart [SF Karaoke]',
  'Oasis - Wonderwall [SF Karaoke]',
  'Spice Girls - Wannabe [SC Karaoke]',
  'Gloria Gaynor - I Will Survive [SF Karaoke]',
  'Survivor - Eye Of The Tiger [SF Karaoke]',
];

function filesFor(names) {
  const files = {};
  for (const name of names) {
    const letter = name[0];
    const artist = name.split(' - ')[0];
    files[`${letter}/${artist}/${name}.cdg`] = 7200 * 200;
    files[`${letter}/${artist}/${name}.mp3`] = 100;
  }
  return files;
}

/**
 * @param {object} [settings] settings patch applied after start (countdown defaults to 0)
 * @param {object} [opts]
 * @param {string[]} [opts.songs] file base names (default SONGS)
 * @param {typeof fetch} [opts.fetch] artwork network (default: offline)
 */
export async function setupRoom(settings = {}, { songs = SONGS, fetch = offlineFetch } = {}) {
  const lib = await tmpDir('ok-lib-');
  await writeTree(lib, filesFor(songs));
  const dataDir = await tmpDir('ok-data-');
  const app = await createApp({ dataDir, args: { library: [lib] }, scan: false, watch: false, fetch, crawl: false });
  await app.library.scan();
  app.settings.update({ playback: { countdown: 0 }, ...settings });
  const room = app.room;

  const connect = async (role, hello = {}, { local = true } = {}) => {
    const c = {
      id: crypto.randomBytes(4).toString('hex'), role: null, data: {}, isLocal: local, ip: local ? '127.0.0.1' : '192.168.1.50',
      open: true, inbox: [],
      send(m) { this.inbox.push(m); },
      sendRaw(t) { this.inbox.push(JSON.parse(t)); },
      close() { this.open = false; },
    };
    const r = await room.hello(c, { role, room: app.settings.get('party.roomCode'), ...hello });
    if (!r.ok) return { denied: r.reason };
    c.role = r.role;
    c.welcome = r.welcome;
    app.hub.clients.set(c.id, c);
    room.onJoin(c);
    return c;
  };
  const leave = (c) => {
    app.hub.clients.delete(c.id);
    c.open = false;
    room.onLeave(c);
  };
  const req = (c, t, body = {}) => room.request(c, { t, ...body });
  const song = (q) => app.library.catalog.search(q).items[0];
  const guest = async (name) => {
    const c = await connect('guest');
    await req(c, 'guest.update', { name, emoji: '🦄' });
    return c;
  };
  const flush = () => room.flush();
  /** The latest view a client got (flushes pending broadcasts first). */
  const view = (c) => {
    room.flush();
    for (let i = c.inbox.length - 1; i >= 0; i--) if (c.inbox[i].t === 'state') return c.inbox[i].state;
    return c.welcome.state;
  };
  return { app, room, connect, leave, req, song, guest, flush, view, s: () => room.s };
}
