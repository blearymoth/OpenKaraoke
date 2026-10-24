// The TV's lyrics as real text (shared/lyric-text.js, PLAN §9.7): a timing.json's lines, long ones
// split with their times, the wipe along a line, the disc's colours made readable on the panel;
// and the server's side: which tracks have words (a timing.json beside the CDG, or an edit), their
// URL in the TV's media (a new one when an edit is saved), and /media/<id>/timing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { textLines, wrapLines, wipeAt, discTextColours, textColours, analysisTextColours, CLASSIC } from '../shared/lyric-text.js';
import { analyzeLines } from '../shared/lyric-lines.js';
import { pagesDisc, rollingDisc, duetDisc } from './lyric-discs.js';
import { contrast, panelBackdrop } from '../shared/lyrics.js';
import { readTiming } from '../shared/timing.js';
import { fakeTiming, cdgFromTiming } from '../server/maker/fake.js';
import { setupRoom } from './room-harness.js';

const until = async (fn, ms = 8000) => {
  const t0 = Date.now();
  while (!(await fn())) {
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
};

const timing = {
  version: 1, title: 'T', artist: 'A', duration: 30,
  lines: [
    { words: [{ text: 'Hello', start: 10, end: 10.5 }, { text: 'world', start: 11, end: 12 }] },
    { words: [] },
    { words: [{ text: 'again', start: 14, end: 15 }] },
  ],
};

test('lyric text: the lines, long ones split with their times, the wipe', () => {
  const lines = textLines(timing);
  assert.equal(lines.length, 2, 'an empty line goes');
  assert.deepEqual(lines[0], { start: 10, end: 12, text: 'Hello world', words: timing.lines[0].words });
  assert.deepEqual(textLines({ lines: [] }), [], 'not a timing file');
  assert.deepEqual(textLines(null), []);

  const width = (s) => s.length * 10; // (10 per character)
  const long = textLines({ version: 1, lines: [{ words: 'one two three four five'.split(' ').map((text, i) => ({ text, start: i, end: i + 0.8 })) }] });
  const split = wrapLines(long, width, 100);
  assert.deepEqual(split.map((l) => l.text), ['one two', 'three four', 'five']);
  assert.deepEqual(split.map((l) => [l.start, l.end]), [[0, 1.8], [2, 3.8], [4, 4.8]], 'each piece keeps its words’ times');
  assert.ok(split.every((l) => width(l.text) <= 100));
  assert.equal(wrapLines(lines, width, 1000)[0], lines[0], 'a line that fits is left as it is');
  assert.equal(wrapLines([{ ...long[0], words: [long[0].words[0]], text: 'one' }], width, 5).length, 1, 'one word can’t be split');

  const xs = [0, 60];
  const ws = [50, 50];
  const w = lines[0].words;
  assert.equal(wipeAt(w, xs, ws, 9), 0, 'before the line');
  assert.equal(wipeAt(w, xs, ws, 10.25), 25, 'half way through “Hello”');
  assert.equal(wipeAt(w, xs, ws, 10.8), 50, 'between the words: waits at the end of “Hello”');
  assert.equal(wipeAt(w, xs, ws, 11.5), 85);
  assert.equal(wipeAt(w, xs, ws, 20), 110, 'all sung');
  assert.equal(wipeAt([{ text: 'x', start: 1, end: 1 }], [0], [10], 1), 10, 'a word with no length is sung at once');
});

test('lyric text: the disc’s colours, readable on both skins’ panels', () => {
  const song = readTiming(fakeTiming('Driving through the night\nNeon on the road', { duration: 20 }));
  const disc = discTextColours(cdgFromTiming(song, 20));
  assert.deepEqual(disc, CLASSIC, 'autokaraoke’s classic theme, from the disc’s first colour table');
  assert.equal(discTextColours(new Uint8Array(24 * 10)), null, 'no colour table');
  for (const plate of [{ rgb: [7, 11, 22], a: 0.9 }, { rgb: [10, 4, 22], a: 0.9 }]) {
    for (const look of ['panel', 'clear']) {
      const c = textColours(look, disc, plate);
      const back = panelBackdrop(plate);
      assert.ok(contrast(c.unsung, back) >= 7 && contrast(c.sung, back) >= 7, `${look}: 7:1 on the panel`);
      assert.ok(contrast(c.unsung, c.sung) > 1.2, 'sung and unsung apart');
    }
  }
  const dim = { bg: [0, 0, 0], unsung: [120, 120, 120], sung: [40, 60, 160] };
  const fixed = textColours('panel', dim, { rgb: [7, 11, 22], a: 0.9 });
  assert.ok(contrast(fixed.sung, panelBackdrop({ rgb: [7, 11, 22], a: 0.9 })) >= 7, 'a dim disc gets brighter');
  assert.deepEqual(textColours('disc', dim, null), dim, 'as the disc made them');
});

test('lyric text: any disc’s colours, from its sung lines (a disc’s own words, PLAN §31.16)', () => {
  const of = (d) => analysisTextColours(analyzeLines(d.bytes || d));
  assert.deepEqual(of(pagesDisc()), { bg: [0, 0, 68], unsung: [255, 255, 255], sung: [255, 255, 0] }, 'white → yellow (alike in brightness, not in colour)');
  assert.deepEqual(of(rollingDisc()).unsung, [255, 255, 255], 'a highlight bar behind the letters is not the letters');
  assert.deepEqual(of(duetDisc()), { bg: [0, 0, 0], unsung: [85, 153, 255], sung: [255, 221, 0] }, 'the colour most letters turn between');
  assert.equal(analysisTextColours({ ok: false, lines: [] }), null);
  assert.equal(analysisTextColours(null), null);
});

test('lyric text: the TV is told where a song’s words are; a saved edit gives a new URL', async (t) => {
  const made = 'P/Pixel Band/Pixel Band - Night Drive';
  const words = fakeTiming('Driving through the night\nNeon on the road', { title: 'Night Drive', artist: 'Pixel Band', duration: 20 });
  const files = {
    [`${made}.mp3`]: 100,
    [`${made}.cdg`]: cdgFromTiming(readTiming(words), 20),
    [`${made}.timing.json`]: JSON.stringify(words),
  };
  const { app, room, connect, req, song } = await setupRoom({}, { files });
  t.after(() => app.close());
  await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${app.port}`;
  const host = await connect('host');
  await connect('tv');
  const nd = song('night drive');
  const trackId = nd.trackIds[0];
  const hello = song('hello');

  await req(host, 'queue.add', { songId: nd.id, singerName: 'Bo' });
  await req(host, 'player.play');
  await until(() => room.currentView({ media: true }).media?.timing);
  assert.equal(room.currentView({ media: true }).media.timing, `/media/${trackId}/timing`);
  const served = await fetch(`${base}/media/${trackId}/timing`);
  assert.equal(served.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.deepEqual((await served.json()).lines[0].words.map((w) => w.text), ['Driving', 'through', 'the', 'night']);

  // A disc without a timing.json: no URL, and the route says so.
  assert.equal(room.lyrics.hasText(app.library.catalog.track(hello.trackIds[0])), false);
  await until(() => room.lyrics.timed.get(hello.trackIds[0]) === false);
  assert.equal(room.mediaFor(app.library.catalog.track(hello.trackIds[0])).timing, undefined);
  assert.equal((await fetch(`${base}/media/${hello.trackIds[0]}/timing`)).status, 404);
  assert.equal((await fetch(`${base}/media/nope1234/timing`)).status, 404);

  // An edit (autokaraoke not installed: saved, not drawn): the words change on the TV at once.
  const edit = structuredClone(words);
  edit.lines[0].words[0].text = 'Cruising';
  const res = await fetch(`${base}/api/lyrics/${trackId}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ timing: edit }) });
  assert.equal((await res.json()).drawnNow, false);
  assert.equal(room.currentView({ media: true }).media.timing, `/media/${trackId}/timing?v=1`, 'a new URL');
  assert.equal((await (await fetch(`${base}/media/${trackId}/timing?v=1`)).json()).lines[0].words[0].text, 'Cruising', 'the edit is what the TV gets');
  await fetch(`${base}/api/lyrics/${trackId}/revert`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(room.currentView({ media: true }).media.timing, `/media/${trackId}/timing?v=2`);
  assert.equal((await (await fetch(`${base}/media/${trackId}/timing?v=2`)).json()).lines[0].words[0].text, 'Driving', 'reverted');
});
