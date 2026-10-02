// Colour-vision helpers for palette tests: Machado et al. (2009) full-severity simulation of
// protanopia, deuteranopia and tritanopia, and the CIEDE2000 colour difference. Test-only.

const MACHADO = {
  normal: [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
  protan: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
  deutan: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.01182, 0.04294, 0.968881]],
  tritan: [[1.255528, -0.076749, -0.178779], [-0.078411, 0.930809, 0.147602], [0.004733, 0.691367, 0.3039]],
};
export const VISION = Object.keys(MACHADO);

const lin = (v) => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

/** CIELAB (D65) of '#rrggbb' as seen with `vision` ('normal', 'protan', 'deutan', 'tritan'). */
export function labAs(hex, vision = 'normal') {
  const l = rgb(hex).map(lin);
  const [r, g, b] = MACHADO[vision].map((row) => Math.min(1, Math.max(0, row[0] * l[0] + row[1] * l[1] + row[2] * l[2])));
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const X = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
  const Y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const Z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
  return [116 * f(Y) - 16, 500 * (f(X) - f(Y)), 200 * (f(Y) - f(Z))];
}

/** CIEDE2000 difference of two CIELAB colours (about 2 is just noticeable; 10 is clearly different). */
export function deltaE2000([L1, a1, b1], [L2, a2, b2]) {
  const rad = Math.PI / 180;
  const Cb = (Math.hypot(a1, b1) + Math.hypot(a2, b2)) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cb ** 7 / (Cb ** 7 + 25 ** 7)));
  const a1p = (1 + G) * a1;
  const a2p = (1 + G) * a2;
  const C1 = Math.hypot(a1p, b1);
  const C2 = Math.hypot(a2p, b2);
  const hue = (b, a) => (a === 0 && b === 0 ? 0 : (Math.atan2(b, a) / rad + 360) % 360);
  const h1 = hue(b1, a1p);
  const h2 = hue(b2, a2p);
  let dh = 0;
  if (C1 * C2 !== 0) dh = h2 - h1 > 180 ? h2 - h1 - 360 : h2 - h1 < -180 ? h2 - h1 + 360 : h2 - h1;
  const dH = 2 * Math.sqrt(C1 * C2) * Math.sin((dh / 2) * rad);
  const L = (L1 + L2) / 2;
  const C = (C1 + C2) / 2;
  let h = h1 + h2;
  if (C1 * C2 !== 0) h = Math.abs(h1 - h2) > 180 ? (h + (h < 360 ? 360 : -360)) / 2 : h / 2;
  const T = 1 - 0.17 * Math.cos((h - 30) * rad) + 0.24 * Math.cos(2 * h * rad) + 0.32 * Math.cos((3 * h + 6) * rad) - 0.2 * Math.cos((4 * h - 63) * rad);
  const Rc = 2 * Math.sqrt(C ** 7 / (C ** 7 + 25 ** 7));
  const Rt = -Math.sin(60 * Math.exp(-(((h - 275) / 25) ** 2)) * rad) * Rc;
  const SL = 1 + (0.015 * (L - 50) ** 2) / Math.sqrt(20 + (L - 50) ** 2);
  const SC = 1 + 0.045 * C;
  const SH = 1 + 0.015 * C * T;
  const x = (L2 - L1) / SL;
  const y = (C2 - C1) / SC;
  const z = dH / SH;
  return Math.sqrt(x * x + y * y + z * z + Rt * y * z);
}

/** The smallest CIEDE2000 difference of two colours over the four kinds of colour vision. */
export function worstDifference(a, b) {
  return Math.min(...VISION.map((v) => deltaE2000(labAs(a, v), labAs(b, v))));
}
