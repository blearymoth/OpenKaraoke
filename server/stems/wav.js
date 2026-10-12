// A tiny PCM WAV writer. Tests and the fake separator use it; the real separator is autokaraoke,
// which writes its own WAVs through ffmpeg.
import fs from 'node:fs/promises';

/** 16-bit stereo (or mono) PCM WAV. `hz` 0 writes silence. */
export async function writePcmWav(file, { seconds = 1, rate = 44100, channels = 2, hz = 440 } = {}) {
  const n = Math.max(1, Math.floor(seconds * rate));
  const data = Buffer.alloc(n * channels * 2);
  for (let i = 0; i < n; i++) {
    const s = hz > 0 ? Math.round(Math.sin((2 * Math.PI * hz * i) / rate) * 8000) : 0;
    for (let c = 0; c < channels; c++) data.writeInt16LE(s, (i * channels + c) * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  await fs.writeFile(file, Buffer.concat([header, data]));
}
