// Position modes (js/logic.js): derived from the words, and the round rules for each mode.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as L from '../../js/logic.js';

const load = (f) => JSON.parse(readFileSync(new URL(`../fixtures/${f}`, import.meta.url), 'utf8'));
const data = load('sounds.modes.json');
const sample = load('sounds.sample.json');
const byId = new Map(data.sounds.map((s) => [s.id, s]));
const words = new Map(data.words.map((w) => [w.word, w]));
const solidHist = ['d1', 'd1', 'd1', 'd2', 'd2', 'd2'].map((d) => ({ c: 1, d }));
const w = (word, phonemes) => ({ word, emoji: word, phonemes });
const mini = (list) => ({ ...data, words: list });

test('mode derivation: start, then end, then anywhere, from at least 4 words', () => {
  assert.equal(L.positionMode(data, 'm'), 'start');
  assert.equal(L.positionMode(data, 'ng'), 'end');
  assert.equal(L.positionMode(data, 'ue'), 'anywhere');
  assert.equal(L.positionMode(data, 'z'), null);
  const m = L.soundModes(data).get('ng');
  assert.deepEqual(m, { mode: 'end', start: 0, end: 4, anywhere: 5 });
  assert.deepEqual(L.soundModes(data).get('z'), { mode: null, start: 0, end: 1, anywhere: 1 });
  assert.deepEqual(L.POSITION_MODES, ['start', 'end', 'anywhere']);
});

test('mode derivation thresholds and order, on made-up words (never by sound id)', () => {
  const s3e4 = mini([w('a', ['ng', 'x']), w('b', ['ng', 'y']), w('c', ['ng', 'z']), w('d', ['x', 'ng']), w('e', ['y', 'ng']), w('f', ['z', 'ng']), w('g', ['s', 'ng'])]);
  assert.equal(L.positionMode(s3e4, 'ng'), 'end', '3 starting words are not enough; 4 ending words are');
  const s4e4 = mini([...s3e4.words, w('h', ['ng', 'o'])]);
  assert.equal(L.positionMode(s4e4, 'ng'), 'start', 'start wins when both reach 4');
  const mid = mini([w('a', ['x', 'ue', 'y']), w('b', ['x', 'ue', 'z']), w('c', ['y', 'ue', 'x']), w('d', ['ue', 'z'])]);
  assert.equal(L.positionMode(mid, 'ue'), 'anywhere');
  const three = mini([w('a', ['x', 'ue', 'y']), w('b', ['x', 'ue', 'z']), w('c', ['ue', 'ue'])]);
  assert.equal(L.positionMode(three, 'ue'), null, 'a word with the sound twice counts once');
  assert.ok(!L.targetEligibleIds(three).has('ue'));
  // The mode changes when the words change (cache follows the data).
  const d2 = { ...data, words: [...data.words, w('zip', ['z', 'i', 'p']), w('zoo', ['z', 'ue']), w('zap', ['z', 'a', 'p'])] };
  assert.equal(L.positionMode(d2, 'z'), 'anywhere');
});

test('the sample fixture now has sounds in all three modes', () => {
  const modes = new Set([...L.soundModes(sample).values()].map((m) => m.mode));
  assert.deepEqual([...modes].sort((a, b) => String(a).localeCompare(String(b))), ['anywhere', 'end', null, 'start']);
});

function checkChoices(target, status, n = 3, seeds = 80) {
  const mode = L.positionMode(data, target.id);
  const blocked = L.blockedIds(data, target, status);
  for (let seed = 1; seed <= seeds; seed++) {
    const ch = L.pickPictureChoices({ data, target, targetStatus: status, n, rng: L.mulberry32(seed) });
    assert.equal(ch.length, n, `${target.id}: ${n} choices`);
    const right = ch.filter((c) => c.correct);
    assert.equal(right.length, 1);
    assert.ok(L.hasSoundAt(words.get(right[0].word), target.id, mode), `${target.id}: answer ${right[0].word} has it (${mode})`);
    assert.equal(right[0].soundId, target.id);
    for (const c of ch) assert.equal(c.position, mode);
    for (const c of ch.filter((x) => !x.correct)) {
      const word = words.get(c.word);
      assert.ok(!word.phonemes.includes(target.id), `${target.id}/${mode}: distractor ${c.word} contains the target`);
      if (mode === 'anywhere') {
        assert.ok(!word.phonemes.some((p) => blocked.has(p)), `${target.id}: ${c.word} has a blocked sound`);
        assert.equal(c.soundId, null);
      } else {
        const at = L.soundAt(word, mode);
        assert.ok(!blocked.has(at), `${target.id}/${status}: ${c.word} has blocked ${at} at the ${mode}`);
        assert.equal(c.soundId, at);
      }
    }
  }
}

test('start mode: answer starts with the target; distractors never contain it anywhere (stricter than before)', () => {
  checkChoices(byId.get('m'), 'learning');
  checkChoices(byId.get('s'), 'solid');
  // "monkey" starts with m; "thumb" ends with m: neither may be a distractor for m, nor "moon" for n.
  for (let seed = 1; seed <= 200; seed++) {
    const ch = L.pickPictureChoices({ data, target: byId.get('m'), targetStatus: 'learning', n: 3, rng: L.mulberry32(seed) });
    assert.ok(!ch.some((c) => !c.correct && c.word === 'thumb'), 'thumb has m at the end');
    const n = L.pickPictureChoices({ data, target: byId.get('n'), targetStatus: 'learning', n: 3, rng: L.mulberry32(seed) });
    assert.ok(!n.some((c) => !c.correct && ['moon', 'sun', 'spoon', 'snake', 'tent'].includes(c.word)), 'n words in any position are never distractors for n');
  }
});

