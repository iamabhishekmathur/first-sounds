// The Learning path figures (js/course.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { learningPath, levelFigures, listText } from '../../js/course.js';
import { targetEligibleIds } from '../../js/logic.js';

const data = JSON.parse(readFileSync(new URL('../fixtures/sounds.sample.json', import.meta.url), 'utf8'));
const reading = JSON.parse(readFileSync(new URL('../fixtures/reading.sample.json', import.meta.url), 'utf8'));
const DAYS = ['2026-11-08', '2026-11-08', '2026-11-08', '2026-11-09', '2026-11-09', '2026-11-09'];
const hist = (c = 1) => DAYS.map((d) => ({ c, d }));
const solidIn = (ids) => Object.fromEntries(ids.map((id) => [id, hist()]));
const TOTAL = targetEligibleIds(data).size;
const G1 = ['m', 's', 'a', 't'];
const byId = (p, id) => p.milestones.find((m) => m.id === id);

test('listText joins names in plain English', () => {
  assert.equal(listText([]), '');
  assert.equal(listText(['m']), 'm');
  assert.equal(listText(['m', 's']), 'm and s');
  assert.equal(listText(['m', 's', 'a', 'f', 'n', 't']), 'm, s, a, f, n and t');
});

test('at the very start: nothing done, next step is recording group 1', () => {
  const p = learningPath({ data, reading, progress: { s1: {}, s2: {}, s3: {} }, recorded: new Set(), readiness: [] });
  assert.deepEqual(p.milestones.map((m) => m.id), ['hear', 'letters', 'ready', 'first', 'harder', 'sentences']);
  assert.deepEqual(p.milestones.map((m) => m.status), ['todo', 'todo', 'todo', 'todo', 'todo', 'later']);
  assert.deepEqual(byId(p, 'hear').bars[0], { label: 'Solid in Hear it', value: 0, total: TOTAL });
  assert.equal(byId(p, 'ready').bars[0].total, 3);
  assert.equal(byId(p, 'first').bars[0].total, 5, 'level 1 words that have a picture');
  assert.deepEqual(byId(p, 'harder').bars.map((b) => [b.label, b.total]), [['Level 2', 4], ['Level 3', 3], ['Level 4', 4]]);
  assert.equal(byId(p, 'sentences').locked, true);
  assert.equal(p.current, 'hear');
  assert.match(p.next, /^Next: record the group 1 sounds \(m, s, a and t\) in the recording studio/);
  const tv = learningPath({ data, reading, progress: { s1: {}, s2: {} }, recorded: new Set(), readiness: [], tv: true });
  assert.match(tv.next, /on the iPad or laptop/);
});

test('recorded, then working through Hear it and See it towards the readiness check', () => {
  const rec = new Set(G1);
  let p = learningPath({ data, reading, progress: { s1: solidIn(['m']), s2: {} }, recorded: rec, readiness: [] });
  assert.equal(byId(p, 'hear').status, 'doing');
  assert.equal(byId(p, 'hear').bars[0].value, 1);
  assert.equal(p.current, 'letters');
  assert.equal(p.next, 'Next: get s, a and t solid in Hear it and then in See it (with m), so the readiness check can start.');
  p = learningPath({ data, reading, progress: { s1: solidIn(G1), s2: solidIn(['m', 's']) }, recorded: rec, readiness: [] });
  assert.equal(byId(p, 'letters').status, 'doing');
  assert.equal(byId(p, 'letters').bars[0].value, 2);
  assert.equal(p.next, 'Next: get a and t solid in See it, so the readiness check can start.');
  p = learningPath({ data, reading, progress: { s1: solidIn(G1), s2: solidIn(G1) }, recorded: rec, readiness: [{ d: '2026-11-09', correct: true }] });
  assert.equal(byId(p, 'ready').status, 'doing');
  assert.equal(byId(p, 'ready').bars[0].value, 1);
  assert.match(p.next, /readiness check.*3 separate days \(1 so far\)/);
});

