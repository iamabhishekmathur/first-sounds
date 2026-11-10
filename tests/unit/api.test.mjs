// The API request handling (api/_lib/core.js) through the local test server and its in-memory store.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../server.mjs';
import { encodeWav } from '../../js/audio.js';

const CODE = 'otter-maple-drum-07';
let srv;
let base;
before(async () => { srv = await startServer(0, { familyCode: CODE }); base = `http://127.0.0.1:${srv.port}/api/`; });
after(() => srv.server.close());

const call = (path, { code = CODE, ...init } = {}) => fetch(base + path, { ...init, headers: { ...(code ? { 'x-family-code': code } : {}), ...(init.headers || {}) } });
const wav = (secs = 0.3) => Buffer.from(encodeWav(new Float32Array(24000 * secs).fill(0.1), 24000));
const putRec = (id, body, updatedAt, extra = {}) => call(`recording?id=${id}`, {
  method: 'PUT', body, headers: { 'content-type': 'audio/wav', 'x-updated-at': String(updatedAt), 'x-duration-ms': '300', 'x-trimmed': '1', ...extra },
});

test('requests without the right code get a bare 401', async () => {
  for (const [path, code] of [['state', null], ['state', 'wrong-words-here-00'], ['recording?id=m', null], ['state', '']]) {
    const res = await call(path, { code });
    assert.equal(res.status, 401, `${path} ${code}`);
    assert.equal(await res.text(), '');
  }
  assert.equal((await call('state', { code: ' Otter Maple Drum 07 ' })).status, 200, 'case and spacing do not matter');
});

test('state: empty at first, then every put is merged into it', async () => {
  await call('state', { method: 'DELETE', headers: { 'x-confirm': 'erase-everything' } });
  let s = await (await call('state')).json();
  assert.equal(s.empty, true);
  const put = (body) => call('state', { method: 'PUT', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }).then((r) => r.json());
  await put({ progress: { s1: { m: [{ c: 1, d: '2026-11-10', id: 'a', t: 1 }] } } });
  s = await put({ progress: { s1: { m: [{ c: 0, d: '2026-11-10', id: 'b', t: 2 }], nope: [{ c: 1, d: 'x', id: 'z', t: 1 }] } } });
  assert.deepEqual(s.progress.s1.m.map((x) => x.id), ['b'], 'a put answers with what it stored');
  assert.equal(s.progress.s1.nope, undefined, 'unknown sound ids are dropped');
  s = await (await call('state')).json();
  assert.deepEqual(s.progress.s1.m.map((x) => x.id), ['a', 'b'], 'second device did not overwrite the first');
  // Concurrent puts from many devices: all rounds survive.
  await Promise.all(Array.from({ length: 8 }, (_, i) => put({ progress: { s1: { s: [{ c: 1, d: '2026-11-10', id: `p${i}`, t: 10 + i }] } } })));
  s = await (await call('state')).json();
  assert.equal(s.progress.s1.s.length, 8);
  assert.equal(s.empty, false);
  const bad = await call('state', { method: 'PUT', body: '{not json', headers: { 'content-type': 'application/json' } });
  assert.equal(bad.status, 400);
  const big = await call('state', { method: 'PUT', body: 'x'.repeat(600 * 1024), headers: { 'content-type': 'application/json' } });
  assert.equal(big.status, 413);
});

