// Lead vocals (shared/vocals.js): the exact mix, what a track allows, and the channel analysis on
// synthetic recordings (music, a guide singer with breaks, codec-like noise).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyseChannelsAsync, clampLead, formatLead, leadGain, leadKind, mixMatrix, resolveVocals, CHANNEL_MATRIX } from '../shared/vocals.js';

const SR = 22050;
const DUR = 60;
const N = SR * DUR;

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** Chords and a noisy beat. */
function music(seed, detune = 1) {
  const x = new Float32Array(N);
  const r = rng(seed);
  for (let i = 0; i < N; i++) {
    const t = i / SR;
    x[i] = 0.2 * Math.sin(2 * Math.PI * 110 * detune * t) + 0.1 * Math.sin(2 * Math.PI * 220 * t) + 0.08 * Math.sin(2 * Math.PI * 330 * detune * t) + ((t * 2) % 1 < 0.05 ? 0.3 * (r() * 2 - 1) : 0);
  }
  return x;
}
/** A singer: verses with breaks in between (and none in the intro and outro). */
function vocal(level = 0.15, on = (t) => (t > 8 && t < 25) || (t > 30 && t < 50)) {
  const v = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const t = i / SR;
    if (!on(t)) continue;
    const syl = (t * 3) % 1 < 0.8 ? 1 : 0.1;
    const f = 440 * (1 + 0.01 * Math.sin(2 * Math.PI * 5.5 * t));
    v[i] = level * syl * (Math.sin(2 * Math.PI * f * t) + 0.5 * Math.sin(4 * Math.PI * f * t));
  }
  return v;
}
const noise = (x, db, seed) => {
  const r = rng(seed);
  const a = 10 ** (db / 20) * 0.3;
  return x.map((v) => v + a * (r() * 2 - 1));
};
const add = (a, b, k = 1) => a.map((x, i) => x + k * b[i]);
const M = music(1);
const M2 = music(2, 1.003);
const V = vocal();

test('lead levels and the exact mix: the music stays, only the singer moves', () => {
  assert.equal(clampLead('50'), 50);
  assert.equal(clampLead(140), 100);
  assert.equal(clampLead(-3), 0);
  assert.equal(clampLead('x'), null);
  assert.equal(clampLead(null), null);
  assert.deepEqual([0, 50, 100].map(formatLead), ['Off', '50%', 'Full']);
  assert.equal(leadGain(50), 0.25);
  // Not adjustable: the channel mode, as before.
  assert.deepEqual(mixMatrix({ channel: 'left' }), CHANNEL_MATRIX.left);
  assert.deepEqual(mixMatrix({ channel: 'nonsense' }), CHANNEL_MATRIX.stereo);
  assert.deepEqual(mixMatrix({ channel: 'mono', vocals: { adjustable: true, side: null } }), CHANNEL_MATRIX.mono, 'no side: no lead mix');
  // Singer on R, a = 1: Off = the music channel on both speakers, Full = the singer's channel.
  const R = { adjustable: true, side: 'R', a: 1 };
  assert.deepEqual(mixMatrix({ vocals: R, lead: 0 }), [1, 0, 1, 0]);
  assert.deepEqual(mixMatrix({ vocals: R, lead: 100 }), [0, 1, 0, 1]);
  assert.deepEqual(mixMatrix({ vocals: { ...R, side: 'L' }, lead: 50 }), [0.25, 0.75, 0.25, 0.75]);
  // For any a (inverted polarity, a > 1, a singer-only channel) the result is M + g·V exactly.
  const m = 0.37;
  const v = -0.21;
  for (const a of [1, 0.9, 0, -1, -0.6, 1.4, 5]) {
    for (const lead of [0, 30, 50, 100]) {
      const [ll, rl] = mixMatrix({ vocals: { adjustable: true, side: 'R', a }, lead });
      const ae = Math.max(-2, Math.min(2, a));
      const out = ll * m + rl * (ae * m + v); // left speaker: L = music, R = a·music + singer
      assert.ok(Math.abs(out - (m + leadGain(lead) * v)) < 1e-12, `a ${a}, lead ${lead}: ${out}`);
    }
  }
});

