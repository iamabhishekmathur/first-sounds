// Merge rules for sync (js/syncdoc.js): nothing is ever lost, and merging is order independent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mergeDocs, emptyDoc, withIds, sanitiseCore, coreOf, canon, normaliseCode, newId,
  cleanSettings, ROUNDS_DEFAULT, wordId, isWordId, knownIds, MAX_WORDS,
} from '../../js/syncdoc.js';
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
  const N = HISTORY_KEEP;
  const a = doc({ progress: { s1: { m: Array.from({ length: N }, (_, i) => r(`a${i}`, i * 2)) }, s2: {} } });
  const b = doc({ progress: { s1: { m: Array.from({ length: N }, (_, i) => r(`b${i}`, i * 2 + 1)) }, s2: {} } });
  const m = mergeDocs(a, b).progress.s1.m;
  assert.equal(m.length, HISTORY_KEEP);
  assert.equal(m.at(-1).id, `b${N - 1}`);
  assert.equal(m[0].t, 2 * N - HISTORY_KEEP);
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
  assert.deepEqual(out.settings, { speakWords: false, roundsPerSession: 20 }, 'clamped to the new maximum');
  assert.deepEqual(out.progress, { s1: { m: [r('a', 1)] }, s2: {}, s3: {} });
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

/* ---------- sessions and wrong taps (added later; old documents have neither) ---------- */

const ses = (id, start, rounds, extra = {}) => ({ id, d: '2026-11-10', start, end: start + 60000 * rounds, stages: [1], rounds, correct: rounds, ...extra });

test('sessions: union by id, the more complete version of a session wins, oldest first', () => {
  const a = doc({ sessions: [ses('s1', 100, 2), ses('s2', 300, 6)] });
  const b = doc({ sessions: [ses('s1', 100, 5), ses('s3', 200, 1)] });
  const m = mergeDocs(a, b);
  assert.deepEqual(ids(m.sessions), ['s1', 's3', 's2']);
  assert.equal(m.sessions[0].rounds, 5, 'the version with more rounds wins');
  assert.equal(canon(mergeDocs(a, b)), canon(mergeDocs(b, a)), 'commutative');
  const c = doc({ sessions: [ses('s1', 100, 5, { end: 999999 })] });
  assert.equal(mergeDocs(b, c).sessions.find((x) => x.id === 's1').end, 999999, 'same rounds: later end wins');
  assert.equal(canon(mergeDocs(mergeDocs(a, b), c)), canon(mergeDocs(a, mergeDocs(b, c))), 'associative');
});

test('sessions: a reset drops sessions started before it; the list stays bounded', async () => {
  const { SESSION_KEEP } = await import('../../js/syncdoc.js');
  const m = mergeDocs(doc({ resetAt: 250 }), doc({ sessions: [ses('old', 100, 3), ses('new', 300, 3)] }));
  assert.deepEqual(ids(m.sessions), ['new']);
  const many = doc({ sessions: Array.from({ length: SESSION_KEEP + 20 }, (_, i) => ses(`x${i}`, i, 1)) });
  const out = mergeDocs(many, emptyDoc()).sessions;
  assert.equal(out.length, SESSION_KEEP);
  assert.equal(out.at(-1).id, `x${SESSION_KEEP + 19}`, 'the newest are kept');
});

test('old documents without sessions or wrong taps merge with new ones unchanged', () => {
  // An old server doc (before this version): no sessions key, rounds without ses or wrong.
  const old = { settings: { speakWords: true, roundsPerSession: 6 }, settingsAt: 5, progress: { s1: { m: [r('o1', 1), r('o2', 2, 0)] }, s2: {} }, resetAt: 0, readiness: [{ id: 'q', at: 1, d: '2026-11-01', correct: true }], recordings: { m: { updatedAt: 3, mime: 'audio/wav' } } };
  const fresh = doc({ progress: { s1: { m: [{ ...r('n1', 3, 0), ses: 'S', wrong: [{ w: 'nose', s: 'n' }] }] }, s2: {} }, sessions: [ses('S', 3, 1)] });
  const m = mergeDocs(old, fresh);
  assert.deepEqual(ids(m.progress.s1.m), ['o1', 'o2', 'n1']);
  assert.deepEqual(m.progress.s1.m[0], r('o1', 1), 'old rounds are not changed');
  assert.deepEqual(m.progress.s1.m[2].wrong, [{ w: 'nose', s: 'n' }]);
  assert.deepEqual(ids(m.sessions), ['S']);
  assert.deepEqual(m.readiness, old.readiness);
  assert.equal(m.settingsAt, 5);
  assert.deepEqual(mergeDocs(old, emptyDoc()).sessions, [], 'an old doc reads as no sessions');
  assert.deepEqual(coreOf(old).sessions, []);
});

