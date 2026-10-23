// Pitch rings in 3D (shared/pitch3d.js): the matrices, the meshes, that every ring and the ball
// stay on screen at any height and screen shape, where a ring is at a moment, and the floor.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SPAN, DEPTH, HOLE, TUBE, BALL_R, CAM_Z, BURST_MS,
  perspective, lookAt, multiply, place, project, torus, sphere, camera, ringPose, floorLines,
} from '../shared/pitch3d.js';
import { HOLE_CENTS } from '../shared/pitch.js';

const near = (a, b, eps = 1e-5) => Math.abs(a - b) < eps;

test('pitch 3D: matrices put what the camera looks at in the middle, nearer is in front', () => {
  const m = multiply(perspective(Math.PI / 3, 16 / 9, 0.5, 100), lookAt([0, 2, 10], [0, 2, -10]));
  const mid = project(m, [0, 2, -5]);
  assert.ok(near(mid[0], 0) && near(mid[1], 0), `centre ${mid}`);
  assert.ok(project(m, [0, 3, -5])[1] > 0, 'up is up');
  assert.ok(project(m, [1, 2, -5])[0] > 0, 'right is right');
  assert.ok(project(m, [0, 2, 0])[2] < project(m, [0, 2, -50])[2], 'depth grows away from the camera');
  const p = project(place(1, 2, 3, 2), [1, 1, 1]);
  assert.deepEqual(p.map((v) => +v.toFixed(5)), [3, 4, 5], 'place: scale, then move');
});

test('pitch 3D: the hole forgives HOLE_CENTS at the octave’s scale, and the ball fits through it', () => {
  assert.ok(near(HOLE / SPAN, HOLE_CENTS / 1200));
  assert.ok(BALL_R < HOLE, 'the ball is smaller than the hole');
  const ring = torus(HOLE + TUBE, TUBE);
  let inner = Infinity;
  for (let i = 0; i < ring.positions.length; i += 3) inner = Math.min(inner, Math.hypot(ring.positions[i], ring.positions[i + 1]));
  assert.ok(near(inner, HOLE, 1e-4), `the ring's inside edge is the hole (${inner})`);
});

test('pitch 3D: meshes have unit normals and indices inside their vertices', () => {
  for (const [name, mesh] of [['torus', torus(1, 0.2)], ['sphere', sphere(0.5)]]) {
    const count = mesh.positions.length / 3;
    assert.equal(mesh.normals.length, mesh.positions.length, name);
    for (let i = 0; i < mesh.normals.length; i += 3) {
      assert.ok(near(Math.hypot(mesh.normals[i], mesh.normals[i + 1], mesh.normals[i + 2]), 1, 1e-4), `${name} normal ${i / 3}`);
    }
    assert.ok(count < 65536, `${name} fits 16-bit indices`);
    assert.ok(mesh.indices.every((ix) => ix < count), `${name} indices`);
    assert.equal(mesh.indices.length % 3, 0, `${name} triangles`);
  }
});

test('pitch 3D: at any ball height and screen shape, every ring at the ball and the ball are on screen', () => {
  for (const aspect of [4 / 3, 16 / 9, 21 / 9, 1280 / 520]) {
    for (let ball = 0; ball <= SPAN; ball += 0.5) {
      const { viewProj } = camera(ball, aspect);
      for (const y of [-(HOLE + TUBE), SPAN + HOLE + TUBE]) {
        const p = project(viewProj, [0, y, 0]);
        assert.ok(Math.abs(p[1]) < 0.98 && Math.abs(p[0]) < 1, `ring edge at y=${y}, ball ${ball}, aspect ${aspect.toFixed(2)}: ${p[1].toFixed(3)}`);
      }
      const b = project(viewProj, [0, ball, 0]);
      assert.ok(Math.abs(b[1]) < 0.95, `the ball at ${ball}`);
      const far = project(viewProj, [0, SPAN / 2, -DEPTH]);
      assert.ok(far[2] < 1 && far[2] > -1, 'a ring coming in is inside the depth range');
    }
  }
});

test('pitch 3D: a ring comes in over the travel time, reaches the ball on time, then fades out', () => {
  const travel = 3600;
  const ring = { arriveAt: 10000, height: 0.25, scored: false, cleared: false };
  assert.equal(ringPose(ring, 10000 - travel - 200, travel), null, 'not yet in sight');
  const start = ringPose(ring, 10000 - travel, travel);
  assert.ok(near(start.z, -DEPTH) && start.alpha === 0, 'it starts far away, unseen');
  const mid = ringPose(ring, 10000 - travel / 2, travel);
  assert.ok(near(mid.z, -DEPTH / 2) && mid.alpha === 1 && mid.tone === 'ahead');
  const at = ringPose(ring, 10000, travel);
  assert.ok(near(at.z, 0) && near(at.y, 0.25 * SPAN), 'at the ball, at its note’s height');

  const cleared = { ...ring, scored: true, cleared: true };
  const missed = { ...ring, scored: true, cleared: false };
  const c = ringPose(cleared, 10000 + BURST_MS / 2, travel);
  assert.ok(c.tone === 'cleared' && c.scale > 1 && c.alpha < 1, 'a cleared ring opens up and fades');
  const m = ringPose(missed, 10000 + BURST_MS / 2, travel);
  assert.ok(m.tone === 'missed' && m.scale === 1 && m.alpha < 1);
  for (let dt = 0; dt < BURST_MS; dt += 25) {
    const p = ringPose(missed, 10000 + dt, travel);
    assert.ok(p.z < CAM_Z - 8, `a passed ring stays well in front of the camera (${p.z})`);
  }
  assert.equal(ringPose(cleared, 10000 + BURST_MS, travel), null, 'then it is gone');
  assert.equal(ringPose(missed, 10000 + BURST_MS, travel), null);
});

test('pitch 3D: the floor lines move toward the camera at the rings’ speed', () => {
  const travel = 3600;
  const a = floorLines(1000, travel);
  const b = floorLines(1100, travel);
  assert.ok(a.length > 5 && a.every((z) => z >= -DEPTH && z <= CAM_Z));
  const speed = DEPTH / travel;
  assert.ok(near(((b[0] - a[0]) % 4 + 4) % 4, (100 * speed) % 4, 1e-6), 'one step of the floor = one step of a ring');
});