test('what a track allows: file name, the TV’s analysis, the host’s correction', () => {
  const mpxR = { l: 'mpx', s: 'R', lean: 'R', a: 0.98, c: 'high' };
  assert.deepEqual(resolveVocals({ flags: { mpx: true }, info: mpxR }), { adjustable: true, side: 'R', a: 0.98, source: 'file', mixed: false, ask: false, suggest: null, bgv: null });
  // Named MPX, analysis not sure of the side: it leans, or the host is asked (no wrong guess).
  assert.equal(resolveVocals({ flags: { mpx: true }, info: { l: 'stereo', lean: 'L' } }).side, 'L');
  const unsure = resolveVocals({ flags: { mpx: true }, info: { l: 'stereo', lean: '' } });
  assert.deepEqual([unsure.adjustable, unsure.ask], [false, true]);
  assert.equal(resolveVocals({ flags: { mpx: true } }).ask, false, 'not analysed yet: nothing to ask');
  assert.equal(resolveVocals({ flags: { mpx: true }, info: { l: 'mono' } }).adjustable, false);
  // Found by the sound alone: never used by itself (a hard-panned instrument looks the same and
  // "lead off" would silence it) — only offered to the host.
  const byEar = resolveVocals({ info: mpxR });
  assert.deepEqual([byEar.adjustable, byEar.suggest, byEar.source], [false, 'R', null]);
  assert.equal(resolveVocals({ info: mpxR, findGuide: false }).suggest, null, 'the kill switch');
  // "Con Voz": mixed in, no control — an analysis that finds a side only suggests it.
  assert.equal(resolveVocals({ flags: { vocals: true } }).mixed, true);
  const conVoz = resolveVocals({ flags: { vocals: true }, info: { ...mpxR, c: 'high' } });
  assert.deepEqual([conVoz.adjustable, conVoz.mixed, conVoz.suggest], [false, true, 'R']);
  // The music level measured for a side is used whichever way the side was decided (a split
  // track has a ≈ 0: assuming 1 would play the guide singer alone at "full").
  const split = { l: 'stereo', s: '', lean: 'L', a: 0.02, aL: 0.02, aR: 0.4, c: 'low' };
  assert.equal(resolveVocals({ flags: { mpx: true }, info: split }).a, 0.02, 'the side it leans to');
  assert.equal(resolveVocals({ info: split, override: 'mpxR' }).a, 0.4, 'the side the host set');
  assert.equal(resolveVocals({ info: { l: 'stereo', lean: 'L', a: 0.3 }, override: 'mpxL' }).a, 0.3, 'older analyses: the lean side’s a');
  // The host decides.
  assert.deepEqual(resolveVocals({ flags: { mpx: true }, info: mpxR, override: 'stereo' }).adjustable, false);
  assert.deepEqual(resolveVocals({ override: 'mpxL' }), { adjustable: true, side: 'L', a: 1, source: 'host', mixed: false, ask: false, suggest: null, bgv: null });
  assert.equal(resolveVocals({ override: 'mpxR', info: mpxR }).a, 0.98, 'the measured music level, same side');
  assert.equal(resolveVocals({ flags: { nobgv: true } }).bgv, 'without');
  assert.equal(resolveVocals({ flags: { bgv: true } }).bgv, 'with');
  // For version lists and requests: a named multiplex offers the guide before its side is known.
  assert.equal(leadKind(resolveVocals({ flags: { mpx: true }, info: mpxR })), 'adjustable');
  assert.equal(leadKind(resolveVocals({ flags: { mpx: true } })), 'multiplex');
  assert.equal(leadKind(resolveVocals({ flags: { mpx: true }, info: { l: 'stereo', lean: '' } })), null, 'analysed, side unknown: the host is asked first');
  assert.equal(leadKind(resolveVocals({ flags: { mpx: true }, override: 'stereo' })), null);
  assert.equal(leadKind(resolveVocals({ flags: { vocals: true } })), 'mixed');
  assert.equal(leadKind(resolveVocals({ info: { ...mpxR, c: 'low' } })), null, 'a suggestion only');
  assert.equal(leadKind(null), null);
});

