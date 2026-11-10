// Scheduling and mastery. Pure functions only: no DOM, no storage, no clock.
// Randomness comes in as `rng` (a function returning [0,1)) and dates as 'YYYY-MM-DD' strings.

export const HISTORY_KEEP = 12;
export const MIN_WORDS_FOR_TARGET = 3;
export const REVIEW_SHARE = 0.25;
export const MAX_LEARNING_BEFORE_NEW = 3;
export const MAX_NEW_PER_SESSION = 2;

/* ---------- small helpers ---------- */

export function dayKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Deterministic PRNG for tests and reproducible sessions. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pick(list, rng) {
  return list[Math.floor(rng() * list.length)];
}

export function shuffle(list, rng) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const soundById = (data) => new Map(data.sounds.map((s) => [s.id, s]));
export const displayGrapheme = (sound) => sound.graphemes[0];

export function wordsStartingWith(data, id) {
  return data.words.filter((w) => w.phonemes[0] === id);
}

/** Sounds usable as targets in stages 1 and 2: at least 3 words start with them. */
export function targetEligibleIds(data) {
  const counts = new Map();
  for (const w of data.words) counts.set(w.phonemes[0], (counts.get(w.phonemes[0]) || 0) + 1);
  return new Set(data.sounds.filter((s) => (counts.get(s.id) || 0) >= MIN_WORDS_FOR_TARGET).map((s) => s.id));
}

/** Sounds in group order, then file order. */
export function introOrder(data) {
  return data.sounds
    .map((s, i) => ({ s, i }))
    .sort((x, y) => x.s.group - y.s.group || x.i - y.i)
    .map((x) => x.s);
}

/* ---------- mastery ---------- */

/** history: [{ c: 1|0 (first-tap correct), d: 'YYYY-MM-DD' }], oldest first. */
export function soundStatus(history) {
  if (!history || history.length === 0) return 'not_started';
  const last = history.slice(-6);
  if (last.length < 6) return 'learning';
  const correct = last.filter((r) => r.c).length;
  const days = new Set(last.map((r) => r.d)).size;
  return correct >= 5 && days >= 2 ? 'solid' : 'learning';
}

export function historyOf(progress, stage, id) {
  return (progress && progress[`s${stage}`] && progress[`s${stage}`][id]) || [];
}

export function statusOf(progress, stage, id) {
  return soundStatus(historyOf(progress, stage, id));
}

/** Returns a new progress object with one round appended (immutably). */
export function recordRound(progress, stage, id, correct, day) {
  const key = `s${stage}`;
  const base = progress || {};
  const prevStage = base[key] || {};
  const hist = [...(prevStage[id] || []), { c: correct ? 1 : 0, d: day }].slice(-HISTORY_KEEP);
  return { ...base, [key]: { ...prevStage, [id]: hist } };
}

/** 2 choices normally; 3 once the sound is "going well" (solid, or 3 of the last 4 first-tap correct). */
export function choiceCount(history) {
  if (soundStatus(history) === 'solid') return 3;
  const last4 = (history || []).slice(-4);
  return last4.length === 4 && last4.filter((r) => r.c).length >= 3 ? 3 : 2;
}

/* ---------- what is available ---------- */

/**
 * Groups the child may play. The first group is always open. A later group opens once
 * every target-eligible sound of the previous group is recorded and solid in stage 1.
 */
export function unlockedGroups(data, recorded, progress) {
  const eligible = targetEligibleIds(data);
  const groups = [...new Set(data.sounds.map((s) => s.group))].sort((a, b) => a - b);
  const open = new Set();
  for (let i = 0; i < groups.length; i++) {
    if (i === 0) { open.add(groups[0]); continue; }
    const prev = data.sounds.filter((s) => s.group === groups[i - 1] && eligible.has(s.id));
    const prevDone = prev.every((s) => recorded.has(s.id) && statusOf(progress, 1, s.id) === 'solid');
    if (!prevDone) break;
    open.add(groups[i]);
  }
  return open;
}

/** Target candidates for a stage, in introduction order. */
export function candidates(data, recorded, progress, stage) {
  const eligible = targetEligibleIds(data);
  if (stage === 1) {
    const open = unlockedGroups(data, recorded, progress);
    return introOrder(data).filter((s) => eligible.has(s.id) && recorded.has(s.id) && open.has(s.group));
  }
  return introOrder(data).filter(
    (s) => eligible.has(s.id) && recorded.has(s.id) && statusOf(progress, 1, s.id) === 'solid',
  );
}

/** The parent needs only the first group recorded (its target-eligible sounds) to start. */
export function canPlay(data, recorded) {
  const eligible = targetEligibleIds(data);
  const first = Math.min(...data.sounds.map((s) => s.group));
  const needed = data.sounds.filter((s) => s.group === first && eligible.has(s.id));
  return needed.length > 0 && needed.every((s) => recorded.has(s.id));
}

