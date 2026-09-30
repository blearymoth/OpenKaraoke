#!/usr/bin/env node
// Generates a small demo karaoke library (synthesised WAV backing tracks + CDG
// lyrics with word highlighting) for trying OpenKaraoke without a real library,
// and for browser end-to-end tests.
//
//   node scripts/make-demo-library.js /tmp/karaoke-demo
import fs from 'node:fs/promises';
import path from 'node:path';
import { CdgWriter, centerCol } from './lib/cdg-writer.js';
import { makeZip } from './lib/zip-writer.js';

const RATE = 44100;
const PALETTE = [
  [1, 1, 3], // 0 paper (dark blue)
  [15, 15, 15], // 1 text white
  [15, 3, 9], // 2 highlight pink
  [3, 13, 15], // 3 cyan (titles)
  [15, 12, 2], // 4 yellow
  [1, 1, 3], // 5 border
];
const NOTE = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const MAJOR = [0, 2, 4, 5, 7, 9, 11];

const SONGS = [
  {
    file: 'D/Demo Band/Demo Band - Hello Karaoke [OK Karaoke]',
    title: 'HELLO KARAOKE', artist: 'DEMO BAND', key: 'C', bpm: 104, seed: 1,
    lines: ['HELLO HELLO KARAOKE', 'SING IT LOUD TONIGHT', 'EVERY VOICE IS WELCOME', 'UNDER PARTY LIGHTS',
      'TAKE THE MIC AND SHINE', 'THE WORDS ARE ON THE SCREEN', 'HELLO HELLO KARAOKE', 'BEST NIGHT WE HAVE SEEN'],
  },
  {
    file: 'D/Demo Band/Demo Band - Hello Karaoke [SF Karaoke]',
    title: 'HELLO KARAOKE', artist: 'DEMO BAND', key: 'D', bpm: 104, seed: 2, lines: null, // same lyrics, other label
  },
  {
    file: 'T/Test Pattern/Test Pattern - Multiplex Check (Multiplex) [OK Karaoke]',
    title: 'MULTIPLEX CHECK', artist: 'TEST PATTERN', key: 'G', bpm: 96, seed: 3, multiplex: true,
    lines: ['LEFT HAS THE BAND', 'RIGHT HAS THE GUIDE', 'SWITCH THE CHANNEL', 'TO HEAR EACH SIDE'],
  },
  {
    file: 'S/Synthetics/The Synthetics & Robo Voice - Duet Of Machines (Duet) [OK Karaoke]',
    title: 'DUET OF MACHINES', artist: 'SYNTHETICS', key: 'A', bpm: 112, seed: 4,
    lines: ['YOU TAKE THE FIRST LINE', 'I WILL TAKE THE NEXT', 'TOGETHER WE ARE LOUDER', 'THAN A LONELY TEXT'],
  },
  {
    file: 'N/Night Owls/Night Owls - Midnight Tempo [OK Karaoke]',
    title: 'MIDNIGHT TEMPO', artist: 'NIGHT OWLS', key: 'F', bpm: 84, seed: 5,
    lines: ['SLOW IT DOWN', 'OR SPEED IT UP', 'CHANGE THE KEY', 'MIDNIGHT TEMPO'],
  },
  {
    file: 'R/Rude Words/Rude Words - Censored Song (Explicit) [OK Karaoke]',
    title: 'CENSORED SONG', artist: 'RUDE WORDS', key: 'E', bpm: 120, seed: 6,
    lines: ['BEEP BEEP BEEP', 'THIS ONE IS EXPLICIT', 'GUESTS MAY NOT SEE IT', 'WHEN THE FILTER IS ON'],
  },
  {
    file: 'Z/Zip Crew/Zip Crew - Packed Song [OK Karaoke]',
    title: 'PACKED SONG', artist: 'ZIP CREW', key: 'Bb', bpm: 100, seed: 7, zip: true,
    lines: ['ZIPPED UP AND READY', 'MP3 PLUS G', 'STRAIGHT FROM THE ZIP', 'ONE TWO THREE'],
  },
];

function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

const midiFreq = (m) => 440 * 2 ** ((m - 69) / 12);

function keyRoot(key) {
  const base = NOTE[key[0]];
  return 60 + base + (key[1] === 'b' ? -1 : key[1] === '#' ? 1 : 0);
}

/** Builds melody notes (one per word) and the lyric timeline. */
function arrange(song) {
  const beat = 60 / song.bpm;
  const r = rng(song.seed);
  const root = keyRoot(song.key);
  const introBeats = 8;
  const words = [];
  let t = introBeats * beat;
  for (const l of song.lines) if (l.length > 23) throw new Error(`lyric line too long for the CDG screen: ${l}`);
  const lines = song.lines.map((text) => {
    const ws = text.split(' ');
    const line = { text, start: t, words: [] };
    let col = 0;
    for (const w of ws) {
      const beats = w.length > 5 ? 2 : 1;
      const degree = [0, 2, 4, 4, 5, 2, 1, 0][Math.floor(r() * 8)];
      const midi = root + MAJOR[degree] + (r() < 0.25 ? 12 : 0);
      const word = { text: w, start: t, dur: beats * beat * 0.92, midi, col };
      line.words.push(word);
      words.push(word);
      t += beats * beat;
      col += w.length + 1;
    }
    t = Math.ceil(t / (4 * beat)) * 4 * beat; // next bar
    line.end = t;
    return line;
  });
  const total = t + 8 * beat;
  return { beat, root, lines, words, total };
}

