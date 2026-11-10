// Tiny dependency-free static file server for the browser tests (and local use), with a local
// fake of the sync API: the real request handling from api/_lib/core.js on an in-memory store.
// Usage: node tests/server.mjs [port]   (serves the project root; family code from $FAMILY_CODE,
// default "local-test-code-11")
import http from 'node:http';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeApi } from '../api/_lib/core.js';
import { memoryBackend } from '../api/_lib/memory-backend.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png',
};

/**
 * opts.familyCode: code the fake API accepts. opts.dataFile: sound ids it accepts (default: the
 * real data file). opts.backendOptions: knobs for the in-memory store (latencyMs, listLagMs). The
 * returned `api` has the in-memory `backend`, `readDoc()` (the merged server doc), `down` (true:
 * every API request fails with 503), `fail` (optional (req, url) => true: that request fails with 504)
 * and `requests` (a log of method + path).
 */
export function startServer(port = 0, { familyCode = 'local-test-code-11', dataFile = 'data/sounds.json', backendOptions = {}, deadlineMs } = {}) {
  const data = JSON.parse(readFileSync(path.join(ROOT, dataFile), 'utf8'));
  const backend = memoryBackend(backendOptions);
  const api = { backend, down: false, requests: [], familyCode };
  const handle = makeApi({ backend, familyCode: () => api.familyCode, validIds: new Set(data.sounds.map((x) => x.id)), deadlineMs });
  api.readDoc = handle.readDoc; // the merged doc on the server, or null when it is empty
  const routes = { '/api/state': handle('state'), '/api/recording': handle('recording') };
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      if (url.pathname.startsWith('/api/')) {
        api.requests.push(`${req.method} ${url.pathname}${url.search}`);
        const route = routes[url.pathname];
        if (api.down) { res.writeHead(503).end(); return; }
        if (api.fail && api.fail(req, url)) { res.writeHead(504).end(); return; }
        if (!route) { res.writeHead(404).end(); return; }
        await route(req, res);
        return;
      }
      let rel = decodeURIComponent(url.pathname);
      if (rel.endsWith('/')) rel += 'index.html';
      const file = path.resolve(ROOT, `.${rel}`);
      if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
      const body = await fs.readFile(file);
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(body);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
    }
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ server, port: server.address().port, api })));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { port } = await startServer(Number(process.argv[2]) || 8080, { familyCode: process.env.FAMILY_CODE || 'local-test-code-11' });
  console.log(`First Sounds at http://127.0.0.1:${port}/`);
}
