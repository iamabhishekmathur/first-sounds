// Reading (stage 3): validation, availability, unlocking, mastery, scheduling, distractors, timing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as R from '../../js/reading.js';
import { mulberry32, recordRound } from '../../js/logic.js';

const sounds = JSON.parse(readFileSync(new URL('../fixtures/sounds.sample.json', import.meta.url), 'utf8'));
const reading = JSON.parse(readFileSync(new URL('../fixtures/reading.sample.json', import.meta.url), 'utf8'));
const DAYS = ['2026-11-08', '2026-11-08', '2026-11-08', '2026-11-09', '2026-11-09', '2026-11-09'];
const hist = (days = DAYS, c = 1) => days.map((d) => ({ c, d }));
const solid2 = (ids) => ({ s1: {}, s2: Object.fromEntries(ids.map((id) => [id, hist()])), s3: {} });
const entry = (word) => ({ ...reading.words.find((w) => w.word === word), id: `w:${word}` });

test('reading.json: the fixture is valid; file-level problems are errors', () => {
  const v = R.validateReading(reading, sounds);
  assert.equal(v.ok, true, v.errors.join('\n'));
  assert.deepEqual(v.warnings, []);
  assert.equal(v.words.length, reading.words.length);
  for (const bad of [null, [], 'x', { version: 2, words: [] }, { version: 1 }, { version: 1, words: {} }]) {
    assert.equal(R.validateReading(bad, sounds).ok, false, JSON.stringify(bad));
  }
  assert.match(R.validateReading({ version: 1, words: [] }, sounds).errors[0], /No usable words/);
});

test('reading.json: a word with a problem is left out with a warning, the rest stay usable', () => {
  const w = (over) => ({ word: 'mat', graphemes: ['m', 'a', 't'], phonemes: ['m', 'a', 't'], level: 1, ...over });
  const d = { version: 1, words: [
    w({}),
    w({ word: 'Mat' }), // not lowercase
    w({ word: 'sat', graphemes: ['s', 'a'], phonemes: ['s', 'a', 't'] }), // not aligned
    w({ word: 'sat', graphemes: ['s', 'a', 't'], phonemes: ['s', 'a', 'zz'] }), // unknown sound
    w({ word: 'tam', graphemes: ['t', 'a', 'm'], phonemes: ['t', 'a', 'm'], level: 5 }), // bad level
    w({ word: 'pat', graphemes: ['p', 'a', 'd'], phonemes: ['p', 'a', 't'], level: 2 }), // does not spell the word
    w({}), // duplicate
    w({ word: 'man', graphemes: ['m', 'a', 'n'], phonemes: ['m', 'a', 'n'], emoji: '' }), // empty emoji
    'junk',
    w({ word: 'tap', graphemes: ['t', 'a', 'p'], phonemes: ['t', 'a', 'p'], level: 1 }), // level hint only
    w({ word: 'cat', graphemes: ['c', 'a', 't'], phonemes: ['k', 'a', 't'], level: 2 }), // "c" is k's second letter
  ] };
  const v = R.validateReading(d, sounds);
  assert.equal(v.ok, true);
  assert.deepEqual(v.words.map((x) => x.word), ['mat', 'tap', 'cat']);
  const text = v.warnings.join('\n');
  for (const re of [/Mat.*lowercase/, /2 graphemes but 3 phonemes/, /unknown sound id "zz"/, /level must be 1, 2, 3 or 4/, /do not spell "pat"/, /more than once/, /emoji must be/, /words\[8\] is not an object/, /tap.*suggest level 2/, /"c" stands for k, but See it shows that sound as "k"/]) {
    assert.match(text, re);
  }
});

test('expected level: continuous start 1, stop start 2, blends 3, digraphs and unit sounds 4', () => {
  const m = new Map(sounds.sounds.map((s) => [s.id, s]));
  assert.equal(R.expectedLevel(entry('mat'), m), 1);
  assert.equal(R.expectedLevel(entry('am'), m), 1);
  assert.equal(R.expectedLevel(entry('tap'), m), 2);
  assert.equal(R.expectedLevel(entry('stop'), m), 3);
  assert.equal(R.expectedLevel(entry('ship'), m), 4);
  assert.equal(R.expectedLevel({ graphemes: ['f', 'o', 'x'], phonemes: ['f', 'o', 'x'] }, m), 4);
});

