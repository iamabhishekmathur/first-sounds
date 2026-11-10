import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as L from '../../js/logic.js';

const data = JSON.parse(readFileSync(new URL('../fixtures/sounds.sample.json', import.meta.url), 'utf8'));
const byId = new Map(data.sounds.map((s) => [s.id, s]));
const H = (spec) => spec.map(([c, d]) => ({ c, d })); // [[1,'2026-01-01'], ...]
const solidHist = H([[1, 'd1'], [1, 'd1'], [1, 'd1'], [1, 'd2'], [1, 'd2'], [1, 'd2']]);
const learningHist = H([[1, 'd1'], [0, 'd1']]);
const progressWith = (s1 = {}, s2 = {}) => ({ s1, s2 });
const all = (ids, hist) => Object.fromEntries(ids.map((id) => [id, hist]));
const G1 = ['m', 's', 'a', 't'];

/* ---------- mastery ---------- */

test('soundStatus: not started, learning, solid', () => {
  assert.equal(L.soundStatus([]), 'not_started');
  assert.equal(L.soundStatus(undefined), 'not_started');
  assert.equal(L.soundStatus(H([[1, 'a'], [1, 'b'], [1, 'b'], [1, 'b'], [1, 'b']])), 'learning', 'fewer than 6 rounds');
  assert.equal(L.soundStatus(H([[1, 'a'], [1, 'a'], [1, 'a'], [1, 'a'], [1, 'a'], [1, 'a']])), 'learning', 'all on one day');
  assert.equal(L.soundStatus(solidHist), 'solid');
  assert.equal(L.soundStatus(H([[0, 'a'], [1, 'a'], [1, 'a'], [1, 'b'], [1, 'b'], [1, 'b']])), 'solid', '5 of 6 over 2 days');
  assert.equal(L.soundStatus(H([[0, 'a'], [0, 'a'], [1, 'a'], [1, 'b'], [1, 'b'], [1, 'b']])), 'learning', '4 of 6');
});

test('soundStatus only looks at the last 6 rounds', () => {
  const old = H([[0, 'x'], [0, 'x'], [0, 'x']]);
  assert.equal(L.soundStatus([...old, ...solidHist]), 'solid');
  // the 2-day span must be within the last 6
  const h = H([[1, 'a'], [1, 'b'], [1, 'b'], [1, 'b'], [1, 'b'], [1, 'b'], [1, 'b']]);
  assert.equal(L.soundStatus(h), 'learning');
});

test('recordRound is immutable and keeps a bounded history', () => {
  const p0 = progressWith();
  const p1 = L.recordRound(p0, 1, 'm', true, '2026-11-10');
  assert.deepEqual(p0, { s1: {}, s2: {} });
  assert.deepEqual(p1.s1.m, [{ c: 1, d: '2026-11-10' }]);
  let p = p1;
  for (let i = 0; i < 30; i++) p = L.recordRound(p, 2, 'm', i % 2 === 0, 'd');
  assert.equal(p.s2.m.length, L.HISTORY_KEEP);
  assert.equal(p.s1.m.length, 1);
});

test('choiceCount: 2 normally, 3 once going well', () => {
  assert.equal(L.choiceCount([]), 2);
  assert.equal(L.choiceCount(learningHist), 2);
  assert.equal(L.choiceCount(H([[0, 'a'], [1, 'a'], [1, 'a'], [1, 'a']])), 3);
  assert.equal(L.choiceCount(solidHist), 3);
});

/* ---------- availability ---------- */

test('target eligibility is derived from word counts, not ids', () => {
  const e = L.targetEligibleIds(data);
  assert.ok(e.has('m') && e.has('th_unvoiced') && e.has('th_voiced'));
  assert.ok(!e.has('ng'), 'no words start with ng');
  assert.ok(!e.has('r'), 'only one word starts with r');
  // Add two more r words and r becomes a target.
  const more = { ...data, words: [...data.words, { word: 'rat', emoji: '🐀', phonemes: ['r', 'a', 't'] }, { word: 'rose', emoji: '🌹', phonemes: ['r', 'oa', 'z'] }] };
  assert.ok(L.targetEligibleIds(more).has('r'));
});

