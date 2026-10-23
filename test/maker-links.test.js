// Song links (shared/maker.js): only YouTube videos, reduced to watch?v=<id>; typed lyrics cleaned.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLink, cleanLyrics, MAX_LYRICS } from '../shared/maker.js';

const ID = 'dQw4w9WgXcQ';
const WATCH = `https://www.youtube.com/watch?v=${ID}`;

test('links: the ways a YouTube video is shared all become one link', () => {
  for (const link of [
    WATCH, `http://youtube.com/watch?v=${ID}`, `https://m.youtube.com/watch?v=${ID}&feature=share`,
    `https://music.youtube.com/watch?v=${ID}&list=RDAMVM`, `https://youtu.be/${ID}?si=abc`, `youtu.be/${ID}`,
    `https://www.youtube.com/shorts/${ID}`, `https://www.youtube.com/live/${ID}`, `https://www.youtube.com/embed/${ID}`,
    `  ${WATCH}&t=42s  `, `https://www.youtube.com/watch?list=PL1&v=${ID}`,
  ]) assert.deepEqual(parseLink(link), { url: WATCH, id: ID }, link);
});

test('links: anything else is refused, with a reason', () => {
  const no = (link, re) => assert.match(parseLink(link).error || '', re, String(link));
  no('', /Paste/);
  no(undefined, /Paste/);
  no('https://vimeo.com/12345', /Only YouTube/);
  no(`https://youtube.com.evil.example/watch?v=${ID}`, /Only YouTube/);
  no(`https://user:pass@www.youtube.com/watch?v=${ID}`, /YouTube link/);
  no(`https://www.youtube.com:8443/watch?v=${ID}`, /YouTube link/);
  no(`javascript:alert(1)//youtube.com/watch?v=${ID}`, /YouTube link/);
  no('https://www.youtube.com/playlist?list=PL123', /playlist/);
  no('https://www.youtube.com/watch?v=short', /video link/);
  no(`https://www.youtube.com/watch?v=${ID}x`, /video link/);
  no('https://www.youtube.com/@channel', /video link/);
  no(`${WATCH} and more`, /YouTube link/);
  no(`https://www.youtube.com/watch?v=${ID}&x=${'a'.repeat(600)}`, /YouTube link/);
});

test('lyrics: plain lines, trimmed, nothing hidden, not too long', () => {
  assert.equal(cleanLyrics('\r\n  Hello   it’s me \r\n\r\nI was\u0007 wondering \n\n'), 'Hello it’s me\n\nI was wondering');
  assert.equal(cleanLyrics(42), '');
  assert.equal(cleanLyrics('x'.repeat(MAX_LYRICS + 10)).length, MAX_LYRICS);
});