test('ready by the check or turned on by you; then words to record, then words to play', () => {
  const s2 = solidIn(['m', 's', 'a', 't', 'n', 'u', 'e', 'i']);
  const progress = { s1: s2, s2, s3: {} };
  const three = ['2026-11-01', '2026-11-02', '2026-11-03'].map((d) => ({ d, correct: true }));
  let p = learningPath({ data, reading, progress, recorded: new Set(G1), readiness: three });
  assert.equal(byId(p, 'ready').status, 'done');
  assert.equal(byId(p, 'ready').bars[0].override, false);
  assert.equal(p.current, 'first');
  assert.equal(p.next, "Next: record the first words in the studio's Words tab: am, mat and sat.");
  p = learningPath({ data, reading, progress, recorded: new Set(G1), readiness: [], override: { on: true, at: 1 } });
  assert.equal(byId(p, 'ready').status, 'done');
  assert.equal(byId(p, 'ready').bars[0].override, true);
  assert.match(byId(p, 'ready').text, /Turned on by you/);
  // Sounds not solid yet for any word: say which sounds unlock the closest word.
  p = learningPath({ data, reading, progress: { s1: {}, s2: solidIn(['m', 's']) }, recorded: new Set(G1), readiness: [], override: { on: true, at: 1 } });
  assert.equal(p.next, 'Next: get a solid in See it, so the first words (like am) can be read.');
  // Words recorded: play together.
  p = learningPath({ data, reading, progress, recorded: new Set(['w:man', 'w:sun', 'w:nut', 'w:net', 'w:mat']), readiness: three });
  assert.equal(p.next, 'Next: play together: every third round is now a reading round.');
  // No word list.
  p = learningPath({ data, reading: null, progress, recorded: new Set(G1), readiness: three });
  assert.equal(byId(p, 'first').status, 'todo');
  assert.match(p.next, /not available yet/);
});

test('in progress: level bars count solid picture words; practised words are noted, not counted', () => {
  const s2 = solidIn(['m', 's', 'a', 't', 'n', 'u', 'e', 'p', 'i', 'o', 'g', 'd']);
  const s3 = { 'w:man': hist(), 'w:sun': hist(), 'w:nut': [{ c: 0, d: '2026-11-09' }], 'w:mat': [{ c: 0, d: '2026-11-09', p: 1 }], 'w:tap': hist() };
  const progress = { s1: s2, s2, s3 };
  const lv = levelFigures(reading, progress);
  assert.deepEqual(lv.map((l) => [l.level, l.words, l.total, l.solid, l.practised, l.started]), [[1, 9, 5, 2, 1, 4], [2, 5, 4, 1, 0, 1], [3, 4, 3, 0, 0, 0], [4, 4, 4, 0, 0, 0]]);
  const rec = new Set(['w:man', 'w:sun', 'w:nut', 'w:mat', 'w:tap', 'w:map', 'w:net', 'w:am', 'w:sat', 'w:sit']);
  const p = learningPath({ data, reading, progress, recorded: rec, readiness: [], override: { on: true, at: 1 } });
  assert.equal(byId(p, 'first').status, 'doing');
  assert.deepEqual(byId(p, 'first').bars[0], { label: 'Level 1 words solid', value: 2, total: 5, practised: 1 });
  assert.equal(byId(p, 'harder').status, 'doing');
  assert.deepEqual(byId(p, 'harder').bars.map((b) => b.value), [1, 0, 0]);
  assert.equal(p.current, 'first');
  assert.equal(p.now, 'Blending first words: 2 of 5 level 1 words solid.');
  assert.match(p.next, /^Next: keep playing together\. Level 1 words become solid/);
  // Everything solid: the next step is sentences, later.
  const all = Object.fromEntries(reading.words.filter((w) => w.emoji).map((w) => [`w:${w.word}`, hist()]));
  const everyId = data.sounds.map((s) => s.id);
  const done = learningPath({ data, reading, progress: { s1: solidIn(everyId), s2: solidIn(everyId), s3: all }, recorded: rec, readiness: [], override: { on: true, at: 1 } });
  assert.deepEqual(done.milestones.map((m) => m.status), ['done', 'done', 'done', 'done', 'done', 'later']);
  assert.equal(done.current, 'sentences');
  assert.match(done.next, /sentences/);
});