test('introOrder is group order, then file order', () => {
  const d = { ...data, sounds: [byId.get('p'), byId.get('m'), byId.get('n'), byId.get('s')] };
  assert.deepEqual(L.introOrder(d).map((s) => s.id), ['m', 's', 'p', 'n']);
});

test('canPlay needs all of group 1 recorded', () => {
  assert.equal(L.canPlay(data, new Set(['m', 's', 'a'])), false);
  assert.equal(L.canPlay(data, new Set(G1)), true);
});

test('later groups unlock only once earlier groups are recorded and solid in stage 1', () => {
  const rec = new Set([...G1, 'p', 'n', 'i', 'sh']);
  assert.deepEqual([...L.unlockedGroups(data, rec, progressWith())], [1]);
  const nearly = progressWith({ ...all(['m', 's', 'a'], solidHist), t: learningHist });
  assert.deepEqual([...L.unlockedGroups(data, rec, nearly)], [1]);
  const g1solid = progressWith(all(G1, solidHist));
  assert.deepEqual([...L.unlockedGroups(data, rec, g1solid)], [1, 2]);
  // Stage 1 candidates: only recorded sounds of open groups.
  const c = L.candidates(data, new Set([...G1, 'p']), g1solid, 1).map((s) => s.id);
  assert.deepEqual(c, ['m', 's', 'a', 't', 'p']);
});

test('stage 2 candidates are exactly the sounds solid in stage 1', () => {
  const p = progressWith({ m: solidHist, s: learningHist });
  assert.deepEqual(L.candidates(data, new Set(G1), p, 2).map((s) => s.id), ['m']);
  assert.deepEqual(L.candidates(data, new Set(G1), progressWith(), 2), []);
});

/* ---------- choosing targets ---------- */

const g1 = G1.map((id) => byId.get(id));

test('chooseTarget introduces new sounds in order, at most 2 per session', () => {
  const rng = L.mulberry32(1);
  const r1 = L.chooseTarget({ cands: g1, progress: progressWith(), stage: 1, rng });
  assert.deepEqual([r1.sound.id, r1.reason], ['m', 'new']);
  const p = progressWith({ m: learningHist });
  const r2 = L.chooseTarget({ cands: g1, progress: p, stage: 1, rng, newThisSession: 1 });
  assert.deepEqual([r2.sound.id, r2.reason], ['s', 'new']);
  const r3 = L.chooseTarget({ cands: g1, progress: p, stage: 1, rng, newThisSession: 2 });
  assert.deepEqual([r3.sound.id, r3.reason], ['m', 'learning']);
});

test('chooseTarget does not introduce a new sound while 4 are learning', () => {
  const five = ['m', 's', 'a', 't', 'p'].map((id) => byId.get(id));
  const p = progressWith(all(G1, learningHist));
  for (let seed = 1; seed < 50; seed++) {
    const r = L.chooseTarget({ cands: five, progress: p, stage: 1, rng: L.mulberry32(seed) });
    assert.notEqual(r.sound.id, 'p');
  }
  const three = progressWith(all(['m', 's', 'a'], learningHist));
  assert.equal(L.chooseTarget({ cands: five, progress: three, stage: 1, rng: L.mulberry32(1) }).sound.id, 't');
});

test('chooseTarget reviews solid sounds about a quarter of the time and avoids repeats', () => {
  const p = progressWith({ m: solidHist, s: solidHist, a: learningHist, t: learningHist });
  const rng = L.mulberry32(42);
  let review = 0;
  const N = 4000;
  for (let i = 0; i < N; i++) {
    const r = L.chooseTarget({ cands: g1, progress: p, stage: 1, rng, lastId: 'a' });
    if (r.reason === 'review') review++;
    else assert.equal(r.sound.id, 't', 'learning pick avoids the previous target');
  }
  assert.ok(Math.abs(review / N - 0.25) < 0.03, `review share ${review / N}`);
});

test('chooseTarget falls back to review when everything is solid', () => {
  const p = progressWith(all(G1, solidHist));
  const r = L.chooseTarget({ cands: g1, progress: p, stage: 1, rng: L.mulberry32(3) });
  assert.equal(r.reason, 'review');
});