test('end mode: answer ends with the target; confusable rule applies to the last sound', () => {
  checkChoices(byId.get('ng'), 'learning');
  checkChoices(byId.get('ng'), 'solid');
  const ng = byId.get('ng');
  for (let seed = 1; seed <= 200; seed++) {
    const ch = L.pickPictureChoices({ data, target: ng, targetStatus: 'learning', n: 3, rng: L.mulberry32(seed) });
    const ans = ch.find((c) => c.correct);
    assert.ok(['ring', 'king', 'sing', 'tongue'].includes(ans.word), ans.word);
    for (const c of ch.filter((x) => !x.correct)) {
      assert.notEqual(L.lastPhoneme(words.get(c.word)), 'n', `learning ng: ${c.word} ends with the confusable n`);
      assert.notEqual(c.word, 'monkey', 'monkey has ng in the middle');
    }
  }
  // Solid: a confusable last sound (n) may appear, and reviews prefer one about half the time.
  let sawN = 0;
  for (let seed = 1; seed <= 100; seed++) {
    const ch = L.pickPictureChoices({ data, target: ng, targetStatus: 'solid', n: 3, rng: L.mulberry32(seed) });
    if (ch.some((c) => c.soundId === 'n')) sawN++;
  }
  assert.ok(sawN > 20, `confusable used ${sawN} times`);
});

test('anywhere mode: answer contains the target; distractors contain no blocked sound at all', () => {
  checkChoices(byId.get('ue'), 'learning');
  checkChoices(byId.get('i'), 'learning');
  checkChoices(byId.get('l'), 'solid');
  for (let seed = 1; seed <= 100; seed++) {
    const ch = L.pickPictureChoices({ data, target: byId.get('ue'), targetStatus: 'learning', n: 2, rng: L.mulberry32(seed) });
    assert.ok(['moon', 'spoon', 'boot', 'shoe', 'tooth'].includes(ch.find((c) => c.correct).word));
  }
});

test('an explicit mode overrides the sound\'s own mode; avoidWord is respected', () => {
  const ch = L.pickPictureChoices({ data, target: byId.get('m'), targetStatus: 'learning', n: 2, rng: L.mulberry32(1), mode: 'end' });
  assert.equal(ch.find((c) => c.correct).word, 'thumb');
  for (let seed = 1; seed <= 50; seed++) {
    const c2 = L.pickPictureChoices({ data, target: byId.get('ng'), targetStatus: 'learning', n: 2, rng: L.mulberry32(seed), avoidWord: 'ring' });
    assert.notEqual(c2.find((c) => c.correct).word, 'ring');
  }
});

test('grapheme twins: neither th sound ever appears in a round for the other, in any mode', () => {
  const thU = sample.sounds.find((s) => s.id === 'th_unvoiced');
  const thV = sample.sounds.find((s) => s.id === 'th_voiced');
  const sw = new Map(sample.words.map((x) => [x.word, x]));
  for (const mode of ['start', 'end', 'anywhere']) {
    for (let seed = 1; seed <= 100; seed++) {
      for (const [t, other] of [[thU, 'th_voiced'], [thV, 'th_unvoiced']]) {
        const pics = L.pickPictureChoices({ data: sample, target: t, targetStatus: 'learning', n: 3, rng: L.mulberry32(seed), mode });
        for (const c of pics.filter((x) => !x.correct)) assert.ok(!sw.get(c.word).phonemes.includes(other), `${t.id}/${mode}: ${c.word}`);
      }
    }
  }
});

test('planRound carries the position mode of the target', () => {
  const rec = new Set(data.sounds.map((s) => s.id));
  const seen = new Map();
  const p = { s1: { m: [{ c: 1, d: 'd1' }], s: [{ c: 0, d: 'd1' }] }, s2: {} };
  for (let seed = 1; seed <= 200; seed++) {
    const r = L.planRound({ data, recorded: rec, progress: p, rng: L.mulberry32(seed), newCount: { 1: 0, 2: 0 } });
    assert.equal(r.position, L.positionMode(data, r.target.id));
    seen.set(r.target.id, r.position);
  }
  assert.equal(seen.get('ng'), 'end');
});

/* ---------- loading existing progress after the change ---------- */

test('migration: a group already played stays open even if new targets appear in an earlier group', () => {
  // Before: group 1 had only m and s as targets. Now ng and ue are targets too, not yet solid.
  const rec = new Set(['m', 's', 'ng', 'ue', 'n', 't', 'sh', 'k']);
  const p = { s1: { m: solidHist, s: solidHist, n: [{ c: 1, d: 'd3' }] }, s2: {} };
  assert.deepEqual([...L.unlockedGroups(data, rec, p)], [1, 2], 'group 2 was being played: it stays open');
  const fresh = { s1: { m: solidHist, s: solidHist }, s2: {} };
  assert.deepEqual([...L.unlockedGroups(data, rec, fresh)], [1], 'otherwise the usual rule');
  assert.ok(L.candidates(data, rec, p, 1).some((s) => s.id === 'n'));
});

test('migration: a child who has played keeps playing when a new group 1 target is not recorded yet', () => {
  const rec = new Set(['m', 's']);
  assert.equal(L.canPlay(data, rec), false);
  assert.equal(L.canPlay(data, rec, { s1: {}, s2: {} }), false);
  assert.equal(L.canPlay(data, rec, { s1: { m: [{ c: 1, d: 'd1' }] }, s2: {} }), true);
  assert.equal(L.canPlay(data, new Set(['m', 's', 'ng', 'ue'])), true);
});