test('analysis: multiplex tracks are found with the singer’s side; stereo mixes are not', async () => {
  const run = (L, R) => analyseChannelsAsync(L, R, SR);
  let r = await run(M, add(M, V));
  assert.deepEqual([r.l, r.s, r.c], ['mpx', 'R', 'high'], JSON.stringify(r));
  assert.ok(Math.abs(r.a - 1) < 0.05, `a ${r.a}`);
  r = await run(add(M, V), M.map((x) => 0.9 * x));
  assert.deepEqual([r.l, r.s], ['mpx', 'L'], 'singer on the left, music channel quieter');
  r = await run(M, V);
  assert.deepEqual([r.l, r.s], ['mpx', 'R'], 'a channel with the singer alone');
  assert.ok(Math.abs(r.a) < 0.05);
  assert.equal(r.aR, r.a, 'the fit for each side is kept (for a side the host sets by hand)');
  assert.ok(Number.isFinite(r.aL));
  // A hard-panned riff that rests between phrases looks just like a guide singer: found by ear,
  // but an unnamed track is only ever suggested (lead off would mute the riff all song long).
  const riff = vocal(0.2, (t) => t % 12 < 7);
  r = await run(add(M, riff), M);
  assert.equal(resolveVocals({ info: r }).adjustable, false, JSON.stringify(r));
  r = await run(M, add(M.map((x) => -x), V));
  assert.deepEqual([r.l, r.s], ['mpx', 'R'], 'inverted polarity');
  assert.ok(r.a < -0.9, `a ${r.a}`);
  r = await run(noise(M, -30, 3), noise(add(M, V), -30, 4));
  assert.deepEqual([r.l, r.s, r.c], ['mpx', 'R', 'low'], 'codec-like noise: found, not sure enough without the file name');
  r = await run(noise(M, -30, 3), noise(add(M, vocal(0.075)), -30, 4));
  assert.equal(r.lean, 'R', `a quieter singer under the noise: no finding, but it leans (${JSON.stringify(r)})`);
  assert.deepEqual(resolveVocals({ flags: { mpx: true }, info: r }).side, 'R', 'which is enough for a track named Multiplex');
  assert.equal(resolveVocals({ info: r }).adjustable, false, 'and nothing for an unnamed one');
  for (const [name, L, R] of [
    ['wide stereo with a centred singer', add(M, V), add(M2, V)],
    ['wide stereo, no singer', M, M2],
    ['near-mono with a little noise', noise(M, -35, 9), noise(M, -35, 10)],
  ]) {
    r = await run(L, R);
    assert.equal(r.l, 'stereo', `${name}: ${JSON.stringify(r)}`);
  }
  r = await run(M, M.slice());
  assert.equal(r.l, 'mono');
  // A mono mix with one hard-panned instrument playing for a stretch looks the same in structure:
  // at most a weak finding, which is only offered to the host.
  const guitar = vocal(0.12, (t) => t > 5 && t < 48);
  r = await run(add(M, guitar), M);
  assert.ok(r.l === 'stereo' || r.c === 'low', JSON.stringify(r));
  assert.equal(resolveVocals({ info: r }).adjustable, false);
  // The page-friendly version gives the same answer.
  const chunked = await analyseChannelsAsync(M, add(M, V), SR, { yieldEvery: SR * 2 });
  assert.deepEqual([chunked.l, chunked.s, chunked.c], ['mpx', 'R', 'high']);
});

// ---- the room: what the TV found, the level, the singer's memory, versions -------------------

const VOCAL_SONGS = [
  'DJ Hush - Quiet Storm [MX Karaoke] (Multiplex)',
  'DJ Hush - Quiet Storm [SF Karaoke]',
  'DJ Hush - Quiet Storm [ZM Karaoke] (Wobgv)',
  'Adele - Hello [SF Karaoke] (Con Voz)',
  'Adele - Hello [ZM Karaoke]',
  'Queen - Bohemian Rhapsody [SF Karaoke]',
];

async function vocalRoom(settings = {}) {
  const { setupRoom } = await import('./room-harness.js');
  const r = await setupRoom({ queue: { maxPerGuest: 0, allowRepeats: true }, ...settings }, { songs: VOCAL_SONGS });
  const cat = r.app.library.catalog;
  const storm = r.song('quiet storm');
  const tracks = storm.trackIds.map((id) => cat.track(id));
  const by = (f) => tracks.find((t) => t.p.flags[f]);
  return { ...r, cat, storm, mpx: by('mpx'), nobgv: by('nobgv'), plain: tracks.find((t) => !Object.keys(t.p.flags).length) };
}

