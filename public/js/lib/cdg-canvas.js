// Draws a CDG track onto a <canvas>, only when the picture changed.
import { CdgDecoder, scale2x, indicesToRgba, CDG_VISIBLE_WIDTH as W, CDG_VISIBLE_HEIGHT as H } from '/shared/cdg.js';

export class CdgRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.g = canvas.getContext('2d', { alpha: true });
    this.decoder = null;
    this.smoothing = true;
    this.transparent = true;
    this.indices = new Uint8Array(W * H);
    this.big = new Uint8Array(W * H * 4);
    this.alpha = new Uint8Array(16);
    this.drawn = -1;
    this.resize();
  }

  resize() {
    const w = this.smoothing ? W * 2 : W;
    const h = this.smoothing ? H * 2 : H;
    if (this.canvas.width !== w) this.canvas.width = w;
    if (this.canvas.height !== h) this.canvas.height = h;
    this.image = this.g.createImageData(w, h);
    this.drawn = -1;
  }

  setOptions({ smoothing = this.smoothing, transparent = this.transparent } = {}) {
    if (smoothing !== this.smoothing) {
      this.smoothing = smoothing;
      this.resize();
    }
    if (transparent !== this.transparent) {
      this.transparent = transparent;
      this.drawn = -1;
    }
  }

  load(bytes) {
    this.decoder = new CdgDecoder(bytes);
    this.drawn = -1;
    this.g.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  unload() {
    this.decoder = null;
    this.g.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  get loaded() {
    return !!this.decoder;
  }

  /** CSS colour of the CDG background (for letterboxing when not transparent). */
  get background() {
    const d = this.decoder;
    if (!d) return 'transparent';
    const p = d.palette;
    const c = d.bgColor * 3;
    return `rgb(${p[c]}, ${p[c + 1]}, ${p[c + 2]})`;
  }

  /** Brings the picture to `time` seconds; returns true when something was drawn. */
  render(time) {
    const d = this.decoder;
    if (!d) return false;
    d.seek(Math.max(0, time));
    if (d.version === this.drawn) return false;
    this.drawn = d.version;
    const idx = d.visibleIndices(this.indices);
    const src = this.smoothing ? scale2x(idx, W, H, this.big) : idx;
    this.alpha.fill(255);
    if (this.transparent) this.alpha[d.bgColor] = 0; // DEFINE_TRANSPARENT is not keyed (it could hide the text)
    indicesToRgba(src, d.palette, this.image.data, this.alpha);
    this.g.putImageData(this.image, 0, 0);
    return true;
  }
}