/* ---------- distractors ---------- */

test('picture choices: one answer, distractors never start with the target, its grapheme twin, or confusables while learning', () => {
  for (const target of data.sounds.filter((s) => L.targetEligibleIds(data).has(s.id))) {
    const conf = new Set([...target.confusable, ...data.sounds.filter((s) => s.confusable.includes(target.id)).map((s) => s.id)]);
    for (let seed = 1; seed <= 60; seed++) {
      const choices = L.pickPictureChoices({ data, target, targetStatus: 'learning', n: 3, rng: L.mulberry32(seed) });
      assert.equal(choices.length, 3);
      const answers = choices.filter((c) => c.correct);
      assert.equal(answers.length, 1);
      assert.equal(answers[0].soundId, target.id);
      const firsts = new Set();
      for (const c of choices.filter((x) => !x.correct)) {
        assert.notEqual(c.soundId, target.id);
        assert.notEqual(byId.get(c.soundId).graphemes[0], target.graphemes[0], `${target.id}: ${c.word}`);
        assert.ok(!conf.has(c.soundId), `${target.id} learning got confusable ${c.word}`);
        firsts.add(c.soundId);
      }
      assert.equal(firsts.size, 2, 'distractors start with different sounds');
      assert.equal(new Set(choices.map((c) => c.emoji)).size, 3, 'no repeated pictures');
    }
  }
});

test('th_unvoiced and th_voiced never appear together', () => {
  const thU = byId.get('th_unvoiced');
  const thV = byId.get('th_voiced');
  for (let seed = 1; seed <= 200; seed++) {
    for (const [t, other] of [[thU, 'th_voiced'], [thV, 'th_unvoiced']]) {
      for (const status of ['learning', 'solid']) {
        const pics = L.pickPictureChoices({ data, target: t, targetStatus: status, n: 3, rng: L.mulberry32(seed) });
        assert.ok(!pics.some((c) => c.soundId === other));
        const letters = L.pickLetterChoices({ data, target: t, targetStatus: status, n: 3, rng: L.mulberry32(seed) });
        assert.ok(!letters.some((c) => c.soundId === other));
      }
    }
  }
});

test('solid targets may get confusable distractors (review rounds can be harder)', () => {
  const m = byId.get('m');
  let sawN = 0;
  for (let seed = 1; seed <= 100; seed++) {
    const pics = L.pickPictureChoices({ data, target: m, targetStatus: 'solid', n: 3, rng: L.mulberry32(seed) });
    if (pics.some((c) => c.soundId === 'n')) sawN++;
  }
  assert.ok(sawN > 20, `confusable used ${sawN} times`);
});

test('letter choices: distinct graphemes, lowercase, no confusables while learning, prefers recorded sounds', () => {
  const rec = new Set(G1);
  for (const target of g1) {
    for (let seed = 1; seed <= 100; seed++) {
      const ch = L.pickLetterChoices({ data, target, targetStatus: 'learning', n: 3, rng: L.mulberry32(seed), preferIds: rec });
      assert.equal(ch.length, 3);
      assert.equal(new Set(ch.map((c) => c.grapheme)).size, 3);
      assert.equal(ch.filter((c) => c.correct).length, 1);
      for (const c of ch) {
        assert.equal(c.grapheme, c.grapheme.toLowerCase());
        if (!c.correct) {
          assert.ok(!target.confusable.includes(c.soundId));
          assert.ok(rec.has(c.soundId), 'recorded sounds are preferred when enough exist');
        }
      }
    }
  }
});

test('distinct displayed graphemes even when two sounds share one (custom data)', () => {
  const d = {
    ...data,
    sounds: [...data.sounds, { id: 'c_hard', graphemes: ['c'], group: 1, kind: 'stop', say: 'k', tip: 't', exampleWord: 'cat', confusable: [] },
      { id: 'c_soft', graphemes: ['c'], group: 1, kind: 'continuous', say: 's', tip: 't', exampleWord: 'city', confusable: [] }],
  };
  for (let seed = 1; seed <= 200; seed++) {
    const ch = L.pickLetterChoices({ data: d, target: byId.get('m'), targetStatus: 'learning', n: 3, rng: L.mulberry32(seed) });
    assert.equal(new Set(ch.map((c) => c.grapheme)).size, ch.length);
  }
});

