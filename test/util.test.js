import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fold, compact, editDistance, similarity, shortId, splitCredits, formatDuration } from '../shared/text.js';
import { qrSvg, wifiPayload } from '../server/util/qr.js';
import { Settings, parseArgs, makeRoomCode } from '../server/config.js';
import { isLocalAddress, lanAddresses } from '../server/util/net.js';
import { tmpDir } from './helpers.js';

test('fold/compact normalise accents, punctuation and ampersands', () => {
  assert.equal(fold('Beyoncé & Jay-Z'), 'beyonce and jay z');
  assert.equal(compact('A-Ha'), 'aha');
  assert.equal(fold("Don't Stop Me Now!"), 'dont stop me now');
  assert.equal(fold('Øystein Æsir'), 'oystein aesir');
  assert.equal(fold('שלום'), 'שלום', 'non-latin letters are kept');
});

test('editDistance / similarity', () => {
  assert.equal(editDistance('morissette', 'morisette'), 1);
  assert.equal(editDistance('abc', 'xyz', 1), 2);
  assert.ok(similarity('Bohemian Rhapsody', 'bohemian rhapsody') === 1);
  assert.ok(similarity('Bohemian Rhapsody', 'Bohemian Like You') < 0.8);
});

test('shortId is stable and short', () => {
  assert.equal(shortId('abc'), shortId('abc'));
  assert.notEqual(shortId('abc'), shortId('abd'));
  assert.ok(shortId('x').length <= 12);
});

test('splitCredits', () => {
  assert.deepEqual(splitCredits('Alesso Feat. Tove Lo'), ['Alesso', 'Tove Lo']);
  assert.deepEqual(splitCredits('Queen & David Bowie'), ['Queen', 'David Bowie']);
  assert.deepEqual(splitCredits('ABBA (Duet)'), ['ABBA']);
});

test('formatDuration', () => {
  assert.equal(formatDuration(185), '3:05');
  assert.equal(formatDuration(NaN), '');
});

test('qrSvg and wifi payload', () => {
  const svg = qrSvg('http://192.168.1.20:8080/j/ABCD');
  assert.match(svg, /^<svg[^>]+viewBox="0 0 \d+ \d+"/);
  assert.match(svg, /<path d="M/);
  assert.equal(wifiPayload({ ssid: 'My;Net', password: 'p:w' }), 'WIFI:T:WPA;S:My\\;Net;P:p\\:w;;');
  assert.equal(wifiPayload({ ssid: 'Open' }), 'WIFI:T:nopass;S:Open;;');
});

test('settings sanitise unknown keys and types', async () => {
  const dir = await tmpDir();
  const s = new Settings(dir);
  await s.load();
  s.update({ queue: { maxPerGuest: '5', bogus: 1 }, party: { name: 'Friday' }, nope: true });
  assert.equal(s.get('queue.maxPerGuest'), 5);
  assert.equal(s.get('queue.bogus'), undefined);
  assert.equal(s.get('party.name'), 'Friday');
  assert.equal(s.data.nope, undefined);
  await s.flush();
  const again = new Settings(dir);
  await again.load();
  assert.equal(again.get('party.name'), 'Friday');
  assert.equal(again.get('queue.mode'), 'rotation', 'defaults merged in');
});

test('parseArgs / room codes / network helpers', () => {
  const a = parseArgs(['--port', '9000', '-l', '/music', '/more']);
  assert.equal(a.port, 9000);
  assert.deepEqual(a.library, ['/music', '/more']);
  assert.match(makeRoomCode(), /^[A-HJ-NP-Z]{4}$/);
  assert.equal(isLocalAddress('::ffff:127.0.0.1'), true);
  assert.equal(isLocalAddress('203.0.113.9'), false);
  assert.ok(Array.isArray(lanAddresses()));
});
