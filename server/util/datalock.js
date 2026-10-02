// One OpenKaraoke per data folder: two would overwrite each other's settings, party state and
// library index. `<data>/server.json` holds the running server's process id, the boot it was
// started in and, once it listens, its port (bin/open-tv.sh reads it). A lock whose process is
// gone (a crash, a power cut, a reboot) is taken over.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const LOCK_FILE = 'server.json';
// Locks this process holds right now: a second server started in the same process (the desktop
// app, the tests) on the same folder is refused too, while a lock left by an earlier process
// that happened to have the same process id is taken over.
const HELD = new Set();
// A lock file another process created a moment ago but hasn't written yet reads as empty: it
// counts as held for this long before it is treated as left over.
const FRESH_MS = 5000;

function bootId() {
  try {
    return fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
  } catch {
    return ''; // not Linux: the process id alone decides
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM'; // exists, but belongs to another user
  }
}

/** True when `holder` (the content of a lock file) belongs to a process that still runs. */
export function lockHeld(holder, { pid = process.pid, boot = bootId() } = {}) {
  if (!holder || !Number.isInteger(holder.pid) || holder.pid === pid) return false;
  if (holder.boot && boot && holder.boot !== boot) return false; // from before a reboot: its pid means nothing now
  return alive(holder.pid);
}

/**
 * Takes the data folder's lock. Resolves to `{ ok: true, update(info), release() }`, or to
 * `{ ok: false, holder }` when another running OpenKaraoke has it (`holder.port` once it listens).
 */
export async function acquireDataLock(dataDir, { pid = process.pid } = {}) {
  const file = path.resolve(dataDir, LOCK_FILE);
  if (HELD.has(file)) {
    let holder = { pid };
    try {
      holder = JSON.parse(await fsp.readFile(file, 'utf8'));
    } catch { /* being rewritten */ }
    return { ok: false, holder };
  }
  const boot = bootId();
  const base = { pid, boot, startedAt: Date.now() };
  for (let attempt = 0; attempt < 5; attempt++) {
    let fh;
    try {
      fh = await fsp.open(file, 'wx');
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let holder = null;
      let st = null;
      try {
        st = await fsp.stat(file);
        holder = JSON.parse(await fsp.readFile(file, 'utf8'));
      } catch { /* gone meanwhile, or not written yet */ }
      if (lockHeld(holder, { pid, boot })) return { ok: false, holder };
      if (!holder && st && Date.now() - st.mtimeMs < FRESH_MS) return { ok: false, holder: { pid: null } };
      await fsp.rm(file, { force: true });
      continue;
    }
    try {
      await fh.writeFile(JSON.stringify(base));
    } finally {
      await fh.close();
    }
    let info = { ...base };
    HELD.add(file);
    return {
      ok: true,
      file,
      /** Adds details for whoever finds the lock (`port`, `host`). */
      async update(more) {
        info = { ...info, ...more };
        const tmp = `${file}.${pid}.tmp`;
        await fsp.writeFile(tmp, JSON.stringify(info));
        await fsp.rename(tmp, file);
      },
      /** Removes the lock, unless another process has taken it over since. */
      async release() {
        HELD.delete(file);
        try {
          const now = JSON.parse(await fsp.readFile(file, 'utf8'));
          if (now?.pid !== pid) return;
        } catch {
          return;
        }
        await fsp.rm(file, { force: true });
      },
    };
  }
  throw new Error(`Could not lock the data folder ${dataDir}`);
}
