// Request handling for the sync API, independent of where blobs live. The Vercel functions in
// api/*.js use a Vercel Blob backend (./vercel-backend.js); tests/server.mjs uses an in-memory one.
//
// Routes (every request needs the header  x-family-code: <code>):
//   GET    /api/state                      -> the family's sync doc (see js/syncdoc.js)
//   PUT    /api/state        JSON core doc -> stored, returns the merged doc (including this push)
//   DELETE /api/state        header x-confirm: erase-everything -> deletes all recordings and state
//   GET    /api/recording?id=<sound>       -> audio bytes
//   PUT    /api/recording?id=<sound>       body: audio bytes; headers x-updated-at, x-duration-ms, x-trimmed
//   DELETE /api/recording?id=<sound>
//
// Storage layout: append-only. No request ever overwrites or conditionally writes a blob, so there
// is nothing to conflict on and nothing can be read stale (a pathname always has the same bytes).
//   recordings/<id>/<updatedAt>-<durationMs>-<t|u>-<rand>.<ext>   one blob per uploaded version;
//                                        the highest (updatedAt, pathname) wins, older ones are
//                                        deleted by the next GET /api/state.
//   state/push/<time>-<rand>.json      one blob per PUT /api/state (the sanitised core doc)
//   state/snap/<time>-<rand>.json      a compaction: everything merged from the blobs it replaced
// The state is the merge (js/syncdoc.js mergeDocs: unions by id, last writer wins) of every state
// blob, so any number of them merge in any order to the same result. When there are more than
// COMPACT_OVER, a request writes a new snapshot and then deletes exactly the blobs it read into it,
// so concurrent compactions are safe (their snapshots are merged later like any other blob).
//
// Cost: on the Hobby plan Blob allows 2,000 "advanced" operations (puts and lists) a month, so only
// GET /api/state lists. Each PUT is a single put, GET /api/recording reads the version the state
// named (reads of immutable blobs are cached), and deletes are free.
//
// Legacy layout (before append-only): state/family.json (mutable, with recording metadata and
// paths) and recordings/<id>/<updatedAt>-<hex>. The first request that sees them copies them into
// the new layout, then deletes the copied originals (see migrate()).
//
// Backend interface (pathnames are relative to the family's data prefix):
//   list(prefix) -> [{ pathname, size }]
//   put(path, buffer, contentType)   create only; throws { exists: true } if the path exists
//   get(path) -> { body: Buffer, contentType } | null
//   del(paths[])

import crypto from 'node:crypto';
import { emptyDoc, mergeDocs, sanitiseCore, normaliseCode, coreOf, canon } from '../../js/syncdoc.js';

export const LEGACY_STATE_PATH = 'state/family.json';
export const MAX_RECORDING_BYTES = 2 * 1024 * 1024;
export const MAX_STATE_BYTES = 512 * 1024;
export const COMPACT_OVER = 20;
const AUDIO_TYPES = /^audio\/(wav|wave|x-wav|mp4|x-m4a|aac|webm|ogg|mpeg)(;.*)?$/i;

const REC_RE = /^recordings\/([^/]+)\/(\d+)-(\d+)-([tu])-([0-9a-z]+)\.([a-z0-9]+)$/;
const LEGACY_REC_RE = /^recordings\/([^/]+)\/(\d+)-([0-9a-f]+)$/;
const STATE_RE = /^state\/(push|snap)\/(\d+)-([0-9a-z-]+)\.json$/;

