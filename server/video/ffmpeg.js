// Video karaoke in containers the browser can't play (AVI, MPG/MPEG, WMV, FLV, VOB): converted
// once with ffmpeg, when it is installed, to WebM (VP8 or VP9 video, Opus or Vorbis sound — what
// every Chromium plays, also Fedora's ffmpeg-free). ffmpeg is an ordinary program on the PC, run
// through spawn with every value its own argument (never a shell); OpenKaraoke has no npm
// dependency for it. Without ffmpeg those videos can't play, and the host and TV say why.
import { execFile, spawn } from 'node:child_process';
import { BROWSER_VIDEO_EXTS, VIDEO_EXTS } from '../library/parse.js';

export const INSTALL_HINT = 'Install ffmpeg to play AVI, MPG and WMV videos (Fedora: sudo dnf install ffmpeg-free; Ubuntu: sudo apt install ffmpeg), then restart OpenKaraoke.';

/** A video file the browser can't play itself: it needs converting. */
export function needsConversion(fileName) {
  const ext = String(fileName || '').split('.').pop().toLowerCase();
  return VIDEO_EXTS.has(ext) && !BROWSER_VIDEO_EXTS.has(ext);
}

/** Which encoders to use, from `ffmpeg -encoders`: the fastest of each kind that is there, or null. */
export function pickEncoders(list) {
  const has = (name) => new RegExp(`^\\s*[A-Z.]{6}\\s+${name.replace(/[-]/g, '\\-')}\\s`, 'm').test(list || '');
  const video = ['libvpx', 'libvpx-vp9'].find(has);
  const audio = ['libopus', 'libvorbis'].find(has);
  return video && audio ? { video, audio } : null;
}

/**
 * The arguments for one conversion: the first video and (if any) first audio stream, made for
 * speed (realtime settings: a few minutes of video take seconds to a minute), written as WebM.
 * `-progress pipe:1` reports the position on stdout.
 */
export function convertArgs({ src, out, video = 'libvpx', audio = 'libopus' }) {
  const v = video === 'libvpx-vp9'
    ? ['-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-row-mt', '1', '-b:v', '2500k']
    : ['-c:v', 'libvpx', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', '2500k', '-qmin', '4', '-qmax', '40'];
  return [
    // (Log level info: the input's "Duration:" line is what progress is measured against.)
    '-hide_banner', '-nostdin', '-nostats', '-loglevel', 'info', '-y',
    '-i', src,
    '-map', '0:v:0', '-map', '0:a:0?', '-sn', '-dn',
    ...v,
    '-c:a', audio, '-b:a', '160k', '-ac', '2', '-ar', '48000',
    '-f', 'webm', '-progress', 'pipe:1',
    out,
  ];
}

/** Seconds from ffmpeg's "Duration: 00:03:45.12" (stderr of a run), or 0. */
export function parseDuration(text) {
  const m = /Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(text || '');
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 0;
}

/**
 * The real ffmpeg: `bin` from OPENKARAOKE_FFMPEG, else `ffmpeg` on the PATH.
 * detect() → { bin, version, encoders } or { missing: reason }; run() converts one file.
 */
export function ffmpegTool({ env = process.env } = {}) {
  const bin = env.OPENKARAOKE_FFMPEG || 'ffmpeg';
  const ask = (args) => new Promise((resolve) => {
    execFile(bin, args, { timeout: 10_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => resolve(err ? null : String(stdout)));
  });
  let detected = null;
  return {
    async detect() {
      detected ||= (async () => {
        const version = await ask(['-hide_banner', '-version']);
        if (version === null) return { missing: 'ffmpeg is not installed' };
        const encoders = pickEncoders(await ask(['-hide_banner', '-encoders']));
        if (!encoders) return { missing: 'this ffmpeg can’t make WebM videos (no VP8/VP9 or Opus/Vorbis encoder)' };
        return { bin, version: (/^ffmpeg version (\S+)/m.exec(version) || [])[1] || '', encoders };
      })();
      return detected;
    },
    async run({ src, out, onProgress, onChild }) {
      const info = await this.detect();
      if (info.missing) throw new Error(info.missing);
      await runFfmpeg({ bin, args: convertArgs({ src, out, ...info.encoders }), onProgress, onChild });
    },
  };
}

/** Runs one conversion; `onProgress(0…1)` while it goes. Rejects with ffmpeg's last error lines. */
export function runFfmpeg({ bin, args, onProgress, onChild }) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    onChild?.(child);
    let err = '';
    let duration = 0;
    let buf = '';
    child.stderr.on('data', (d) => {
      err = (err + d).slice(-8000);
      duration ||= parseDuration(err);
    });
    child.stdout.on('data', (d) => {
      buf += d;
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        const m = /^out_time_(?:us|ms)=(\d+)/.exec(line);
        if (m && duration > 0) onProgress?.(Math.min(0.99, Number(m[1]) / 1e6 / duration));
      }
    });
    child.on('error', (e) => reject(e.code === 'ENOENT' ? new Error('ffmpeg is not installed') : e));
    child.on('close', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(err.trim().split('\n').slice(-3).join(' ').slice(0, 300) || `ffmpeg stopped (${signal || code})`));
    });
  });
}
