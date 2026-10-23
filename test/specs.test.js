// The hardware check (server/system/specs.js): nvidia-smi's answer, the verdict and its model,
// free-space warnings; and the maker's use of it (Auto lyric timer, waiting during songs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseNvidiaSmi, assess, gatherSpecs } from '../server/system/specs.js';
import { setupRoom } from './room-harness.js';
import { fakeAutokaraoke } from '../server/maker/fake.js';

const until = async (fn, ms = 5000) => {
  const t0 = Date.now();
  while (!(await fn())) {
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
};

test('specs: nvidia-smi’s cards', () => {
  assert.deepEqual(parseNvidiaSmi('NVIDIA GeForce RTX 3080, 10240\nNVIDIA GeForce GT 1030, 2048\n'), [
    { name: 'NVIDIA GeForce RTX 3080', memMB: 10240 }, { name: 'NVIDIA GeForce GT 1030', memMB: 2048 },
  ]);
  assert.deepEqual(parseNvidiaSmi('NVIDIA-SMI has failed because it couldn’t communicate with the NVIDIA driver.'), []);
  assert.deepEqual(parseNvidiaSmi(''), []);
});

test('specs: the verdicts and their thresholds', () => {
  const gpu = (gb) => [{ name: 'NVIDIA X', memMB: Math.round(gb * 1024) }];
  assert.equal(assess({ gpus: gpu(8), cores: 4, memGB: 8 }).verdict, 'fast');
  assert.equal(assess({ gpus: gpu(8) }).model, 'medium');
  assert.equal(assess({ gpus: gpu(5.9) }).verdict, 'fast', '5.9 GB is enough for medium');
  assert.equal(assess({ gpus: gpu(5.8) }).verdict, 'good');
  assert.equal(assess({ gpus: gpu(3.8) }).model, 'small');
  assert.equal(assess({ gpus: gpu(2), cores: 8, memGB: 16 }).verdict, 'slow', 'a small card: the processor');
  assert.equal(assess({ cores: 4, memGB: 12 }).verdict, 'slow');
  assert.equal(assess({ cores: 6, memGB: 11.9 }).verdict, 'no');
  assert.equal(assess({ cores: 2, memGB: 32 }).verdict, 'no');
  assert.equal(assess({ cores: 3, memGB: 15 }).verdict, 'no', 'too few cores');
  assert.equal(assess({}).label, 'Not recommended');
  assert.match(assess({ gpus: gpu(8), freeGB: 9 }).warnings[0], /needs about 10 GB/);
  assert.deepEqual(assess({ gpus: gpu(8), freeGB: 11 }).warnings, []);
  assert.match(assess({ cores: 8, memGB: 16, freeGB: 5 }).warnings[0], /about 6 GB/);
});

test('specs: gathered through the runner (nvidia-smi’s query), the disk of the first folder that exists', async () => {
  const calls = [];
  const specs = await gatherSpecs({
    run: async (file, args) => { calls.push([file, ...args]); return { code: 0, out: 'NVIDIA RTX A2000, 6138\n' }; },
    diskPaths: ['/no/such/folder', '/'],
  });
  assert.deepEqual(calls, [['nvidia-smi', '--query-gpu=name,memory.total', '--format=csv,noheader,nounits']]);
  assert.deepEqual(specs.gpus, [{ name: 'NVIDIA RTX A2000', memMB: 6138 }]);
  assert.ok(specs.cores >= 1 && specs.memGB > 0 && specs.freeGB > 0);
  const none = await gatherSpecs({ run: async () => ({ code: 127, out: '' }), diskPaths: [] });
  assert.deepEqual(none.gpus, []);
  assert.equal(none.freeGB, null);
});

test('specs: the maker shows the verdict, keeps it, and picks the lyric timer by it', async (t) => {
  const tool = fakeAutokaraoke({ gpu: 'NVIDIA GeForce RTX 3060', gpuMB: 12288 });
  const { app, room } = await setupRoom({}, { makerTool: tool });
  t.after(() => app.close());
  await until(() => room.maker.verdict);
  let v = room.hostView().maker;
  assert.equal(v.verdict.verdict, 'fast');
  assert.equal(v.whisperModel, 'medium', 'Auto: medium on a big card');
  assert.equal(v.waitsDuringSongs, false);
  const saved = JSON.parse(await (await import('node:fs/promises')).readFile(`${app.dataDir}/maker/specs.json`, 'utf8'));
  assert.equal(saved.verdict.verdict, 'fast', 'kept for the next start');
  // A slower PC on "Check again".
  Object.assign(tool.state, { gpu: '', cores: 4, memGB: 12 });
  await room.maker.check();
  v = room.hostView().maker;
  assert.equal(v.verdict.verdict, 'slow');
  assert.equal(v.whisperModel, 'small');
  assert.equal(v.waitsDuringSongs, true, 'the processor does the work: wait for the song to end');
  app.settings.update({ maker: { whisperModel: 'large-v3' } });
  assert.equal(room.hostView().maker.whisperModel, 'large-v3', 'the host’s own choice wins');
  app.settings.update({ maker: { whisperModel: 'gigantic' } });
  assert.equal(app.settings.get('maker.whisperModel'), 'large-v3', 'an unknown model is ignored');
});
