// Request handling for the sync API, independent of where blobs live. The Vercel functions in
// api/*.js use a Vercel Blob backend (./vercel-backend.js); tests/server.mjs uses an in-memory one.
//
// Routes (every request needs the header  x-family-code: <code>):
//   GET    /api/state                      -> the family's sync doc (see js/syncdoc.js)
//   PUT    /api/state        JSON core doc -> merged on the server, returns the merged doc
//   DELETE /api/state        header x-confirm: erase-everything -> deletes all recordings and state
//   GET    /api/recording?id=<sound>       -> audio bytes
//   PUT    /api/recording?id=<sound>       body: audio bytes; headers x-updated-at, x-duration-ms, x-trimmed
//   DELETE /api/recording?id=<sound>
//
// Backend interface:
//   readJSON(path) -> { value, etag } | null
//   writeJSON(path, value, { etag }) -> throws { conflict: true } if etag no longer matches
//                                       (etag null: create only; throws conflict if it exists)
//   putBytes(path, buffer, contentType); getBytes(path) -> { body: Buffer, contentType } | null
//   del(paths[]); list(prefix) -> [pathname]

import crypto from 'node:crypto';
import { emptyDoc, mergeDocs, sanitiseCore, normaliseCode } from '../../js/syncdoc.js';

export const STATE_PATH = 'state/family.json';
export const MAX_RECORDING_BYTES = 2 * 1024 * 1024;
export const MAX_STATE_BYTES = 512 * 1024;
const AUDIO_TYPES = /^audio\/(wav|wave|x-wav|mp4|x-m4a|aac|webm|ogg|mpeg)(;.*)?$/i;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function digest(s) { return crypto.createHash('sha256').update(s).digest(); }

/** Constant-time check of the request's family code against the configured one. */
export function codeMatches(given, expected) {
  const a = digest(normaliseCode(given));
  const b = digest(normaliseCode(expected));
  return crypto.timingSafeEqual(a, b) && normaliseCode(expected).length > 0;
}