test('sanitiseCore keeps sessions and wrong taps, and drops malformed ones', () => {
  const valid = new Set(['m', 'n']);
  const out = sanitiseCore({
    progress: { s1: { m: [
      { ...r('a', 1, 0), ses: 'S1', wrong: [{ w: 'nose', s: 'n' }, { g: 'n', s: 'n' }, { w: 'pig' }, { s: 'n' }, 'x', { w: 'y'.repeat(41) }, { g: 'm', s: 'bad id!' }] },
      { ...r('b', 2), ses: 'bad id!', wrong: [] },
      { ...r('c', 3), wrong: Array.from({ length: 20 }, () => ({ w: 'nut', s: 'n' })) },
    ] } },
    sessions: [
      ses('S1', 10, 6, { correct: 9, stages: [2, 1, 1, 3, 4], extra: '<b>' }),
      { id: 'bad id!', start: 1, end: 2 }, { id: 'nostart', end: 2 }, 'junk',
      { id: 'S2', start: 50, end: 40, rounds: -3, correct: 2, d: 'not-a-day' },
    ],
  }, valid);
  const [a, b, c] = out.progress.s1.m;
  assert.deepEqual(a, { ...r('a', 1, 0), ses: 'S1', wrong: [{ w: 'nose', s: 'n' }, { g: 'n', s: 'n' }, { w: 'pig' }, { g: 'm' }] });
  assert.deepEqual(b, r('b', 2), 'bad session id and empty wrong list are left out');
  assert.equal(c.wrong.length, 8, 'at most 8 wrong taps per round');
  assert.deepEqual(out.sessions, [
    { id: 'S1', d: '2026-11-10', start: 10, end: 10 + 6 * 60000, stages: [1, 2, 3], rounds: 6, correct: 6 },
    { id: 'S2', start: 50, end: 50, stages: [], rounds: 0, correct: 0 },
  ]);
  // An old client's doc (no sessions key at all) is still accepted.
  const old = sanitiseCore({ progress: { s1: { m: [r('z', 1)] } }, readiness: [] }, valid);
  assert.deepEqual(old.sessions, []);
  assert.deepEqual(old.progress.s1.m, [r('z', 1)]);
});

test('with sessions and wrong taps, a client and the server still converge after one push', () => {
  const valid = new Set(['m', 'n']);
  const local = doc({
    settings: { speakWords: true, roundsPerSession: 6 }, settingsAt: 1,
    progress: { s1: { m: [{ ...r('a', 1, 0), ses: 'S', wrong: [{ w: 'nose', s: 'n' }, { w: 'shoe' }] }, { ...r('b', 2), ses: 'S' }] }, s2: { n: [{ ...r('c', 3, 0), ses: 'S', wrong: [{ g: 'm', s: 'm' }] }] } },
    sessions: [{ id: 'S', d: '2026-11-10', start: 0, end: 3, stages: [1, 2], rounds: 3, correct: 1 }],
  });
  const server = doc({ progress: { s1: { m: [r('old', 0)] }, s2: {} } }); // an old-format server doc
  const merged = mergeDocs(local, server);
  const stored = mergeDocs(server, { ...sanitiseCore(coreOf(merged), valid), recordings: {} });
  assert.equal(canon(coreOf(merged)), canon(coreOf(stored)), 'nothing is stripped, so no endless re-pushing');
  // The session grows on the device: the next push replaces the stored version.
  const grown = { ...local, sessions: [{ ...local.sessions[0], rounds: 4, correct: 2, end: 9 }] };
  const again = mergeDocs(stored, { ...sanitiseCore(coreOf(mergeDocs(grown, stored)), valid), recordings: {} });
  assert.equal(again.sessions[0].rounds, 4);
});

/* ---------- longer sessions and reading (stage 3) ---------- */

