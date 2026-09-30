// Draws a CDG stream onto a <canvas>, synced to an external clock.
import { CdgDecoder, scale2x, VISIBLE_WIDTH, VISIBLE_HEIGHT } from '/shared/cdg.js';

export class CdgView {
  constructor(canvas, { smoothing = true, transparent = true } = {}) {
    this.canvas = canvas;
    this.g = canvas.getContext('2d');
    this.decoder = new CdgDecoder();
    this.idx = new Uint8Array(VISIBLE_WIDTH * VISIBLE_HEIGHT);
    this.idx2 = new Uint8Array(VISIBLE_WIDTH * VISIBLE_HEIGHT * 4);
    this.smoothing = smoothing;
    this.transparent = transparent;
    this.drawnKey = '';
    this._size();
  }

  _size() {
    const s = this.smoothing ? 2 : 1;
    const w = VISIBLE_WIDTH * s;
    const h = VISIBLE_HEIGHT * s;
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.image = this.g.createImageData(w, h);
    this.u32 = new Uint32Array(this.image.data.buffer);
    this.drawnKey = '';
  }

  setOptions({ smoothing = this.smoothing, transparent = this.transparent } = {}) {
    if (smoothing !== this.smoothing) { this.smoothing = smoothing; this._size(); }
    if (transparent !== this.transparent) { this.transparent = transparent; this.drawnKey = ''; }
  }

  get loaded() { return !!this.decoder.data; }
  get duration() { return this.decoder.duration; }

  load(buffer) {
    this.decoder.setData(new Uint8Array(buffer));
    this.drawnKey = '';
  }

  clear() {
    this.decoder.setData(null);
    this.g.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.drawnKey = '';
  }

  /** CSS colour of the CDG "paper" (for letterboxing in opaque mode). */
  paperColor() {
    const d = this.decoder;
    const i = d.bgColor * 3;
    return `rgb(${d.palette[i]}, ${d.palette[i + 1]}, ${d.palette[i + 2]})`;
  }

  render(time) {
    const d = this.decoder;
    if (!d.data) return false;
    d.seekTime(Math.max(0, time));
    const key = `${d.version}:${d.paletteVersion}:${d.hOffset}:${d.vOffset}:${d.bgColor}:${this.transparent}:${this.smoothing}`;
    if (key === this.drawnKey) return false;
    this.drawnKey = key;
    const idx = d.indices({ out: this.idx });
    const src = this.smoothing ? scale2x(idx, VISIBLE_WIDTH, VISIBLE_HEIGHT, this.idx2) : idx;
    const lut = d.rgba32({ transparentBg: this.transparent });
    const out = this.u32;
    for (let i = 0; i < out.length; i++) out[i] = lut[src[i]];
    this.g.putImageData(this.image, 0, 0);
    return true;
  }
}