const EXT_MIME = { wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac', webm: 'audio/webm', ogg: 'audio/ogg', mp3: 'audio/mpeg' };
const MIME_EXT = { wav: 'wav', wave: 'wav', 'x-wav': 'wav', mp4: 'm4a', 'x-m4a': 'm4a', aac: 'aac', webm: 'webm', ogg: 'ogg', mpeg: 'mp3' };

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function digest(s) { return crypto.createHash('sha256').update(s).digest(); }
const rand = () => crypto.randomBytes(6).toString('hex');
const stamp = () => String(Date.now()).padStart(13, '0');

/** Constant-time check of the request's family code against the configured one. */
export function codeMatches(given, expected) {
  const a = digest(normaliseCode(given));
  const b = digest(normaliseCode(expected));
  return crypto.timingSafeEqual(a, b) && normaliseCode(expected).length > 0;
}

/** Puts every path of a backend under a prefix such as "test-abc/" (empty: unchanged). */
export function withPrefix(backend, prefix) {
  if (!prefix) return backend;
  if (!/^[A-Za-z0-9_-]+\/$/.test(prefix)) throw new Error('bad data prefix');
  return {
    async list(p) { return (await backend.list(prefix + (p || ''))).map((b) => ({ ...b, pathname: b.pathname.slice(prefix.length) })); },
    put: (p, body, type) => backend.put(prefix + p, body, type),
    get: (p) => backend.get(prefix + p),
    del: (paths) => backend.del(paths.map((p) => prefix + p)),
  };
}

/** Audio type from a content type header ("audio/wav; codecs=1" -> { mime, ext }) or null. */
function audioType(contentType) {
  const m = /^audio\/([a-z0-9-]+)/i.exec(String(contentType || '').trim());
  const ext = m && MIME_EXT[m[1].toLowerCase()];
  return ext ? { mime: EXT_MIME[ext], ext } : null;
}

export function recordingPath(id, { updatedAt, durationMs, trimmed, ext }, suffix = rand()) {
  return `recordings/${id}/${updatedAt}-${Math.round(durationMs) || 0}-${trimmed ? 't' : 'u'}-${suffix}.${ext}`;
}

/** Metadata encoded in a recording pathname, or null if it is not one. */
export function parseRecordingPath(pathname) {
  const m = REC_RE.exec(pathname);
  if (!m || !EXT_MIME[m[6]]) return null;
  return { id: m[1], updatedAt: Number(m[2]), durationMs: Number(m[3]), trimmed: m[4] === 't', mime: EXT_MIME[m[6]], path: pathname };
}

/** a before b: older updatedAt first, then pathname. The greatest version of a sound wins. */
/** The file name of a version ("<updatedAt>-...<ext>"), handed to clients to fetch it directly. */
const versionName = (path) => path.slice(path.lastIndexOf('/') + 1);

const versionLess = (a, b) => a.updatedAt < b.updatedAt || (a.updatedAt === b.updatedAt && a.path < b.path);

/** Duration of a PCM WAV file in ms, or null if it is not one. */
function wavDurationMs(buf) {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null;
  let byteRate = 0;
  for (let p = 12; p + 8 <= buf.length;) {
    const tag = buf.toString('ascii', p, p + 4);
    const size = buf.readUInt32LE(p + 4);
    if (tag === 'fmt ' && p + 16 <= buf.length) byteRate = buf.readUInt32LE(p + 16);
    if (tag === 'data') return byteRate ? Math.round((Math.min(size, buf.length - p - 8) / byteRate) * 1000) : null;
    p += 8 + size + (size % 2);
  }
  return null;
}

function send(res, status, body, headers = {}) {
  if (res.headersSent || res.writableEnded) return;
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
    recordings[id] = { updatedAt: r.updatedAt, mime: r.mime, durationMs: r.durationMs, trimmed: r.trimmed, size: r.size, version: r.path ? versionName(r.path) : r.version };
  }
  return { ...d, recordings };
}

/**
 * familyCode: the expected code, or a function returning it (the test server can change it).
 * deadlineMs: a request that takes longer answers 503 at once, so clients retry instead of hanging.
 */
