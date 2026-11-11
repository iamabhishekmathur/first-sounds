// The Tracker's figures (js/tracker.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as T from '../../js/tracker.js';
import { HISTORY_KEEP } from '../../js/logic.js';

const data = JSON.parse(readFileSync(new URL('../fixtures/sounds.modes.json', import.meta.url), 'utf8'));
const TODAY = '2026-11-10';
const at = (day, h = 9, min = 0) => new Date(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)), h, min).getTime();
let n = 0;
const R = (d, c, extra = {}) => ({ c, d, id: `r${n++}`, t: at(d) + n, ...extra });
const S = (id, d, rounds, correct, mins = 4, extra = {}) => ({ id, d, start: at(d, 9, 15), end: at(d, 9, 15) + mins * 60000, stages: [1], rounds, correct, ...extra });
const solid6 = (d1, d2) => [R(d1, 1), R(d1, 1), R(d1, 1), R(d2, 1), R(d2, 1), R(d2, 1)];

test('dates: ranges, short and relative names', () => {
  assert.equal(T.addDays('2026-11-01', -1), '2026-10-31');
  assert.equal(T.addDays('2026-03-28', 3), '2026-03-31', 'across a DST change');
  assert.deepEqual(T.dayRange('2026-11-10', 3), ['2026-11-08', '2026-11-09', '2026-11-10']);
  assert.equal(T.shortDay('2026-11-03'), '3 Nov');
  assert.equal(T.relativeDay('2026-11-10', TODAY), 'today');
  assert.equal(T.relativeDay('2026-11-09', TODAY), 'yesterday');
  assert.equal(T.relativeDay('2026-11-07', TODAY), '3 days ago');
  assert.equal(T.relativeDay('2026-10-01', TODAY), '1 Oct');
});

test('daily activity: sessions count with their totals, rounds without a known session count alone', () => {
  const progress = {
    s1: {
      m: [R('2026-11-01', 1), R('2026-11-01', 0), R('2026-11-09', 1, { ses: 'A' }), R('2026-11-09', 0, { ses: 'A' })],
      s: [R('2026-11-09', 1, { ses: 'A' }), R('2026-11-09', 1, { ses: 'gone' }), R('junk', 1)],
    },
    s2: { m: [R('2026-11-10', 1, { ses: 'B' })] },
  };
  const sessions = [S('A', '2026-11-09', 6, 4), S('B', '2026-11-10', 6, 6, 3)];
  const daily = T.dailyActivity(progress, sessions);
  assert.deepEqual(daily.get('2026-11-01'), { rounds: 2, correct: 1, checked: 2, sessions: 0, ms: 0 }, 'old rounds still count');
  // Session A's own totals (6 rounds, even though only 3 of its rounds are still kept) + 1 orphan.
  assert.deepEqual(daily.get('2026-11-09'), { rounds: 7, correct: 5, checked: 7, sessions: 1, ms: 4 * 60000 });
  assert.deepEqual(daily.get('2026-11-10'), { rounds: 6, correct: 6, checked: 6, sessions: 1, ms: 3 * 60000 });
  assert.equal(daily.has('junk'), false);
});

test('accuracy windows: last 7 days against the 7 before, inclusive bounds', () => {
  const progress = { s1: { m: [
    R('2026-11-04', 1), R('2026-11-04', 1), R('2026-11-10', 0), R('2026-11-10', 1), // last 7: 3 of 4
    R('2026-11-03', 0), R('2026-10-28', 1), // the 7 before: 1 of 2
    R('2026-10-27', 1), // older: not counted
  ] }, s2: {} };
  const sm = T.summary({ data, progress, sessions: [], readiness: [], today: TODAY });
  assert.deepEqual(sm.acc7, { rounds: 4, correct: 3, acc: 0.75 });
  assert.deepEqual(sm.accPrev7, { rounds: 2, correct: 1, acc: 0.5 });
  const none = T.summary({ data, progress: { s1: {}, s2: {} }, sessions: [], readiness: [], today: TODAY });
  assert.equal(none.acc7.acc, null);
  assert.equal(none.hasPlay, false);
});

test('summary: days practised, sessions and minutes, solid per stage, readiness', () => {
  const progress = {
    s1: { m: solid6('2026-11-08', '2026-11-09'), s: solid6('2026-10-20', '2026-10-21'), ng: [R('2026-11-10', 0)] },
    s2: { m: [R('2026-11-10', 1)] },
  };
  const sessions = [S('a', '2026-11-08', 3, 3, 5), S('b', '2026-11-09', 3, 3, 2.4), S('c', '2026-11-10', 2, 1, 1)];
  const sm = T.summary({
    data, progress, sessions, today: TODAY,
    readiness: [{ d: '2026-11-01', correct: true }, { d: '2026-11-02', correct: false }, { d: '2026-11-03', correct: true }],
  });
  assert.equal(sm.days7, 3);
  assert.equal(sm.days30, 5, '20 and 21 Oct are within 30 days');
  assert.equal(sm.sessions, 3);
  assert.equal(sm.minutes, 8);
  assert.equal(sm.firstSession, '2026-11-08');
  assert.deepEqual(sm.solid[1], { solid: 2, learning: 1, total: 13 });
  assert.deepEqual(sm.solid[2], { solid: 0, learning: 1, total: 13 });
  assert.deepEqual(sm.readiness, { passedDays: 2, needed: 3, tried: 3 });
  assert.equal(sm.hasPlay, true);
});

