// Song lists carry the party state: "In queue" / "Sung tonight" marks and "Most sung here".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupRoom } from './room-harness.js';

test('song summaries are marked queued / sung tonight; most sung here lists performed songs', async () => {
  const { app, connect, req, song, s, room } = await setupRoom();
  await app.listen(0, '127.0.0.1');
  const get = async (p) => (await fetch(`http://127.0.0.1:${app.port}${p}`)).json();
  try {
    const host = await connect('host');
    const hello = song('hello');
    assert.equal((await get('/api/search?q=hello')).items[0].qd, undefined);
    await req(host, 'queue.add', { songId: hello.id, singerName: 'Ann' });
    assert.equal((await get('/api/search?q=hello')).items[0].qd, 1);
    await req(host, 'queue.add', { songId: song('waterloo').id, singerName: 'Bo', mystery: true });
    assert.equal((await get('/api/search?q=waterloo')).items[0].qd, undefined, 'mystery songs stay a secret');
    await req(host, 'player.play', { entryId: s().queue[0].id });
    s().player.pos = 190;
    room.finish('ended', { advance: false });
    const item = (await get('/api/search?q=hello')).items[0];
    assert.equal(item.tn, 1);
    assert.equal(item.qd, undefined);
    const most = await get('/api/browse/popular?sort=plays');
    assert.deepEqual(most.items.map((x) => x.id), [hello.id]);
    assert.equal(most.total, 1);
  } finally {
    await app.close();
  }
});

test('search: identical searches come from a cache; phones are rate limited, the host is not', async () => {
  const { app } = await setupRoom();
  await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${app.port}`;
  try {
    const cat = app.library.catalog;
    let calls = 0;
    const orig = cat.search.bind(cat);
    cat.search = (...a) => { calls++; return orig(...a); };
    for (let i = 0; i < 5; i++) assert.equal((await fetch(`${base}/api/search?q=queen`)).status, 200);
    assert.equal(calls, 1, 'answered from the cache');
    cat.metaChanged();
    await fetch(`${base}/api/search?q=queen`);
    assert.equal(calls, 2, 'metadata changes invalidate it');
    app.auth.isHostRequest = () => false; // a phone
    let limited = 0;
    for (let i = 0; i < 60; i++) if ((await fetch(`${base}/api/search?q=q${i}`)).status === 429) limited++;
    assert.ok(limited >= 15, `phones get 429 after a burst (${limited})`);
  } finally {
    await app.close();
  }
});
