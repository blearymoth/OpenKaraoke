import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fold, compact, editDistance, similarity, shortId, splitCredits, formatDuration } from '../shared/text.js';
import { qrSvg, wifiPayload } from '../server/util/qr.js';
import { Settings, DEFAULT_SETTINGS, migrateSettings, parseArgs, makeRoomCode } from '../server/config.js';
import { LYRICS_LOOKS } from '../shared/lyrics.js';
import { isLocalAddress, lanAddresses } from '../server/util/net.js';
import { deviceLabel } from '../server/util/useragent.js';
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

test('settings: the lyrics look, scrolling and lighter effects take only their listed values', async () => {
  const s = new Settings(await tmpDir());
  await s.load();
  assert.equal(s.get('display.lyricsLook'), 'panel');
  assert.equal(s.get('display.lyricsMotion'), 'smooth');
  assert.equal(s.get('display.lighterEffects'), 'auto');
  assert.equal(s.get('display.cdgSmoothing'), true);
  assert.equal(Object.hasOwn(DEFAULT_SETTINGS.display, 'cdgTransparent'), false, 'display.cdgTransparent is gone');
  s.update({ display: { lyricsLook: 'clear', lyricsMotion: 'disc', lighterEffects: 'on' } });
  assert.deepEqual([s.get('display.lyricsLook'), s.get('display.lyricsMotion'), s.get('display.lighterEffects')], ['clear', 'disc', 'on']);
  for (const bad of ['Panel', '', 'lines', 'classic', '__proto__', 'constructor', 'toString', 3, null, ['disc'], { look: 'disc' }, true]) {
    s.update({ display: { lyricsLook: bad, lyricsMotion: bad, lighterEffects: bad } });
    assert.deepEqual([s.get('display.lyricsLook'), s.get('display.lyricsMotion'), s.get('display.lighterEffects')], ['clear', 'disc', 'on'], `${JSON.stringify(bad)} is ignored`);
  }
  s.update({ display: { lyricsLook: 'bogus', showQr: false } });
  assert.equal(s.get('display.showQr'), false, 'the valid half of an update still applies');
  assert.equal(s.get('display.lyricsLook'), 'clear');
  for (const look of LYRICS_LOOKS) {
    s.update({ display: { lyricsLook: look } });
    assert.equal(s.get('display.lyricsLook'), look);
  }
  await s.flush();
});

test('settings: "show the background behind the lyrics" off becomes the disc look', async () => {
  const off = { display: { cdgTransparent: false, background: 'art' } };
  assert.equal(migrateSettings(off), true);
  assert.equal(off.display.lyricsLook, 'disc', 'the disc’s own background, as before');
  assert.equal(Object.hasOwn(off.display, 'cdgTransparent'), false);
  assert.equal(off.display.background, 'art');
  const on = { display: { cdgTransparent: true } };
  assert.equal(migrateSettings(on), true);
  assert.equal(Object.hasOwn(on.display, 'cdgTransparent'), false, 'removed');
  assert.equal(Object.hasOwn(on.display, 'lyricsLook'), false, 'the look stays the default');
  const chosen = { display: { cdgTransparent: false, lyricsLook: 'clear' } };
  migrateSettings(chosen);
  assert.equal(chosen.display.lyricsLook, 'clear', 'a look chosen since is kept');
  const current = { appearance: { theme: 'studio', accent: '' }, display: { lyricsLook: 'clear', lyricsMotion: 'disc', lighterEffects: 'off', cdgSmoothing: false } };
  const before = structuredClone(current);
  assert.equal(migrateSettings(current), false, 'settings saved without it are left alone');
  assert.deepEqual(current, before);
  const edited = { appearance: { theme: 'studio', accent: '' }, display: { lyricsLook: 'neon', lighterEffects: 7 } };
  assert.equal(migrateSettings(edited), true);
  assert.deepEqual([edited.display.lyricsLook, edited.display.lighterEffects], ['panel', 'auto'], 'a value no version offers: the default');

  // through the settings file: the defaults are merged in first, then the old switch moves over
  const dir = await tmpDir();
  await fs.writeFile(path.join(dir, 'settings.json'), JSON.stringify({ display: { cdgTransparent: false, cdgSmoothing: false } }));
  const s = new Settings(dir);
  await s.load();
  assert.equal(s.get('display.lyricsLook'), 'disc');
  assert.equal(s.get('display.cdgSmoothing'), false);
  assert.equal(s.get('display.cdgTransparent'), undefined);
  await s.flush();
  const saved = JSON.parse(await fs.readFile(path.join(dir, 'settings.json'), 'utf8'));
  assert.equal(saved.display.lyricsLook, 'disc');
  assert.equal(Object.hasOwn(saved.display, 'cdgTransparent'), false);
  const dir2 = await tmpDir();
  await fs.writeFile(path.join(dir2, 'settings.json'), JSON.stringify({ display: { cdgTransparent: true } }));
  const s2 = new Settings(dir2);
  await s2.load();
  assert.equal(s2.get('display.lyricsLook'), 'panel');
  assert.equal(s2.get('display.cdgTransparent'), undefined);
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

test('deviceLabel: a short name from a fixed list for any User-Agent', () => {
  const table = [
    ['Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36', 'Chrome · Android'],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1', 'Safari · iPhone'],
    ['Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1', 'Safari · iPad'],
    ['Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0', 'Firefox · Linux'],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0', 'Edge · Windows'],
    ['Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/129.0.0.0 Safari/537.36', 'Chrome · Linux'],
    ['Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) OpenKaraoke/0.1.0 Chrome/152.0.0.0 Electron/44.5.1 Safari/537.36', 'OpenKaraoke app'],
    ['Mozilla/5.0 (SMART-TV; LINUX; Tizen 6.0) AppleWebKit/537.36 (KHTML, like Gecko) 76.0.3809.146/6.0 TV Safari/537.36', 'Samsung TV'],
    ['Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/79.0.3945.79 Safari/537.36 WebAppManager', 'LG TV'],
    ['Mozilla/5.0 (Linux; Android 9; AFTMM Build/PS7233) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36', 'Fire TV'],
    ['Mozilla/5.0 (X11; Linux armv7l) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0 Safari/537.36 CrKey/1.56.500000', 'Chromecast'],
    ['', 'Browser'], [undefined, 'Browser'], ['%%% garbage <script>', 'Browser'],
  ];
  for (const [ua, want] of table) assert.equal(deviceLabel(ua), want, String(ua));
  const big = `Mozilla/5.0 Version/${'a'.repeat(10_000)}`;
  const t0 = performance.now();
  const label = deviceLabel(big);
  assert.ok(performance.now() - t0 < 5, 'linear on long input');
  assert.equal(label, 'Browser');
});
