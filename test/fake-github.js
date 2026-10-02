// A stand-in for GitHub's releases (test/desktop.test.js and the desktop app's end-to-end test).
import crypto from 'node:crypto';
import http from 'node:http';

export const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** An HTTP server on 127.0.0.1 (a free port): { url, close }. */
export async function serve(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => server.close(resolve)) };
}

/**
 * GitHub's API (one origin) and its file storage (another, as on GitHub) for the repository
 * `repo`: release files are fetched from the API (with a token) or the public link, and both
 * redirect to the storage. `token` makes the repository private: without it the API answers 404,
 * as GitHub does.
 */
export async function fakeGitHub({ repo = 'o/r', token = null } = {}) {
  const files = new Map();
  const seen = [];
  let latest = null;
  const storage = await serve((req, res) => {
    seen.push({ at: 'storage', url: req.url, auth: req.headers.authorization || null });
    const body = files.get(decodeURIComponent(req.url.replace(/^\/blob\//, '')));
    if (!body) {
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': body.length });
    res.end(body);
  });
  const api = await serve((req, res) => {
    const auth = req.headers.authorization || null;
    seen.push({ at: 'api', url: req.url, auth });
    const allowed = !token || auth === `Bearer ${token}`;
    if (req.url === `/repos/${repo}/releases/latest`) {
      if (!allowed || !latest) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end('{"message":"Not Found"}');
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(latest));
    }
    const asset = (req.url.startsWith(`/repos/${repo}/releases/assets/`) && /\/assets\/(.+)$/.exec(req.url)) || (!token && /^\/download\/(.+)$/.exec(req.url));
    if (asset && allowed && files.has(decodeURIComponent(asset[1]))) {
      res.writeHead(302, { Location: `${storage.url}/blob/${asset[1]}` });
      return res.end();
    }
    res.writeHead(404);
    res.end();
  });
  return {
    api: api.url,
    seen,
    files,
    /** A new latest release with these files (name → Buffer), SHA256SUMS and GitHub's digests. */
    publish(version, assets, { sums = true, digests = false, wrongSum = null } = {}) {
      files.clear();
      for (const [name, body] of Object.entries(assets)) files.set(name, body);
      if (sums) files.set('SHA256SUMS', Buffer.from(Object.entries(assets).map(([n, b]) => `${n === wrongSum ? '0'.repeat(64) : sha256(b)}  ${n}\n`).join('')));
      latest = {
        tag_name: `v${version}`,
        name: `OpenKaraoke ${version}`,
        body: '## What’s changed\n* Faster search',
        html_url: `https://github.com/${repo}/releases/tag/v${version}`,
        published_at: '2026-10-01T10:00:00Z',
        assets: [...files].map(([name, body]) => ({
          name,
          size: body.length,
          url: `${api.url}/repos/${repo}/releases/assets/${encodeURIComponent(name)}`,
          browser_download_url: `${api.url}/download/${encodeURIComponent(name)}`,
          ...(digests ? { digest: `sha256:${sha256(body)}` } : {}),
        })),
      };
    },
    close: async () => {
      await api.close();
      await storage.close();
    },
  };
}
