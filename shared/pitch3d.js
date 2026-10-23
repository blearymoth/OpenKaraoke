// Pitch rings in 3D (PLAN §13.9): the scene the TV draws with WebGL, without the browser —
// matrices, meshes, where a ring and the ball are at a moment, and the camera. Pure functions
// (isomorphic), so the tests can check that every ring and the ball stay on screen.
//
// World units: x right, y up, z toward the camera. The ball flies at z = 0; the octave the
// singer sings in spans y = 0…SPAN (pitchHeight × SPAN, the same height as the flat playfield);
// a ring starts DEPTH away (z = −DEPTH) and reaches the ball's plane at its arrival time.
import { HOLE_CENTS } from './pitch.js';

export const SPAN = 10;
export const DEPTH = 44;
/** The hole's radius: the cents a ring forgives, at the octave's scale. */
export const HOLE = (HOLE_CENTS / 1200) * SPAN;
export const TUBE = 0.17;
export const BALL_R = 0.5;
export const FLOOR_Y = -1.6;
export const LANE_X = 4.6;
export const CAM_Z = 15;
export const FOV = (50 * Math.PI) / 180;
/** How much the camera follows the ball up and down (0: still). */
export const FOLLOW = 0.12;
/** A ring fades for this long after it passes the ball (a cleared one also opens up). */
export const BURST_MS = 450;
/** Past the ball, rings move at this fraction of their speed while they fade. */
export const PAST_SPEED = 0.35;
/** A ring fades in over the far end of its path. */
const FADE_IN = 0.18;

// ---- matrices (column-major Float32Array(16), as WebGL takes them) --------------------------------

export function perspective(fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2);
  const nf = 1 / (near - far);
  const m = new Float32Array(16);
  m[0] = f / aspect;
  m[5] = f;
  m[10] = (far + near) * nf;
  m[11] = -1;
  m[14] = 2 * far * near * nf;
  return m;
}

export function lookAt(eye, target, up = [0, 1, 0]) {
  let zx = eye[0] - target[0];
  let zy = eye[1] - target[1];
  let zz = eye[2] - target[2];
  let len = Math.hypot(zx, zy, zz) || 1;
  zx /= len; zy /= len; zz /= len;
  let xx = up[1] * zz - up[2] * zy;
  let xy = up[2] * zx - up[0] * zz;
  let xz = up[0] * zy - up[1] * zx;
  len = Math.hypot(xx, xy, xz) || 1;
  xx /= len; xy /= len; xz /= len;
  const yx = zy * xz - zz * xy;
  const yy = zz * xx - zx * xz;
  const yz = zx * xy - zy * xx;
  const m = new Float32Array(16);
  m[0] = xx; m[1] = yx; m[2] = zx;
  m[4] = xy; m[5] = yy; m[6] = zy;
  m[8] = xz; m[9] = yz; m[10] = zz;
  m[12] = -(xx * eye[0] + xy * eye[1] + xz * eye[2]);
  m[13] = -(yx * eye[0] + yy * eye[1] + yz * eye[2]);
  m[14] = -(zx * eye[0] + zy * eye[1] + zz * eye[2]);
  m[15] = 1;
  return m;
}

export function multiply(a, b) {
  const m = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      m[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
  }
  return m;
}

/** Translate, then scale evenly (the meshes are drawn around their own centre). */
export function place(x, y, z, s = 1) {
  const m = new Float32Array(16);
  m[0] = s; m[5] = s; m[10] = s; m[15] = 1;
  m[12] = x; m[13] = y; m[14] = z;
  return m;
}

/** A point through a matrix → normalised device coordinates [x, y, z] (−1…1 is on screen). */
export function project(m, p) {
  const x = m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12];
  const y = m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13];
  const z = m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14];
  const w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
  return [x / w, y / w, z / w];
}

// ---- meshes (positions, normals, 16-bit indices) ------------------------------------------------------

