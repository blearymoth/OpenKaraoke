import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
export { makeZip } from '../scripts/lib/zip-writer.js';

export async function tmpDir(prefix = 'openkaraoke-test-') {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

/** Writes files described as { 'rel/path': Buffer|string|number(bytes) }. */
export async function writeTree(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    const data = typeof content === 'number' ? Buffer.alloc(content) : content;
    await fs.writeFile(abs, data);
  }
}

/** Raw scanner-style track records built from "Artist - Title [Brand Karaoke]" names. */
export function rawTracks(names) {
  return names.map((name, i) => {
    const artist = name.split(' - ')[0];
    return {
      root: 0,
      dir: `${artist[0].toUpperCase()}/${artist}`,
      name,
      kind: 'cdg',
      cdg: `${name}.cdg`,
      audio: `${name}.mp3`,
      size: 7200 * (180 + i),
      duration: 180 + i,
    };
  });
}
