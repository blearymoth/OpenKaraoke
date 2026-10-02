// Keeps the desktop app up to date with the repository: the release workflow
// (.github/workflows/desktop.yml) publishes a GitHub release for every change to main, and this
// checks the latest one (soon after the start, then every 6 hours, or when asked). Nothing is
// installed without the host asking for it:
//   AppImage   the new AppImage is downloaded next to the old one, checked and swapped in;
//   .deb/.rpm  the new package is downloaded, checked and installed with the system's password
//              prompt (pkexec), or opened in the software centre;
//   then "Restart now". Downloads are checked against the release's checksums.
// A private repository needs a GitHub token that may read it (kept in updates.json, readable
// only by this user, never shown to the pages, and sent to GitHub's API only).
import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { compareVersions, expectedHash, installCommand, installKind, parseChecksums, pickAsset, releaseInfo } from './update-logic.mjs';

const FIRST_CHECK_MS = 30_000;
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
const CHECK_TIMEOUT_MS = 30_000;
const STALL_MS = 60_000;
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;
const TOKEN_RE = /^[A-Za-z0-9_]{20,255}$/;
const SELF_UPDATING = ['appimage', 'deb', 'rpm'];

/** A failed request as the host reads it. */
function friendly(e) {
  if (e?.name === 'TimeoutError') return 'GitHub didn’t answer in time — try again later.';
  const text = `${e?.message || e} ${e?.cause?.code || ''} ${e?.cause?.message || ''}`;
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|ENETUNREACH|EHOSTUNREACH|EAI_AGAIN|ETIMEDOUT|UND_ERR/i.test(text)) return 'GitHub can’t be reached — is the internet connected?';
  return e?.message || String(e);
}

const has = (cmd) => spawnSync('sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore' }).status === 0;