export function makeApi({ backend, familyCode, validIds, deadlineMs = 9000, log = console }) {
  /** All versions of each sound's recording in a listing: { id: [version, ...] }, oldest first. */
  function versionsOf(items) {
    const out = {};
    for (const it of items) {
      const v = parseRecordingPath(it.pathname);
      if (!v || !validIds.has(v.id)) continue;
      v.size = it.size;
      (out[v.id] ||= []).push(v);
    }
    for (const list of Object.values(out)) list.sort((a, b) => (versionLess(a, b) ? -1 : versionLess(b, a) ? 1 : 0));
    return out;
  }

  function recordingsOf(items) {
    const recordings = {};
    for (const [id, list] of Object.entries(versionsOf(items))) recordings[id] = list[list.length - 1];
    return recordings;
  }

  /** Create-only put that treats "already there" as done (used for deterministic migration paths). */
  async function putOnce(path, body, type) {
    try { await backend.put(path, body, type); } catch (e) { if (!e || !e.exists) throw e; }
  }

  /** Deletes versions of a sound older than the newest one it knows of. Never the newest. */
  async function pruneOlder(list, newest) {
    const old = list.filter((v) => versionLess(v, newest)).map((v) => v.path);
    if (old.length) await backend.del(old).catch((e) => log.error('prune failed', e && e.message));
    return old;
  }

  /**
   * Copies legacy blobs into the append-only layout, then deletes the originals that were copied.
   * Safe to run in several requests at once: the new paths are deterministic and create-only, and
   * nothing is deleted before its copy exists. Returns the listing after the changes.
   */
  async function migrate(items) {
    const hasLegacyState = items.some((it) => it.pathname === LEGACY_STATE_PATH);
    const legacyRecs = items.filter((it) => LEGACY_REC_RE.test(it.pathname));
    let fam = null;
    if (hasLegacyState) {
      const got = await backend.get(LEGACY_STATE_PATH);
      // Gone since the listing: another request migrated it. Its copies are in place by now.
      if (!got) return backend.list('');
      try { fam = { raw: got.body, doc: JSON.parse(got.body.toString('utf8')) }; } catch { log.error('unreadable legacy state'); }
    }
    const metaByPath = new Map();
    for (const r of Object.values((fam && fam.doc.recordings) || {})) if (r && r.path) metaByPath.set(r.path, r);

    const created = [];
    const copied = [];
    await Promise.all(legacyRecs.map(async (it) => {
      const [, id, ts, hex] = LEGACY_REC_RE.exec(it.pathname);
      if (!validIds.has(id)) return; // not ours to interpret: left alone
      const got = await backend.get(it.pathname);
      if (!got) return;
      const meta = metaByPath.get(it.pathname);
      const type = audioType((meta && meta.mime) || got.contentType) || audioType('audio/wav');
      const v = {
        updatedAt: Number(ts),
        durationMs: meta ? Number(meta.durationMs) || 0 : wavDurationMs(got.body) || 0,
        trimmed: meta ? !!meta.trimmed : false,
        ext: type.ext,
      };
      const path = recordingPath(id, v, hex);
      await putOnce(path, got.body, type.mime);
      created.push({ pathname: path, size: got.body.length });
      copied.push(it.pathname);
    }));

    const deleted = [...copied];
    if (fam) {
      const core = sanitiseCore(fam.doc, validIds);
      const snap = `state/snap/0000000000000-legacy-${digest(fam.raw).toString('hex').slice(0, 12)}.json`;
      await putOnce(snap, Buffer.from(JSON.stringify(core)), 'application/json');
      created.push({ pathname: snap, size: 0 });
      // family.json holds the metadata of its recordings, so it goes only once they are all copied.
      const pending = [...metaByPath.keys()].filter((p) => legacyRecs.some((it) => it.pathname === p) && !copied.includes(p));
      if (!pending.length) deleted.push(LEGACY_STATE_PATH);
    }
    if (deleted.length) await backend.del(deleted);
    log.info?.('migrated legacy blobs', { copied: copied.length, deleted: deleted.length });
    let next = [...items.filter((it) => !deleted.includes(it.pathname)), ...created];
    // Several legacy copies of the same version (an upload retried): keep the greatest only.
    const versions = versionsOf(next);
    const pruned = [];
    for (const list of Object.values(versions)) pruned.push(...await pruneOlder(list, list[list.length - 1]));
    next = next.filter((it) => !pruned.includes(it.pathname));
    return next;
  }

  /** The family's listing, migrated to the append-only layout. */
  async function listing() {
    const items = await backend.list('');
    const legacy = (it) => it.pathname === LEGACY_STATE_PATH || (LEGACY_REC_RE.test(it.pathname) && validIds.has(LEGACY_REC_RE.exec(it.pathname)[1]));
    if (items.some(legacy)) return migrate(items);
    return items;
  }

  /** Reads and merges every state blob in the listing. A blob deleted meanwhile is re-listed once. */
  async function readState(items) {
    const docs = new Map(); // pathname -> core doc
    let stateItems = items.filter((it) => STATE_RE.test(it.pathname));
    for (let pass = 0; pass < 2; pass++) {
      let missing = false;
      await Promise.all(stateItems.filter((it) => !docs.has(it.pathname)).map(async (it) => {
        const got = await backend.get(it.pathname);
        if (!got) { missing = true; return; }
        try { docs.set(it.pathname, sanitiseCore(JSON.parse(got.body.toString('utf8')), validIds)); } catch { log.error('unreadable state blob', it.pathname); }
      }));
      if (!missing) break;
      // Compacted by another request: its snapshot holds the content, so list again.
      stateItems = (await backend.list('state/')).filter((it) => STATE_RE.test(it.pathname));
    }
    let doc = emptyDoc();
    for (const d of docs.values()) doc = mergeDocs(doc, d);
    return { doc: coreOf(doc), included: [...docs.keys()] };
  }

  /** Replaces many state blobs with one snapshot. Only the blobs merged into it are deleted. */
  async function compact(state) {
    if (state.included.length <= COMPACT_OVER) return;
    try {
      await backend.put(`state/snap/${stamp()}-${rand()}.json`, Buffer.from(JSON.stringify(state.doc)), 'application/json');
      await backend.del(state.included);
    } catch (e) { log.error('compaction failed', e && e.message); }
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

  /** Deletes superseded recording versions (deletes cost nothing). Returns the listing without them. */
  async function pruneAll(items) {
    const gone = [];
    for (const list of Object.values(versionsOf(items))) gone.push(...await pruneOlder(list, list[list.length - 1]));
    return gone.length ? items.filter((it) => !gone.includes(it.pathname)) : items;
  }

  async function state(req, res) {
    if (req.method === 'GET') {
      const items = await pruneAll(await listing());
      const st = await readState(items);
      await compact(st);
      const empty = !st.included.length && !Object.keys(recordingsOf(items)).length;
      send(res, 200, { ...publicDoc({ ...st.doc, recordings: recordingsOf(items) }), empty });
      return;
    }
    if (req.method === 'PUT') {
      let input;
      try { input = JSON.parse((await readBody(req, MAX_STATE_BYTES)).toString('utf8')); } catch (e) { throw e.status ? e : new HttpError(400, 'bad json'); }
      const core = sanitiseCore(input, validIds);
      // One put and nothing else: no listing, nothing read back. The answer is what was stored
      // (the client merges it into what it has; the next GET merges it with everything else).
      await backend.put(`state/push/${stamp()}-${rand()}.json`, Buffer.from(JSON.stringify(core)), 'application/json');
      send(res, 200, publicDoc(core));
      return;
    }
    if (req.method === 'DELETE') {
      if (req.headers['x-confirm'] !== 'erase-everything') throw new HttpError(400, 'confirm');
      const paths = (await backend.list('')).map((it) => it.pathname);
      if (paths.length) await backend.del(paths);
      send(res, 200, { deleted: paths.length });
      return;
    }
    throw new HttpError(405, 'method');
  }

  async function recording(req, res, url) {
    const id = soundId(url);
    if (req.method === 'GET') {
      // The version named by GET /api/state is read directly (no listing). Without one, or if it was
      // replaced meanwhile, the sound's versions are listed.
      const v = url.searchParams.get('v');
      const named = v ? parseRecordingPath(`recordings/${id}/${v}`) : null;
      const candidates = named ? [async () => named] : [];
      candidates.push(async () => {
        let items = await backend.list(`recordings/${id}/`);
        if (items.some((it) => LEGACY_REC_RE.test(it.pathname))) items = await listing(); // not migrated yet
        const list = versionsOf(items)[id];
        return list && list[list.length - 1];
      });
      for (const next of candidates) {
        const meta = await next();
        if (!meta) continue;
        const got = await backend.get(meta.path);
        if (!got) continue;
        send(res, 200, got.body, {
          'content-type': meta.mime,
          'x-updated-at': String(meta.updatedAt),
          'x-duration-ms': String(meta.durationMs),
          'x-trimmed': meta.trimmed ? '1' : '0',
          'cache-control': 'private, no-store',
        });
        return;
      }
      send(res, 404, { error: 'not found' });
      return;
    }
    if (req.method === 'PUT') {
      const type = audioType(req.headers['content-type']);
      if (!AUDIO_TYPES.test(String(req.headers['content-type'] || '')) || !type) throw new HttpError(415, 'not audio');
      const updatedAt = Number(req.headers['x-updated-at']);
      if (!Number.isInteger(updatedAt) || updatedAt <= 0) throw new HttpError(400, 'updated-at');
      const durationMs = Math.round(Math.max(0, Math.min(60000, Number(req.headers['x-duration-ms']) || 0)));
      const trimmed = req.headers['x-trimmed'] === '1';
      const body = await readBody(req, MAX_RECORDING_BYTES);
      if (body.length < 44) throw new HttpError(400, 'empty');
      // One put. An older upload never replaces a newer one: the newest version wins when read,
      // and the superseded ones are deleted by the next GET /api/state.
      const path = recordingPath(id, { updatedAt, durationMs, trimmed, ext: type.ext });
      await backend.put(path, body, type.mime);
      const meta = { updatedAt, mime: type.mime, durationMs, trimmed, size: body.length, path };
      send(res, 200, { stored: true, recording: publicDoc({ recordings: { [id]: meta } }).recordings[id] });
      return;
    }
    if (req.method === 'DELETE') {
      await listing(); // migrates first, so a legacy copy cannot come back
      const paths = (await backend.list(`recordings/${id}/`)).map((it) => it.pathname);
      if (paths.length) await backend.del(paths);
      send(res, 200, { deleted: paths.length });
      return;
    }
    throw new HttpError(405, 'method');
  }

  const routes = { state, recording };

  /** The merged doc as GET /api/state would give it, or null when the store is empty (tests). */
  async function readDoc() {
    const items = await pruneAll(await listing());
    const st = await readState(items);
    const recordings = recordingsOf(items);
    if (!st.included.length && !Object.keys(recordings).length) return null;
    return publicDoc({ ...st.doc, recordings });
  }

  /** Node-style (req, res) handler for one route. */
  function handle(route) {
    return async (req, res) => {
      let timer;
      try {
        if (!expectedCode()) { send(res, 503, null); return; }
        if (!authorised(req)) { send(res, 401, null); return; }
        const url = new URL(req.url, 'http://local');
        const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new HttpError(503, 'timeout')), deadlineMs); });
        await Promise.race([routes[route](req, res, url), deadline]);
      } catch (e) {
        if (e instanceof HttpError) {
          if (e.status === 503) log.error('api timeout', route, req.method);
          send(res, e.status, { error: e.message });
          return;
        }
        log.error('api error', route, e && e.name, e && e.message);
        send(res, 500, { error: 'server' });
      } finally {
        clearTimeout(timer);
      }
    };
  }
  handle.readDoc = readDoc;
  return handle;
}
