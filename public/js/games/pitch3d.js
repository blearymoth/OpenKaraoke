// Pitch rings in 3D on the TV (PLAN §13.9): WebGL 1, written by hand (no library). The ball flies
// away from the camera; rings come out of the distance at the height of their note and pass it
// when they reach the ball; a lane mark at every note of the scale, a floor that moves. The scene
// (matrices, meshes, poses) is shared/pitch3d.js. Colours are the skin's tokens.
//
// createPitch3D(canvas) → null when the browser gives no WebGL (the flat playfield is drawn
// instead). The canvas is drawn at a lower resolution when frames slow down (a PC drawing in
// software), and from the start with the TV's lighter effects on.
import { token } from '../lib/theme.js';
import {
  SPAN, DEPTH, HOLE, TUBE, BALL_R, FLOOR_Y, LANE_X, CAM_Z,
  camera, place, torus, sphere, ringPose, floorLines,
} from '/shared/pitch3d.js';

const MESH_VS = `
attribute vec3 aPos;
attribute vec3 aNor;
uniform mat4 uViewProj;
uniform mat4 uModel;
varying vec3 vNor;
varying vec3 vWorld;
void main() {
  vec4 w = uModel * vec4(aPos, 1.0);
  vWorld = w.xyz;
  vNor = aNor;
  gl_Position = uViewProj * w;
}`;

const MESH_FS = `
precision mediump float;
uniform vec3 uColor;
uniform vec3 uFog;
uniform vec3 uEye;
uniform float uAlpha;
uniform float uGlow;
varying vec3 vNor;
varying vec3 vWorld;
void main() {
  vec3 n = normalize(vNor);
  vec3 l = normalize(vec3(-0.4, 0.8, 0.6));
  vec3 v = normalize(uEye - vWorld);
  float diff = max(dot(n, l), 0.0);
  float spec = pow(max(dot(reflect(-l, n), v), 0.0), 24.0);
  float rim = pow(1.0 - max(dot(n, v), 0.0), 2.0);
  vec3 c = uColor * (0.3 + 0.7 * diff) + vec3(spec * 0.55) + uColor * (rim * 0.5 + uGlow);
  float fog = smoothstep(${(CAM_Z + DEPTH * 0.45).toFixed(1)}, ${(CAM_Z + DEPTH).toFixed(1)}, distance(uEye, vWorld));
  gl_FragColor = vec4(mix(c, uFog, fog), uAlpha);
}`;

const LINE_VS = `
attribute vec3 aPos;
uniform mat4 uViewProj;
varying float vDist;
uniform vec3 uEye;
void main() {
  vDist = distance(uEye, aPos);
  gl_Position = uViewProj * vec4(aPos, 1.0);
}`;

const LINE_FS = `
precision mediump float;
uniform vec3 uColor;
uniform vec3 uFog;
uniform float uAlpha;
varying float vDist;
void main() {
  float fog = smoothstep(${(CAM_Z + DEPTH * 0.3).toFixed(1)}, ${(CAM_Z + DEPTH).toFixed(1)}, vDist);
  gl_FragColor = vec4(mix(uColor, uFog, fog), uAlpha * (1.0 - fog * 0.6));
}`;

const TRAIL = 7; // ghost balls behind the ball
const SLOW_MS = 26; // an average frame slower than this lowers the resolution
const MIN_SCALE = 0.45;

/** A CSS colour (any syntax the skin uses) → [r, g, b] 0…1. */
const colourCache = new Map();
function rgb(value, fallback) {
  const key = value || fallback;
  if (colourCache.has(key)) return colourCache.get(key);
  const ctx = document.createElement('canvas').getContext('2d');
  ctx.fillStyle = fallback;
  ctx.fillStyle = key;
  const s = ctx.fillStyle;
  let out;
  if (s.startsWith('#')) out = [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16) / 255);
  else out = (s.match(/[\d.]+/g) || ['0', '0', '0']).slice(0, 3).map((n) => Number(n) / 255);
  colourCache.set(key, out);
  return out;
}