test('loadReading: missing or broken files leave stage 3 off, never throw', async () => {
  const fetch404 = async () => ({ ok: false, status: 404 });
  const a = await R.loadReading('x.json', sounds, fetch404);
  assert.equal(a.data, null);
  assert.equal(a.report.missing, true);
  const b = await R.loadReading('x.json', sounds, async () => ({ ok: true, json: async () => { throw new Error('bad'); } }));
  assert.equal(b.data, null);
  assert.match(b.report.errors[0], /not valid JSON/);
  const c = await R.loadReading('x.json', sounds, async () => { throw new Error('offline'); });
  assert.equal(c.data, null);
  const d = await R.loadReading('x.json', sounds, async () => ({ ok: true, json: async () => reading }));
  assert.equal(d.data.words.length, reading.words.length);
});

test('a word is available when every sound is solid in See it AND the word is recorded', () => {
  const mat = entry('mat');
  const all = solid2(['m', 'a', 't']);
  assert.equal(R.wordAvailable(mat, all, new Set(['w:mat'])), true);
  assert.equal(R.wordAvailable(mat, all, new Set(['m', 'a', 't'])), false, 'not recorded');
  assert.equal(R.wordAvailable(mat, solid2(['m', 'a']), new Set(['w:mat'])), false, 't not solid in See it');
  const onlyHear = { s1: { m: hist(), a: hist(), t: hist() }, s2: {} };
  assert.equal(R.wordAvailable(mat, onlyHear, new Set(['w:mat'])), false, 'solid in Hear it is not enough');
  assert.deepEqual(R.unsolidSounds(entry('stop'), solid2(['s', 't'])), ['o', 'p']);
  assert.deepEqual(R.availableWords(reading, all, new Set(['w:mat', 'w:sat', 'w:am'])).map((w) => w.word), ['am', 'mat'], 'sat needs s');
});

test('words to record: sounds all solid in See it, level then file order, unrecorded first, next 5', () => {
  const p = solid2(['m', 'a', 't', 's', 'n', 'u', 'p', 'e', 'i']);
  const list = R.wordsToRecord(reading, p, new Set(['w:mat']), 5);
  assert.deepEqual(list.next.map((w) => w.word), ['am', 'sat', 'man', 'map', 'sun']);
  assert.ok(list.ready.some((w) => w.word === 'mat'), 'recorded words are still ready');
  assert.ok(!list.todo.some((w) => w.word === 'mat'));
  assert.deepEqual(list.ready.map((w) => w.level), [...list.ready.map((w) => w.level)].sort());
  assert.equal(list.all.length, reading.words.length);
  assert.ok(list.ready.some((w) => w.word === 'tap') && !list.ready.some((w) => w.word === 'pig'), 'pig needs g');
});

test('the example respelling: continuous sounds tripled, stops as they are', () => {
  assert.equal(R.stretched(entry('mat'), sounds), 'mmmaaat');
  assert.equal(R.stretched(entry('sun'), sounds), 'sssuuunnn');
  assert.equal(R.stretched(entry('tap'), sounds), 'taaap');
  assert.equal(R.stretched(entry('ship'), sounds), 'shhhiiip');
  assert.equal(R.stretched(entry('dog'), sounds), 'dooog');
});

test('grapheme timing: continuous about 1.0, stops about 0.4, contiguous over the whole recording', () => {
  assert.deepEqual(R.graphemeWeights(entry('mat'), sounds), [1, 1, 0.4]);
  assert.deepEqual(R.graphemeWeights(entry('stop'), sounds), [1, 0.4, 1, 0.4]);
  const t = R.graphemeTimings(entry('mat'), sounds, 2400);
  assert.deepEqual(t, [{ start: 0, end: 1000 }, { start: 1000, end: 2000 }, { start: 2000, end: 2400 }]);
  const s = R.graphemeTimings(entry('ship'), sounds, 1000);
  assert.equal(s[0].start, 0);
  assert.equal(s.at(-1).end, 1000);
  for (let i = 1; i < s.length; i++) assert.equal(s[i].start, s[i - 1].end);
  assert.ok(s[2].end - s[2].start < s[0].end - s[0].start, 'the stop p is shorter than sh');
  assert.deepEqual(R.graphemeTimings(entry('am'), sounds, 0), [{ start: 0, end: 0 }, { start: 0, end: 0 }]);
});

