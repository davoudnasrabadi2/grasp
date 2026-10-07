/*
 * Grasp — local dashboard server. Serves the same dashboard as demo.html, with the
 * dataset injected in place of the demo data. Binds to 127.0.0.1 only.
 */

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const FILES = {
  '/demo.html': ['demo.html', 'text/html; charset=utf-8'],
  '/assets/css/style.css': ['assets/css/style.css', 'text/css; charset=utf-8'],
  '/assets/css/dashboard.css': ['assets/css/dashboard.css', 'text/css; charset=utf-8'],
  '/assets/js/signals.js': ['assets/js/signals.js', 'text/javascript; charset=utf-8'],
  '/assets/js/demo.js': ['assets/js/demo.js', 'text/javascript; charset=utf-8']
};

export function dataScript(data) {
  return 'window.GRASP_DEMO = ' + JSON.stringify(data).replace(/</g, '\\u003c') + ';\n';
}

export async function serveDashboard(data, { port = 4517, host = '127.0.0.1' } = {}) {
  const script = dataScript(data);
  const server = http.createServer(async (req, res) => {
    let path = (req.url || '/').split('?')[0];
    if (path === '/' || path === '/index.html') path = '/demo.html';
    if (path === '/assets/data/demo-data.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(script);
    }
    const hit = FILES[path];
    if (!hit) { res.writeHead(404); return res.end('not found'); }
    try {
      const body = await readFile(join(ROOT, hit[0]));
      res.writeHead(200, { 'Content-Type': hit[1], 'Cache-Control': 'no-store' });
      res.end(body);
    } catch {
      res.writeHead(500); res.end('read error');
    }
  });

  for (let p = port; p < port + 20; p++) {
    const ok = await new Promise(resolve => {
      server.once('error', () => resolve(false));
      server.listen(p, host, () => resolve(true));
    });
    if (ok) return { server, url: `http://${host === '127.0.0.1' ? 'localhost' : host}:${p}/` };
  }
  throw new Error(`No free port in ${port}–${port + 19}. Pass --port=<n>.`);
}

export function openBrowser(url) {
  const [cmd, args] =
    process.platform === 'darwin' ? ['open', [url]] :
    process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] :
    ['xdg-open', [url]];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  } catch { /* no browser available: the URL is printed anyway */ }
}
