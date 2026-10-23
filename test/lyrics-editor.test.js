// The lyrics editor's server side (server/lyrics/edits.js, PLAN §31.5): which versions can be
// edited (autokaraoke's timing.json beside them), host only, an edit saved and drawn by
// autokaraoke (the stand-in) and served to the TV in place of the disc's CDG, a failed drawing,
// revert, writing it back into the song's folder (originals kept as .orig), the theme a disc was
// drawn in, and an edit following its file to a new track id.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setupRoom } from './room-harness.js';
import { fakeAutokaraoke, fakeTiming, cdgFromTiming } from '../server/maker/fake.js';
import { cdgTheme, LyricEdits } from '../server/lyrics/edits.js';
import { readTiming } from '../shared/timing.js';

const until = async (fn, ms = 8000) => {
  const t0 = Date.now();
  while (!(await fn())) {
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
};

const timing = fakeTiming('Driving through the night\nNeon on the road', { title: 'Night Drive', artist: 'Pixel Band', duration: 20 });
const made = 'P/Pixel Band/Pixel Band - Night Drive';
const FILES = {
  [`${made}.mp3`]: 100,
  [`${made}.cdg`]: cdgFromTiming(readTiming(timing), 20),
  [`${made}.timing.json`]: JSON.stringify(timing),
};

test('lyrics editor: autokaraoke’s songs only, host only; save → drawn → the TV gets it; revert; write back', async (t) => {
  const tool = fakeAutokaraoke({ seconds: 0.1 });
  const { app, room, connect, guest, req, song } = await setupRoom({}, { makerTool: tool, files: FILES });
  t.after(() => app.close());
  await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${app.port}`;
  await until(() => room.maker.where?.installed);
  const host = await connect('host');
  await connect('tv');
  const nd = song('night drive');
  const trackId = nd.trackIds[0];
  const hello = song('hello');

  // Song details: the host sees "Edit lyrics" on autokaraoke's version only.
  const details = async (s) => (await fetch(`${base}/api/songs/${s.id}`)).json();
  assert.deepEqual((await details(nd)).versions[0].lyrics, { edited: false });
  assert.ok((await details(hello)).versions.every((v) => !v.lyrics), 'a disc without a timing.json: nothing to edit');
  const ana = await guest('Ana');
  const asGuest = await fetch(`${base}/api/songs/${nd.id}`, { headers: { 'x-guest-token': ana.welcome.token } });
  assert.ok(!(await asGuest.json()).versions[0].lyrics, 'not for guests');

  // Open (host only), as autokaraoke wrote it.
  assert.equal((await fetch(`${base}/api/lyrics/${hello.trackIds[0]}`)).status, 400, 'no timing.json');
  const opened = await (await fetch(`${base}/api/lyrics/${trackId}`)).json();
  assert.equal(opened.edited, false);
  assert.equal(opened.renderer, true);
  assert.deepEqual(opened.timing.lines[0].words.map((w) => w.text), ['Driving', 'through', 'the', 'night']);

  // The song is on: an edit is drawn, served in place of the disc's CDG, and the TV reloads it.
  await req(host, 'queue.add', { songId: nd.id, singerName: 'Bo' });
  await req(host, 'player.play');
  const before = Buffer.from(await (await fetch(`${base}/media/${trackId}/cdg`)).arrayBuffer());
  const reload = room.s.player.reload || 0;
  const edit = structuredClone(opened.timing);
  edit.lines[0].words[0].text = 'Cruising';
  edit.lines[0].words[0].start = 2.5;
  const post = (url, body) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const saved = await (await post(`${base}/api/lyrics/${trackId}`, { timing: edit })).json();
  assert.equal(saved.drawnNow, true);
  assert.equal(saved.edited, true);
  assert.equal(saved.timing.lines[0].words[0].text, 'Cruising');
  assert.equal(room.s.player.reload, reload + 1, 'the TV reloads the song where it is');
  assert.match(room.currentView({ media: true }).media.cdg, /\/cdg\?edit=1$/, 'a new CDG URL');
  const after = Buffer.from(await (await fetch(`${base}/media/${trackId}/cdg`)).arrayBuffer());
  assert.ok(after.length > 0 && !after.equals(before), 'the edited CDG is served');
  const render = tool.state.runs.find((r) => r.kind === 'render');
  assert.equal(render.opts.theme, 'classic', 'drawn in the colours the disc was drawn in');
  assert.ok(render.opts.timing.startsWith(path.join(app.dataDir, 'lyrics')), 'the edit is in the data folder');
  assert.deepEqual((await details(nd)).versions[0].lyrics, { edited: true });
  const lib = app.library.paths[0];
  assert.equal(JSON.parse(await fs.readFile(path.join(lib, `${made}.timing.json`), 'utf8')).lines[0].words[0].text, 'Driving', 'the library file is untouched');

  // Bad input is refused.
  assert.equal((await post(`${base}/api/lyrics/${trackId}`, { timing: { version: 2 } })).status, 400);
  assert.equal((await post(`${base}/api/lyrics/${trackId}`, { timing: { ...edit, lines: [] } })).status, 400);

  // Drawing fails: the edit is kept, the TV keeps the last drawing, and the host is told why.
  tool.state.fail = 'render';
  edit.lines[1].words[0].text = 'Neon!';
  const failed = await (await post(`${base}/api/lyrics/${trackId}`, { timing: edit })).json();
  assert.equal(failed.drawnNow, false);
  assert.match(failed.error, /could not be drawn: ValueError/);
  assert.equal(failed.timing.lines[1].words[0].text, 'Neon!', 'the edit is saved');
  assert.equal(room.lyrics.gen(trackId), 1, 'the TV keeps the last drawing');
  tool.state.fail = '';

  // Revert: autokaraoke's own again, and the disc's CDG.
  const reverted = await (await post(`${base}/api/lyrics/${trackId}/revert`, {})).json();
  assert.equal(reverted.edited, false);
  assert.equal(reverted.timing.lines[0].words[0].text, 'Driving');
  assert.equal(room.lyrics.cdgFor(trackId), null);
  assert.ok(Buffer.from(await (await fetch(`${base}/media/${trackId}/cdg`)).arrayBuffer()).equals(before));

  // Write back: into the song's folder, the originals kept once.
  assert.equal((await post(`${base}/api/lyrics/${trackId}/write`, {})).status, 400, 'nothing saved yet');
  await post(`${base}/api/lyrics/${trackId}`, { timing: edit });
  const written = await (await post(`${base}/api/lyrics/${trackId}/write`, {})).json();
  assert.equal(written.edited, false, 'the song’s own files are the edit now');
  assert.equal(written.timing.lines[0].words[0].text, 'Cruising');
  assert.equal(JSON.parse(await fs.readFile(path.join(lib, `${made}.timing.json.orig`), 'utf8')).lines[0].words[0].text, 'Driving');
  assert.ok((await fs.readFile(path.join(lib, `${made}.cdg.orig`))).equals(before));
  assert.match(await fs.readFile(path.join(lib, `${made}.lrc`), 'utf8'), /<00:02\.50> Cruising/);
  assert.ok(!(await fs.readFile(path.join(lib, `${made}.cdg`))).equals(before), 'the new drawing is the song’s CDG');

});

test('lyrics editor: autokaraoke not installed — the edit is kept, not drawn', async (t) => {
  const tool = fakeAutokaraoke({ installed: false });
  const { app, room, song } = await setupRoom({}, { makerTool: tool, files: FILES });
  t.after(() => app.close());
  await until(() => room.maker.where);
  const trackId = song('night drive').trackIds[0];
  const opened = await room.lyrics.open(trackId);
  assert.equal(opened.renderer, false);
  const saved = await room.lyrics.save(trackId, opened.timing);
  assert.equal(saved.drawnNow, false);
  assert.match(saved.error, /autokaraoke is needed/);
  assert.equal(saved.edited, true);
  assert.equal(room.lyrics.cdgFor(trackId), null);
});

test('lyrics editor: the colours a disc was drawn in; an edit follows its file', async () => {
  const cdg = cdgFromTiming(readTiming(timing), 5);
  assert.equal(cdgTheme(cdg), 'classic');
  assert.equal(cdgTheme(Buffer.alloc(24 * 10)), '', 'no colour table');
  const other = Buffer.from(cdg);
  other[8] = 0; // colour 2 (the sung words) of the first colour table: another maker's disc
  other[9] = 0;
  assert.equal(cdgTheme(other), '');

  const dataDir = await fs.mkdtemp('/tmp/ok-le-');
  const edits = new LyricEdits({ dataDir, library: null, maker: null });
  await fs.mkdir(path.join(dataDir, 'lyrics', 'aaaa1111'), { recursive: true });
  await fs.writeFile(path.join(dataDir, 'lyrics', 'aaaa1111', 'lyrics.cdg'), cdg);
  await edits.load();
  assert.ok(edits.cdgFor('aaaa1111'));
  assert.equal(edits.rekey([{ from: 'aaaa1111', to: 'bbbb2222' }]), 1);
  assert.equal(edits.cdgFor('aaaa1111'), null);
  assert.ok(edits.cdgFor('bbbb2222').endsWith(path.join('bbbb2222', 'lyrics.cdg')));
  assert.ok(edits.gen('bbbb2222') > 1, 'a new URL for the TV');
  assert.equal(edits.dir('../etc'), null, 'ids can’t leave the folder');
});