test('recordings: validated, last writer wins, older uploads never replace newer ones', async () => {
  assert.equal((await putRec('nope', wav(), 5)).status, 400, 'unknown sound id');
  assert.equal((await putRec('m', Buffer.alloc(2 * 1024 * 1024 + 1, 1), 5)).status, 413, 'over 2 MB');
  assert.equal((await putRec('m', wav(), 5, { 'content-type': 'text/html' })).status, 415);
  assert.equal((await putRec('m', wav(), 'soon')).status, 400);

  const first = wav(0.3);
  let out = await (await putRec('m', first, 1000)).json();
  assert.equal(out.stored, true);
  const newer = wav(0.5);
  out = await (await putRec('m', newer, 2000)).json();
  assert.equal(out.stored, true);
  out = await (await putRec('m', first, 1500)).json();
  assert.equal(out.recording.updatedAt, 1500, 'an older upload is stored as its own version');
  const got = await call('recording?id=m');
  assert.equal(got.status, 200);
  assert.equal(got.headers.get('content-type'), 'audio/wav');
  assert.equal(got.headers.get('x-updated-at'), '2000');
  assert.deepEqual(Buffer.from(await got.arrayBuffer()), newer);
  const s = await (await call('state')).json();
  assert.equal(s.recordings.m.updatedAt, 2000, 'but never replaces the newer one');
  assert.equal(s.recordings.m.path, undefined, 'storage paths are not handed out');
  const blobs = [...srv.api.backend.blobs.keys()].filter((k) => k.startsWith('recordings/m/'));
  assert.equal(blobs.length, 1, 'the superseded versions were deleted');
  // The version named in the state is read directly; a bad or stale name falls back to the newest.
  for (const v of [s.recordings.m.version, '../../state/x', '1-1-t-0.wav']) {
    const r = await call(`recording?id=m&v=${encodeURIComponent(v)}`);
    assert.equal(r.headers.get('x-updated-at'), '2000', v);
  }

  assert.equal((await call('recording?id=s')).status, 404);
  assert.equal((await call('recording?id=m', { method: 'DELETE' })).status, 200);
  assert.equal((await call('recording?id=m')).status, 404);
});

test('erase everything needs an explicit confirmation header', async () => {
  await putRec('s', wav(), 10);
  assert.equal((await call('state', { method: 'DELETE' })).status, 400);
  const res = await call('state', { method: 'DELETE', headers: { 'x-confirm': 'erase-everything' } });
  assert.equal(res.status, 200);
  assert.equal(srv.api.backend.blobs.size, 0);
  assert.equal((await (await call('state')).json()).empty, true);
});

test('state: accepts old documents (no sessions, no wrong taps) and new ones, and merges both', async () => {
  await call('state', { method: 'DELETE', headers: { 'x-confirm': 'erase-everything' } });
  // A blob written by the previous version of the server (before sessions existed).
  const oldBlob = { settings: { speakWords: true, roundsPerSession: 6 }, settingsAt: 1, progress: { s1: { m: [{ c: 1, d: '2026-11-01', id: 'old1', t: 1 }] }, s2: {} }, resetAt: 0, readiness: [{ id: 'rq', at: 1, d: '2026-11-01', correct: true }] };
  await srv.api.backend.put('state/push/0000000000001-oldver.json', Buffer.from(JSON.stringify(oldBlob)), 'application/json');
  const put = (body) => call('state', { method: 'PUT', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
  // An old client's push: still accepted.
  let res = await put({ progress: { s1: { s: [{ c: 0, d: '2026-11-02', id: 'old2', t: 2 }] } } });
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).sessions, []);
  // A new client's push with a session and wrong taps.
  const session = { id: 'S1', d: '2026-11-10', start: 100, end: 400100, stages: [1], rounds: 2, correct: 1 };
  const round = { c: 0, d: '2026-11-10', id: 'new1', t: 200, ses: 'S1', wrong: [{ w: 'nose', s: 'n' }, { w: 'cup' }] };
  res = await put({ progress: { s1: { m: [round] } }, sessions: [session] });
  const stored = await res.json();
  assert.deepEqual(stored.sessions, [session], 'a put answers with the session it stored, unchanged');
  assert.deepEqual(stored.progress.s1.m, [round]);
  const s = await (await call('state')).json();
  assert.deepEqual(s.progress.s1.m.map((x) => x.id), ['old1', 'new1']);
  assert.deepEqual(s.progress.s1.m[0], oldBlob.progress.s1.m[0], 'old rounds read back exactly');
  assert.deepEqual(s.progress.s1.m[1], round);
  assert.deepEqual(s.progress.s1.s.map((x) => x.id), ['old2']);
  assert.deepEqual(s.sessions, [session]);
  assert.deepEqual(s.readiness, oldBlob.readiness);
  // The session grows on the device: the version with more rounds wins on the server.
  await put({ sessions: [{ ...session, rounds: 5, correct: 4, end: 900000 }] });
  const s2 = await (await call('state')).json();
  assert.equal(s2.sessions.length, 1);
  assert.equal(s2.sessions[0].rounds, 5);
});
