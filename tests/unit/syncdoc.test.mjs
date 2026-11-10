// Merge rules for sync (js/syncdoc.js): nothing is ever lost, and merging is order independent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeDocs, emptyDoc, withIds, sanitiseCore, coreOf, canon, normaliseCode, newId } from '../../js/syncdoc.js';
import { HISTORY_KEEP } from '../../js/logic.js';

const r = (id, t, c = 1, d = '2026-11-10') => ({ c, d, id, t });
const doc = (over) => ({ ...emptyDoc(), ...over });
const ids = (list) => list.map((x) => x.id);

test('rounds: union by id, oldest first, duplicates kept once', () => {
  const a = doc({ progress: { s1: { m: [r('a1', 1), r('x', 3)] }, s2: {} } });
  const b = doc({ progress: { s1: { m: [r('b1', 2), r('x', 3)], s: [r('b2', 5)] }, s2: { m: [r('b3', 4)] } } });
  const m = mergeDocs(a, b);
  assert.deepEqual(ids(m.progress.s1.m), ['a1', 'b1', 'x']);
  assert.deepEqual(ids(m.progress.s1.s), ['b2']);
  assert.deepEqual(ids(m.progress.s2.m), ['b3']);
});

test('merge is commutative, associative and idempotent', () => {
  const a = doc({ progress: { s1: { m: [r('a1', 1), r('a2', 7)] }, s2: {} }, readiness: [{ id: 'ra', at: 3, d: '2026-11-09', correct: true }], settings: { speakWords: false, roundsPerSession: 5 }, settingsAt: 10 });
  const b = doc({ progress: { s1: { m: [r('b1', 2)] }, s2: { t: [r('b2', 4)] } }, readiness: [{ id: 'rb', at: 1 }], settings: { speakWords: true, roundsPerSession: 8 }, settingsAt: 10 });
  const c = doc({ progress: { s1: { m: [r('c1', 5)] }, s2: {} }, resetAt: 0, recordings: { m: { updatedAt: 9, mime: 'audio/wav' } } });
  assert.equal(canon(mergeDocs(a, b)), canon(mergeDocs(b, a)));
  assert.equal(canon(mergeDocs(mergeDocs(a, b), c)), canon(mergeDocs(a, mergeDocs(b, c))));
  const ab = mergeDocs(a, b);
  assert.equal(canon(mergeDocs(ab, ab)), canon(ab));
  assert.equal(canon(mergeDocs(ab, emptyDoc())), canon(ab));
});

test('two devices playing offline: every round from both survives', () => {
  const base = [r('r0', 100)];
  const a = doc({ progress: { s1: { m: [...base, r('a1', 200), r('a2', 300)] }, s2: {} } });
  const b = doc({ progress: { s1: { m: [...base, r('b1', 250)], s: [r('b2', 260, 0)] }, s2: {} } });
  const m = mergeDocs(a, b);
  assert.deepEqual(ids(m.progress.s1.m), ['r0', 'a1', 'b1', 'a2']);
  assert.deepEqual(m.progress.s1.s, [r('b2', 260, 0)]);
});

test('history stays bounded at HISTORY_KEEP, keeping the newest rounds', () => {
  const a = doc({ progress: { s1: { m: Array.from({ length: 10 }, (_, i) => r(`a${i}`, i * 2)) }, s2: {} } });
  const b = doc({ progress: { s1: { m: Array.from({ length: 10 }, (_, i) => r(`b${i}`, i * 2 + 1)) }, s2: {} } });
  const m = mergeDocs(a, b).progress.s1.m;
  assert.equal(m.length, HISTORY_KEEP);
  assert.equal(m.at(-1).id, 'b9');
  assert.equal(m[0].t, 20 - HISTORY_KEEP);
});

test('readiness: union by id, sorted by time', () => {
  const a = doc({ readiness: [{ id: 'x', at: 5, d: '2026-11-10', correct: true }, { id: 'y', at: 1 }] });
  const b = doc({ readiness: [{ id: 'z', at: 3 }, { id: 'x', at: 5, d: '2026-11-10', correct: true }] });
  assert.deepEqual(ids(mergeDocs(a, b).readiness), ['y', 'z', 'x']);
});

test('a reset drops only what was played before it, on every device', () => {
  const a = doc({ progress: { s1: {}, s2: {} }, readiness: [], resetAt: 1000 });
  const b = doc({ progress: { s1: { m: [r('old', 900), r('new', 1100)] }, s2: { m: [r('old2', 500)] } }, readiness: [{ id: 'ro', at: 999 }, { id: 'rn', at: 1001 }] });
  const m = mergeDocs(a, b);
  assert.deepEqual(ids(m.progress.s1.m), ['new']);
  assert.deepEqual(m.progress.s2, {});
  assert.deepEqual(ids(m.readiness), ['rn']);
  assert.equal(m.resetAt, 1000);
});