test('room: the TV’s analysis, the lead level, and who may change it', async (t) => {
  const { app, room, connect, guest, req, s, mpx, storm, view } = await vocalRoom();
  t.after(() => app.close());
  const host = await connect('host');
  const tv = await connect('tv');
  // Reports are checked field by field; a mirror's or an unknown track's are ignored.
  await assert.rejects(req(tv, 'tv.analysis', { trackId: mpx.id, layout: 'mpx', side: '' }), /Bad analysis/);
  await assert.rejects(req(tv, 'tv.analysis', { trackId: mpx.id, layout: 'weird' }), /Bad analysis/);
  assert.deepEqual(await req(tv, 'tv.analysis', { trackId: '__proto__', layout: 'stereo' }), { ok: false });
  const mirror = await connect('tv', { display: 'mirror' });
  assert.deepEqual(await req(mirror, 'tv.analysis', { trackId: mpx.id, layout: 'stereo' }), { ok: false });
  await assert.rejects(req(host, 'tv.analysis', { trackId: mpx.id, layout: 'stereo' }), /not allowed/);

  // The multiplex version, its side found by the TV before the song plays.
  await req(host, 'queue.add', { songId: storm.id, singerName: 'Ana', trackId: mpx.id });
  assert.equal(s().current.trackId, mpx.id);
  assert.equal(s().player.vocals.adjustable, false, 'named Multiplex, side not known yet');
  await req(tv, 'tv.analysis', { trackId: mpx.id, layout: 'mpx', side: 'L', lean: 'L', a: 0.97, confidence: 'low' });
  assert.deepEqual([s().player.vocals.adjustable, s().player.vocals.side, s().player.vocals.a], [true, 'L', 0.97]);
  assert.equal(s().player.lead, 0, 'the setting: no guide singer');
  assert.equal(view(host).player.vocals.side, 'L');
  await assert.rejects(req(host, 'player.channel', { mode: 'left' }), /use “Lead vocal”/);
  assert.deepEqual(await req(host, 'player.lead', { level: '70' }), { lead: 70 });
  await assert.rejects(req(host, 'player.lead', { level: 'loud' }), /Unknown level/);
  // Remembered for Ana (only): she starts with it next time; Bob doesn't inherit it.
  const key = room.catalog.song(storm.id).key;
  assert.equal(s().songPrefs[key].bySinger[s().current.singerIds[0]].lead, 70);
  assert.equal(s().songPrefs[key].lead, undefined, 'never song-wide');
  await req(host, 'queue.add', { songId: storm.id, singerName: 'Bob', trackId: mpx.id });
  await req(host, 'queue.add', { songId: storm.id, singerName: 'Ana', trackId: mpx.id });
  await req(host, 'player.next');
  assert.equal(s().player.lead, 0, 'Bob: the setting');
  await req(host, 'player.next');
  assert.equal(s().player.lead, 70, 'Ana: her level');

  // Guests: the singer on their own song, guide on (quiet) or off; nobody else.
  const ana = await guest('Ana2');
  const bob = await guest('Bob2');
  await req(ana, 'queue.add', { songId: storm.id });
  await req(host, 'queue.update', { entryId: s().queue[0].id, patch: { trackId: mpx.id } });
  await req(host, 'player.next');
  assert.equal(s().current.addedBy, ana.data.deviceId);
  assert.deepEqual(await req(ana, 'player.lead', { level: 100 }), { lead: 50 }, 'snapped to quiet');
  assert.equal(view(ana).player.leadAdjustable, true);
  await assert.rejects(req(bob, 'player.lead', { level: 0 }), /Only the singer/);
  app.settings.update({ queue: { guestVocals: false } });
  await assert.rejects(req(ana, 'player.lead', { level: 0 }), /turned this off/);
  app.settings.update({ queue: { guestVocals: true } });
  await req(host, 'guest.cohost', { deviceId: bob.data.deviceId, on: true });
  assert.deepEqual(await req(bob, 'player.lead', { level: 30 }), { lead: 30 }, 'a co-host: any level');

  // The host's correction is kept per version.
  await assert.rejects(req(host, 'player.layout', { layout: 'mpxL', trackId: '__proto__' }), /Unknown track/);
  await assert.rejects(req(host, 'player.layout', { layout: 'sideways' }), /Unknown layout/);
  await req(host, 'player.layout', { layout: 'stereo' });
  assert.equal(s().player.vocals.adjustable, false);
  assert.equal(s().trackPrefs[mpx.id].layout, 'stereo');
  await req(host, 'player.layout', { layout: 'mpxR' });
  assert.deepEqual([s().player.vocals.adjustable, s().player.vocals.side, s().player.vocals.source], [true, 'R', 'host']);
  await req(host, 'player.layout', { layout: 'auto' });
  assert.equal(s().player.vocals.side, 'L', 'back to what the TV found');

  // A battle round is judged: no guide singer, and none remembered for it.
  s().current.source = 'game:battle';
  await assert.rejects(req(host, 'player.lead', { level: 50 }), /battle round/);
  assert.equal(room.leadFor({ ...s().current, lead: 100 }), 0);
  delete s().current.source;
  // Nothing playing: no lead control left over from the last song.
  await req(host, 'player.stop');
  assert.deepEqual([s().current, s().player.vocals, view(host).player.vocals], [null, null, null]);
  await assert.rejects(req(host, 'player.lead', { level: 50 }), /Nothing is playing/);

  // A track only the sound says is a multiplex is never adjustable by itself: suggested.
  const plainHello = room.catalog.song(room.catalog.search('hello').items[0].id).trackIds.map((id) => room.catalog.track(id)).find((x) => !x.p.flags.vocals);
  await req(host, 'queue.add', { songId: plainHello.songId, trackId: plainHello.id, singerName: 'Cy', position: 'now' });
  if (s().current?.trackId !== plainHello.id) await req(host, 'player.play', { entryId: s().queue.find((e) => e.trackId === plainHello.id).id });
  await req(tv, 'tv.analysis', { trackId: plainHello.id, layout: 'mpx', side: 'R', lean: 'R', a: 1, confidence: 'high' });
  assert.deepEqual([s().player.vocals.adjustable, s().player.vocals.suggest], [false, 'R']);
  await req(host, 'settings.update', { patch: { playback: { findGuideVocal: false } } });
  assert.equal(s().player.vocals.suggest, null, 'the setting applies to the song that is on');
  await room.close();
  const saved = JSON.parse(await (await import('node:fs/promises')).readFile(`${app.dataDir}/vocals.json`, 'utf8'));
  assert.equal(saved.tracks[mpx.id].s, 'L', 'kept in vocals.json');
});