/** A ring standing in the x–y plane, facing the camera: `radius` to the tube's centre, `tube` thick. */
export function torus(radius, tube, segments = 48, sides = 14) {
  const positions = [];
  const normals = [];
  for (let i = 0; i <= segments; i++) {
    const u = (i / segments) * Math.PI * 2;
    const cu = Math.cos(u);
    const su = Math.sin(u);
    for (let j = 0; j <= sides; j++) {
      const v = (j / sides) * Math.PI * 2;
      const cv = Math.cos(v);
      const sv = Math.sin(v);
      positions.push((radius + tube * cv) * cu, (radius + tube * cv) * su, tube * sv);
      normals.push(cv * cu, cv * su, sv);
    }
  }
  return { positions: new Float32Array(positions), normals: new Float32Array(normals), indices: grid(segments, sides) };
}

export function sphere(r, rings = 16, segments = 24) {
  const positions = [];
  const normals = [];
  for (let i = 0; i <= rings; i++) {
    const t = (i / rings) * Math.PI;
    for (let j = 0; j <= segments; j++) {
      const p = (j / segments) * Math.PI * 2;
      const nx = Math.sin(t) * Math.cos(p);
      const ny = Math.cos(t);
      const nz = Math.sin(t) * Math.sin(p);
      positions.push(nx * r, ny * r, nz * r);
      normals.push(nx, ny, nz);
    }
  }
  return { positions: new Float32Array(positions), normals: new Float32Array(normals), indices: grid(rings, segments) };
}

function grid(a, b) {
  const out = [];
  for (let i = 0; i < a; i++) {
    for (let j = 0; j < b; j++) {
      const p = i * (b + 1) + j;
      const q = p + b + 1;
      out.push(p, q, p + 1, p + 1, q, q + 1);
    }
  }
  return new Uint16Array(out);
}

// ---- the scene at a moment ------------------------------------------------------------------------------

/** The camera for the ball's height (world y): behind and a little above, following it a little. */
export function camera(ballY, aspect) {
  const mid = SPAN / 2;
  const y = mid + (Math.max(0, Math.min(SPAN, ballY)) - mid) * FOLLOW;
  const eye = [0, y + 0.5, CAM_Z];
  const view = lookAt(eye, [0, y, -20]);
  const proj = perspective(FOV, Math.max(0.3, aspect), 0.5, DEPTH + CAM_Z + 10);
  return { eye, viewProj: multiply(proj, view) };
}

/**
 * Where a ring is and how it looks at `now` (the server's clock): `{ x, y, z, scale, alpha, tone }`,
 * tone 'ahead' (not scored yet), 'cleared' or 'missed'. Null once it is out of sight.
 */
export function ringPose(ring, now, travel) {
  const dt = ring.arriveAt - now;
  // Past the ball a ring slows down and fades: it never flies into the camera.
  const z = -(dt / (travel || 1)) * DEPTH * (dt < 0 ? PAST_SPEED : 1);
  if (z < -DEPTH - 1) return null;
  const tone = !ring.scored ? 'ahead' : ring.cleared ? 'cleared' : 'missed';
  let scale = 1;
  let alpha = 1;
  if (z < -DEPTH * (1 - FADE_IN)) alpha = Math.max(0, (z + DEPTH) / (DEPTH * FADE_IN));
  if (dt < 0) {
    const k = Math.min(1, -dt / BURST_MS);
    if (k >= 1) return null;
    alpha *= 1 - k;
    if (tone === 'cleared') scale = 1 + k * 0.8; // a cleared ring opens up as it goes
  }
  return { x: 0, y: (ring.height || 0) * SPAN, z, scale, alpha, tone };
}

/** The floor's cross lines (z of each), moving toward the camera as the run goes on. */
export function floorLines(now, travel, step = 4) {
  const speed = DEPTH / (travel || 1); // world units per ms
  const shift = ((now * speed) % step + step) % step;
  const out = [];
  for (let z = -DEPTH + shift; z <= CAM_Z; z += step) out.push(z);
  return out;
}
