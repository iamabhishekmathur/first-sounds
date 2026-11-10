// The append-only blob layout (api/_lib/core.js): many rapid writes, compaction (also two at once),
// an eventually consistent listing, and migration from the legacy state/family.json layout.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { startServer } from '../server.mjs';
import { encodeWav } from '../../js/audio.js';
import { COMPACT_OVER, LEGACY_STATE_PATH, withPrefix, makeApi } from '../../api/_lib/core.js';
import { memoryBackend } from '../../api/_lib/memory-backend.js';

const CODE = 'heron-candle-plum-55';
const IDS = JSON.parse(readFileSync(new URL('../../data/sounds.json', import.meta.url), 'utf8')).sounds.map((x) => x.id).slice(0, 20);

async function server(backendOptions = {}) {
  const srv = await startServer(0, { familyCode: CODE, backendOptions });
  const base = `http://127.0.0.1:${srv.port}/api/`;
  const call = (path, init = {}) => fetch(base + path, { ...init, headers: { 'x-family-code': CODE, ...(init.headers || {}) } });
  return {
    srv, call, close: () => srv.server.close(), blobs: srv.api.backend.blobs, backend: srv.api.backend,
    putState: (body) => call('state', { method: 'PUT', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
    putRec: (id, body, updatedAt, durationMs = 300) => call(`recording?id=${id}`, {
      method: 'PUT', body, headers: { 'content-type': 'audio/wav', 'x-updated-at': String(updatedAt), 'x-duration-ms': String(durationMs), 'x-trimmed': '1' },
    }),
    getState: () => call('state').then((r) => r.json()),
  };
}

const wav = (secs, level = 0.1) => Buffer.from(encodeWav(new Float32Array(Math.round(24000 * secs)).fill(level), 24000));
const round = (id, t) => ({ c: 1, d: '2026-11-10', id, t });
const paths = (blobs, prefix) => [...blobs.keys()].filter((k) => k.startsWith(prefix)).sort();
const roundIds = (doc) => Object.values(doc.progress.s1).flat().map((r) => r.id).sort();

test('20 recordings and 20 state pushes at once: all succeed quickly and nothing is lost', async () => {
  const s = await server({ latencyMs: 40, listLagMs: 150 });
  try {
    const t0 = Date.now();
    const recs = IDS.map((id, i) => s.putRec(id, wav(0.2 + i / 100), 1000 + i, 200 + i));
    const pushes = IDS.map((id, i) => s.putState({ progress: { s1: { [id]: [round(`r${i}`, 10 + i)] } }, readiness: [{ id: `q${i}`, at: 100 + i }] }));
    const answers = await Promise.all([...recs, ...pushes]);
    assert.deepEqual(answers.map((r) => r.status), Array(40).fill(200));
    assert.ok(Date.now() - t0 < 5000, `took ${Date.now() - t0} ms`);
    // Each PUT /api/state answer includes its own push, even though the listing lags behind.
    const bodies = await Promise.all(answers.slice(20).map((r) => r.json()));
    bodies.forEach((b, i) => assert.ok(b.progress.s1[IDS[i]].some((r) => r.id === `r${i}`), `push ${i} in its own answer`));

    await new Promise((r) => setTimeout(r, 200)); // the listing catches up
    const doc = await s.getState();
    assert.equal(Object.keys(doc.recordings).length, 20);
    IDS.forEach((id, i) => assert.deepEqual(
      { updatedAt: doc.recordings[id].updatedAt, durationMs: doc.recordings[id].durationMs, trimmed: doc.recordings[id].trimmed, mime: doc.recordings[id].mime },
      { updatedAt: 1000 + i, durationMs: 200 + i, trimmed: true, mime: 'audio/wav' },
    ));
    assert.deepEqual(roundIds(doc), IDS.map((_, i) => `r${i}`).sort());
    assert.equal(doc.readiness.length, 20);
    const got = await s.call(`recording?id=${IDS[19]}`);
    assert.deepEqual(Buffer.from(await got.arrayBuffer()), wav(0.2 + 19 / 100));
    // Nothing was ever overwritten: every blob path is immutable and the old layout is not used.
    assert.ok(!s.blobs.has(LEGACY_STATE_PATH));
    assert.ok(paths(s.blobs, 'state/').length <= COMPACT_OVER + 1, 'compacted');
  } finally { s.close(); }
});

test('repeated uploads of one sound: newest wins and older versions are removed', async () => {
  const s = await server({ latencyMs: 20 });
  try {
    const answers = await Promise.all([3000, 1000, 2000, 3000].map((t, i) => s.putRec('m', wav(0.1 + i / 10), t)));
    assert.deepEqual(answers.map((r) => r.status), [200, 200, 200, 200]);
    const doc = await s.getState();
    assert.equal(doc.recordings.m.updatedAt, 3000);
    // Racing uploads can leave a stale version until the next upload of that sound tidies it up.
    assert.equal((await (await s.putRec('m', wav(0.6), 4000)).json()).stored, true);
    assert.deepEqual(paths(s.blobs, 'recordings/m/').length, 1);
    assert.match(paths(s.blobs, 'recordings/m/')[0], /^recordings\/m\/4000-300-t-[0-9a-f]+\.wav$/);
    assert.equal((await (await s.putRec('m', wav(0.2), 3500)).json()).stored, false, 'older refused');
  } finally { s.close(); }
});

test('compaction keeps every round, and two compactions at once are safe', async () => {
  const s = await server({ latencyMs: 30 });
  try {
    for (let i = 0; i < COMPACT_OVER + 5; i++) {
      s.backend.seed(`state/push/${String(1000 + i).padStart(13, '0')}-x${i}.json`, JSON.stringify({ progress: { s1: { [IDS[i % 20]]: [round(`c${i}`, i + 1)] } } }), 'application/json');
    }
    // Two requests both see too many blobs, both write a snapshot and both delete what they read.
    const [a, b] = await Promise.all([s.getState(), s.getState()]);
    assert.deepEqual(roundIds(a), roundIds(b));
    assert.equal(roundIds(a).length, COMPACT_OVER + 5);
    const state = paths(s.blobs, 'state/');
    assert.ok(state.length <= 2 && state.every((p) => p.startsWith('state/snap/')), state.join(' '));
    assert.equal(roundIds(await s.getState()).length, COMPACT_OVER + 5);

    // Compaction while new pushes keep arriving: nothing pushed meanwhile is lost.
    for (let i = 0; i < COMPACT_OVER; i++) s.backend.seed(`state/push/0000000002000-y${i}.json`, JSON.stringify({ readiness: [{ id: `y${i}`, at: i }] }), 'application/json');
    const more = Array.from({ length: 10 }, (_, i) => s.putState({ readiness: [{ id: `z${i}`, at: 50 + i }] }));
    const reads = [s.getState(), s.getState(), s.getState()];
    assert.deepEqual((await Promise.all(more)).map((r) => r.status), Array(10).fill(200));
    await Promise.all(reads);
    const doc = await s.getState();
    assert.equal(doc.readiness.length, COMPACT_OVER + 10);
    assert.equal(roundIds(doc).length, COMPACT_OVER + 5);
    assert.ok(paths(s.blobs, 'state/').length <= COMPACT_OVER);
  } finally { s.close(); }
});

test('a push that adds nothing stores nothing', async () => {
  const s = await server();
  try {
    await s.putState({ progress: { s1: { m: [round('a', 1)] } } });
    const before = paths(s.blobs, 'state/');
    await s.putState({ progress: { s1: { m: [round('a', 1)] } } });
    assert.deepEqual(paths(s.blobs, 'state/'), before);
  } finally { s.close(); }
});

/** The layout the previous version wrote: family.json with metadata and paths, plus old recordings. */
function seedLegacy(backend, bytes) {
  const fam = {
    settings: { speakWords: false, roundsPerSession: 8 }, settingsAt: 50,
    progress: { s1: { m: [round('old1', 5)] }, s2: {} }, resetAt: 0, readiness: [{ id: 'rq', at: 7 }],
    recordings: {
      m: { updatedAt: 1794337720014, mime: 'audio/wav', durationMs: 850, trimmed: true, size: bytes.m.length, path: 'recordings/m/1794337720014-2f819f2d8d76' },
      s: { updatedAt: 1794337733863, mime: 'audio/wav', durationMs: 3160, trimmed: true, size: bytes.s.length, path: 'recordings/s/1794337733863-dfdd4c95c57e' },
    },
  };
  backend.seed(LEGACY_STATE_PATH, JSON.stringify(fam), 'application/json');
  backend.seed('recordings/m/1794337720014-2f819f2d8d76', bytes.m, 'audio/wav');
  backend.seed('recordings/s/1794337733863-dfdd4c95c57e', bytes.s, 'audio/wav');
  // An upload whose metadata write timed out (twice): its blob exists but family.json lacks it.
  backend.seed('recordings/n/1794337763934-1ccd5358b9d6', bytes.n, 'audio/wav');
  backend.seed('recordings/n/1794337763934-8a6e7085cf6c', bytes.n, 'audio/wav');
  // Something this code does not know: left alone.
  backend.seed('recordings/zz/1-abc', bytes.n, 'audio/wav');
}

test('legacy family.json and old-path recordings are migrated, then the originals deleted', async () => {
  const s = await server({ latencyMs: 20 });
  const bytes = { m: wav(0.85), s: wav(0.4, 0.2), n: wav(0.5, 0.3) };
  try {
    seedLegacy(s.backend, bytes);
    // Several requests arrive at once right after the deploy: they all migrate, idempotently.
    const [doc, doc2, rec] = await Promise.all([s.getState(), s.getState(), s.call('recording?id=s')]);
    assert.equal(rec.status, 200);
    assert.deepEqual(Buffer.from(await rec.arrayBuffer()), bytes.s);
    for (const d of [doc, doc2]) {
      assert.deepEqual(Object.keys(d.recordings).sort(), ['m', 'n', 's']);
      assert.deepEqual(d.recordings.m, { updatedAt: 1794337720014, mime: 'audio/wav', durationMs: 850, trimmed: true, size: bytes.m.length });
      assert.equal(d.recordings.s.durationMs, 3160);
      assert.equal(d.recordings.n.updatedAt, 1794337763934);
      assert.equal(d.recordings.n.durationMs, 500, 'duration read from the WAV header');
      assert.equal(d.settings.roundsPerSession, 8);
      assert.deepEqual(roundIds(d), ['old1']);
      assert.equal(d.readiness[0].id, 'rq');
    }
    assert.deepEqual(paths(s.blobs, ''), [
      'recordings/m/1794337720014-850-t-2f819f2d8d76.wav',
      'recordings/n/1794337763934-500-u-8a6e7085cf6c.wav',
      'recordings/s/1794337733863-3160-t-dfdd4c95c57e.wav',
      'recordings/zz/1-abc',
      paths(s.blobs, 'state/snap/0000000000000-legacy-')[0],
    ].sort());
    for (const id of ['m', 'n']) {
      const got = await s.call(`recording?id=${id}`);
      assert.deepEqual(Buffer.from(await got.arrayBuffer()), bytes[id]);
    }
    // A device that still has the old version does not re-upload it; a newer one replaces it.
    assert.equal((await (await s.putRec('m', bytes.m, 1794337720014)).json()).stored, false);
    assert.equal((await (await s.putRec('m', wav(0.3), 1794337799999)).json()).stored, true);
    assert.equal(paths(s.blobs, 'recordings/m/').length, 1);
    assert.match(paths(s.blobs, 'recordings/m/')[0], /^recordings\/m\/1794337799999-300-t-[0-9a-f]+\.wav$/);
  } finally { s.close(); }
});

test('every path goes under the data prefix', async () => {
  const mem = memoryBackend();
  const api = makeApi({ backend: withPrefix(mem, 'test-x/'), familyCode: CODE, validIds: new Set(['m']) });
  mem.seed('state/push/0000000000001-a.json', JSON.stringify({ readiness: [{ id: 'prod', at: 1 }] }), 'application/json');
  mem.seed('test-x/state/family.json', JSON.stringify({ readiness: [{ id: 'mine', at: 1 }], recordings: {} }), 'application/json');
  const doc = await api.readDoc();
  assert.deepEqual(doc.readiness.map((r) => r.id), ['mine'], 'only sees its own prefix');
  assert.ok([...mem.blobs.keys()].every((k) => k === 'state/push/0000000000001-a.json' || k.startsWith('test-x/state/snap/')));
  assert.throws(() => withPrefix(mem, '../x'), /prefix/);
});

test('a request that takes too long answers 503 quickly instead of hanging', async () => {
  const srv = await startServer(0, { familyCode: CODE, deadlineMs: 300 });
  try {
    srv.api.backend.list = () => new Promise(() => {}); // the store never answers
    const t0 = Date.now();
    const res = await fetch(`http://127.0.0.1:${srv.port}/api/state`, { headers: { 'x-family-code': CODE } });
    assert.equal(res.status, 503);
    assert.ok(Date.now() - t0 < 2000);
  } finally { srv.server.close(); }
});