export function groupProgress(data, recorded) {
  const groups = [...new Set(data.sounds.map((s) => s.group))].sort((a, b) => a - b);
  return groups.map((g) => {
    const sounds = introOrder(data).filter((s) => s.group === g);
    return { group: g, sounds, recorded: sounds.filter((s) => recorded.has(s.id)).length, total: sounds.length };
  });
}

/* ---------- choosing a target ---------- */

/**
 * Mostly "learning" sounds, about a quarter review of solid ones. A new sound is introduced only
 * when no more than 3 are learning (and at most MAX_NEW_PER_SESSION per session, per stage).
 * Returns { sound, reason: 'review' | 'new' | 'learning' } or null.
 */
export function chooseTarget({ cands, progress, stage, rng, lastId = null, newThisSession = 0 }) {
  if (!cands.length) return null;
  const st = (s) => statusOf(progress, stage, s.id);
  const learning = cands.filter((s) => st(s) === 'learning');
  const solid = cands.filter((s) => st(s) === 'solid');
  const fresh = cands.filter((s) => st(s) === 'not_started');
  const notLast = (list) => (list.length > 1 ? list.filter((s) => s.id !== lastId) : list);

  const canIntroduce = fresh.length > 0 && learning.length <= MAX_LEARNING_BEFORE_NEW
    && newThisSession < MAX_NEW_PER_SESSION;
  const r = rng();
  if (solid.length && (r < REVIEW_SHARE || (!learning.length && !canIntroduce))) {
    return { sound: pick(notLast(solid), rng), reason: 'review' };
  }
  if (canIntroduce) return { sound: fresh[0], reason: 'new' };
  if (learning.length) return { sound: pick(notLast(learning), rng), reason: 'learning' };
  // Only not-started sounds remain but the per-session limit is reached: keep playing them anyway.
  return { sound: fresh[0], reason: 'new' };
}

/* ---------- distractors ---------- */

/**
 * Sound ids a distractor must not start with / be:
 * - the target itself and any sound displaying the same grapheme (e.g. th_unvoiced / th_voiced);
 * - while the target is not solid, its confusable sounds (both directions).
 */
export function blockedIds(data, target, targetStatus) {
  const blocked = new Set([target.id]);
  for (const s of data.sounds) {
    if (displayGrapheme(s) === displayGrapheme(target)) blocked.add(s.id);
  }
  if (targetStatus !== 'solid') {
    for (const c of target.confusable || []) blocked.add(c);
    for (const s of data.sounds) if ((s.confusable || []).includes(target.id)) blocked.add(s.id);
  }
  return blocked;
}

function confusableSet(data, target) {
  const set = new Set(target.confusable || []);
  for (const s of data.sounds) if ((s.confusable || []).includes(target.id)) set.add(s.id);
  return set;
}

/**
 * Picture choices: one word starting with the target, n-1 distractors each starting with a different,
 * allowed sound. Returns [{ kind:'word', word, emoji, soundId, correct }] in random order.
 */
export function pickPictureChoices({ data, target, targetStatus, n, rng, avoidWord = null }) {
  const own = wordsStartingWith(data, target.id);
  const ownPool = own.length > 1 ? own.filter((w) => w.word !== avoidWord) : own;
  const answer = pick(ownPool, rng);
  const blocked = blockedIds(data, target, targetStatus);
  const pool = data.words.filter((w) => !blocked.has(w.phonemes[0]) && w.emoji !== answer.emoji);
  const byFirst = new Map();
  for (const w of pool) byFirst.set(w.phonemes[0], [...(byFirst.get(w.phonemes[0]) || []), w]);

  let firsts = shuffle([...byFirst.keys()], rng);
  if (targetStatus === 'solid' && rng() < 0.5) {
    // Review rounds may be harder: put a confusable sound first when one is available.
    const conf = confusableSet(data, target);
    firsts = [...firsts.filter((f) => conf.has(f)), ...firsts.filter((f) => !conf.has(f))];
  }
  const distractors = [];
  const usedEmoji = new Set([answer.emoji]);
  for (const f of firsts) {
    if (distractors.length >= n - 1) break;
    const options = byFirst.get(f).filter((w) => !usedEmoji.has(w.emoji));
    if (!options.length) continue;
    const w = pick(options, rng);
    usedEmoji.add(w.emoji);
    distractors.push(w);
  }
  const toChoice = (w, correct) => ({ kind: 'word', word: w.word, emoji: w.emoji, soundId: w.phonemes[0], correct });
  return shuffle([toChoice(answer, true), ...distractors.map((w) => toChoice(w, false))], rng);
}