test('slide: from the left end to the right starts the blend; from the middle or backwards never', () => {
  assert.equal(R.slideDecision(0.05, 0.2), 'go');
  assert.equal(R.slideDecision(-0.1, 0.0), 'go', 'from the go arrow');
  assert.equal(R.slideDecision(0.05, 0.1), 'wait', 'not far enough yet');
  assert.equal(R.slideDecision(0.1, 0.0), 'wait', 'backwards');
  assert.equal(R.slideDecision(0.6, 0.95), 'wait', 'from the middle');
  assert.equal(R.slideDecision(NaN, 1), 'wait');
});

test('word mastery: the sound rule on picture-check rounds; no-picture rounds are "practised"', () => {
  let p = { s1: {}, s2: {}, s3: {} };
  assert.equal(R.wordStatus(p, 'w:mat'), 'not_started');
  p = recordRound(p, 3, 'w:mat', false, '2026-11-08', { p: 1 });
  assert.equal(R.wordStatus(p, 'w:mat'), 'practised');
  for (const d of DAYS) p = recordRound(p, 3, 'w:man', true, d);
  assert.equal(R.wordStatus(p, 'w:man'), 'solid');
  // Practised rounds in between do not count against mastery.
  p = recordRound(p, 3, 'w:man', false, '2026-11-10', { p: 1 });
  assert.equal(R.wordStatus(p, 'w:man'), 'solid');
  let q = { s3: {} };
  for (const d of ['2026-11-08', '2026-11-08', '2026-11-08', '2026-11-08', '2026-11-08', '2026-11-08']) q = recordRound(q, 3, 'w:sun', true, d);
  assert.equal(R.wordStatus(q, 'w:sun'), 'learning', 'one day is not enough');
  // Word histories are kept shorter than sound histories.
  for (let i = 0; i < 20; i++) q = recordRound(q, 3, 'w:sun', true, '2026-11-09');
  assert.equal(q.s3['w:sun'].length, 12);
});

test('unlock: readiness on 3 separate days or the parent override, AND at least one available word', () => {
  const pass = (d, correct = true) => ({ id: d, d, correct, at: 1 });
  const progress = solid2(['m', 'a', 't']);
  const recorded = new Set(['w:mat']);
  const u = (readiness, override, rec = recorded, rd = reading) => R.readingUnlock({ reading: rd, progress, recorded: rec, readiness, override });
  assert.equal(u([], null).unlocked, false);
  assert.equal(u([pass('2026-11-01'), pass('2026-11-02')], null).unlocked, false, 'two days');
  assert.equal(u([pass('2026-11-01'), pass('2026-11-01'), pass('2026-11-02'), pass('2026-11-03', false)], null).unlocked, false, 'same day twice, and a wrong answer');
  const three = [pass('2026-11-01'), pass('2026-11-02'), pass('2026-11-03')];
  assert.equal(u(three, null).unlocked, true);
  assert.equal(u(three, null).byCheck, true);
  assert.equal(u([], { on: true, at: 5 }).unlocked, true, 'override');
  assert.equal(u([], { on: true, at: 5 }).byOverride, true);
  assert.equal(u([], { on: false, at: 9 }).unlocked, false, 'override turned off again');
  assert.equal(u(three, null, new Set()).unlocked, false, 'ready but no word recorded');
  assert.equal(u(three, null, recorded, null).unlocked, false, 'no word list');
  assert.equal(u(three, null, recorded, null).ready, true);
});