function compile(gl, vs, fs) {
  const prog = gl.createProgram();
  for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh) || 'shader');
    gl.attachShader(prog, sh);
  }
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) || 'link');
  const u = {};
  const n = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) {
    const name = gl.getActiveUniform(prog, i).name;
    u[name] = gl.getUniformLocation(prog, name);
  }
  return { prog, u, aPos: gl.getAttribLocation(prog, 'aPos'), aNor: gl.getAttribLocation(prog, 'aNor') };
}

function upload(gl, mesh) {
  const buf = (target, data) => {
    const b = gl.createBuffer();
    gl.bindBuffer(target, b);
    gl.bufferData(target, data, gl.STATIC_DRAW);
    return b;
  };
  return {
    pos: buf(gl.ARRAY_BUFFER, mesh.positions),
    nor: buf(gl.ARRAY_BUFFER, mesh.normals),
    idx: buf(gl.ELEMENT_ARRAY_BUFFER, mesh.indices),
    count: mesh.indices.length,
  };
}

export function createPitch3D(canvas) {
  let gl = null;
  try {
    const opts = { antialias: true, alpha: false, premultipliedAlpha: false, preserveDrawingBuffer: false };
    gl = canvas.getContext('webgl', opts) || canvas.getContext('experimental-webgl', opts);
  } catch { gl = null; }
  if (!gl) return null;
  let mesh;
  let line;
  let ringMesh;
  let ballMesh;
  try {
    mesh = compile(gl, MESH_VS, MESH_FS);
    line = compile(gl, LINE_VS, LINE_FS);
    ringMesh = upload(gl, torus(HOLE + TUBE, TUBE));
    ballMesh = upload(gl, sphere(BALL_R));
  } catch {
    return null;
  }
  const lineBuf = gl.createBuffer();
  const lite = () => document.documentElement.matches('.lite-auto, .lite-fx');
  let scale = lite() ? 0.7 : 1;
  let frames = [];
  let lastFrame = 0;
  const trail = [];
  canvas.dataset.renderer = 'webgl';

  function drawMesh(m, model, colour, alpha, glow) {
    gl.uniformMatrix4fv(mesh.u.uModel, false, model);
    gl.uniform3fv(mesh.u.uColor, colour);
    gl.uniform1f(mesh.u.uAlpha, alpha);
    gl.uniform1f(mesh.u.uGlow, glow);
    gl.bindBuffer(gl.ARRAY_BUFFER, m.pos);
    gl.vertexAttribPointer(mesh.aPos, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, m.nor);
    gl.vertexAttribPointer(mesh.aNor, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, m.idx);
    gl.drawElements(gl.TRIANGLES, m.count, gl.UNSIGNED_SHORT, 0);
  }

  function drawLines(points, colour, alpha) {
    if (!points.length) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, lineBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(points), gl.DYNAMIC_DRAW);
    gl.vertexAttribPointer(line.aPos, 3, gl.FLOAT, false, 0, 0);
    gl.uniform3fv(line.u.uColor, colour);
    gl.uniform1f(line.u.uAlpha, alpha);
    gl.drawArrays(gl.LINES, 0, points.length / 3);
  }

  /** Keeps the frame rate: a slow average lowers the resolution (never raises it again this run). */
  function pace(t) {
    if (lastFrame) frames.push(t - lastFrame);
    lastFrame = t;
    if (frames.length < 40) return;
    const avg = frames.reduce((a, b) => a + b, 0) / frames.length;
    frames = [];
    if (avg > SLOW_MS && avg < 250 && scale > MIN_SCALE) scale = Math.max(MIN_SCALE, scale * 0.8);
  }

  /**
   * One frame. `ballHeight` 0…1 (the smoothed pitch), `rings` from the TV's game view, `now` the
   * server clock, `lanes` the scale's heights (0…1).
   */
  function frame({ ballHeight, rings, now, travel, lanes }) {
    if (gl.isContextLost()) return false;
    pace(performance.now());
    const cssW = canvas.clientWidth;
    const cssH = canvas.clientHeight;
    if (cssW < 2 || cssH < 2) return true;
    const dpr = Math.min(lite() ? 1 : 2, window.devicePixelRatio || 1) * scale;
    const pxW = Math.max(1, Math.floor(cssW * dpr));
    const pxH = Math.max(1, Math.floor(cssH * dpr));
    if (canvas.width !== pxW || canvas.height !== pxH) {
      canvas.width = pxW;
      canvas.height = pxH;
    }
    canvas.dataset.scale = scale.toFixed(2);
    gl.viewport(0, 0, pxW, pxH);
    const fog = rgb(token('--stage'), '#000');
    const neon = rgb(token('--neon'), '#fff');
    const ok = rgb(token('--ok'), '#fff');
    const bad = rgb(token('--bad'), '#fff');
    const bulb = rgb(token('--bulb'), '#fff');
    const ink2 = rgb(token('--ink-2'), '#ccc');
    gl.clearColor(fog[0], fog[1], fog[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    const ballY = Math.max(0, Math.min(1, ballHeight)) * SPAN;
    const cam = camera(ballY, cssW / cssH);

    // Floor, lane marks.
    gl.useProgram(line.prog);
    gl.enableVertexAttribArray(line.aPos);
    gl.uniformMatrix4fv(line.u.uViewProj, false, cam.viewProj);
    gl.uniform3fv(line.u.uEye, cam.eye);
    gl.uniform3fv(line.u.uFog, fog);
    const floor = [];
    for (let x = -12; x <= 12; x += 2) floor.push(x, FLOOR_Y, -DEPTH, x, FLOOR_Y, CAM_Z);
    for (const z of floorLines(now, travel)) floor.push(-12, FLOOR_Y, z, 12, FLOOR_Y, z);
    drawLines(floor, ink2, 0.28);
    const marks = [];
    for (const h of lanes) {
      const y = h * SPAN;
      marks.push(-LANE_X, y, -DEPTH, -LANE_X, y, 2, LANE_X, y, -DEPTH, LANE_X, y, 2);
    }
    drawLines(marks, neon, 0.32);
    gl.disableVertexAttribArray(line.aPos);

    // Rings far to near, then the ball and its trail.
    gl.useProgram(mesh.prog);
    gl.enableVertexAttribArray(mesh.aPos);
    gl.enableVertexAttribArray(mesh.aNor);
    gl.uniformMatrix4fv(mesh.u.uViewProj, false, cam.viewProj);
    gl.uniform3fv(mesh.u.uEye, cam.eye);
    gl.uniform3fv(mesh.u.uFog, fog);
    const poses = [];
    for (const ring of rings) {
      const p = ringPose(ring, now, travel);
      if (p) poses.push(p);
    }
    poses.sort((a, b) => a.z - b.z);
    for (const p of poses) {
      const colour = p.tone === 'ahead' ? neon : p.tone === 'cleared' ? ok : bad;
      gl.depthMask(p.alpha >= 0.99);
      drawMesh(ringMesh, place(p.x, p.y, p.z, p.scale), colour, p.alpha, p.tone === 'cleared' ? 0.45 : 0.12);
    }
    gl.depthMask(true);
    drawMesh(ballMesh, place(0, ballY, 0), bulb, 1, 0.25);
    trail.unshift(ballY);
    if (trail.length > TRAIL) trail.length = TRAIL;
    gl.depthMask(false);
    for (let i = 1; i < trail.length; i++) {
      const k = 1 - i / TRAIL;
      drawMesh(ballMesh, place(0, trail[i], i * 0.55, 0.35 + 0.5 * k), bulb, 0.35 * k, 0.6);
    }
    gl.depthMask(true);
    gl.disableVertexAttribArray(mesh.aPos);
    gl.disableVertexAttribArray(mesh.aNor);
    return true;
  }

  function destroy() {
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  }

  return { frame, destroy, get scale() { return scale; } };
}

