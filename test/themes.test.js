// App-wide skins (settings.appearance): validation, migration of the old display.accent, the skin
// written into every served page (ETag, 304, gzip, 404), and base.css staying in step with
// shared/themes.js.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { Settings, DEFAULT_SETTINGS, migrateSettings, LEGACY_ACCENT, PUBLIC_DIR } from '../server/config.js';
import { createApp } from '../server/app.js';
import { withAppearance, appearanceVariant, notFoundPage } from '../server/http/shell.js';
import { THEMES, THEME_IDS, DEFAULT_THEME, normalizeTheme, normalizeAccent, normalizeAppearance, accentInk } from '../shared/themes.js';
import { contrastText } from '../shared/text.js';
import { tmpDir } from './helpers.js';
import { worstDifference, labAs, oklch } from './color-vision.js';
import { segmentIndex, WHEEL_MAX_SEGMENTS } from '../shared/wheel.js';
import { COLORS, singerColor } from '../shared/protocol.js';
import { offlineFetch } from './fake-art.js';

// ---- validation -------------------------------------------------------------------------------

test('themes: Studio is the default skin, Party is the other one', () => {
  assert.equal(DEFAULT_THEME, 'studio');
  assert.deepEqual(THEME_IDS, ['studio', 'party']);
  assert.deepEqual(DEFAULT_SETTINGS.appearance, { theme: 'studio', accent: '' });
  assert.equal(Object.hasOwn(DEFAULT_SETTINGS.display, 'accent'), false, 'display.accent is gone');
  for (const id of THEME_IDS) {
    assert.ok(THEMES[id].name && THEMES[id].description, `${id} has a name and a description`);
    assert.match(THEMES[id].themeColor, /^#[0-9a-f]{6}$/);
    assert.match(THEMES[id].accent, /^#[0-9a-f]{6}$/);
  }
});

test('themes: theme and accent are normalised', () => {
  assert.equal(normalizeTheme('party'), 'party');
  assert.equal(normalizeTheme('studio'), 'studio');
  for (const bad of ['neon', '', 'Party', 'constructor', '__proto__', 'toString', null, undefined, 3, {}]) {
    assert.equal(normalizeTheme(bad), 'studio', `${String(bad)} → studio`);
  }
  assert.equal(normalizeAccent('#00C2FF'), '#00c2ff');
  assert.equal(normalizeAccent(''), '');
  for (const bad of ['#fff', '00c2ff', '#00c2ffcc', 'red', '#00c2fg', ' #00c2ff', 'url(x)', null, 7]) {
    assert.equal(normalizeAccent(bad), '', `${String(bad)} is not an accent`);
  }
  assert.deepEqual(normalizeAppearance({ theme: 'party', accent: '#ABCDEF', extra: 1 }), { theme: 'party', accent: '#abcdef' });
  assert.deepEqual(normalizeAppearance(null), { theme: 'studio', accent: '' });
  assert.equal(accentInk('#ffe066'), '#111', 'dark text on a light accent');
  assert.equal(accentInk('#1368ce'), '#fff', 'white text on a dark accent');
  // Mid-light accents get whichever text colour has the higher WCAG contrast (white would be
  // 2–3:1 on these), so labels on accent buttons stay readable.
  for (const mid of ['#00c2ff', '#2ecc71', '#3498db', '#ff6262', '#e67e22']) {
    assert.equal(accentInk(mid), '#111', `dark text on ${mid}`);
    assert.ok(contrast('#111111', mid) >= 4.5, `${mid}: readable`);
  }
  for (const dark of ['#9b59b6', '#000000', '#7a1fa2']) assert.equal(accentInk(dark), '#fff', `white text on ${dark}`);
  assert.equal(accentInk('red'), '#fff', 'not an accent');
});

test('settings: appearance updates are validated', async () => {
  const s = new Settings(await tmpDir());
  await s.load();
  assert.deepEqual(s.get('appearance'), { theme: 'studio', accent: '' });
  s.update({ appearance: { theme: 'party' } });
  assert.equal(s.get('appearance.theme'), 'party');
  for (const bad of ['disco', 'Party', '', 'constructor', '__proto__', 'toString', 5, null, ['party'], { id: 'party' }]) {
    s.update({ appearance: { theme: bad } });
    assert.equal(s.get('appearance.theme'), 'party', `${JSON.stringify(bad)} is ignored, the skin stays`);
  }
  s.update({ appearance: { theme: 'bogus', accent: '#123456' } });
  assert.deepEqual(s.get('appearance'), { theme: 'party', accent: '#123456' }, 'the valid half of an update still applies');
  s.update({ appearance: { theme: 'studio', accent: '' } });
  assert.deepEqual(s.get('appearance'), { theme: 'studio', accent: '' });
  s.update({ appearance: { accent: '#00C2FF' } });
  assert.equal(s.get('appearance.accent'), '#00c2ff');
  for (const bad of ['red', '#fff', 'javascript:alert(1)', '#00c2ff;color:red', 42]) {
    s.update({ appearance: { accent: bad } });
    assert.equal(s.get('appearance.accent'), '#00c2ff', `${bad} is refused, the accent stays`);
  }
  s.update({ appearance: { accent: '' } });
  assert.equal(s.get('appearance.accent'), '', 'back to the skin’s own colour');
  s.update({ appearance: { bogus: 1 }, display: { accent: '#123456' } });
  assert.equal(s.get('appearance.bogus'), undefined);
  assert.equal(s.get('display.accent'), undefined, 'nothing writes display.accent any more');
  await s.flush();
});

// ---- migration of settings saved before skins existed ---------------------------------------------

test('settings: display.accent migrates to appearance.accent', () => {
  const custom = { display: { accent: '#00C2FF', background: 'art' } };
  assert.equal(migrateSettings(custom), true);
  assert.deepEqual(custom.appearance, { theme: 'studio', accent: '#00c2ff' }, 'an owner’s own colour survives');
  assert.equal(Object.hasOwn(custom.display, 'accent'), false);
  assert.equal(custom.display.background, 'art');

  const legacyDefault = { display: { accent: LEGACY_ACCENT } };
  migrateSettings(legacyDefault);
  assert.deepEqual(legacyDefault.appearance, { theme: 'studio', accent: '' }, 'the old default pink is not an override');
  assert.equal(Object.hasOwn(legacyDefault.display, 'accent'), false);
  const upper = { display: { accent: '#FF3D8B' } };
  migrateSettings(upper);
  assert.equal(upper.appearance.accent, '');

  const garbage = { display: { accent: 'not a colour' } };
  migrateSettings(garbage);
  assert.equal(garbage.appearance.accent, '');
  assert.equal(Object.hasOwn(garbage.display, 'accent'), false);

  const both = { appearance: { theme: 'party', accent: '#111111' }, display: { accent: '#222222' } };
  migrateSettings(both);
  assert.deepEqual(both.appearance, { theme: 'party', accent: '#111111' }, 'an appearance already saved wins');

  const broken = { appearance: { theme: 'rave', accent: 'pink' } };
  assert.equal(migrateSettings(broken), true);
  assert.deepEqual(broken.appearance, { theme: 'studio', accent: '' });

  const current = { appearance: { theme: 'party', accent: '' }, display: {} };
  assert.equal(migrateSettings(current), false, 'up-to-date settings are left alone');
});

test('settings: an old settings.json loads in the new shape (and is saved that way)', async () => {
  const dir = await tmpDir();
  const file = path.join(dir, 'settings.json');
  await fs.writeFile(file, JSON.stringify({ party: { name: 'Old party' }, display: { accent: '#7cf05a', showQr: false } }));
  const s = new Settings(dir);
  await s.load();
  assert.deepEqual(s.get('appearance'), { theme: 'studio', accent: '#7cf05a' }, 'existing parties switch to Studio, keeping their colour');
  assert.equal(s.get('display.accent'), undefined);
  assert.equal(s.get('display.showQr'), false);
  await s.flush();
  const saved = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.deepEqual(saved.appearance, { theme: 'studio', accent: '#7cf05a' });
  assert.equal(Object.hasOwn(saved.display, 'accent'), false);

  await fs.writeFile(file, JSON.stringify({ display: { accent: '#ff3d8b' } }));
  const t = new Settings(dir);
  await t.load();
  assert.deepEqual(t.get('appearance'), { theme: 'studio', accent: '' });
  await t.flush();
});

// ---- the skin in the HTML shells --------------------------------------------------------------------

test('shell: the skin is written into <html> and theme-color', async () => {
  const page = await fs.readFile(path.join(PUBLIC_DIR, 'host.html'), 'utf8');
  const studio = withAppearance(page, { theme: 'studio', accent: '' });
  assert.match(studio, /<html lang="en" data-theme="studio">/);
  assert.ok(studio.includes(`<meta name="theme-color" content="${THEMES.studio.themeColor}">`));
  const party = withAppearance(page, { theme: 'party', accent: '' });
  assert.match(party, /<html lang="en" data-theme="party">/);
  assert.match(party, /<meta name="theme-color" content="#150f26">/);
  const accented = withAppearance(page, { theme: 'party', accent: '#FFE066' });
  assert.match(accented, /<html lang="en" data-theme="party" style="--neon: #ffe066; --neon-ink: #111;">/);
  assert.equal(withAppearance(accented, { theme: 'studio' }), studio, 'a page that already has a skin gets the new one only');
  assert.match(withAppearance(page, { theme: '"><script>' }), /data-theme="studio"/, 'never anything but a known skin');
  assert.doesNotMatch(withAppearance(page, { accent: '#fff"><script>' }), /script>"/);
  assert.equal(appearanceVariant({ theme: 'studio', accent: '' }), 'studio');
  assert.equal(appearanceVariant({ theme: 'party', accent: '#00C2FF' }), 'party-00c2ff');
  for (const f of ['index.html', 'host.html', 'tv.html', 'guest.html']) {
    const text = await fs.readFile(path.join(PUBLIC_DIR, f), 'utf8');
    assert.match(withAppearance(text, { theme: 'party' }), /<html lang="en" data-theme="party">[\s\S]*<meta name="theme-color" content="#150f26">/, `${f} has both`);
    // the favicon is the skin's app icon; Party's page keeps the original links untouched
    assert.equal(withAppearance(text, { theme: 'party' }).replace(/<html[^>]*>/, '').replace(/<meta name="theme-color"[^>]*>/, ''),
      text.replace(/<html[^>]*>/, '').replace(/<meta name="theme-color"[^>]*>/, ''), `${f}: Party changes only <html> and theme-color`);
    const studioText = withAppearance(text, { theme: 'studio' });
    assert.match(studioText, /<link rel="icon" href="\/img\/icon-studio\.svg"/, `${f}: Studio favicon`);
    assert.doesNotMatch(studioText, /href="\/img\/icon\.svg"/, `${f}: no Party icon link left in Studio`);
    assert.equal(withAppearance(studioText, { theme: 'party' }), withAppearance(text, { theme: 'party' }), `${f}: and back`);
  }
  assert.match(notFoundPage({ theme: 'party' }), /data-theme="party"[\s\S]*background:#0e0b16[\s\S]*color:#ff3d8b/);
  const studio404 = notFoundPage({ theme: 'studio', accent: '#00c2ff' });
  assert.match(studio404, new RegExp(`data-theme="studio"[\\s\\S]*background:${THEMES.studio.themeColor}[\\s\\S]*background:#00c2ff;color:#111`), 'Studio 404: the accent button, with readable text on it');
  assert.match(notFoundPage({ theme: 'studio' }), new RegExp(`src="${THEMES.studio.icon}"[\\s\\S]*background:${THEMES.studio.accent};color:${THEMES.studio.accentInk}`));
  assert.match(studio404, /font-family:'Figtree'[\s\S]*url\(\/fonts\/figtree-latin\.woff2\)/, 'Studio 404 uses the app font');
});

let app;
let base;
before(async () => {
  app = await createApp({ dataDir: await tmpDir('ok-themes-data-'), args: { library: [await tmpDir('ok-themes-lib-')] }, scan: false, watch: false, fetch: offlineFetch, crawl: false });
  await app.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${app.port}`;
});
after(async () => {
  await app?.close();
});

/** A raw GET (no automatic decompression), resolving to { status, headers, body: Buffer }. */
function rawGet(p, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get(base + p, { headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
}

test('http: every page is served in the current skin; a switch changes the page and its ETag', async () => {
  app.settings.update({ appearance: { theme: 'studio', accent: '' } });
  const pages = ['/', '/host', '/tv', `/j/${app.settings.get('party.roomCode')}`];
  const etags = {};
  for (const p of pages) {
    const r = await rawGet(p);
    assert.equal(r.status, 200, p);
    assert.match(r.body.toString(), /<html lang="en" data-theme="studio">/, `${p} in Studio`);
    assert.ok(r.body.toString().includes(`<meta name="theme-color" content="${THEMES.studio.themeColor}">`));
    etags[p] = r.headers.etag;
    assert.ok(etags[p]);
    const again = await rawGet(p, { 'if-none-match': etags[p] });
    assert.equal(again.status, 304, `${p}: unchanged skin → 304`);
  }

  app.settings.update({ appearance: { theme: 'party' } });
  for (const p of pages) {
    const r = await rawGet(p, { 'if-none-match': etags[p] });
    assert.equal(r.status, 200, `${p}: the copy cached in Studio is not reused after the switch`);
    assert.notEqual(r.headers.etag, etags[p], `${p}: the ETag depends on the skin`);
    assert.match(r.body.toString(), /<html lang="en" data-theme="party">/, `${p} in Party`);
    assert.match(r.body.toString(), /<meta name="theme-color" content="#150f26">/);
  }

  // gzip (the landing page is big enough) carries the same skin
  const gz = await rawGet('/', { 'accept-encoding': 'gzip' });
  assert.equal(gz.headers['content-encoding'], 'gzip');
  assert.match(zlib.gunzipSync(gz.body).toString(), /data-theme="party"/);
  assert.equal(gz.headers.etag, (await rawGet('/')).headers.etag);

  app.settings.update({ appearance: { accent: '#00C2FF' } });
  const tv = await rawGet('/tv', { 'if-none-match': etags['/tv'] });
  assert.equal(tv.status, 200);
  assert.match(tv.body.toString(), new RegExp(`data-theme="party" style="--neon: #00c2ff; --neon-ink: ${accentInk('#00c2ff')};"`));
  assert.match(tv.headers.etag, /party-00c2ff/);

  // /favicon.ico (pages without an icon link: the songbook) follows the skin too, so no 301
  const fav = await rawGet('/favicon.ico');
  assert.equal(fav.status, 302);
  assert.equal(fav.headers.location, '/img/icon.svg', 'Party: the original icon');

  const missing = await rawGet('/no-such-page');
  assert.equal(missing.status, 404);
  assert.match(missing.body.toString(), /data-theme="party"[\s\S]*color:#00c2ff/);

  app.settings.update({ appearance: { theme: 'studio', accent: '' } });
  const back = await rawGet('/host');
  assert.equal(back.headers.etag, etags['/host'], 'back in Studio: the Studio copy is valid again');
  assert.match(back.body.toString(), /data-theme="studio">/);
  assert.equal((await rawGet('/favicon.ico')).headers.location, '/img/icon-studio.svg');
  for (const id of THEME_IDS) {
    const icon = await rawGet(THEMES[id].icon);
    assert.equal(icon.status, 200, `${id}: ${THEMES[id].icon} is served`);
    assert.match(icon.headers['content-type'], /image\/svg\+xml/);
  }
});

test('views: host, TV and guests get the skin; the TV pairing screen and /api/info too', async () => {
  app.settings.update({ appearance: { theme: 'party', accent: '#123abc' } });
  assert.deepEqual(app.room.hostView().settings.appearance, { theme: 'party', accent: '#123abc' });
  const tv = app.room.tvView();
  assert.deepEqual(tv.appearance, { theme: 'party', accent: '#123abc' });
  assert.equal(tv.display.accent, undefined);
  const guest = app.room.guestBase();
  assert.deepEqual(guest.appearance, { theme: 'party', accent: '#123abc' });
  assert.equal(guest.accent, undefined, 'the old accent field is gone');
  const r = await fetch(`${base}/api/pair/nope`);
  const body = await r.json();
  assert.deepEqual(body.appearance, { theme: 'party', accent: '#123abc' });
  // screens without party state (landing page, PIN and can't-join screens) follow it from here
  assert.deepEqual((await (await fetch(`${base}/api/info`)).json()).appearance, { theme: 'party', accent: '#123abc' });
  app.settings.update({ appearance: { theme: 'studio', accent: '' } });
});

// ---- base.css defines both skins, in step with shared/themes.js ---------------------------------------

const css = await fs.readFile(path.join(PUBLIC_DIR, 'css', 'base.css'), 'utf8');
function skinBlock(selector) {
  const start = css.indexOf(`${selector} {`);
  assert.ok(start >= 0, `base.css has ${selector}`);
  const body = css.slice(start + selector.length + 2, css.indexOf('\n}', start));
  const tokens = new Map();
  for (const m of body.matchAll(/^\s*(--[\w-]+):\s*([^;]+);/gm)) tokens.set(m[1], m[2].trim());
  return tokens;
}
const skins = { studio: skinBlock(':root, [data-theme="studio"]'), party: skinBlock('[data-theme="party"]') };

/** `fg` at `alpha` over `bg` (#rrggbb, blended like CSS opacity). */
function blend(fg, bg, alpha) {
  const ch = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return `#${ch(fg).map((v, i) => Math.round(v * alpha + ch(bg)[i] * (1 - alpha)).toString(16).padStart(2, '0')).join('')}`;
}

/** WCAG contrast ratio of two #rrggbb colours. */
function contrast(a, b) {
  const lum = (hex) => {
    const n = parseInt(hex.slice(1), 16);
    const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

test('base.css: both skins define the same tokens, matching shared/themes.js', () => {
  assert.deepEqual([...skins.party.keys()], [...skins.studio.keys()], 'same tokens, same order');
  assert.ok(skins.studio.size > 100);
  for (const id of THEME_IDS) {
    assert.equal(skins[id].get('--night'), THEMES[id].themeColor, `${id}: theme-color is --night`);
    assert.equal(skins[id].get('--neon'), THEMES[id].accent, `${id}: the accent picker starts at --neon`);
    assert.equal(skins[id].get('--neon-ink'), THEMES[id].accentInk, `${id}: text on the skin’s own accent is --neon-ink`);
  }
  // the app icon: Party draws the original <img src="/img/icon.svg">, Studio its own variant
  assert.equal(THEMES.party.icon, '/img/icon.svg');
  assert.equal(skins.party.get('--app-icon'), 'normal');
  assert.equal(skins.studio.get('--app-icon'), `url('${THEMES.studio.icon}')`);
  assert.match(css, /^img\[src="\/img\/icon\.svg"\] \{ content: var\(--app-icon\); \}/m);
});

test('base.css: Studio derives every accent tint from var(--neon), so a custom accent recolours it', () => {
  const hex = THEMES.studio.accent.toLowerCase();
  const n = parseInt(hex.slice(1), 16);
  const rgb = new RegExp(`\\b${(n >> 16) & 255},\\s*${(n >> 8) & 255},\\s*${n & 255}\\b`);
  const hardCoded = [...skins.studio].filter(([k, v]) => k !== '--neon' && (v.toLowerCase().includes(hex) || rgb.test(v))).map(([k]) => k);
  assert.deepEqual(hardCoded, [], 'Studio tokens that hard-code the default accent');
});

test('every token the app uses is defined (by the skins, a rule, or the code that sets it)', async () => {
  const read = async (dir, filter) => {
    const files = (await fs.readdir(dir, { recursive: true })).filter(filter);
    return Promise.all(files.map((f) => fs.readFile(path.join(dir, f), 'utf8')));
  };
  const sources = [
    ...await read(path.join(PUBLIC_DIR, 'css'), (f) => f.endsWith('.css')),
    ...await read(path.join(PUBLIC_DIR, 'js'), (f) => f.endsWith('.js') && !f.startsWith('vendor')),
    ...await read(PUBLIC_DIR, (f) => /^[a-z]+\.html$/.test(f)),
    ...await read(path.join(PUBLIC_DIR, '..', 'shared'), (f) => f.endsWith('.js')),
  ];
  const all = sources.join('\n');
  const defined = new Set();
  for (const m of all.matchAll(/(--[a-z][\w-]*)\s*:/g)) defined.add(m[1]); // in CSS and style strings
  for (const m of all.matchAll(/'(--[a-z][\w-]*)'/g)) defined.add(m[1]); // style objects, setProperty()
  // generated names: `var(--wheel-${i + 1})` etc. are the numbered tokens of the skins
  for (const m of all.matchAll(/`var\(--([a-z]+(?:-[a-z]+)*)-\$\{/g)) for (const n of skins.studio.keys()) if (new RegExp(`^--${m[1]}-\\d+$`).test(n)) defined.add(n);
  const used = new Set([...all.matchAll(/var\((--[a-z][\w-]*)/g)].map((m) => m[1]).filter((n) => !n.endsWith('-')));
  assert.deepEqual([...used].filter((n) => !defined.has(n)), [], 'tokens used but never defined');
  const generated = [...all.matchAll(/`var\(--([a-z]+(?:-[a-z]+)*)-\$\{/g)].map((m) => m[1]);
  assert.deepEqual(generated.sort(), ['confetti', 'singer', 'wheel', 'wheel-ink'], 'the numbered tokens the code builds');
});

test('no colour is hard-coded outside the skin blocks (CSS and browser code)', async () => {
  // Black, white and greys are shared on purpose (shadows, photo prints, slider thumbs, video
  // backdrops, print pages); every colour with a hue comes from a token, so a new screen can't
  // stay pink in Studio.
  const hue = (r, g, b) => Math.max(r, g, b) - Math.min(r, g, b) > 12;
  const fromHex = (h) => {
    const x = h.length <= 5 ? [...h.slice(1, 4)].map((c) => c + c).join('') : h.slice(1, 7);
    return [0, 2, 4].map((i) => parseInt(x.slice(i, i + 2), 16));
  };
  const found = [];
  const scan = (file, text) => {
    const code = text.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '));
    code.split('\n').forEach((line, i) => {
      for (const m of line.matchAll(/#[0-9a-f]{3,8}\b|rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/gi)) {
        if (m[0].startsWith('#') && !/^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(m[0])) continue;
        const rgb = m[0].startsWith('#') ? fromHex(m[0]) : [+m[1], +m[2], +m[3]];
        if (hue(...rgb)) found.push(`${file}:${i + 1}: ${m[0]}`);
      }
    });
  };
  const cssDir = path.join(PUBLIC_DIR, 'css');
  for (const f of (await fs.readdir(cssDir, { recursive: true })).filter((n) => n.endsWith('.css'))) {
    let text = await fs.readFile(path.join(cssDir, f), 'utf8');
    if (f === 'base.css') { // the two skin blocks are where the colours live
      const from = text.indexOf(':root, [data-theme="studio"] {');
      const to = text.indexOf('\n}\n', text.indexOf('[data-theme="party"] {'));
      text = text.slice(0, from) + text.slice(from, to).replace(/[^\n]/g, ' ') + text.slice(to);
    }
    scan(`css/${f}`, text);
  }
  const jsDir = path.join(PUBLIC_DIR, 'js');
  for (const f of (await fs.readdir(jsDir, { recursive: true })).filter((n) => n.endsWith('.js') && !n.startsWith('vendor'))) {
    scan(`js/${f}`, await fs.readFile(path.join(jsDir, f), 'utf8'));
  }
  for (const f of (await fs.readdir(PUBLIC_DIR)).filter((n) => n.endsWith('.html'))) {
    // (theme-color: the server writes the current skin's into every page, server/http/shell.js)
    scan(f, (await fs.readFile(path.join(PUBLIC_DIR, f), 'utf8')).replace(/<meta name="theme-color"[^>]*>/, ''));
  }
  assert.deepEqual(found, [], 'colours to move into the skin tokens (public/css/base.css)');
});

test('base.css: Party keeps its exact old values; Studio is readable', () => {
  const party = skins.party;
  const studio = skins.studio;
  // the values the app had before skins existed (a890418)
  const old = {
    '--night': '#150f26', '--stage': '#1d1535', '--stage-2': '#271d45', '--stage-3': '#33275a', '--line': 'rgba(200, 180, 255, 0.13)',
    '--line-strong': 'rgba(200, 180, 255, 0.24)', '--ink': '#f6f1ff', '--ink-2': '#b6aad8', '--ink-3': '#8174a8', '--neon': '#ff3d8b',
    '--neon-ink': '#fff', '--bulb': '#ffc94a', '--ok': '#45e2a6', '--bad': '#ff6262', '--r-sm': '8px', '--r-md': '12px', '--r-lg': '18px',
    '--font-display': '\'Bricolage\', \'Figtree\', system-ui, sans-serif',
  };
  for (const [k, v] of Object.entries(old)) assert.equal(party.get(k), v, `Party ${k}`);
  const oldWheel = ['#ff3d8b', '#ffc94a', '#45e2a6', '#4cc3ff', '#b388ff', '#ff8a3d', '#7cf05a', '#ff6262', '#3de0d0', '#f06bff', '#ffe066', '#5c7cff'];
  oldWheel.forEach((c, i) => {
    assert.equal(party.get(`--wheel-${i + 1}`), c, `Party wheel segment ${i + 1}`);
    assert.equal(party.get(`--wheel-ink-${i + 1}`), contrastText(c), `Party wheel label ${i + 1} as before`);
  });
  ['#e21b3c', '#1368ce', '#d89e00', '#26890c'].forEach((c, i) => assert.equal(party.get(`--answer-${i + 1}`), c, `Party answer ${i + 1}`));
  ['#ff3d8b', '#ffc94a', '#45e2a6', '#4cc3ff', '#b388ff', '#fff'].forEach((c, i) => assert.equal(party.get(`--confetti-${i + 1}`), c, `Party confetti ${i + 1}`));
  COLORS.forEach((c, i) => assert.equal(party.get(`--singer-${i + 1}`), c, `Party draws singer colour ${i + 1} as it is stored`));

  // Studio: no Bricolage, AA contrast for text and the accent
  assert.doesNotMatch(studio.get('--font-display'), /Bricolage/);
  for (const bg of ['--night', '--stage', '--stage-2']) {
    for (const ink of ['--ink', '--ink-2', '--ink-3', '--neon', '--bulb', '--ok', '--bad']) {
      assert.ok(contrast(studio.get(ink), studio.get(bg)) >= 4.5, `Studio ${ink} on ${bg}: ${contrast(studio.get(ink), studio.get(bg)).toFixed(2)}`);
    }
  }
  assert.ok(contrast(studio.get('--neon-ink'), studio.get('--neon')) >= 4.5, 'Studio text on the accent');
  assert.ok(contrast(studio.get('--bulb-ink'), studio.get('--bulb')) >= 4.5, 'Studio text on the highlight');
  for (let i = 1; i <= 12; i++) {
    const c = studio.get(`--wheel-${i}`);
    assert.ok(contrast(studio.get(`--wheel-ink-${i}`), c) >= 4.5, `Studio wheel label ${i} on ${c}`);
  }
  for (let i = 1; i <= 4; i++) {
    const c = studio.get(`--answer-${i}`);
    assert.ok(contrast('#ffffff', c) >= 4.5, `Studio white on answer ${i}`);
    assert.ok(contrast(blend('#ffffff', c, 0.85), c) >= 4.5, `Studio sub-label on phones (white at 85%) on answer ${i}: ${contrast(blend('#ffffff', c, 0.85), c).toFixed(2)}`);
  }
});

test('base.css: Studio TV text holds 7:1 (read across a room), even over a white cover or artist photo', () => {
  const studio = skins.studio;
  // The intro card and the lyrics sit on the song's cover (blurred) or the artist's photos, dimmed
  // by the skin's filter, then darkened by the scrim (--art-scrim at the centre, 0.72 at the edges).
  const shade = studio.get('--shade-rgb').split(',').map(Number);
  const scrim = Number(studio.get('--art-scrim'));
  for (const filter of ['--art-bg-filter', '--fanart-filter']) {
    const brightness = Number(/brightness\(([\d.]+)\)/.exec(studio.get(filter))?.[1] ?? 1);
    const white = `#${shade.map((v) => Math.round(255 * brightness * (1 - scrim) + v * scrim).toString(16).padStart(2, '0')).join('')}`;
    for (const ink of ['--ink', '--ink-2', '--bulb']) {
      const r = contrast(studio.get(ink), white);
      assert.ok(r >= 7, `Studio ${ink} over a white picture (${filter}): ${r.toFixed(2)}`);
    }
  }
  // Quiz and poll answers on the TV: white labels, the artist line at full strength in Studio (games.css),
  // and losing answers turn into navy tiles with ink-2 text. The ochre tile stays lighter (5.7:1, still
  // AA) to keep the four answers apart in lightness.
  for (let i = 1; i <= 4; i++) {
    const r = contrast('#ffffff', studio.get(`--answer-${i}`));
    assert.ok(r >= (i === 3 ? 5.7 : 7), `Studio white on answer ${i} on the TV: ${r.toFixed(2)}`);
  }
  assert.ok(contrast(studio.get('--ink-2'), studio.get('--stage-2')) >= 7, 'Studio losing answers on the TV');
});

test('singers’ colours: stored as one of COLORS, drawn by the skin', () => {
  COLORS.forEach((c, i) => {
    assert.equal(singerColor(c), `var(--singer-${i + 1})`);
    assert.equal(singerColor(c.toUpperCase()), `var(--singer-${i + 1})`, 'any case');
  });
  assert.equal(singerColor('#123456'), '#123456', 'another colour is drawn as it is');
  assert.equal(singerColor(undefined), undefined);
  for (const skin of Object.values(skins)) COLORS.forEach((_, i) => assert.match(skin.get(`--singer-${i + 1}`), /^#[0-9a-f]{6}$/));
});

test('base.css: Studio has no pink or purple where it is always seen', () => {
  // OKLCH hue: purples, magentas and pinks sit from about 290° round to 12° (red is 20°–30°,
  // royal blue 265°–270°); a nearly grey colour has no hue to speak of
  const pinkOrPurple = (hex) => {
    const [, c, h] = oklch(hex);
    return c > 0.04 && (h >= 290 || h < 12);
  };
  for (const pink of ['#ff3d8b', '#d296b0', '#f06bff', '#b388ff', '#b59be6']) assert.ok(pinkOrPurple(pink), `${pink} counts as pink or purple`);
  for (const not of ['#2e409c', '#2263b1', '#78071e', '#f08f83', '#9da9bd']) assert.ok(!pinkOrPurple(not), `${not} does not`);
  const always = [...COLORS.map((_, i) => `--singer-${i + 1}`), '--wheel-1', '--wheel-2', '--wheel-3', '--neon', '--bulb', ...[1, 2, 3, 4].map((i) => `--answer-${i}`)];
  for (const name of always) assert.ok(!pinkOrPurple(skins.studio.get(name)), `Studio ${name} (${skins.studio.get(name)}) is not pink or purple`);
});

test('base.css: Studio game colours stay apart for colour-blind players', () => {
  const studio = skins.studio;
  // every pair of wheel segments that can sit side by side: a wheel has 2…12 segments (spins can
  // remove some), so the last segment also meets the first one
  const wheel = (i) => studio.get(`--wheel-${i + 1}`);
  let worst = { d: Infinity };
  for (let n = 2; n <= WHEEL_MAX_SEGMENTS; n++) {
    for (let i = 0; i < n; i++) {
      const a = segmentIndex(i, n);
      const b = segmentIndex((i + 1) % n, n);
      const d = worstDifference(wheel(a), wheel(b));
      if (d < worst.d) worst = { d, at: `n=${n}: segments ${a + 1} and ${b + 1}` };
    }
  }
  assert.ok(worst.d >= 8, `wheel neighbours differ by CIEDE2000 ≥ 8 in every kind of colour vision (worst ${worst.d.toFixed(1)}, ${worst.at})`);
  // the four answer colours (each also has its own shape)
  for (let i = 1; i <= 4; i++) {
    for (let j = i + 1; j <= 4; j++) {
      const d = worstDifference(studio.get(`--answer-${i}`), studio.get(`--answer-${j}`));
      assert.ok(d >= 10, `answers ${i} and ${j}: ${d.toFixed(1)}`);
      // and no two share a lightness, so the tiles also differ in grey (or on a washed-out projector)
      const dL = Math.abs(labAs(studio.get(`--answer-${i}`))[0] - labAs(studio.get(`--answer-${j}`))[0]);
      assert.ok(dL >= 6, `answers ${i} and ${j} differ in lightness by L* ${dL.toFixed(1)}`);
    }
  }
});
