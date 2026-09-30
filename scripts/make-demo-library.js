#!/usr/bin/env node
// Creates a small demo karaoke library (synthesised MP3 backing tracks + CDG lyrics with a
// karaoke highlight wipe) so OpenKaraoke can be tried and tested without a real collection.
//
//   node scripts/make-demo-library.js [folder]      (default: ./demo-library)
//
// Uses ffmpeg to encode MP3 when it is installed, otherwise writes WAV files.
// All songs, artists and lyrics are made up for this demo.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { CdgWriter, drawText, centeredX, textWidth } from './lib/cdg-writer.js';
import { CDG_VISIBLE_X, CDG_VISIBLE_Y } from '../shared/cdg.js';

const SR = 44100;

export const DEMO_SONGS = [
  {
    artist: 'The Midnight Mics', title: 'Neon Heart', brand: 'OK', bpm: 112, root: 57, prog: [0, 7, 9, 5],
    lyrics: [
      'Turn the lights down low tonight', 'Every mic is shining bright',
      'Grab the words and hold them tight', 'Neon heart, we sing till light',
      'Shout it louder, shout it clear', 'All your friends are standing here',
      'One more chorus, one more cheer', 'Neon heart, the night is near',
    ],
  },
  {
    artist: 'The Midnight Mics', title: 'Neon Heart', brand: 'ZZ', bpm: 104, root: 55, prog: [0, 7, 9, 5],
    lyrics: [
      'Turn the lights down low tonight', 'Every mic is shining bright',
      'Grab the words and hold them tight', 'Neon heart, we sing till light',
    ],
  },
  {
    artist: 'Pixel Parade', title: 'Tempo Tantrum', brand: 'OK', bpm: 128, root: 52, prog: [0, 3, 5, 3],
    lyrics: [
      'Faster, faster, count to four', 'Feet are stomping on the floor',
      'Slow it down, then speed it more', 'Tempo tantrum, give me more',
      'Up and down the scale we go', 'Nobody sings it slow',
    ],
  },
  {
    artist: 'Aurora & The Echoes', title: 'Singing In The Kitchen (Duet)', brand: 'OK', bpm: 92, root: 60, prog: [0, 5, 9, 7],
    lyrics: [
      'You take the high part, I take the low', 'Pots and pans for a drum solo',
      'Singing in the kitchen, lights are on', 'Two voices blending into one song',
      'Pass the spoon, it is your turn', 'Burning toast is all we learn',
    ],
  },
  {
    artist: 'DJ Hush', title: 'Quiet Storm (Multiplex)', brand: 'MX', bpm: 98, root: 50, prog: [0, 10, 8, 7], guideLeft: true,
    lyrics: [
      'Guide vocal on the left side', 'Backing track is on the right',
      'Pick a channel, find your key', 'Quiet storm is here for me',
    ],
  },
  {
    artist: 'Captain Falsetto', title: 'High Notes Only', brand: 'OK', bpm: 118, root: 64, prog: [0, 5, 7, 5],
    lyrics: [
      'Every note is way up high', 'Hit it once and touch the sky',
      'Lower the key if you must', 'High notes only, in me we trust',
    ],
  },
];

// ---- audio ---------------------------------------------------------------------