function synth(song, arr) {
  const n = Math.ceil(arr.total * RATE);
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  const { beat, root } = arr;
  const prog = [0, 7, 9, 5]; // I V vi IV
  const bar = beat * 4;
  const noise = rng(song.seed * 99);
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    const barIdx = Math.floor(t / bar);
    const chordRoot = root + prog[barIdx % 4] - 12;
    const third = prog[barIdx % 4] === 9 ? 3 : 4;
    const env = Math.min(1, (arr.total - t) / 2);
    // pad chord (soft saw-ish)
    let pad = 0;
    for (const iv of [0, third, 7]) {
      const f = midiFreq(chordRoot + 12 + iv);
      pad += Math.sin(2 * Math.PI * f * t) * 0.5 + Math.sin(4 * Math.PI * f * t) * 0.12;
    }
    pad *= 0.06;
    // bass on every beat
    const bt = t % beat;
    const bass = Math.sin(2 * Math.PI * midiFreq(chordRoot - 12) * t) * Math.exp(-bt * 3) * 0.28;
    // kick on 1 and 3, hat on off-beats
    const kt = t % (beat * 2);
    const kick = Math.sin(2 * Math.PI * (50 + 90 * Math.exp(-kt * 30)) * kt) * Math.exp(-kt * 9) * 0.45;
    const ht = (t + beat / 2) % beat;
    const hat = (noise() * 2 - 1) * Math.exp(-ht * 60) * 0.06;
    const music = (pad + bass + kick) * env;
    L[i] = music + hat;
    R[i] = music - hat * 0.5;
  }
  // guide melody (the "vocal"): centred, or right channel only for multiplex tracks
  for (const w of arr.words) {
    const f = midiFreq(w.midi);
    const s0 = Math.floor(w.start * RATE);
    const s1 = Math.min(n, Math.floor((w.start + w.dur) * RATE));
    for (let i = s0; i < s1; i++) {
      const tt = (i - s0) / RATE;
      const e = Math.min(1, tt * 40) * Math.min(1, (s1 - i) / RATE * 20);
      const vib = Math.sin(2 * Math.PI * 5.5 * tt) * 0.004;
      const v = (Math.sin(2 * Math.PI * f * (1 + vib) * tt) * 0.8 + Math.sin(4 * Math.PI * f * tt) * 0.15) * e * 0.22;
      if (song.multiplex) R[i] += v * 1.6; // left = band only, right = band + guide vocal
      else { L[i] += v; R[i] += v; }
    }
  }
  return { L, R, n };
}

function wav({ L, R, n }) {
  const buf = Buffer.alloc(44 + n * 4);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 4, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(RATE, 24);
  buf.writeUInt32LE(RATE * 4, 28);
  buf.writeUInt16LE(4, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * 4, 40);
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
  const g = peak > 0.95 ? 0.95 / peak : 1;
  for (let i = 0; i < n; i++) {
    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, L[i] * g)) * 32767), 44 + i * 4);
    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, R[i] * g)) * 32767), 46 + i * 4);
  }
  return buf;
}

function cdg(song, arr) {
  const w = new CdgWriter().loadColors(PALETTE).memoryPreset(0).borderPreset(5);
  const events = [];
  // title card
  events.push({ t: 0.01, draw: () => {
    w.text(song.title, 5, centerCol(song.title), 3, 0);
    w.text(song.artist, 9, centerCol(song.artist), 1, 0);
    w.text('OPENKARAOKE DEMO', 14, centerCol('OPENKARAOKE DEMO'), 4, 0);
  } });
  // lyric pages of two lines
  for (let p = 0; p < arr.lines.length; p += 2) {
    const page = arr.lines.slice(p, p + 2);
    const showAt = Math.max(0.5, page[0].start - arr.beat * 3);
    events.push({ t: showAt, draw: () => {
      w.memoryPreset(0);
      w.borderPreset(5);
      page.forEach((line, i) => {
        line.row = 6 + i * 5;
        line.col = centerCol(line.text);
        w.text(line.text, line.row, line.col, 1, 0);
      });
    } });
    for (const line of page) {
      for (const word of line.words) {
        events.push({ t: word.start, draw: () => w.text(word.text, line.row, line.col + word.col * 2, 1, 2, { xor: true }) });
      }
    }
  }
  events.push({ t: arr.total - 3, draw: () => {
    w.memoryPreset(0);
    w.text('THANK YOU', 8, centerCol('THANK YOU'), 4, 0);
  } });
  events.sort((a, b) => a.t - b.t);
  for (const e of events) {
    w.padToTime(e.t);
    e.draw();
  }
  w.padToTime(arr.total);
  return w.toBuffer().subarray(0, Math.round(arr.total * 300) * 24);
}

async function main() {
  const out = process.argv[2];
  if (!out) {
    console.error('Usage: node scripts/make-demo-library.js <output folder>');
    process.exit(1);
  }
  let lastLines = null;
  for (const song of SONGS) {
    if (!song.lines) song.lines = lastLines;
    lastLines = song.lines;
    const arr = arrange(song);
    const audio = wav(synth(song, arr));
    const graphics = cdg(song, arr);
    const base = path.join(out, song.file);
    await fs.mkdir(path.dirname(base), { recursive: true });
    if (song.zip) {
      const name = path.basename(base).replace(/ \[.*\]$/, '');
      await fs.writeFile(`${base}.zip`, makeZip([
        { name: `${name}.cdg`, data: graphics, deflate: true },
        { name: `${name}.wav`, data: audio },
      ]));
    } else {
      await fs.writeFile(`${base}.wav`, audio);
      await fs.writeFile(`${base}.cdg`, graphics);
    }
    console.log(`${song.file}  (${Math.round(arr.total)} s)`);
  }
  console.log(`\nDemo library written to ${out}\nStart the server with:  npm start -- --library "${out}"`);
}

main();
