// Songs from a link (PLAN §31.12): the lyrics preview and the deny note. Without lyrics, the song is
// guessed from the video's title and its lyrics looked up at once (the stand-in's "LRCLIB"); the
// host sees them, can look up again with other names, and Approve uses what was shown. Deny sends
// a note and, when the library has the song already, that song for the guest to sing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupRoom } from './room-harness.js';
import { fakeAutokaraoke } from '../server/maker/fake.js';
import { lyricsArgs, readLyricsLookup } from '../server/maker/autokaraoke.js';
import { namesFromVideo } from '../shared/maker.js';

const until = async (fn, ms = 8000) => {
  const t0 = Date.now();
  while (!(await fn())) {
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
};
const YT = (id) => `https://youtu.be/${id}`;
const TITLES = {
  dQw4w9WgXcQ: { title: 'Rick Astley - Never Gonna Give You Up (Official Music Video)', author_name: 'Rick Astley' },
  kJQP7kiw5Fk: { title: 'Hello (Official Video)', author_name: 'AdeleVEVO' },
  '9bZkp7q19f0': { title: 'Nothing Like It At All', author_name: 'Somebody' },
};
/** YouTube's oEmbed, as a stand-in: the titles above. */
const oembed = async (url) => {
  const id = /[?&]v=([\w-]{11})|youtu\.be%2F([\w-]{11})|watch%3Fv%3D([\w-]{11})/.exec(String(url));
  const hit = id && TITLES[id[1] || id[2] || id[3]];
  return hit ? { ok: true, json: async () => hit } : { ok: false, json: async () => ({}) };
};

test('links: names from a video’s title; the lookup command and its output', () => {
  assert.deepEqual(namesFromVideo('Rick Astley - Never Gonna Give You Up (Official Music Video)'), { artist: 'Rick Astley', title: 'Never Gonna Give You Up' });
  assert.deepEqual(namesFromVideo('Hello (Official Video) [4K]', 'Adele - Topic'), { artist: 'Adele', title: 'Hello' });
  assert.deepEqual(namesFromVideo('Hello', 'AdeleVEVO'), { artist: 'Adele', title: 'Hello' });
  assert.deepEqual(namesFromVideo('Bon Iver | Holocene'), { artist: 'Bon Iver', title: 'Holocene' });
  assert.deepEqual(namesFromVideo('Live Forever (Remastered 2014)', 'Oasis'), { artist: 'Oasis', title: 'Live Forever' });
  assert.deepEqual(namesFromVideo(42), { artist: '', title: '' });

  assert.deepEqual(lyricsArgs({ artist: 'Rick Astley', title: 'Never Gonna', sources: ['sidecar', 'lrclib', 'evil'] }),
    ['-m', 'autokaraoke', 'lyrics', '--sources', 'lrclib', '--show', '--', 'Rick Astley', 'Never Gonna'], 'no sidecar (no song file), no unknown source; names after --');
  assert.deepEqual(lyricsArgs({ artist: '-rf', title: '--x', sources: ['lrclib'] }).slice(-3), ['--', '-rf', '--x'], 'a name that looks like an option is still a name');
  assert.throws(() => lyricsArgs({ title: ' ', sources: ['lrclib'] }), /title/);
  assert.throws(() => lyricsArgs({ title: 'T', sources: ['sidecar'] }), /source/);
  const out = readLyricsLookup(`LRCLIB                       nothing found
NetEase                      2 lines  (Rick Astley - Never Gonna Give You Up)
Never gonna give you up
Never gonna let you down
lyrics.ovh                   nothing found`);
  assert.deepEqual(out.map((r) => [r.source, r.found, r.lines]), [['lrclib', false, 0], ['netease', true, 2], ['lyricsovh', false, 0]]);
  assert.equal(out[1].text, 'Never gonna give you up\nNever gonna let you down');
  assert.equal(out[1].match, 'Rick Astley - Never Gonna Give You Up');
});

test('links: the lyrics preview — guessed names, looked up at once, Approve uses what was shown', async (t) => {
  const tool = fakeAutokaraoke({ seconds: 0.1, lookupHit: 'Never gonna give you up\nNever gonna let you down' });
  const { app, room, req, guest, connect, view } = await setupRoom({}, { makerTool: tool, fetch: oembed });
  t.after(() => app.close());
  await until(() => room.maker.checks);
  app.settings.update({ maker: { guestLinks: true } });
  const host = await connect('host');
  const ana = await guest('Ana');

  // No lyrics: the names from the video's title, then the lyrics looked up.
  const asked = await req(ana, 'link.add', { url: YT('dQw4w9WgXcQ') });
  await until(() => room.hostView().links[0].preview?.state === 'found');
  const r = room.hostView().links[0];
  assert.equal(r.artist, 'Rick Astley');
  assert.equal(r.plainTitle, 'Never Gonna Give You Up');
  assert.equal(r.guessed, true);
  assert.deepEqual({ ...r.preview, text: undefined }, { state: 'found', label: 'LRCLIB', lines: 2, match: 'Rick Astley - Never Gonna Give You Up', text: undefined, artist: 'Rick Astley', title: 'Never Gonna Give You Up' });
  const lookup = tool.state.runs.find((x) => x.kind === 'lyrics');
  assert.deepEqual(lookup.opts.sources, ['lrclib'], 'the host’s sources (sidecar left out)');
  assert.equal(view(ana).me.links[0].preview, undefined, 'the guest doesn’t see the preview');

  // Guests can't look up; the host looks up with other names: nothing found.
  await assert.rejects(req(ana, 'link.lyrics', { id: asked.id }), /not allowed/);
  const none = await req(host, 'link.lyrics', { id: asked.id, artist: 'Nobody', title: 'Nothing Like This' });
  assert.equal(none.preview.state, 'none');
  assert.equal(none.plainTitle, 'Nothing Like This');
  await assert.rejects(req(host, 'link.lyrics', { id: asked.id, title: ' ' }), /Fill in the title/);
  const back = await req(host, 'link.lyrics', { id: asked.id, artist: 'Rick Astley', title: 'Never Gonna Give You Up' });
  assert.equal(back.preview.state, 'found');

  // Approve from the popup (no lyrics sent): the lyrics shown are the ones used, as typed.
  await req(host, 'link.approve', { id: asked.id });
  await until(() => room.links.list.find((x) => x.id === asked.id).state === 'done');
  const job = room.maker.jobs.find((j) => j.tag === asked.id);
  assert.equal(job.lyrics, 'Never gonna give you up\nNever gonna let you down');
  const made = tool.state.runs.filter((x) => x.kind === 'make').at(-1);
  assert.deepEqual(made.opts.lyricsSources, [], 'not looked up again: used as written');
  assert.equal(room.links.list.find((x) => x.id === asked.id).preview.text, '', 'decided: the preview’s text isn’t kept');

  // The guest typed lyrics: nothing is looked up.
  const typed = await req(ana, 'link.add', { url: YT('kJQP7kiw5Fk'), lyrics: 'Hello, it’s me' });
  await until(() => room.hostView().links.find((x) => x.id === typed.id).plainTitle === 'Hello');
  await new Promise((res) => setTimeout(res, 100));
  assert.equal(room.hostView().links.find((x) => x.id === typed.id).preview, null);
  assert.equal(room.hostView().links.find((x) => x.id === typed.id).artist, 'Adele', 'the channel, when the title has no artist');
});

test('links: deny with a note and a song the library has; host only; checked', async (t) => {
  const tool = fakeAutokaraoke({ seconds: 0.1, lookupHit: '' });
  const { app, room, req, guest, connect, song } = await setupRoom({}, { makerTool: tool, fetch: oembed });
  t.after(() => app.close());
  await until(() => room.maker.checks);
  app.settings.update({ maker: { guestLinks: true } });
  const host = await connect('host');
  const ana = await guest('Ana');
  const asked = await req(ana, 'link.add', { url: YT('kJQP7kiw5Fk') });
  const hello = song('hello');

  await assert.rejects(req(ana, 'link.deny', { id: asked.id, reason: 'mine' }), /not allowed/);
  await assert.rejects(req(host, 'link.deny', { id: asked.id, songId: 'nope' }), /isn’t in the library/);
  assert.equal(room.links.list[0].state, 'pending', 'a bad song: nothing decided');
  const denied = await req(host, 'link.deny', { id: asked.id, reason: '  We already have this song —\nsing ours!  ', songId: hello.id });
  assert.equal(denied.state, 'denied');
  assert.equal(denied.error, 'We already have this song — sing ours!', 'one line, trimmed');
  assert.deepEqual(denied.alt, { songId: hello.id, title: room.catalog.song(hello.id).title, artist: room.catalog.song(hello.id).artist });

  // Ana's phone is told, with the song to open; her Me tab has the note and the song.
  await until(() => ana.inbox.some((m) => m.t === 'notify' && m.kind === 'link' && m.state === 'denied'));
  const told = ana.inbox.find((m) => m.t === 'notify' && m.kind === 'link' && m.state === 'denied');
  assert.equal(told.reason, 'We already have this song — sing ours!');
  assert.equal(told.alt.songId, hello.id);
  const mine = room.links.mine(room.links.list[0].owner)[0];
  assert.equal(mine.error, 'We already have this song — sing ours!');
  assert.equal(mine.alt.songId, hello.id);
  await assert.rejects(req(host, 'link.deny', { id: asked.id }), /already decided/);

  // No note, no song: still fine.
  const second = await req(ana, 'link.add', { url: YT('9bZkp7q19f0') });
  const plain = await req(host, 'link.deny', { id: second.id });
  assert.equal(plain.error, '');
  assert.equal(plain.alt, null);
  const long = 'x'.repeat(500);
  const third = await req(ana, 'link.add', { url: YT('dQw4w9WgXcQ') });
  assert.equal((await req(host, 'link.deny', { id: third.id, reason: long })).error.length, 200, 'a note is 200 characters at most');
});