/* ---------- planning rounds ---------- */

test('planRound: stage 1 only until a sound is solid; never targets sounds with < 3 words', () => {
  const rec = new Set(data.sounds.map((s) => s.id));
  for (let seed = 1; seed <= 100; seed++) {
    const r = L.planRound({ data, recorded: rec, progress: progressWith(), rng: L.mulberry32(seed) });
    assert.equal(r.stage, 1);
    assert.equal(r.mode, 'hear');
    assert.ok(G1.includes(r.target.id));
  }
  const p = progressWith(all([...G1, 'p', 'n', 'i', 'sh', 'th_unvoiced', 'th_voiced', 'f'], solidHist));
  const seen = new Set();
  for (let seed = 1; seed <= 300; seed++) {
    const r = L.planRound({ data, recorded: rec, progress: p, rng: L.mulberry32(seed) });
    assert.ok(L.targetEligibleIds(data).has(r.target.id), `target ${r.target.id}`);
    seen.add(r.mode);
  }
  assert.deepEqual([...seen].sort(), ['hear', 'pick-letter', 'see-letter']);
});

test('planRound: stage 2 targets are only stage-1-solid sounds; 2-day rule respected', () => {
  const rec = new Set(G1);
  const oneDay = H([[1, 'd1'], [1, 'd1'], [1, 'd1'], [1, 'd1'], [1, 'd1'], [1, 'd1']]);
  const pOneDay = progressWith({ m: oneDay, s: oneDay });
  for (let seed = 1; seed <= 100; seed++) {
    assert.equal(L.planRound({ data, recorded: rec, progress: pOneDay, rng: L.mulberry32(seed) }).stage, 1);
  }
  const p = progressWith({ m: solidHist, s: learningHist });
  let stage2 = 0;
  for (let seed = 1; seed <= 200; seed++) {
    const r = L.planRound({ data, recorded: rec, progress: p, rng: L.mulberry32(seed) });
    if (r.stage === 2) { stage2++; assert.equal(r.target.id, 'm'); }
  }
  assert.ok(stage2 > 40);
});

test('planRound returns null when nothing is recorded', () => {
  assert.equal(L.planRound({ data, recorded: new Set(), progress: progressWith(), rng: Math.random }), null);
});

/* ---------- readiness ---------- */

test('readiness: needs group 1 solid in stage 2, at most once per day', () => {
  const rec = new Set(G1);
  const base = { data, recorded: rec, results: [], today: '2026-11-10' };
  assert.equal(L.readinessEligible({ ...base, progress: progressWith(all(G1, solidHist)) }), false);
  const p = progressWith(all(G1, solidHist), all(G1, solidHist));
  assert.equal(L.readinessEligible({ ...base, progress: p }), true);
  assert.equal(L.readinessEligible({ ...base, progress: p, results: [{ d: '2026-11-10', correct: false }] }), false);
  assert.equal(L.readinessEligible({ ...base, progress: p, results: [{ d: '2026-11-09', correct: true }] }), true);
});

test('readiness: plan has both orders and passed days count distinct days', () => {
  const plan = L.planReadiness(data, L.mulberry32(5));
  assert.deepEqual([...plan.rows].sort(), ['ab', 'ba']);
  assert.ok(['ab', 'ba'].includes(plan.ask));
  const results = [
    { d: '2026-11-01', correct: true }, { d: '2026-11-01', correct: true },
    { d: '2026-11-02', correct: false }, { d: '2026-11-03', correct: true },
  ];
  assert.equal(L.readinessPassedDays(results), 2);
  assert.equal(L.readinessPassedDays([...results, { d: '2026-11-04', correct: true }]), 3);
  assert.deepEqual(L.readinessByDate(results).map((x) => [x.d, x.passed]), [['2026-11-03', true], ['2026-11-02', false], ['2026-11-01', true]]);
});

test('dayKey uses the local calendar date', () => {
  assert.equal(L.dayKey(new Date(2026, 0, 5, 23, 59)), '2026-01-05');
});