const midiHz = (m) => 440 * 2 ** ((m - 69) / 12);

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Renders a backing track; returns { left, right, duration, barSec, introBars }. */
export function synthSong(song, seed = 1) {
  const beat = 60 / song.bpm;
  const bar = beat * 4;
  const introBars = 2;
  const lineBars = 2;
  const bars = introBars + song.lyrics.length * lineBars + 2;
  const duration = bars * bar;
  const n = Math.ceil(duration * SR);
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  const G = song.guideLeft ? new Float32Array(n) : null;
  const rand = mulberry32(seed);
  const chordOf = (b) => {
    const deg = song.prog[b % song.prog.length];
    const minor = [9, 2, 4].includes(deg % 12);
    return [song.root + deg, song.root + deg + (minor ? 3 : 4), song.root + deg + 7];
  };

  const add = (buf, start, len, fn) => {
    const s0 = Math.max(0, Math.floor(start * SR));
    const s1 = Math.min(n, s0 + Math.floor(len * SR));
    for (let i = s0; i < s1; i++) buf[i] += fn((i - s0) / SR);
  };

  for (let b = 0; b < bars; b++) {
    const t0 = b * bar;
    const chord = chordOf(b);
    const outro = b >= bars - 2;
    // pad: soft chord with slow attack
    for (const note of chord) {
      const f = midiHz(note);
      add(L, t0, bar, (t) => 0.05 * Math.min(1, t / 0.3) * Math.min(1, (bar - t) / 0.2) * (Math.sin(2 * Math.PI * f * t) + 0.3 * Math.sin(4 * Math.PI * f * t * 1.003)));
      add(R, t0, bar, (t) => 0.05 * Math.min(1, t / 0.3) * Math.min(1, (bar - t) / 0.2) * (Math.sin(2 * Math.PI * f * 1.002 * t) + 0.3 * Math.sin(4 * Math.PI * f * t)));
    }
    if (outro && b === bars - 1) continue; // let the last bar ring out
    for (let k = 0; k < 8; k++) {
      const t = t0 + k * beat / 2;
      // bass: root on the eighths, octave jump on the "and" of 2 and 4
      const bassNote = chord[0] - 24 + (k === 3 || k === 7 ? 12 : 0);
      const bf = midiHz(bassNote);
      const bass = (x) => 0.22 * Math.exp(-x * 5) * Math.sin(2 * Math.PI * bf * x + 0.8 * Math.sin(2 * Math.PI * bf * x));
      add(L, t, beat / 2, bass);
      add(R, t, beat / 2, bass);
      // hi-hat
      const hat = (x) => 0.05 * Math.exp(-x * 60) * (rand() * 2 - 1);
      add(L, t, 0.08, hat);
      add(R, t + 0.004, 0.08, hat);
      if (k % 2 === 0) {
        const beatNo = k / 2;
        if (beatNo === 0 || beatNo === 2) {
          const kick = (x) => 0.5 * Math.exp(-x * 9) * Math.sin(2 * Math.PI * (45 * x + 60 * (1 - Math.exp(-x * 30)) / 30 * 1.6));
          add(L, t, 0.35, kick);
          add(R, t, 0.35, kick);
        } else {
          const snare = (x) => Math.exp(-x * 18) * (0.16 * (rand() * 2 - 1) + 0.1 * Math.sin(2 * Math.PI * 190 * x));
          add(L, t, 0.25, snare);
          add(R, t, 0.25, snare);
        }
      }
    }
    // guide melody (only in the multiplex song, on the left channel)
    if (G && b >= introBars && !outro) {
      const pattern = [0, 1, 2, 1, 2, 0, 1, 2];
      for (let k = 0; k < 8; k++) {
        const f = midiHz(chord[pattern[k]] + 12);
        add(G, t0 + k * beat / 2, beat / 2, (x) => 0.13 * Math.min(1, x / 0.02) * Math.exp(-x * 2) * triangle(f * x + 0.004 * Math.sin(2 * Math.PI * 5.5 * x)));
      }
    }
  }
  if (G) for (let i = 0; i < n; i++) L[i] += G[i];
  // soft limiter + normalise
  let peak = 0;
  for (let i = 0; i < n; i++) {
    L[i] = Math.tanh(L[i] * 1.2);
    R[i] = Math.tanh(R[i] * 1.2);
    peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
  }
  const g = peak ? 0.89 / peak : 1;
  for (let i = 0; i < n; i++) { L[i] *= g; R[i] *= g; }
  return { left: L, right: R, duration, barSec: bar, introBars, lineBars };
}

function triangle(phase) {
  const p = phase - Math.floor(phase);
  return 4 * Math.abs(p - 0.5) - 1;
}

export function wavBuffer(left, right) {
  const n = left.length;
  const buf = Buffer.alloc(44 + n * 4);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 4, 4);
  buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(SR, 24);
  buf.writeUInt32LE(SR * 4, 28);
  buf.writeUInt16LE(4, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * 4, 40);
  for (let i = 0; i < n; i++) {
    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, left[i])) * 32767), 44 + i * 4);
    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, right[i])) * 32767), 46 + i * 4);
  }
  return buf;
}

// ---- graphics --------------------------------------------------------------------

const BG = 0;
const TEXT = 1;
const HIGHLIGHT = 2;
const SHADOW = 3;
const BAND = 4;
const TITLE = 5;
const SUB = 6;
const PALETTE = [
  [1, 1, 3], [15, 15, 15], [15, 4, 9], [0, 0, 0], [4, 2, 8], [15, 12, 4], [10, 9, 14],
  ...Array.from({ length: 9 }, () => [0, 0, 0]),
];

/** Splits a lyric line into at most two balanced rows that fit the screen. */
export function wrapLine(text, max = 276) {
  if (textWidth(text) <= max) return [text];
  const words = text.split(' ');
  let best = null;
  for (let i = 1; i < words.length; i++) {
    const a = words.slice(0, i).join(' ');
    const b = words.slice(i).join(' ');
    const worst = Math.max(textWidth(a), textWidth(b));
    if (!best || worst < best.worst) best = { rows: [a, b], worst };
  }
  return best && best.worst <= max ? best.rows : [text];
}