test('rounds per session: default 10, range 4 to 20; never changed (settingsAt 0) gets the default', () => {
  assert.equal(ROUNDS_DEFAULT, 10);
  assert.deepEqual(cleanSettings(null, 0), { speakWords: true, roundsPerSession: 10 });
  assert.deepEqual(cleanSettings({ speakWords: false, roundsPerSession: 6 }, 0), { speakWords: false, roundsPerSession: 10 }, 'the old default, never changed');
  assert.deepEqual(cleanSettings({ roundsPerSession: 6 }, 123), { speakWords: true, roundsPerSession: 6 }, 'chosen by the parent');
  assert.equal(cleanSettings({ roundsPerSession: 3 }, 1).roundsPerSession, 4);
  assert.equal(cleanSettings({ roundsPerSession: 25 }, 1).roundsPerSession, 20);
  assert.equal(cleanSettings({ roundsPerSession: 17 }, 1).roundsPerSession, 17);
  assert.equal(cleanSettings({ roundsPerSession: 'x' }, 1).roundsPerSession, 10);
  // A server doc from the old version (6 rounds, never changed) and a new device: 10.
  const oldServer = doc({ settings: { speakWords: true, roundsPerSession: 6 }, settingsAt: 0 });
  const newDevice = doc({ settings: { speakWords: true, roundsPerSession: 10 }, settingsAt: 0 });
  assert.equal(mergeDocs(oldServer, newDevice).settings.roundsPerSession, 10);
  assert.equal(mergeDocs(newDevice, oldServer).settings.roundsPerSession, 10);
  assert.equal(sanitiseCore(oldServer, new Set()).settings.roundsPerSession, 10);
  // A family that chose 6 keeps 6; a choice of 15 survives the server.
  assert.equal(mergeDocs(doc({ settings: { speakWords: true, roundsPerSession: 6 }, settingsAt: 50 }), newDevice).settings.roundsPerSession, 6);
  assert.equal(sanitiseCore(doc({ settings: { roundsPerSession: 15 }, settingsAt: 9 }), new Set()).settings.roundsPerSession, 15);
});

test('word ids: their own namespace, from reading.json, never colliding with sound ids', () => {
  assert.equal(wordId('mat'), 'w:mat');
  assert.equal(isWordId('w:mat'), true);
  assert.equal(isWordId('m'), false);
  assert.equal(isWordId('w:Mat'), false);
  const ids = knownIds({ sounds: [{ id: 'm' }, { id: 'w' }, { id: 'th_voiced' }] }, { words: [{ word: 'mat' }, { word: 'Bad Word' }, { word: 'w' }, null] });
  assert.deepEqual([...ids].sort(), ['m', 'th_voiced', 'w', 'w:mat', 'w:w']);
  assert.deepEqual([...knownIds({ sounds: [{ id: 'm' }] }, null)], ['m'], 'no reading file: sounds only');
});

const wr = (id, t, c = 1, extra = {}) => ({ c, d: '2026-11-10', id, t, ...extra });

test('reading rounds (s3): union by id like sounds, last 12 per word, practised flag kept', () => {
  const a = doc({ progress: { s1: {}, s2: {}, s3: { 'w:mat': [wr('a1', 1, 0, { p: 1 }), wr('x', 3)] } } });
  const b = doc({ progress: { s1: {}, s2: {}, s3: { 'w:mat': [wr('b1', 2), wr('x', 3)], 'w:sun': [wr('b2', 5, 0, { ses: 'S', wrong: [{ w: 'nut' }] })] } } });
  const m = mergeDocs(a, b);
  assert.deepEqual(ids(m.progress.s3['w:mat']), ['a1', 'b1', 'x']);
  assert.equal(m.progress.s3['w:mat'][0].p, 1);
  assert.equal(canon(mergeDocs(a, b)), canon(mergeDocs(b, a)));
  const many = doc({ progress: { s3: { 'w:mat': Array.from({ length: 40 }, (_, i) => wr(`r${i}`, i)) } } });
  assert.equal(mergeDocs(many, emptyDoc()).progress.s3['w:mat'].length, 12);
  // A reset drops reading rounds too.
  assert.deepEqual(mergeDocs(a, doc({ resetAt: 10 })).progress.s3, {});
});