/**
 * Letter choices: the target's grapheme plus n-1 others, all displaying different graphemes.
 * Prefers distractor sounds the parent has recorded (familiar to the family), falls back to any.
 */
export function pickLetterChoices({ data, target, targetStatus, n, rng, preferIds = new Set() }) {
  const blocked = blockedIds(data, target, targetStatus);
  const pool = data.sounds.filter((s) => !blocked.has(s.id));
  let ordered = [
    ...shuffle(pool.filter((s) => preferIds.has(s.id)), rng),
    ...shuffle(pool.filter((s) => !preferIds.has(s.id)), rng),
  ];
  if (targetStatus === 'solid' && rng() < 0.5) {
    const conf = confusableSet(data, target);
    ordered = [...ordered.filter((s) => conf.has(s.id)), ...ordered.filter((s) => !conf.has(s.id))];
  }
  const used = new Set([displayGrapheme(target)]);
  const picked = [];
  for (const s of ordered) {
    if (picked.length >= n - 1) break;
    if (used.has(displayGrapheme(s))) continue;
    used.add(displayGrapheme(s));
    picked.push(s);
  }
  const toChoice = (s, correct) => ({ kind: 'letter', grapheme: displayGrapheme(s), soundId: s.id, correct });
  return shuffle([toChoice(target, true), ...picked.map((s) => toChoice(s, false))], rng);
}

/* ---------- planning a round ---------- */

function hasWork(cands, progress, stage) {
  return cands.some((s) => statusOf(progress, stage, s.id) !== 'solid');
}

/**
 * Plan the next round. Returns null when nothing is playable.
 * { stage: 1|2, mode: 'hear'|'see-letter'|'pick-letter', target, reason, choices }
 */
export function planRound({ data, recorded, progress, rng, lastId = null, lastWord = null, newCount = { 1: 0, 2: 0 } }) {
  const c1 = candidates(data, recorded, progress, 1);
  const c2 = candidates(data, recorded, progress, 2);
  if (!c1.length && !c2.length) return null;
  let stage;
  if (!c2.length) stage = 1;
  else if (!c1.length) stage = 2;
  else {
    const w1 = hasWork(c1, progress, 1);
    const w2 = hasWork(c2, progress, 2);
    const p2 = w2 ? (w1 ? 0.5 : 0.8) : 0.3;
    stage = rng() < p2 ? 2 : 1;
  }
  const chosen = chooseTarget({
    cands: stage === 1 ? c1 : c2, progress, stage, rng, lastId, newThisSession: newCount[stage] || 0,
  });
  const target = chosen.sound;
  const targetStatus = statusOf(progress, stage, target.id);
  const n = choiceCount(historyOf(progress, stage, target.id));
  const base = { stage, target, reason: chosen.reason, targetStatus };
  if (stage === 1) {
    return { ...base, mode: 'hear', choices: pickPictureChoices({ data, target, targetStatus, n, rng, avoidWord: lastWord }) };
  }
  if (rng() < 0.5) {
    return { ...base, mode: 'see-letter', choices: pickPictureChoices({ data, target, targetStatus, n, rng, avoidWord: lastWord }) };
  }
  return { ...base, mode: 'pick-letter', choices: pickLetterChoices({ data, target, targetStatus, n, rng, preferIds: recorded }) };
}

/* ---------- readiness check ---------- */

/** First group solid in stage 2, pairs exist, and not already done today. */
export function readinessEligible({ data, recorded, progress, results, today }) {
  if (!data.readinessPairs || !data.readinessPairs.length) return false;
  if ((results || []).some((r) => r.d === today)) return false;
  const eligible = targetEligibleIds(data);
  const first = Math.min(...data.sounds.map((s) => s.group));
  const sounds = data.sounds.filter((s) => s.group === first && eligible.has(s.id));
  return sounds.length > 0
    && sounds.every((s) => recorded.has(s.id) && statusOf(progress, 2, s.id) === 'solid');
}

/** ask 'ab' means "which one is <a><b>?"; rows is the stacked display order (top first). */
export function planReadiness(data, rng) {
  const pair = pick(data.readinessPairs, rng);
  const ask = rng() < 0.5 ? 'ab' : 'ba';
  const rows = shuffle(['ab', 'ba'], rng);
  return { pair, ask, rows };
}

export function readinessPassedDays(results) {
  return new Set((results || []).filter((r) => r.correct).map((r) => r.d)).size;
}

export function readinessByDate(results) {
  const map = new Map();
  for (const r of results || []) map.set(r.d, [...(map.get(r.d) || []), r]);
  return [...map.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1)).map(([d, list]) => ({ d, list, passed: list.some((r) => r.correct) }));
}
