// Figures for the parent's Tracker. Pure functions only: no DOM, no storage, no clock (today comes
// in as 'YYYY-MM-DD'). The screen (js/tracker-view.js) only renders what these return.
//
// Sources: rounds in progress (the last HISTORY_KEEP per sound per stage; newer rounds carry the id of
// their session and their wrong taps), sessions (recorded since the Tracker exists) and readiness
// results. Per-day counts use a session's own totals for its rounds, plus every round that belongs to
// no known session (rounds played before sessions were recorded), so nothing is counted twice.

import {
  soundStatus, historyOf, introOrder, soundModes, targetEligibleIds, readinessPassedDays, HISTORY_KEEP,
} from './logic.js';

export const READINESS_DAYS_NEEDED = 3;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const isDay = (d) => typeof d === 'string' && DAY.test(d);

/* ---------- dates ---------- */

export function addDays(day, n) {
  const t = Date.parse(`${day}T12:00:00Z`) + n * 864e5;
  return new Date(t).toISOString().slice(0, 10);
}

/** The n days ending with `today`, oldest first. */
export function dayRange(today, n) {
  return Array.from({ length: n }, (_, i) => addDays(today, i - n + 1));
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "10 Nov" */
export function shortDay(d) {
  if (!isDay(d)) return String(d ?? '');
  return `${Number(d.slice(8, 10))} ${MONTHS[Number(d.slice(5, 7)) - 1]}`;
}

/** "today", "yesterday", "3 days ago" (up to a week), else "10 Nov". */
export function relativeDay(d, today) {
  if (!isDay(d)) return '';
  const diff = Math.round((Date.parse(`${today}T12:00:00Z`) - Date.parse(`${d}T12:00:00Z`)) / 864e5);
  if (diff === 0) return 'today';
  if (diff === 1) return 'yesterday';
  if (diff > 1 && diff < 7) return `${diff} days ago`;
  return shortDay(d);
}

/* ---------- rounds and days ---------- */

/**
 * Every kept round as { stage, sound, c, d, t, id, ses, wrong, p }, oldest first. Stage 3 (reading)
 * rounds have a word id ("w:mat") as `sound`.
 */
export function allRounds(progress, stages = [1, 2, 3]) {
  const out = [];
  for (const stage of stages) {
    for (const [sound, hist] of Object.entries((progress && progress[`s${stage}`]) || {})) {
      if (!Array.isArray(hist)) continue;
      for (const r of hist) if (r && typeof r === 'object') out.push({ stage, sound, ...r });
    }
  }
  return out.sort((a, b) => (Number(a.t) || 0) - (Number(b.t) || 0));
}

export function hasAnyPlay(progress, sessions) {
  return (sessions || []).length > 0 || allRounds(progress).length > 0;
}

/**
 * Activity per calendar day: Map day -> { rounds, correct, checked, sessions, ms }.
 * A session counts with its own totals; a round counts by itself only if it has no known session.
 * checked: rounds with a right or wrong answer (practised reading rounds have none), for accuracy.
 */
export function dailyActivity(progress, sessions) {
  const map = new Map();
  const at = (d) => {
    if (!map.has(d)) map.set(d, { rounds: 0, correct: 0, checked: 0, sessions: 0, ms: 0 });
    return map.get(d);
  };
  const known = new Set();
  for (const s of sessions || []) {
    if (!s || !s.id) continue;
    known.add(s.id);
    const d = isDay(s.d) ? s.d : null;
    if (!d) continue;
    const x = at(d);
    const rounds = Number(s.rounds) || 0;
    x.sessions += 1;
    x.rounds += rounds;
    x.correct += Number(s.correct) || 0;
    x.checked += Math.max(0, rounds - (Number(s.practised) || 0));
    x.ms += Math.max(0, (Number(s.end) || 0) - (Number(s.start) || 0));
  }
  for (const r of allRounds(progress)) {
    if (r.ses && known.has(r.ses)) continue;
    if (!isDay(r.d)) continue;
    const x = at(r.d);
    x.rounds += 1;
    if (!r.p) x.checked += 1;
    if (r.c) x.correct += 1;
  }
  return map;
}

/** First-try accuracy over the days from..to (inclusive): { rounds, correct, acc } (acc null: no rounds). */
export function accuracyBetween(daily, from, to) {
  let rounds = 0;
  let correct = 0;
  for (const [d, x] of daily) {
    if (d >= from && d <= to) { rounds += x.checked ?? x.rounds; correct += x.correct; }
  }
  return { rounds, correct, acc: rounds ? correct / rounds : null };
}

export function daysPractisedBetween(daily, from, to) {
  let n = 0;
  for (const [d, x] of daily) if (d >= from && d <= to && x.rounds > 0) n++;
  return n;
}

/** Daily rounds and first-try accuracy for the n days ending today, oldest first. */
export function dailySeries(progress, sessions, today, n = 30) {
  const daily = dailyActivity(progress, sessions);
  return dayRange(today, n).map((d) => {
    const x = daily.get(d) || { rounds: 0, correct: 0, checked: 0 };
    const checked = x.checked ?? x.rounds;
    return { d, rounds: x.rounds, correct: x.correct, acc: checked ? x.correct / checked : null };
  });
}

/* ---------- status over time ---------- */

/**
 * A sound's status at the end of `day`, from its kept history. Exact when at least 6 kept rounds are
 * on or before the day. If the history may have been cut (HISTORY_KEEP rounds kept) and fewer than
 * 6 kept rounds are that old, the status of the oldest kept rounds is used.
 */
export function statusOnDay(history, day) {
  const hist = (history || []).filter((r) => r && isDay(r.d));
  const upTo = hist.filter((r) => r.d <= day);
  if (upTo.length < 6 && hist.length >= HISTORY_KEEP && upTo.length < hist.length) {
    return soundStatus(hist.slice(0, 6));
  }
  return soundStatus(upTo);
}

/** Count of solid target sounds per stage at the end of each of the n days: [{ d, s1, s2 }]. */
export function solidOverTime(data, progress, today, n = 30) {
  const ids = [...targetEligibleIds(data)];
  return dayRange(today, n).map((d) => ({
    d,
    s1: ids.filter((id) => statusOnDay(historyOf(progress, 1, id), d) === 'solid').length,
    s2: ids.filter((id) => statusOnDay(historyOf(progress, 2, id), d) === 'solid').length,
  }));
}

/* ---------- summary ---------- */

export function summary({ data, progress, sessions, readiness, today }) {
  const daily = dailyActivity(progress, sessions);
  const list = (sessions || []).filter((s) => s && s.id);
  const ms = list.reduce((n, s) => n + Math.max(0, (Number(s.end) || 0) - (Number(s.start) || 0)), 0);
  const ids = [...targetEligibleIds(data)];
  const solid = {};
  for (const stage of [1, 2]) {
    const st = ids.map((id) => soundStatus(historyOf(progress, stage, id)));
    solid[stage] = { solid: st.filter((x) => x === 'solid').length, learning: st.filter((x) => x === 'learning').length, total: ids.length };
  }
  const firstSession = list.map((s) => s.d).filter(isDay).sort()[0] || null;
  return {
    hasPlay: hasAnyPlay(progress, list),
    days7: daysPractisedBetween(daily, addDays(today, -6), today),
    days30: daysPractisedBetween(daily, addDays(today, -29), today),
    sessions: list.length,
    minutes: Math.round(ms / 60000),
    firstSession,
    acc7: accuracyBetween(daily, addDays(today, -6), today),
    accPrev7: accuracyBetween(daily, addDays(today, -13), addDays(today, -7)),
    solid,
    readiness: { passedDays: readinessPassedDays(readiness), needed: READINESS_DAYS_NEEDED, tried: (readiness || []).length },
  };
}

/* ---------- sessions ---------- */

const pad = (n) => String(n).padStart(2, '0');

export function timeOfDay(ms) {
  const h = new Date(ms).getHours();
  return h < 12 ? 'morning' : h < 17 ? 'afternoon' : 'evening';
}

/** The newest n sessions, newest first, with display fields. Local time of day from the device clock. */
export function recentSessions(sessions, n = 10) {
  return (sessions || []).filter((s) => s && s.id && Number.isFinite(s.start))
    .sort((a, b) => b.start - a.start || (a.id < b.id ? 1 : -1))
    .slice(0, n)
    .map((s) => {
      const t = new Date(s.start);
      const ms = Math.max(0, (Number(s.end) || s.start) - s.start);
      return {
        id: s.id, d: s.d, rounds: Number(s.rounds) || 0, correct: Number(s.correct) || 0, stages: s.stages || [],
        clock: `${pad(t.getHours())}:${pad(t.getMinutes())}`, part: timeOfDay(s.start), minutes: ms / 60000,
      };
    });
}

/** "under 1 min", "3 min" */
export function lengthText(minutes) {
  if (!(minutes >= 1)) return 'under 1 min';
  return `${Math.round(minutes)} min`;
}

/* ---------- sounds ---------- */

const acc = (list) => (list.length ? list.filter((r) => r.c).length / list.length : null);

/** 'up' | 'down' | 'steady', comparing the last 4 rounds with the 4 before; null under 8 rounds. */
export function trendOf(history) {
  const h = history || [];
  if (h.length < 8) return null;
  const diff = acc(h.slice(-4)) - acc(h.slice(-8, -4));
  return diff >= 0.25 ? 'up' : diff <= -0.25 ? 'down' : 'steady';
}

/**
 * One row per sound: group, mode (null: not a target, with the word counts that explain why), the
 * status and last-6 result of each stage, days practised, last practised, and a trend for the stage
 * being worked on (See it once Hear it is solid and See it has started).
 */
export function soundRows(data, progress, recorded = new Set()) {
  const modes = soundModes(data);
  return introOrder(data).map((s, order) => {
    const m = modes.get(s.id);
    const stages = {};
    const days = new Set();
    let last = null;
    for (const stage of [1, 2]) {
      const hist = historyOf(progress, stage, s.id);
      const last6 = hist.slice(-6);
      stages[stage] = {
        status: soundStatus(hist), rounds: hist.length,
        last6: { correct: last6.filter((r) => r.c).length, total: last6.length },
      };
      for (const r of hist) {
        if (!isDay(r.d)) continue;
        days.add(r.d);
        if (!last || r.d > last) last = r.d;
      }
    }
    const focus = stages[1].status === 'solid' && stages[2].rounds > 0 ? 2 : 1;
    const fh = historyOf(progress, focus, s.id);
    return {
      id: s.id, grapheme: s.graphemes[0], say: s.say, group: s.group, order,
      mode: m ? m.mode : null, counts: m ? { start: m.start, end: m.end, anywhere: m.anywhere } : null,
      target: !!(m && m.mode), recorded: recorded.has(s.id),
      stages, days: days.size, last, focus,
      recent: fh.slice(-8).map((r) => (r.c ? 1 : 0)), trend: trendOf(fh),
    };
  });
}

/**
 * "Needs attention first": learning sounds by lowest recent accuracy, then sounds ready to start
 * See it, then solid sounds, then sounds not started, then sounds that are not targets.
 * Returns [rank, accuracy key].
 */
export function attentionKey(row) {
  if (!row.target) return [5, 0];
  const learning = [1, 2].filter((st) => row.stages[st].status === 'learning');
  if (learning.length) {
    const a = Math.min(...learning.map((st) => { const l = row.stages[st].last6; return l.total ? l.correct / l.total : 0; }));
    return [0, a];
  }
  const s1 = row.stages[1].status;
  const s2 = row.stages[2].status;
  if (s1 === 'solid' && s2 === 'not_started') return [1, 0];
  if (s1 === 'solid' && s2 === 'solid') return [2, 0];
  return [3, 0];
}

export const SORTS = {
  attention: 'Needs attention first',
  group: 'Group order',
  recent: 'Most recently practised',
  days: 'Most days practised',
};

export function sortRows(rows, by = 'attention') {
  const list = [...rows];
  if (by === 'group') return list.sort((a, b) => a.order - b.order);
  if (by === 'recent') return list.sort((a, b) => (b.last || '').localeCompare(a.last || '') || a.order - b.order);
  if (by === 'days') return list.sort((a, b) => b.days - a.days || a.order - b.order);
  return list.sort((a, b) => {
    const ka = attentionKey(a);
    const kb = attentionKey(b);
    return ka[0] - kb[0] || ka[1] - kb[1] || a.order - b.order;
  });
}

/* ---------- mix-ups ---------- */

/**
 * The most common confusions from recorded wrong taps: [{ target, sound, word, grapheme, count, examples }].
 * `sound` is the sound the wrongly tapped picture or letter stands for; for a picture in an
 * "anywhere" round it is null and the word itself is the mix-up. A choice tapped twice in one round
 * counts once.
 */
export function mixUps(progress, limit = 8) {
  const map = new Map();
  let rounds = 0;
  for (const r of allRounds(progress, [1, 2])) { // reading mix-ups are word pictures: not sound mix-ups
    if (!Array.isArray(r.wrong) || !r.wrong.length) continue;
    rounds++;
    const seen = new Set();
    for (const tap of r.wrong) {
      if (!tap) continue;
      const key = tap.s ? `s:${tap.s}` : tap.w ? `w:${tap.w}` : tap.g ? `g:${tap.g}` : null;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const k = `${r.sound}>${key}`;
      if (!map.has(k)) map.set(k, { target: r.sound, sound: tap.s || null, word: tap.s ? null : tap.w || null, grapheme: tap.s ? null : tap.g || null, count: 0, examples: new Set() });
      const x = map.get(k);
      x.count++;
      if (tap.w) x.examples.add(tap.w);
      if (tap.g) x.examples.add(tap.g);
    }
  }
  const list = [...map.values()].map((x) => ({ ...x, examples: [...x.examples] }))
    .sort((a, b) => b.count - a.count || a.target.localeCompare(b.target) || String(a.sound || a.word || a.grapheme).localeCompare(String(b.sound || b.word || b.grapheme)));
  return { list: list.slice(0, limit), total: list.length, rounds };
}

/* ---------- recordings ---------- */

/**
 * recordings: Map or object id -> { trimmed }. Returns which sounds still need recording (game
 * targets first) and which recordings could not be trimmed.
 */
export function recordingStatus(data, recordings) {
  const get = (id) => (recordings instanceof Map ? recordings.get(id) : recordings && recordings[id]);
  const eligible = targetEligibleIds(data);
  const order = introOrder(data);
  const missing = order.filter((s) => !get(s.id));
  return {
    total: order.length,
    recorded: order.length - missing.length,
    missingTargets: missing.filter((s) => eligible.has(s.id)).map((s) => s.id),
    missingOther: missing.filter((s) => !eligible.has(s.id)).map((s) => s.id),
    untrimmed: order.filter((s) => get(s.id) && !get(s.id).trimmed).map((s) => s.id),
  };
}
