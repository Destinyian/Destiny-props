// Zero-dependency static server for this effect's demo page.
//   node serve.mjs      ->  http://127.0.0.1:4179
// ES modules cannot load over file://, so the demo needs a server.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const port = Number(process.env.PORT || 4179);
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith('/')) rel += 'index.html';
    const file = normalize(join(root, rel));
    const base = root.endsWith(sep) ? root : root + sep;
    if (!file.startsWith(base)) {                     // no path traversal
      res.writeHead(403).end('forbidden');
      return;
    }
    if (!(await stat(file)).isFile()) { res.writeHead(404).end('not found'); return; }
    const body = await readFile(file);
    res.writeHead(200, {
      'content-type': TYPES[extname(file).toLowerCase()] || 'application/octet-stream',
      // a stale cached engine keeps looking like "my edit did not take effect"
      'cache-control': 'no-store',
      'content-length': body.length,
    });
    res.end(body);
  } catch (e) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found');
  }
}).listen(port, '127.0.0.1', () => {
  console.log(`重力文字演示： http://127.0.0.1:${port}`);
});