test('daily series covers 30 days, oldest first, with null accuracy on days without play', () => {
  const progress = { s1: { m: [R('2026-11-10', 1), R('2026-11-10', 0), R('2026-10-12', 1)] }, s2: {} };
  const s = T.dailySeries(progress, [], TODAY, 30);
  assert.equal(s.length, 30);
  assert.equal(s[0].d, '2026-10-12');
  assert.deepEqual(s[0], { d: '2026-10-12', rounds: 1, correct: 1, acc: 1 });
  assert.deepEqual(s[29], { d: TODAY, rounds: 2, correct: 1, acc: 0.5 });
  assert.equal(s[10].acc, null);
});

test('solid over time follows each sound\'s history day by day', () => {
  const progress = {
    s1: { m: solid6('2026-11-05', '2026-11-07'), s: [...solid6('2026-11-01', '2026-11-02'), R('2026-11-09', 0), R('2026-11-09', 0)] },
    s2: { m: solid6('2026-11-08', '2026-11-10') },
  };
  const s = T.solidOverTime(data, progress, TODAY, 10);
  const on = (d) => s.find((x) => x.d === d);
  assert.deepEqual(on('2026-11-01'), { d: '2026-11-01', s1: 0, s2: 0 });
  assert.deepEqual(on('2026-11-02'), { d: '2026-11-02', s1: 1, s2: 0 }, 's solid');
  assert.deepEqual(on('2026-11-07'), { d: '2026-11-07', s1: 2, s2: 0 }, 'm solid too');
  assert.deepEqual(on('2026-11-09'), { d: '2026-11-09', s1: 1, s2: 0 }, 's dropped back to learning');
  assert.deepEqual(on(TODAY), { d: TODAY, s1: 1, s2: 1 });
});

test('statusOnDay: a cut history uses its oldest kept rounds for earlier days', () => {
  const full = Array.from({ length: HISTORY_KEEP }, (_, i) => R(i < 15 ? `2026-11-0${4 + (i % 2)}` : `2026-11-0${6 + (i % 2)}`, i === 20 ? 0 : 1));
  assert.equal(T.statusOnDay(full, '2026-11-01'), 'solid', 'cut history: assumed as solid as its oldest rounds');
  assert.equal(T.statusOnDay(full.slice(0, 10), '2026-11-01'), 'not_started', 'a short history is complete');
  assert.equal(T.statusOnDay(full, '2026-11-05'), 'solid', 'enough kept rounds: exact');
  assert.equal(T.statusOnDay(full.map((r, i) => (i >= 15 ? { ...r, c: i % 3 ? 1 : 0 } : r)), '2026-11-07'), 'learning', 'exact: 4 of the last 6');
});

test('recent sessions: newest first, with time of day and length', () => {
  const list = T.recentSessions([
    S('a', '2026-11-08', 6, 5, 4),
    { ...S('b', '2026-11-09', 6, 6, 0.5), start: at('2026-11-09', 18, 5), end: at('2026-11-09', 18, 5) + 30000 },
    { ...S('c', '2026-11-09', 4, 3, 3), start: at('2026-11-09', 14, 30), end: at('2026-11-09', 14, 33), stages: [1, 2] },
  ], 2);
  assert.deepEqual(list.map((x) => x.id), ['b', 'c']);
  assert.equal(list[0].part, 'evening');
  assert.equal(list[0].clock, '18:05');
  assert.equal(T.lengthText(list[0].minutes), 'under 1 min');
  assert.equal(list[1].part, 'afternoon');
  assert.equal(T.lengthText(list[1].minutes), '3 min');
  assert.deepEqual(list[1].stages, [1, 2]);
  assert.equal(T.timeOfDay(at(TODAY, 8)), 'morning');
});