test('settings: last writer wins; missing settings never win', () => {
  const a = doc({ settings: { speakWords: false, roundsPerSession: 4 }, settingsAt: 200 });
  const b = doc({ settings: { speakWords: true, roundsPerSession: 9 }, settingsAt: 100 });
  assert.deepEqual(mergeDocs(a, b).settings, a.settings);
  assert.deepEqual(mergeDocs(b, a).settings, a.settings);
  assert.equal(mergeDocs(b, a).settingsAt, 200);
  assert.deepEqual(mergeDocs(emptyDoc(), b).settings, b.settings);
  assert.deepEqual(mergeDocs(b, emptyDoc()).settings, b.settings);
});

test('recordings: newest per sound wins, others untouched', () => {
  const a = doc({ recordings: { m: { updatedAt: 5, mime: 'audio/wav', durationMs: 1 }, s: { updatedAt: 1, mime: 'audio/wav' } } });
  const b = doc({ recordings: { m: { updatedAt: 7, mime: 'audio/mp4', durationMs: 2 }, t: { updatedAt: 2, mime: 'audio/wav' } } });
  const m = mergeDocs(a, b).recordings;
  assert.equal(m.m.updatedAt, 7);
  assert.deepEqual(Object.keys(m).sort(), ['m', 's', 't']);
});

test('withIds gives old rounds stable ids and keeps their order', () => {
  const progress = { s1: { m: [{ c: 1, d: '2026-11-08' }, { c: 0, d: '2026-11-09' }, { c: 1, d: '2026-11-09', id: 'k', t: 5e12 }] }, s2: {} };
  const readiness = [{ d: '2026-11-09', pair: 'dog+fish', asked: 'fishdog', chose: 'fishdog', correct: true }];
  const one = withIds(progress, readiness);
  const two = withIds(structuredClone(progress), structuredClone(readiness));
  assert.deepEqual(one, two, 'deterministic: the same old data on two devices gets the same ids');
  const m = one.progress.s1.m;
  assert.ok(m.every((x) => typeof x.id === 'string' && Number.isFinite(x.t)));
  assert.equal(m[2].id, 'k');
  assert.ok(m[0].t < m[1].t && m[1].t < m[2].t);
  assert.equal(new Set(m.map((x) => x.id)).size, 3);
  assert.ok(one.readiness[0].id && Number.isFinite(one.readiness[0].at));
  // Merging the same legacy data from two devices does not double it.
  const d = doc({ progress: one.progress, readiness: one.readiness });
  const e = doc({ progress: two.progress, readiness: two.readiness });
  assert.equal(mergeDocs(d, e).progress.s1.m.length, 3);
  assert.equal(mergeDocs(d, e).readiness.length, 1);
});

test('sanitiseCore keeps valid entries for known sounds only', () => {
  const valid = new Set(['m', 's']);
  const out = sanitiseCore({
    settings: { speakWords: false, roundsPerSession: 99, extra: 'x' }, settingsAt: 5,
    progress: { s1: { m: [r('a', 1), { c: 1, d: 'x' }, 'junk'], evil: [r('b', 2)] }, s2: { s: 'no' }, s3: { m: [r('c', 3)] } },
    readiness: [{ id: 'q', at: 1, d: '2026-11-10', correct: true, html: '<b>' }, { at: 2 }],
    recordings: { m: { path: 'x' } },
  }, valid);
  assert.deepEqual(out.settings, { speakWords: false, roundsPerSession: 10 });
  assert.deepEqual(out.progress, { s1: { m: [r('a', 1)] }, s2: {} });
  assert.deepEqual(out.readiness, [{ id: 'q', at: 1, d: '2026-11-10', correct: true }]);
  assert.equal('recordings' in out, false);
});

test('a client and the server converge after one push (no endless re-pushing)', () => {
  const valid = new Set(['m', 's']);
  const old = withIds({ s1: { m: [{ c: 1, d: '2026-11-08' }] }, s2: {} }, [{ d: '2026-11-01', correct: true }]);
  const local = doc({ settings: { speakWords: true, roundsPerSession: 6 }, settingsAt: 0, progress: { s1: { ...old.progress.s1, s: [r(newId(), 7)] }, s2: {} }, readiness: old.readiness });
  const server = doc({ progress: { s1: { m: [r('srv', 9)] }, s2: {} }, settings: { speakWords: false, roundsPerSession: 7 }, settingsAt: 3 });
  const merged = mergeDocs(local, server);
  const stored = mergeDocs(server, { ...sanitiseCore(coreOf(merged), valid), recordings: {} });
  assert.equal(canon(coreOf(mergeDocs(merged, stored))), canon(coreOf(stored)));
  assert.equal(canon(coreOf(merged)), canon(coreOf(stored)));
});

test('family codes compare loosely on case, spaces and dashes', () => {
  assert.equal(normaliseCode('  Tiger Lamp_Rose 42 '), 'tiger-lamp-rose-42');
  assert.equal(normaliseCode('tiger--lamp-rose-42'), 'tiger-lamp-rose-42');
  assert.equal(normaliseCode(''), '');
});
