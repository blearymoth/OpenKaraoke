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