test('sound rows: mode, stage statuses with last 6, days, last practised, trend', () => {
  const progress = {
    s1: {
      m: solid6('2026-11-01', '2026-11-02'),
      ng: [R('2026-11-03', 1), R('2026-11-03', 1), R('2026-11-04', 1), R('2026-11-04', 1), R('2026-11-05', 0), R('2026-11-05', 0), R('2026-11-06', 0), R('2026-11-06', 1)],
    },
    s2: { m: [R('2026-11-09', 1), R('2026-11-10', 0)] },
  };
  const rows = T.soundRows(data, progress, new Set(['m', 'ng']));
  const m = rows.find((r) => r.id === 'm');
  const ng = rows.find((r) => r.id === 'ng');
  const z = rows.find((r) => r.id === 'z');
  assert.deepEqual([m.mode, m.stages[1].status, m.stages[2].status, m.days, m.last, m.focus], ['start', 'solid', 'learning', 4, '2026-11-10', 2]);
  assert.deepEqual(m.stages[1].last6, { correct: 6, total: 6 });
  assert.deepEqual(m.recent, [1, 0], 'trend dots are for See it once it has started');
  assert.equal(m.trend, null, 'too few rounds for a trend');
  assert.deepEqual([ng.mode, ng.stages[1].status, ng.days, ng.trend], ['end', 'learning', 4, 'down']);
  assert.deepEqual(ng.stages[1].last6, { correct: 3, total: 6 });
  assert.equal(z.target, false);
  assert.equal(z.mode, null);
  assert.deepEqual(z.counts, { start: 0, end: 1, anywhere: 1 });
  assert.equal(T.trendOf([R('d', 0), R('d', 0), R('d', 0), R('d', 0), R('d', 1), R('d', 1), R('d', 1), R('d', 0)]), 'up');
  assert.equal(T.trendOf([R('d', 1), R('d', 0), R('d', 1), R('d', 0), R('d', 0), R('d', 1), R('d', 1), R('d', 0)]), 'steady');
});

test('needs attention first: learning sounds by lowest recent accuracy, then See it ready, solid, not started, non-targets', () => {
  const progress = {
    s1: {
      m: solid6('2026-11-01', '2026-11-02'), // solid, See it not started
      s: solid6('2026-11-01', '2026-11-02'), // solid in both
      ng: [R('d', 1), R('d', 0), R('d', 0)], // learning 1/3
      ue: [R('d', 1), R('d', 1), R('d', 0)], // learning 2/3
    },
    s2: { s: solid6('2026-11-03', '2026-11-04'), n: [R('d', 0)] },
  };
  progress.s1.n = solid6('2026-11-01', '2026-11-02'); // n: solid in Hear it, learning (0/1) in See it
  const order = T.sortRows(T.soundRows(data, progress), 'attention').map((r) => r.id);
  assert.deepEqual(order.slice(0, 6), ['n', 'ng', 'ue', 'm', 's', 't']);
  assert.equal(order.at(-1), 'igh', 'non-targets last, in group order');
  assert.ok(order.indexOf('z') > order.indexOf('e'));
  const byGroup = T.sortRows(T.soundRows(data, progress), 'group').map((r) => r.id);
  assert.deepEqual(byGroup.slice(0, 4), ['m', 's', 'ng', 'ue']);
  const byDays = T.sortRows(T.soundRows(data, progress), 'days').map((r) => r.id);
  assert.equal(byDays[0], 's');
});

test('mix-ups: target → tapped sound (or word, in anywhere rounds), counted once per round, most common first', () => {
  const progress = {
    s1: {
      m: [R('d', 0, { wrong: [{ w: 'nut', s: 'n' }, { w: 'nut', s: 'n' }] }), R('d', 0, { wrong: [{ w: 'nose', s: 'n' }] }), R('d', 1)],
      ue: [R('d', 0, { wrong: [{ w: 'sock' }] }), R('d', 0, { wrong: [{ w: 'sock' }, { w: 'cup' }] })],
      ng: [R('d', 0, { wrong: [{ w: 'mouse', s: 's' }] })],
    },
    s2: { m: [R('d', 0, { wrong: [{ g: 'n', s: 'n' }] })], s: [R('d', 1)] },
  };
  const mx = T.mixUps(progress, 3);
  assert.equal(mx.rounds, 6);
  assert.equal(mx.total, 4);
  assert.deepEqual(mx.list.map((x) => [x.target, x.sound, x.word, x.count]), [
    ['m', 'n', null, 3], ['ue', null, 'sock', 2], ['ng', 's', null, 1],
  ]);
  assert.deepEqual(mx.list[0].examples.sort(), ['n', 'nose', 'nut']);
  assert.deepEqual(T.mixUps({ s1: { m: [R('d', 0)] }, s2: {} }), { list: [], total: 0, rounds: 0 }, 'old rounds have no taps');
});

test('recordings: missing targets first, other missing, untrimmed', () => {
  const recs = new Map([['m', { trimmed: true }], ['s', { trimmed: false }], ['ng', { trimmed: true }], ['z', { trimmed: false }]]);
  const rs = T.recordingStatus(data, recs);
  assert.equal(rs.recorded, 4);
  assert.equal(rs.total, data.sounds.length);
  assert.deepEqual(rs.missingTargets.slice(0, 3), ['ue', 'n', 't']);
  assert.ok(!rs.missingTargets.includes('r') && rs.missingOther.includes('r'));
  assert.deepEqual(rs.untrimmed, ['s', 'z']);
  assert.deepEqual(T.recordingStatus(data, { m: { trimmed: false } }).untrimmed, ['m'], 'plain objects too');
});
