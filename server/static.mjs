// Serve the client captured at server startup. Reading edited files on each request
// paired new UI code with an older in-memory API and broke otherwise valid actions.
// One process owns one client snapshot; restarting publishes both sides together.

import fs from 'node:fs';
import path from 'node:path';

const MIME = new Map(
  Object.entries({
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.map': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.mp4': 'video/mp4',
    '.wav': 'audio/wav',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.txt': 'text/plain; charset=utf-8',
    '.md': 'text/markdown; charset=utf-8',
    '.wasm': 'application/wasm',
  }),
);

const PLACEHOLDER = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Studio — server running</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 16px/1.6 ui-sans-serif, system-ui, sans-serif; max-width: 42rem; margin: 4rem auto; padding: 0 1.5rem; }
  code { background: rgba(127,127,127,.18); padding: .1em .35em; border-radius: .25em; }
  ul { padding-left: 1.2rem; }
</style>
</head>
<body>
  <h1>Studio server is running</h1>
  <p>The API is up, but there is no client yet — <code>studio/web/</code> does not exist
     (or has no <code>index.html</code>). The server does not create it.</p>
  <p>The API is answering right now:</p>
  <ul>
    <li><a href="/api/health">/api/health</a></li>
    <li><a href="/api/problems">/api/problems</a></li>
    <li><a href="/api/problems/two-sum">/api/problems/two-sum</a></li>
  </ul>
</body>
</html>
`;

export class StaticSite {
  constructor(webDir) {
    this.webDir = webDir;
    this.files = new Map();
    try {
      this.rootReal = fs.realpathSync(webDir);
    } catch {
      this.rootReal = null;
    }
    if (this.rootReal) {
      const inside = real => real === this.rootReal || real.startsWith(this.rootReal + path.sep);
      const capture = (directory, ancestors = new Set()) => {
        const realDirectory = fs.realpathSync(directory);
        if (!inside(realDirectory) || ancestors.has(realDirectory)) return;
        const visited = new Set([...ancestors, realDirectory]);
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
          const file = path.join(directory, entry.name);
          let real, stat;
          try { real = fs.realpathSync(file); if (!inside(real)) continue; stat = fs.statSync(real); }
          catch (error) { if (error.code === 'ENOENT') continue; throw error; }
          if (stat.isDirectory()) capture(file, visited);
          else if (stat.isFile()) this.files.set(file, fs.readFileSync(real));
        }
      };
      capture(this.rootReal);
    }
  }

  get available() {
    return this.rootReal !== null;
  }

  /** Resolve only files in the contained startup snapshot, including directory indexes. */
  async resolve(urlPath) {
    if (this.rootReal === null) return null;
    let decoded;
    try {
      decoded = decodeURIComponent(urlPath);
    } catch {
      return null;
    }
    if (decoded.includes('\0')) return null;

    const rel = decoded.replace(/^\/+/, '');
    const candidate = path.resolve(this.rootReal, rel === '' ? 'index.html' : rel);

    if (this.files.has(candidate)) return candidate;
    const index = path.join(candidate, 'index.html');
    return this.files.has(index) ? index : null;
  }

  async serve(req, res, urlPath) {
    let file = await this.resolve(urlPath);

    // SPA fallback: extensionless paths fall back to index.html so client routing works.
    if (file === null && path.extname(urlPath) === '') {
      file = await this.resolve('/index.html');
    }

    if (file === null) {
      if (!this.available || (await this.resolve('/index.html')) === null) {
        const body = Buffer.from(PLACEHOLDER, 'utf8');
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'content-length': body.length,
          'cache-control': 'no-store',
        });
        res.end(req.method === 'HEAD' ? undefined : body);
        return;
      }
      const body = Buffer.from('Not found\n', 'utf8');
      res.writeHead(404, {
        'content-type': 'text/plain; charset=utf-8',
        'content-length': body.length,
      });
      res.end(req.method === 'HEAD' ? undefined : body);
      return;
    }

    const data = this.files.get(file);

    res.writeHead(200, {
      'content-type': MIME.get(path.extname(file).toLowerCase()) ?? 'application/octet-stream',
      'content-length': data.length,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  }
}