/** Karaoke graphics: title card during the intro, then pages of up to 4 rows with a colour wipe. */
export function makeCdg(song, timing) {
  const { duration, barSec, introBars, lineBars } = timing;
  const w = new CdgWriter();
  w.loadColors(PALETTE);
  w.memoryPreset(BG, 2);
  w.borderPreset(BG);
  let frame = w.screen.slice();

  // title card
  for (let y = 70; y < 150; y++) frame.fill(BAND, y * 300 + CDG_VISIBLE_X, y * 300 + CDG_VISIBLE_X + 288);
  const title = song.title.replace(/\s*\((?:Duet|Multiplex)\)/i, '');
  drawText(frame, title, centeredX(title), 82, TITLE, { shadowColor: SHADOW });
  drawText(frame, song.artist, centeredX(song.artist), 112, SUB, { shadowColor: SHADOW });
  const demo = 'OpenKaraoke demo track';
  drawText(frame, demo, centeredX(demo), 172, SUB);
  w.drawFrame(frame);

  const lineDur = lineBars * barSec;
  const firstLine = introBars * barSec;

  // Each lyric line becomes 1–2 rows; a row owns the share of the line's time that matches its width.
  const lines = song.lyrics.map((text, index) => {
    const rows = wrapLine(text);
    const total = rows.reduce((s, r) => s + textWidth(r), 0);
    let acc = 0;
    return {
      index,
      rows: rows.map((r) => {
        const width = textWidth(r);
        const row = { text: r, width, from: acc / total, to: (acc + width) / total };
        acc += width;
        return row;
      }),
    };
  });
  const pages = [];
  for (const line of lines) {
    const page = pages.at(-1);
    if (page && page.rows + line.rows.length <= 4) {
      page.lines.push(line);
      page.rows += line.rows.length;
    } else {
      pages.push({ lines: [line], rows: line.rows.length });
    }
  }
  const rowY = (k) => CDG_VISIBLE_Y + 22 + k * 42;

  for (const page of pages) {
    const pageStart = firstLine + page.lines[0].index * lineDur;
    w.padTo(Math.max(w.time, pageStart - barSec * 0.75));
    frame = new Uint8Array(w.screen.length);
    const drawPage = (activeIndex, progress) => {
      frame.fill(BG);
      let k = 0;
      for (const line of page.lines) {
        for (const row of line.rows) {
          const x = centeredX(row.text);
          let hx = -1;
          if (line.index < activeIndex) hx = 999;
          else if (line.index === activeIndex) hx = x + Math.round(Math.max(0, Math.min(1, (progress - row.from) / (row.to - row.from))) * row.width);
          drawText(frame, row.text, x, rowY(k++), TEXT, { highlightX: hx, highlightColor: HIGHLIGHT, shadowColor: SHADOW });
        }
      }
    };
    drawPage(-1, 0);
    w.drawFrame(frame);
    for (const line of page.lines) {
      const start = firstLine + line.index * lineDur;
      const sing = lineDur * 0.85;
      for (let t = 0; t <= sing + 1e-6; t += 0.05) {
        w.padTo(start + t);
        drawPage(line.index, t / sing);
        w.drawFrame(frame);
      }
    }
  }
  // outro: clear and thank the singer
  w.padTo(Math.max(w.time, firstLine + song.lyrics.length * lineDur + 0.5));
  frame = new Uint8Array(w.screen.length).fill(BG);
  drawText(frame, 'Thank you!', centeredX('Thank you!'), 96, TITLE, { shadowColor: SHADOW });
  w.drawFrame(frame);
  w.padTo(duration);
  return w.toBuffer();
}

// ---- main -------------------------------------------------------------------------

export async function makeDemoLibrary(outDir, { songs = DEMO_SONGS, log = console.log } = {}) {
  const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ok-demo-'));
  const made = [];
  let seed = 7;
  for (const song of songs) {
    const timing = synthSong(song, seed++);
    const name = `${song.artist} - ${song.title} [${song.brand} Karaoke]`;
    const letter = /^[a-z]/i.test(song.artist.replace(/^the /i, '')) ? song.artist.replace(/^the /i, '')[0].toUpperCase() : '#';
    const dir = path.join(outDir, letter, song.artist);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, `${name}.cdg`), makeCdg(song, timing));
    const wav = wavBuffer(timing.left, timing.right);
    if (hasFfmpeg) {
      const tmpWav = path.join(tmp, 'track.wav');
      await fs.writeFile(tmpWav, wav);
      execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', tmpWav, '-codec:a', 'libmp3lame', '-b:a', '160k',
        '-metadata', `title=${song.title} [${song.brand} Karaoke]`, '-metadata', `artist=${song.artist}`, path.join(dir, `${name}.mp3`)]);
    } else {
      await fs.writeFile(path.join(dir, `${name}.wav`), wav);
    }
    made.push({ name, duration: timing.duration });
    log(`  ${name}  (${Math.round(timing.duration)} s)`);
  }
  await fs.rm(tmp, { recursive: true, force: true });
  return { made, format: hasFfmpeg ? 'mp3' : 'wav' };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (isMain) {
  const out = path.resolve(process.argv[2] || 'demo-library');
  console.log(`Creating demo karaoke library in ${out} …`);
  const { made, format } = await makeDemoLibrary(out);
  console.log(`Done: ${made.length} tracks (${format.toUpperCase()} + CDG).`);
  console.log(`Start OpenKaraoke with it:  npm start -- --library "${out}"`);
}