test('picture distractor: same level, different first sound when possible; null when impossible', () => {
  const rng = mulberry32(1);
  const avail = ['man', 'map', 'sun', 'nut', 'mat', 'tap', 'stop'].map(entry);
  for (let i = 0; i < 30; i++) {
    const d = R.pickDistractor(entry('man'), avail, rng);
    assert.equal(d.level, 1);
    assert.notEqual(d.phonemes[0], 'm', `${d.word} shares the first sound`);
    assert.ok(d.emoji && d.word !== 'man');
  }
  // Only words sharing the first sound at the same level: then another level with a different start.
  assert.equal(R.pickDistractor(entry('man'), [entry('man'), entry('map'), entry('tap')], rng).word, 'tap');
  // Only a same-first-sound word at all: used rather than no check.
  assert.equal(R.pickDistractor(entry('man'), [entry('man'), entry('map')], rng).word, 'map');
  // No other picture word: no check.
  assert.equal(R.pickDistractor(entry('man'), [entry('man'), entry('mat')], rng), null);
  assert.equal(R.pickDistractor(entry('mat'), avail, rng), null, 'the word itself has no picture');
  const ch = R.pictureChoices(entry('sun'), avail, rng);
  assert.equal(ch.length, 2);
  assert.equal(ch.filter((c) => c.correct).length, 1);
  assert.equal(ch.find((c) => c.correct).word, 'sun');
  assert.equal(R.pictureChoices(entry('man'), [entry('man')], rng), null);
});

test('session mixing: every third round is a reading round', () => {
  assert.deepEqual([...R.readingSlots(10)], [2, 5, 8]);
  assert.deepEqual([...R.readingSlots(4)], [2]);
  assert.deepEqual([...R.readingSlots(20)].length, 6);
  for (const n of [4, 6, 10, 15, 20]) {
    const k = R.readingSlots(n).size;
    assert.ok(Math.abs(k - n / 3) <= 1, `${k} of ${n} is about a third`);
  }
});

test('word choice: at most 2 new words per session, mostly learning, some review', () => {
  const words = ['am', 'mat', 'sat', 'man', 'map', 'sun', 'nut', 'net'].map(entry);
  // A fresh start: a session of 20 reading rounds introduces at most 2 words.
  const rng = mulberry32(3);
  let p = { s1: {}, s2: {}, s3: {} };
  let newCount = 0;
  const seen = new Set();
  for (let i = 0; i < 20; i++) {
    const c = R.chooseWord({ available: words, progress: p, rng, newThisSession: newCount });
    if (!c) continue;
    if (c.reason === 'new') newCount += 1;
    seen.add(c.word.word);
    p = recordRound(p, 3, c.word.id, true, '2026-11-10');
  }
  assert.ok(newCount <= 2);
  assert.ok(seen.size <= 2, `${[...seen]}`);
  // Only new words and the cap reached: no word (a sound round is played instead).
  assert.equal(R.chooseWord({ available: words, progress: { s3: {} }, rng, newThisSession: 2 }), null);
  // With learning and solid words: mostly learning, some review, never more new than allowed.
  const q = { s3: {} };
  for (const w of ['am', 'mat']) q.s3[w === 'am' ? 'w:am' : 'w:mat'] = hist().map((r, i) => ({ ...r, id: `${w}${i}`, t: i }));
  q.s3['w:man'] = [{ c: 1, d: '2026-11-09' }];
  q.s3['w:sun'] = [{ c: 0, d: '2026-11-09' }];
  const tally = { review: 0, learning: 0, new: 0 };
  const rng2 = mulberry32(9);
  for (let i = 0; i < 600; i++) tally[R.chooseWord({ available: words, progress: q, rng: rng2, newThisSession: 0 }).reason] += 1;
  assert.ok(tally.learning > tally.review && tally.learning > tally.new, JSON.stringify(tally));
  assert.ok(tally.review > 60 && tally.review < 240, JSON.stringify(tally));
  assert.equal(R.chooseWord({ available: [], progress: q, rng: rng2 }), null);
  // planReading never picks a word without a recording.
  const prog = solid2(['m', 'a', 't', 's', 'n', 'u']);
  for (let i = 0; i < 20; i++) {
    const plan = R.planReading({ reading, progress: prog, recorded: new Set(['w:man', 'w:sun']), rng: rng2 });
    assert.ok(['man', 'sun'].includes(plan.word.word));
    assert.equal(plan.choices.length, 2);
  }
  assert.equal(R.planReading({ reading, progress: prog, recorded: new Set(['man']), rng: rng2 }), null);
});