export class Updater extends EventEmitter {
  /**
   * @param {object} o
   * @param {string} o.repo "owner/name"
   * @param {string} o.version this app's version
   * @param {boolean} o.packaged
   * @param {string} o.configFile where autoCheck and the token are kept
   * @param {string} o.downloadDir where .deb/.rpm files go
   * @param {typeof fetch} o.fetch Node's fetch (see get(): redirects are followed here)
   * @param {string} [o.api] GitHub's API (a stand-in in the tests)
   * @param {object} [o.env]
   * @param {string} [o.execPath] the running program (whose package it is decides how to update)
   * @param {(file: string) => Promise<unknown>} [o.openPath] opens a file with its usual app
   * @param {string} [o.kind] how this copy was installed (found out when not given; the tests set it)
   * @param {(cmd: string) => boolean} [o.has] whether a program exists (the tests pretend)
   */
  constructor({ repo, version, packaged, configFile, downloadDir, fetch, api = 'https://api.github.com', env = process.env, arch = process.arch, execPath = process.execPath, log, openPath, kind, has: hasCmd = has }) {
    super();
    this.repo = repo;
    this.version = version;
    this.configFile = configFile;
    this.downloadDir = downloadDir;
    this.fetch = fetch;
    this.api = api.replace(/\/+$/, '');
    this.env = env;
    this.arch = arch;
    this.log = log;
    this.openPath = openPath;
    this.has = hasCmd;
    this.kind = kind || installKind({ env, packaged, execPath, run: (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8', timeout: 5000 }) });
    this.config = { autoCheck: true, token: '' };
    try {
      const saved = JSON.parse(fs.readFileSync(configFile, 'utf8'));
      if (typeof saved?.autoCheck === 'boolean') this.config.autoCheck = saved.autoCheck;
      if (typeof saved?.token === 'string' && TOKEN_RE.test(saved.token)) this.config.token = saved.token;
    } catch { /* first start */ }
    this.release = null;
    this.timers = [];
    this.state = { status: 'idle', version, kind: this.kind, latest: null, progress: 0, error: null, checkedAt: null, needsToken: false };
  }

  /** What the host page may see (never the token). */
  publicState() {
    return { ...this.state, autoCheck: this.config.autoCheck, hasToken: !!this.config.token, repo: this.repo };
  }

  set(patch) {
    Object.assign(this.state, patch);
    this.emit('state', this.publicState());
  }

  start() {
    this.timers.push(setTimeout(() => this.config.autoCheck && this.check({ quiet: true }), FIRST_CHECK_MS));
    this.timers.push(setInterval(() => this.config.autoCheck && this.check({ quiet: true }), CHECK_EVERY_MS));
  }

  stop() {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }

  busy() {
    return ['checking', 'downloading', 'installing'].includes(this.state.status);
  }

  async saveConfig() {
    const tmp = `${this.configFile}.tmp`;
    await fsp.mkdir(path.dirname(this.configFile), { recursive: true });
    await fsp.writeFile(tmp, JSON.stringify(this.config), { mode: 0o600 });
    await fsp.rename(tmp, this.configFile);
  }

  async setAutoCheck(on) {
    this.config.autoCheck = !!on;
    await this.saveConfig();
    this.set({});
    return this.publicState();
  }

  /** A token that may read a private repository; '' removes it. Checks again with it. */
  async setToken(token) {
    const t = String(token || '').trim();
    if (t && !TOKEN_RE.test(t)) throw new Error('That doesn’t look like a GitHub token.');
    this.config.token = t;
    await this.saveConfig();
    return this.check();
  }

  isApi(url) {
    try {
      return new URL(url).origin === new URL(this.api).origin;
    } catch {
      return false;
    }
  }

  headers(accept, url) {
    const h = { Accept: accept, 'User-Agent': `OpenKaraoke/${this.version}` };
    if (this.isApi(url)) {
      h['X-GitHub-Api-Version'] = '2022-11-28';
      if (this.config.token) h.Authorization = `Bearer ${this.config.token}`;
    }
    return h;
  }

  /**
   * GET, following redirects here: the token goes to GitHub's API only, never on to where a
   * download is sent (GitHub's file storage, which refuses a second kind of authorisation), and
   * never from https to http.
   */
  async get(url, accept, signal) {
    let next = url;
    for (let hop = 0; hop < 6; hop++) {
      const res = await this.fetch(next, { headers: this.headers(accept, next), redirect: 'manual', signal });
      const to = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
      if (!to) return res;
      await res.body?.cancel().catch(() => {});
      const target = new URL(to, next);
      if (target.protocol !== 'https:' && new URL(next).protocol === 'https:') throw new Error('GitHub sent the download somewhere unsafe, so it was stopped.');
      next = target.href;
    }
    throw new Error('GitHub sent the download around in circles, so it was stopped.');
  }

  /** The URL of a release file: through the API with a token (a private repository), else the public link. */
  assetUrl(asset) {
    return this.config.token && asset.url ? asset.url : asset.browser_download_url;
  }

  async check({ quiet = false } = {}) {
    if (this.busy()) return this.publicState();
    // A finished update waits for its restart: no need to look again.
    if (this.state.status === 'ready') return this.publicState();
    this.set({ status: 'checking', error: null });
    try {
      const res = await this.get(`${this.api}/repos/${this.repo}/releases/latest`, 'application/vnd.github+json', AbortSignal.timeout(CHECK_TIMEOUT_MS));
      if (res.status === 404) {
        await res.body?.cancel().catch(() => {});
        this.set({
          status: 'unavailable',
          checkedAt: Date.now(),
          needsToken: true,
          error: this.config.token
            ? 'No release found: the repository has none yet, or the token can’t read it.'
            : 'No releases to check: the repository is private (add a token below) or has none yet.',
        });
        return this.publicState();
      }
      if (res.status === 401) {
        this.set({ needsToken: true });
        throw new Error('GitHub refused the token: check it, or remove it.');
      }
      if (res.status === 403 || res.status === 429) throw new Error('GitHub asks to wait a little before checking again.');
      if (!res.ok) throw new Error(`GitHub answered ${res.status}.`);
      const release = await res.json().catch(() => null);
      if (!release) throw new Error('GitHub’s answer couldn’t be read.');
      const latest = releaseInfo(release);
      if (!latest) throw new Error('The latest release has no version number.');
      this.release = release;
      const newer = compareVersions(latest.version, this.version) > 0;
      this.set({ status: newer ? 'available' : 'current', latest, checkedAt: Date.now(), needsToken: false });
      if (newer) this.log?.info(`update available: ${latest.version} (this is ${this.version})`);
    } catch (e) {
      this.set({ status: 'unavailable', checkedAt: Date.now(), error: friendly(e) });
      if (!quiet) this.log?.warn('update check failed', e.message || e);
    }
    return this.publicState();
  }

  /** Downloads `asset` to `file` (via file.part), checking its sha256; reports progress. */
  async download(asset, file, hash) {
    const part = `${file}.part`;
    // Stopped when nothing arrives for a minute (a slow connection is fine, a dead one isn't).
    const stall = new AbortController();
    let stallTimer = null;
    const alive = () => {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => stall.abort(new Error('The download stopped arriving: try again later.')), STALL_MS);
    };
    alive();
    let reader = null;
    const out = fs.createWriteStream(part, { mode: 0o644 });
    let failure = null;
    out.on('error', (e) => { failure = e; });
    const drained = () => new Promise((resolve) => {
      if (out.destroyed) return resolve();
      const done = () => {
        out.off('drain', done);
        out.off('close', done);
        resolve();
      };
      out.on('drain', done);
      out.on('close', done);
    });
    try {
      const res = await this.get(this.assetUrl(asset), 'application/octet-stream', stall.signal);
      if (!res.ok || !res.body) throw new Error(`The download failed (GitHub answered ${res.status}).`);
      const total = Number(res.headers.get('content-length')) || asset.size || 0;
      const sha = crypto.createHash('sha256');
      let got = 0;
      let lastReport = 0;
      reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (failure) throw failure;
        if (done) break;
        alive();
        sha.update(value);
        got += value.length;
        if (!out.write(value)) await drained();
        if (total && Date.now() - lastReport > 250) {
          lastReport = Date.now();
          this.set({ progress: Math.min(0.99, got / total) });
        }
      }
      if (failure) throw failure;
      await new Promise((resolve, reject) => out.end((e) => (e ? reject(e) : resolve())));
      if (failure) throw failure;
      if (sha.digest('hex') !== hash) throw new Error('The download doesn’t match its checksum, so it was not installed. Try again later.');
      await fsp.rename(part, file);
    } catch (e) {
      await reader?.cancel().catch(() => {});
      await new Promise((resolve) => {
        if (out.closed) return resolve();
        out.once('close', resolve);
        out.destroy(); // waits for the file to be open, so that it can't appear after the rm
      });
      await fsp.rm(part, { force: true });
      throw stall.signal.aborted && stall.signal.reason instanceof Error ? stall.signal.reason : e;
    } finally {
      clearTimeout(stallTimer);
    }
  }

  /** Runs the package manager through pkexec; resolves to { code, stderr }. */
  runInstaller(cmd) {
    return new Promise((resolve) => {
      const child = spawn(cmd[0], cmd.slice(1), { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      const timer = setTimeout(() => {
        stderr += '\nIt took more than 10 minutes, so it was stopped.';
        child.kill();
      }, INSTALL_TIMEOUT_MS);
      child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-2000); });
      child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, stderr: e.message }); });
      child.on('close', (code) => { clearTimeout(timer); resolve({ code, stderr }); });
    });
  }

  /** Downloads and installs the available update; afterwards a restart finishes it. */
  async install() {
    if (this.state.status !== 'available' || !this.release) return this.publicState();
    const kind = this.kind;
    if (!SELF_UPDATING.includes(kind)) {
      this.set({ error: kind === 'source' ? 'This copy runs from the source code: update it with git pull.' : 'This copy can’t update itself: download the new version from the release page.' });
      return this.publicState();
    }
    const asset = pickAsset(this.release.assets, kind, this.arch);
    if (!asset) {
      this.set({ error: `This release has no ${kind === 'appimage' ? 'AppImage' : `.${kind}`} file for this computer.` });
      return this.publicState();
    }
    this.set({ status: 'downloading', progress: 0, error: null });
    try {
      const sumsAsset = (this.release.assets || []).find((a) => a?.name === 'SHA256SUMS');
      let sums = null;
      if (sumsAsset) {
        const res = await this.get(this.assetUrl(sumsAsset), 'application/octet-stream', AbortSignal.timeout(CHECK_TIMEOUT_MS));
        if (res.ok) sums = parseChecksums(await res.text());
        else await res.body?.cancel().catch(() => {});
      }
      const hash = expectedHash(asset, sums);
      if (!hash) throw new Error('This release has no checksum for its file, so it was not installed.');

      if (kind === 'appimage') {
        // Next to the running AppImage, then swapped in at once: the menu entry and any
        // shortcut keep working, and the running copy carries on until the restart.
        const target = this.env.APPIMAGE;
        const dir = path.dirname(target);
        try {
          await fsp.access(dir, fs.constants.W_OK);
        } catch {
          throw new Error(`OpenKaraoke can’t replace its AppImage in ${dir} (no permission there): download the new one from the release page.`);
        }
        const file = path.join(dir, `.${path.basename(target)}.update`);
        await this.download(asset, file, hash);
        await fsp.chmod(file, 0o755);
        await fsp.rename(file, target);
        this.log?.info(`updated the AppImage to ${this.state.latest?.version}`);
        this.set({ status: 'ready', progress: 1 });
        return this.publicState();
      }

      await fsp.mkdir(this.downloadDir, { recursive: true });
      const file = path.join(this.downloadDir, path.basename(asset.name));
      await this.download(asset, file, hash);
      const inSoftwareCentre = async () => {
        await this.openPath?.(file);
        this.set({ status: 'available', progress: 0, error: `The new version is in ${file} and opened in your software centre: install it there, then restart OpenKaraoke.` });
        return this.publicState();
      };
      const cmd = installCommand(kind, file, this.has);
      if (!cmd) return await inSoftwareCentre();
      this.set({ status: 'installing', progress: 1 });
      const { code, stderr } = await this.runInstaller(cmd);
      // pkexec: 126 = the password prompt was dismissed, 127 = not authorised or no prompt available.
      if ((code === 126 || code === 127) && /authentication agent|no agent/i.test(stderr)) return await inSoftwareCentre();
      if (code === 126 || code === 127) {
        this.set({ status: 'available', progress: 0, error: 'The installation was cancelled.' });
        return this.publicState();
      }
      if (code !== 0) throw new Error(`The installation failed: ${String(stderr || '').trim().split('\n').slice(-2).join(' ') || `exit ${code}`}`);
      await fsp.rm(file, { force: true });
      this.log?.info(`installed ${asset.name}`);
      this.set({ status: 'ready', progress: 1 });
    } catch (e) {
      this.log?.warn('update failed', e.message || e);
      this.set({ status: 'available', progress: 0, error: friendly(e) });
    }
    return this.publicState();
  }
}