function send(res, status, body, headers = {}) {
  const isBuf = Buffer.isBuffer(body);
  const payload = body == null ? '' : isBuf ? body : JSON.stringify(body);
  res.writeHead(status, {
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...(body == null ? {} : { 'content-type': isBuf ? 'application/octet-stream' : 'application/json; charset=utf-8' }),
    ...headers,
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function readBody(req, max) {
  if (req.readableEnded && req.body != null) {
    const b = Buffer.isBuffer(req.body) ? req.body : Buffer.from(typeof req.body === 'string' ? req.body : JSON.stringify(req.body));
    if (b.length > max) throw new HttpError(413, 'too large');
    return b;
  }
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > max) throw new HttpError(413, 'too large');
  const chunks = [];
  let n = 0;
  for await (const c of req) {
    n += c.length;
    if (n > max) throw new HttpError(413, 'too large');
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

function publicDoc(doc) {
  const d = mergeDocs(doc, emptyDoc());
  const recordings = {};
  for (const [id, r] of Object.entries(d.recordings)) {
    recordings[id] = { updatedAt: r.updatedAt, mime: r.mime, durationMs: r.durationMs, trimmed: r.trimmed, size: r.size };
  }
  return { ...d, recordings };
}

/** familyCode: the expected code, or a function returning it (the test server can change it). */
export function makeApi({ backend, familyCode, validIds }) {
  async function load() {
    const got = await backend.readJSON(STATE_PATH);
    return got ? { doc: got.value, etag: got.etag } : { doc: null, etag: null };
  }

  /** Read, change, write with an etag check; retried when another request wrote in between. */
  async function update(change) {
    for (let attempt = 0; attempt < 8; attempt++) {
      const { doc, etag } = await load();
      const next = await change(doc || emptyDoc());
      if (next == null) return doc || emptyDoc();
      try {
        await backend.writeJSON(STATE_PATH, next, { etag });
        return next;
      } catch (e) {
        if (!e || !e.conflict) throw e;
        await new Promise((r) => setTimeout(r, 30 + Math.random() * 120 * (attempt + 1)));
      }
    }
    throw new HttpError(409, 'busy');
  }

  function soundId(url) {
    const id = url.searchParams.get('id') || '';
    if (!validIds.has(id)) throw new HttpError(400, 'unknown sound');
    return id;
  }

  const expectedCode = () => (typeof familyCode === 'function' ? familyCode() : familyCode);

  function authorised(req) {
    const given = req.headers['x-family-code'];
    const expected = expectedCode();
    if (!expected || typeof given !== 'string' || given.length > 200) return false;
    return codeMatches(given, expected);
  }

  async function state(req, res, url) {
    if (req.method === 'GET') {
      const { doc } = await load();
      send(res, 200, { ...publicDoc(doc), empty: !doc });
      return;
    }
    if (req.method === 'PUT') {
      let input;
      try { input = JSON.parse((await readBody(req, MAX_STATE_BYTES)).toString('utf8')); } catch (e) { throw e.status ? e : new HttpError(400, 'bad json'); }
      const core = sanitiseCore(input, validIds);
      const saved = await update((cur) => {
        const merged = mergeDocs(cur, { ...core, recordings: {} });
        merged.recordings = cur.recordings || {};
        return merged;
      });
      send(res, 200, publicDoc(saved));
      return;
    }
    if (req.method === 'DELETE') {
      if (req.headers['x-confirm'] !== 'erase-everything') throw new HttpError(400, 'confirm');
      const paths = await backend.list('');
      if (paths.length) await backend.del(paths);
      send(res, 200, { deleted: paths.length });
      return;
    }
    throw new HttpError(405, 'method');
  }

  async function recording(req, res, url) {
    const id = soundId(url);
    if (req.method === 'GET') {
      const { doc } = await load();
      const meta = doc && doc.recordings && doc.recordings[id];
      const got = meta && await backend.getBytes(meta.path);
      if (!got) { send(res, 404, { error: 'not found' }); return; }
      send(res, 200, got.body, {
        'content-type': meta.mime,
        'x-updated-at': String(meta.updatedAt),
        'x-duration-ms': String(meta.durationMs),
        'x-trimmed': meta.trimmed ? '1' : '0',
        'cache-control': 'private, no-store',
      });
      return;
    }
    if (req.method === 'PUT') {
      const mime = String(req.headers['content-type'] || '');
      if (!AUDIO_TYPES.test(mime)) throw new HttpError(415, 'not audio');
      const updatedAt = Number(req.headers['x-updated-at']);
      if (!Number.isFinite(updatedAt) || updatedAt <= 0) throw new HttpError(400, 'updated-at');
      const durationMs = Math.max(0, Math.min(60000, Number(req.headers['x-duration-ms']) || 0));
      const trimmed = req.headers['x-trimmed'] === '1';
      const body = await readBody(req, MAX_RECORDING_BYTES);
      if (body.length < 44) throw new HttpError(400, 'empty');

      const { doc } = await load();
      const existing = doc && doc.recordings && doc.recordings[id];
      if (existing && existing.updatedAt >= updatedAt) { send(res, 200, { stored: false, recording: publicDoc(doc).recordings[id] }); return; }

      // Each version gets its own path, so a slow older upload can never overwrite a newer one.
      const path = `recordings/${id}/${updatedAt}-${crypto.randomBytes(6).toString('hex')}`;
      await backend.putBytes(path, body, mime.split(';')[0].trim());
      const meta = { updatedAt, mime: mime.split(';')[0].trim(), durationMs, trimmed, size: body.length, path };
      let replaced = null;
      let won = false;
      const saved = await update((cur) => {
        const prev = cur.recordings && cur.recordings[id];
        if (prev && prev.updatedAt >= updatedAt) { won = false; return null; }
        won = true;
        replaced = prev ? prev.path : null;
        return { ...cur, recordings: { ...(cur.recordings || {}), [id]: meta } };
      });
      if (!won) await backend.del([path]).catch(() => {});
      else if (replaced && replaced !== path) await backend.del([replaced]).catch(() => {});
      send(res, 200, { stored: won, recording: publicDoc(saved).recordings[id] });
      return;
    }
    if (req.method === 'DELETE') {
      let removed = null;
      await update((cur) => {
        const prev = cur.recordings && cur.recordings[id];
        if (!prev) return null;
        removed = prev.path;
        const recordings = { ...cur.recordings };
        delete recordings[id];
        return { ...cur, recordings };
      });
      const leftovers = await backend.list(`recordings/${id}/`);
      const paths = [...new Set([removed, ...leftovers].filter(Boolean))];
      if (paths.length) await backend.del(paths);
      send(res, 200, { deleted: paths.length });
      return;
    }
    throw new HttpError(405, 'method');
  }

  const routes = { state, recording };

  /** Node-style (req, res) handler for one route. */
  return function handle(route) {
    return async (req, res) => {
      try {
        if (!expectedCode()) { send(res, 503, null); return; }
        if (!authorised(req)) { send(res, 401, null); return; }
        const url = new URL(req.url, 'http://local');
        await routes[route](req, res, url);
      } catch (e) {
        if (e instanceof HttpError) { send(res, e.status, { error: e.message }); return; }
        console.error('api error', route, e && e.name, e && e.message);
        send(res, 500, { error: 'server' });
      }
    };
  };
}

