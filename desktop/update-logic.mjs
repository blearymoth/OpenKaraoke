// The desktop app's updates, the parts that need no Electron (tested in test/desktop.test.js):
// comparing versions, finding this install's file in a GitHub release, checksums, and how a
// .deb or .rpm is installed.

/** [major, minor, patch] of "v1.2.3", "1.2.3-beta" or "1.2.3+build"; null when it isn't one. */
export function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(v || '').trim());
  return m ? { parts: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] || '' } : null;
}

/** < 0 when a is older than b, 0 when the same, > 0 when newer (a pre-release is older than its release). */
export function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return 0;
  for (let i = 0; i < 3; i++) if (x.parts[i] !== y.parts[i]) return x.parts[i] - y.parts[i];
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre < y.pre ? -1 : 1;
}

const DEB_ARCH = { x64: 'amd64', arm64: 'arm64' };
const RPM_ARCH = { x64: 'x86_64', arm64: 'aarch64' };

/** The release asset this install needs: the AppImage, or the .deb / .rpm for this machine. */
export function pickAsset(assets, kind, arch = 'x64') {
  const list = (Array.isArray(assets) ? assets : []).filter((a) => typeof a?.name === 'string');
  if (kind === 'appimage') {
    const own = arch === 'x64' ? (n) => !/(arm64|aarch64)/i.test(n) : (n) => /(arm64|aarch64)/i.test(n);
    return list.find((a) => /\.AppImage$/.test(a.name) && own(a.name)) || null;
  }
  if (kind === 'deb') return list.find((a) => a.name.endsWith(`_${DEB_ARCH[arch]}.deb`)) || null;
  if (kind === 'rpm') return list.find((a) => a.name.endsWith(`.${RPM_ARCH[arch]}.rpm`)) || null;
  return null;
}

/** "sha256  file" lines (sha256sum's output) → Map of file name → lower-case hash. */
export function parseChecksums(text) {
  const sums = new Map();
  for (const line of String(text || '').split('\n')) {
    const m = /^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$/.exec(line);
    if (m) sums.set(m[2], m[1].toLowerCase());
  }
  return sums;
}

/**
 * The sha256 an asset must have: GitHub's own `digest` ("sha256:…", computed when it was uploaded)
 * and the release's SHA256SUMS (written by the release workflow). Null when neither has it, or
 * when the two disagree.
 */
export function expectedHash(asset, sums) {
  const fromSums = sums?.get(asset.name) || null;
  const m = /^sha256:([0-9a-f]{64})$/i.exec(asset.digest || '');
  const fromGitHub = m ? m[1].toLowerCase() : null;
  if (fromSums && fromGitHub && fromSums !== fromGitHub) return null;
  return fromGitHub || fromSums;
}

/**
 * How this copy of the app was installed: 'appimage' ($APPIMAGE is set by the AppImage
 * runtime), 'deb' or 'rpm' (that package manager owns the running program, e.g.
 * /opt/OpenKaraoke/openkaraoke), 'source' (not packaged: a git checkout, updated with
 * `git pull`), else 'unknown' (e.g. the unpacked build in desktop/dist).
 * `run(cmd, args)` → { status, stdout } (child_process.spawnSync).
 */
export function installKind({ env = {}, packaged, execPath = '', run }) {
  if (env.APPIMAGE) return 'appimage';
  if (!packaged) return 'source';
  const out = (cmd, args) => {
    try {
      const r = run(cmd, args);
      return r && r.status === 0 ? String(r.stdout || '').trim() : null;
    } catch {
      return null;
    }
  };
  if (!execPath) return 'unknown';
  if (/^openkaraoke:/m.test(out('dpkg-query', ['-S', execPath]) || '')) return 'deb';
  if (out('rpm', ['-qf', '--queryformat', '%{NAME}', execPath]) === 'openkaraoke') return 'rpm';
  return 'unknown';
}

/**
 * The command that installs a downloaded package with the system's password prompt (pkexec,
 * polkit), or null when there is no way (then the file is opened in the software centre).
 * `has(cmd)` tells whether a program exists.
 */
export function installCommand(kind, file, has) {
  if (!has('pkexec')) return null;
  if (kind === 'deb') {
    if (has('apt-get')) return ['pkexec', 'apt-get', 'install', '-y', '--allow-downgrades', file];
    if (has('dpkg')) return ['pkexec', 'dpkg', '-i', file];
  }
  if (kind === 'rpm') {
    if (has('dnf')) return ['pkexec', 'dnf', 'install', '-y', file];
    if (has('zypper')) return ['pkexec', 'zypper', '--non-interactive', 'install', '--allow-unsigned-rpm', file];
    if (has('rpm')) return ['pkexec', 'rpm', '-U', '--replacepkgs', file];
  }
  return null;
}

/**
 * The command that removes the installed .deb or .rpm with the system's password prompt
 * (Settings → About → Uninstall), or null when there is no way (then the software centre does it).
 */
export function removeCommand(kind, has) {
  if (!has('pkexec')) return null;
  if (kind === 'deb') {
    if (has('apt-get')) return ['pkexec', 'apt-get', 'remove', '-y', 'openkaraoke'];
    if (has('dpkg')) return ['pkexec', 'dpkg', '--remove', 'openkaraoke'];
  }
  if (kind === 'rpm') {
    if (has('dnf')) return ['pkexec', 'dnf', 'remove', '-y', 'openkaraoke'];
    if (has('zypper')) return ['pkexec', 'zypper', '--non-interactive', 'remove', 'openkaraoke'];
    if (has('rpm')) return ['pkexec', 'rpm', '-e', 'openkaraoke'];
  }
  return null;
}

/** A release from the GitHub API as the app shows it. */
export function releaseInfo(release) {
  if (!release || typeof release !== 'object') return null;
  const version = String(release.tag_name || '').replace(/^v/, '');
  if (!parseVersion(version)) return null;
  return {
    version,
    name: String(release.name || `OpenKaraoke ${version}`).slice(0, 200),
    notes: String(release.body || '').slice(0, 20_000),
    url: String(release.html_url || ''),
    publishedAt: release.published_at || null,
  };
}