test('room: queueing picks the version the singer needs; switching versions mid-song', async (t) => {
  const { app, connect, guest, req, s, mpx, nobgv, plain, storm, song, cat } = await vocalRoom({ playback: { countdown: 0, autoStart: false } });
  t.after(() => app.close());
  const host = await connect('host');
  const tv = await connect('tv');
  // Before the TV has decoded it, the version named "Multiplex" is the one for a guide singer.
  assert.equal(app.room.pickTrack(cat.song(storm.id), { lead: 50 }).id, mpx.id);
  await req(tv, 'tv.analysis', { trackId: mpx.id, layout: 'mpx', side: 'L', lean: 'L', a: 1, confidence: 'high' });
  const add = async (who, body) => (await req(who, 'queue.add', { songId: storm.id, ...body })).entry;
  assert.equal((await add(host, { singerName: 'A', lead: 50 })).trackId, mpx.id, 'a guide singer: the multiplex version');
  assert.equal((await add(host, { singerName: 'B', bgv: 'without' })).trackId, nobgv.id, 'no backing vocals');
  assert.equal((await add(host, { singerName: 'C', lead: 50, bgv: 'without' })).trackId, mpx.id, 'both: the guide first');
  assert.equal(s().queue[0].lead, 50);
  const hello = song('hello');
  const mixed = hello.trackIds.map((id) => cat.track(id)).find((x) => x.p.flags.vocals);
  assert.notEqual((await req(host, 'queue.add', { songId: hello.id, singerName: 'D', lead: 0 })).entry.trackId, mixed.id, 'no guide: not the version with the singer mixed in');
  // Guests too (snapped), unless the host turned it off.
  const g = await guest('Gia');
  assert.equal((await add(g, { lead: 37, bgv: 'without' })).trackId, mpx.id);
  assert.equal(s().queue.at(-1).lead, 50);
  await add(g, { lead: 100 });
  assert.equal(s().queue.at(-1).lead, 50, 'a guest’s guide is quiet or off');
  app.settings.update({ queue: { guestVocals: false } });
  const plainPick = (await add(g, { lead: 100, bgv: 'without' })).trackId;
  assert.notEqual(plainPick, mpx.id);
  assert.equal(s().queue.at(-1).lead, undefined);
  // Edit: automatic again.
  await req(host, 'queue.update', { entryId: s().queue[0].id, patch: { lead: null } });
  assert.equal(s().queue[0].lead, undefined);

  // Mid-song: another version (e.g. without backing vocals) starts the song again with it.
  await req(host, 'player.play');
  const before = s().player.reload || 0;
  await req(host, 'player.version', { trackId: nobgv.id });
  assert.equal(s().current.trackId, nobgv.id);
  assert.deepEqual([s().player.state, s().player.pos, s().player.reload], ['intro', 0, before + 1]);
  assert.equal(s().player.vocals.bgv, 'without');
  assert.equal(s().songPrefs[cat.song(storm.id).key].trackId, nobgv.id, 'remembered for next time');
  await assert.rejects(req(host, 'player.version', { trackId: hello.trackIds[0] }), /isn’t a version of this song/);
  await assert.rejects(req(g, 'player.version', { trackId: plain.id }), /not allowed/);
});
