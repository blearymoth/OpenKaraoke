// autokaraoke's timing.json (shared/timing.js): reading and checking it, autokaraoke's clean-up
// rules, the LRC it writes, and new words that keep the old times (its transfer_timing).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readTiming, timingJson, timingToLrc, cleanTiming, parseLyrics, timingText, transferTiming } from '../shared/timing.js';

const file = {
  version: 1, title: 'Hello', artist: 'Adele', language: 'en', duration: 30.5,
  lines: [
    { words: [{ text: 'Hello', start: 12.3, end: 12.71 }, { text: 'it’s', start: 12.8, end: 13 }, { text: 'me', start: 13.05, end: 13.6 }] },
    { words: [{ text: 'I', start: 14, end: 14.2 }, { text: 'was', start: 14.25, end: 14.5 }] },
  ],
};

test('timing: read, write back, LRC', () => {
  const song = readTiming(file);
  assert.equal(song.lines.length, 2);
  assert.deepEqual(timingJson(song), file, 'the same file back');
  assert.equal(timingToLrc(song), '[ti:Hello]\n[ar:Adele]\n[00:12.30] <00:12.30> Hello <00:12.80> it’s <00:13.05> me <00:13.60>\n[00:14.00] <00:14.00> I <00:14.25> was <00:14.50>\n');
  assert.throws(() => readTiming({ version: 2, lines: [] }), /version 1/);
  assert.throws(() => readTiming(null));
});

test('timing: autokaraoke’s clean-up — empty words go, lines in order, nothing backwards', () => {
  const song = cleanTiming({
    lines: [
      { words: [{ text: 'b', start: 5, end: 4 }, { text: '  ', start: 5, end: 6 }] },
      { words: [{ text: 'a', start: 1, end: 2 }] },
      { words: [] },
      { words: [{ text: 'c', start: 4.5, end: 6 }] }, // starts before "b" ended: pushed forward
    ],
  });
  assert.deepEqual(song.lines.map((l) => l.words.map((w) => w.text).join(' ')), ['a', 'c', 'b']);
  const b = song.lines[2].words[0];
  assert.ok(b.end >= b.start, 'end ≥ start');
  assert.ok(song.lines[2].words[0].start >= song.lines[1].words[0].end - 0.05, 'never starts before the one before ended');
});

test('timing: the editor’s text, and lyrics text the way autokaraoke reads it', () => {
  assert.equal(timingText(readTiming(file)), 'Hello it’s me\nI was');
  assert.deepEqual(parseLyrics('[Chorus]\n  Hello  it’s me \n\n{Verse 2}\nI was'), [['Hello', 'it’s', 'me'], ['I', 'was']]);
});

test('timing: new words keep the old times (a fixed word, a split line, an added word)', () => {
  const old = readTiming(file).lines.flatMap((l) => l.words);
  // "it’s" → "its" (fixed), "me" kept, a new word "there" with no match.
  const lines = transferTiming([['Hello', 'its', 'me', 'there'], ['I', 'was']], old);
  const w = lines.flatMap((l) => l.words);
  assert.equal(w[0].start, 12.3, 'Hello keeps its time');
  assert.equal(w[1].start, 12.8, 'the corrected word keeps its time');
  assert.equal(w[2].start, 13.05);
  assert.ok(w[3].start >= w[2].end && w[3].end <= 14 + 1e-9, `the new word sits between its neighbours (${w[3].start}–${w[3].end})`);
  assert.equal(w[4].start, 14);
  assert.equal(w[5].end, 14.5);
  // Lines split differently: the words keep their times whatever the lines.
  const split = transferTiming([['Hello', 'it’s'], ['me', 'I', 'was']], old);
  assert.equal(split[1].words[0].start, 13.05);
  // Nothing matches at all: the words are spread from 0, never NaN.
  const none = transferTiming([['zzz', 'qqq']], old).flatMap((l) => l.words);
  assert.ok(none.every((x) => Number.isFinite(x.start) && Number.isFinite(x.end) && x.end >= x.start));
});