test('sanitiseCore: reading rounds for any well-formed word id, the practised flag, stage 3 sessions', () => {
  const valid = knownIds({ sounds: [{ id: 'm' }, { id: 'a' }] }, { words: [{ word: 'mat' }] });
  const out = sanitiseCore({
    progress: {
      s1: { m: [r('s', 1)], 'w:mat': [r('bad', 1)] },
      s3: {
        'w:mat': [{ ...wr('a', 1, 1, { p: 1, ses: 'S1', wrong: [{ w: 'sun' }, { w: 'x'.repeat(50) }] }) }, 'junk'],
        'w:gone': [wr('b', 2)], // not (or no longer) in the word list: kept, so a word list change loses nothing
        m: [wr('c', 3)], 'w:Bad': [wr('d', 4)], '../x': [wr('e', 5)],
      },
    },
    sessions: [{ id: 'S1', d: '2026-11-10', start: 1, end: 9, stages: [1, 3], rounds: 6, correct: 4, practised: 9 }],
    blendOverride: { on: 'yes', at: 77, extra: 1 },
  }, valid);
  assert.deepEqual(out.progress.s1, { m: [r('s', 1)] }, 'word ids never go into a sound stage');
  assert.deepEqual(Object.keys(out.progress.s3).sort(), ['w:gone', 'w:mat']);
  assert.deepEqual(out.progress.s3['w:mat'], [{ c: 0, d: '2026-11-10', id: 'a', t: 1, ses: 'S1', p: 1, wrong: [{ w: 'sun' }] }], 'a practised round is never correct');
  assert.deepEqual(out.sessions, [{ id: 'S1', d: '2026-11-10', start: 1, end: 9, stages: [1, 3], rounds: 6, correct: 4, practised: 2 }]);
  assert.deepEqual(out.blendOverride, { on: true, at: 77 });
  assert.equal(sanitiseCore({ blendOverride: { on: true } }, valid).blendOverride, null, 'no time: dropped');
  // At most MAX_WORDS words with reading rounds.
  const huge = { progress: { s3: Object.fromEntries(Array.from({ length: MAX_WORDS + 50 }, (_, i) => [`w:${String.fromCharCode(97 + (i % 26))}${'abcdefghijklmnopqrstuvwxyz'[Math.floor(i / 26) % 26]}${'abcdefghijklmnopqrstuvwxyz'[Math.floor(i / 676) % 26]}`, [wr(`h${i}`, i)]])) } };
  assert.equal(Object.keys(sanitiseCore(huge, valid).progress.s3).length, MAX_WORDS);
});

test('the ready-to-blend override: the later change wins, ties favour on, old docs have none', () => {
  const on = doc({ blendOverride: { on: true, at: 100 } });
  const off = doc({ blendOverride: { on: false, at: 200 } });
  assert.deepEqual(mergeDocs(on, off).blendOverride, { on: false, at: 200 });
  assert.deepEqual(mergeDocs(off, on).blendOverride, { on: false, at: 200 });
  assert.deepEqual(mergeDocs(on, doc({ blendOverride: { on: false, at: 100 } })).blendOverride, { on: true, at: 100 });
  assert.deepEqual(mergeDocs(on, emptyDoc()).blendOverride, { on: true, at: 100 });
  assert.equal(mergeDocs(emptyDoc(), emptyDoc()).blendOverride, null);
  // A reset of progress keeps the parent's switch.
  assert.deepEqual(mergeDocs(on, doc({ resetAt: 500 })).blendOverride, { on: true, at: 100 });
});

test('old documents (before reading) stay valid and merge without loss', () => {
  // What the previous version stored and sent: no s3, no blendOverride, settings at the old default.
  const old = { settings: { speakWords: false, roundsPerSession: 8 }, settingsAt: 40, progress: { s1: { m: [r('o1', 1), r('o2', 2, 0)] }, s2: { m: [r('o3', 3)] } }, resetAt: 0, readiness: [{ id: 'q', at: 1, d: '2026-11-01', correct: true }], sessions: [{ id: 'S0', d: '2026-11-01', start: 1, end: 2, stages: [1], rounds: 2, correct: 1 }] };
  const valid = new Set(['m']);
  const clean = sanitiseCore(old, valid);
  assert.deepEqual(clean.progress, { s1: old.progress.s1, s2: old.progress.s2, s3: {} });
  assert.deepEqual(clean.settings, old.settings);
  assert.equal(clean.blendOverride, null);
  assert.deepEqual(clean.sessions, old.sessions);
  const merged = mergeDocs(old, doc({ progress: { s1: {}, s2: {}, s3: { 'w:mat': [wr('n1', 5)] } }, blendOverride: { on: true, at: 3 } }));
  assert.deepEqual(merged.progress.s1, old.progress.s1);
  assert.deepEqual(merged.progress.s2, old.progress.s2);
  assert.deepEqual(ids(merged.progress.s3['w:mat']), ['n1']);
  assert.deepEqual(merged.readiness, old.readiness);
  assert.deepEqual(merged.settings, old.settings);
  // Converges: the core of a merged doc, sanitised again, is unchanged (no endless re-pushing).
  const core = coreOf(merged);
  assert.equal(canon(sanitiseCore(core, new Set(['m', 'w:mat']))), canon(core));
  // withIds gives old reading-less progress a stage 3 too, and leaves s3 rounds alone.
  const w = withIds({ s1: { m: [{ c: 1, d: '2026-11-08' }] }, s2: {} }, []);
  assert.deepEqual(w.progress.s3, {});
});
