// Reading ("Read it", stage 3): the word list, its validation, and the pure rules for availability,
// unlocking, mastery, scheduling, picture distractors and the timing of the blend lights.
// No DOM, no storage, no clock: it runs in Node tests too.
//
// data/reading.json = { version: 1, words: [ { word, graphemes[], phonemes[], level (1-4), emoji? } ] }
// graphemes and phonemes align one to one; each phoneme is a sound id of sounds.json.
// Levels: 1 VC/CVC starting with a continuous sound, 2 CVC starting with a stop, 3 consonant blends,
// 4 digraphs or unit sounds.

import { soundStatus, historyOf, statusOf, readinessPassedDays, shuffle, pick, MAX_LEARNING_BEFORE_NEW, REVIEW_SHARE } from './logic.js';
import { VOWEL_IDS } from './data.js';
import { wordId, WORD_RE } from './syncdoc.js';

export { wordId };
export const READ_STAGE = 3;
export const LEVELS = [1, 2, 3, 4];
export const READINESS_DAYS_NEEDED = 3;
export const MAX_NEW_WORDS_PER_SESSION = 2;
/** Every third round of a session is a reading round once stage 3 is unlocked. */
export const READING_EVERY = 3;
/** Light weights: a continuous sound is held, a stop is short. */
export const WEIGHT = { continuous: 1.0, stop: 0.4 };
/** A slide counts when it starts in the left part of the road and moves right this far (fractions of the road). */
export const SLIDE_START_ZONE = 0.35;
export const SLIDE_MIN_MOVE = 0.08;

const isStr = (v) => typeof v === 'string' && v.trim().length > 0;

/* ---------- validation ---------- */

/** Unit sounds: one letter for two sounds (x is k+s, qu is k+w). */
export const UNIT_SOUNDS = new Set(['x', 'qu']);

/** The level a word's sounds suggest (used for warnings only; the file's level is what counts). */
export function expectedLevel(entry, soundsById) {
  const ph = entry.phonemes;
  if (entry.graphemes.some((g) => g.length > 1) || ph.some((p) => UNIT_SOUNDS.has(p))) return 4;
  const vowel = (p) => VOWEL_IDS.has(p);
  for (let i = 1; i < ph.length; i++) if (!vowel(ph[i]) && !vowel(ph[i - 1])) return 3;
  const first = soundsById.get(ph[0]);
  return first && first.kind === 'stop' ? 2 : 1;
}

/**
 * Validates reading.json against the sounds. File-level problems are errors (stage 3 is then not
 * available). A word with a problem is left out (listed in warnings); the file is still usable as
 * long as at least one word is fine.
 * Returns { ok, errors, warnings, words } where words are the usable entries, in file order.
 */
export function validateReading(d, soundsData) {
  const errors = [];
  const warnings = [];
  if (!d || typeof d !== 'object' || Array.isArray(d)) return { ok: false, errors: ['The reading data must be a JSON object.'], warnings, words: [] };
  if (d.version !== 1) errors.push(`version must be 1 (found ${JSON.stringify(d.version)}).`);
  if (!Array.isArray(d.words)) errors.push('words must be an array.');
  if (errors.length) return { ok: false, errors, warnings, words: [] };

  const sounds = new Map(((soundsData && soundsData.sounds) || []).map((s) => [s.id, s]));
  const seen = new Set();
  const words = [];
  d.words.forEach((w, i) => {
    const at = `words[${i}]${w && isStr(w.word) ? ` (${w.word})` : ''}`;
    const problems = [];
    if (!w || typeof w !== 'object' || Array.isArray(w)) { warnings.push(`${at} is not an object: left out.`); return; }
    if (!isStr(w.word) || !WORD_RE.test(w.word)) problems.push('word must be 1 to 20 lowercase letters a to z');
    else if (seen.has(w.word)) problems.push('is listed more than once');
    const gOk = Array.isArray(w.graphemes) && w.graphemes.length > 0 && w.graphemes.every(isStr);
    const pOk = Array.isArray(w.phonemes) && w.phonemes.length > 0 && w.phonemes.every((p) => typeof p === 'string');
    if (!gOk) problems.push('graphemes must be a non-empty array of strings');
    if (!pOk) problems.push('phonemes must be a non-empty array of sound ids');
    if (gOk && pOk) {
      if (w.graphemes.length !== w.phonemes.length) problems.push(`has ${w.graphemes.length} graphemes but ${w.phonemes.length} phonemes (they must align one to one)`);
      if (w.graphemes.some((g) => g !== g.toLowerCase())) problems.push('graphemes must be lowercase');
      if (isStr(w.word) && w.graphemes.join('') !== w.word) problems.push(`graphemes "${w.graphemes.join(' ')}" do not spell "${w.word}"`);
      for (const p of w.phonemes) if (!sounds.has(p)) problems.push(`phonemes has unknown sound id ${JSON.stringify(p)}`);
    }
    if (!Number.isInteger(w.level) || w.level < 1 || w.level > 4) problems.push(`level must be 1, 2, 3 or 4 (found ${JSON.stringify(w.level)})`);
    if (w.emoji !== undefined && !isStr(w.emoji)) problems.push('emoji must be a non-empty string when given');
    if (problems.length) { warnings.push(`${at} is left out: ${problems.join('; ')}.`); return; }
    seen.add(w.word);
    // Letters never change their sound: each tile should show a letter the child learnt for that sound.
    w.graphemes.forEach((g, k) => {
      const s = sounds.get(w.phonemes[k]);
      if (!s.graphemes.includes(g)) warnings.push(`${at}: "${g}" is not one of the letters of sound ${s.id} (${s.graphemes.join(', ')}).`);
      else if (s.graphemes[0] !== g) warnings.push(`${at}: "${g}" stands for ${s.id}, but See it shows that sound as "${s.graphemes[0]}".`);
    });
    const lvl = expectedLevel(w, sounds);
    if (lvl !== w.level) warnings.push(`${at}: level ${w.level}, but its sounds suggest level ${lvl}.`);
    words.push(w);
  });
  if (!words.length) errors.push('No usable words: every word has a problem (see the warnings).');
  return { ok: errors.length === 0, errors, warnings, words };
}

/** Fetches and validates. Never throws: { data: { version, words } | null, report }. */
export async function loadReading(url, soundsData, fetchFn = globalThis.fetch) {
  const fail = (msg) => ({ data: null, report: { ok: false, errors: [msg], warnings: [], words: [], missing: true } });
  let res;
  try { res = await fetchFn(url, { cache: 'no-cache' }); } catch (e) { return fail(`Could not fetch ${url}: ${e.message}`); }
  if (!res.ok) return fail(`Could not fetch ${url} (HTTP ${res.status}).`);
  let json;
  try { json = await res.json(); } catch (e) { return { data: null, report: { ok: false, errors: [`${url} is not valid JSON: ${e.message}`], warnings: [], words: [] } }; }
  const report = validateReading(json, soundsData);
  return { data: report.ok ? { version: 1, words: report.words } : null, report };
}

/* ---------- words and sounds ---------- */

const soundMap = (data) => new Map(data.sounds.map((s) => [s.id, s]));

/** Word entries with their id, in level order then file order. */
export function orderedWords(reading) {
  const words = (reading && reading.words) || [];
  return words.map((w, i) => ({ w, i })).sort((a, b) => a.w.level - b.w.level || a.i - b.i).map(({ w }) => ({ ...w, id: wordId(w.word) }));
}

/** The sounds of a word that are not yet solid in See it (stage 2). */
export function unsolidSounds(entry, progress) {
  return [...new Set(entry.phonemes.filter((p) => statusOf(progress, 2, p) !== 'solid'))];
}

/** Every sound of the word is solid in See it. */
export const soundsReady = (entry, progress) => unsolidSounds(entry, progress).length === 0;

/** Available to play: every sound solid in See it AND the parent has recorded the word. */
export function wordAvailable(entry, progress, recorded) {
  return recorded.has(wordId(entry.word)) && soundsReady(entry, progress);
}

export function availableWords(reading, progress, recorded) {
  return orderedWords(reading).filter((w) => wordAvailable(w, progress, recorded));
}

/**
 * The studio's Words tab: words whose sounds are all solid in See it, level then file order, the
 * unrecorded ones first. { next: the first `n` unrecorded, ready: all ready words, all: every word }.
 */
export function wordsToRecord(reading, progress, recorded, n = 5) {
  const all = orderedWords(reading);
  const ready = all.filter((w) => soundsReady(w, progress));
  const todo = ready.filter((w) => !recorded.has(w.id));
  return { next: todo.slice(0, n), todo, ready, all };
}

/**
 * The example respelling for the parent: continuous sounds held (tripled), stops as they are.
 * A one-letter continuous sound is written three times ("mmm"); a longer one gets its last letter
 * twice more ("shhh"). mat -> "mmmaaat", ship -> "shhhiiip".
 */
export function stretched(entry, data) {
  const sounds = soundMap(data);
  return entry.graphemes.map((g, i) => {
    const s = sounds.get(entry.phonemes[i]);
    if (!s || s.kind !== 'continuous') return g;
    return g.length === 1 ? g.repeat(3) : g + g.slice(-1).repeat(2);
  }).join('');
}

/** Light weights per grapheme: continuous sounds about 1.0, stops about 0.4. */
export function graphemeWeights(entry, data) {
  const sounds = soundMap(data);
  return entry.phonemes.map((p) => WEIGHT[(sounds.get(p) || {}).kind] ?? WEIGHT.continuous);
}

/** Splits a recording's duration across the graphemes by weight: [{ start, end }] in ms, contiguous. */
export function graphemeTimings(entry, data, durationMs) {
  const w = graphemeWeights(entry, data);
  const total = w.reduce((a, b) => a + b, 0) || 1;
  const d = Math.max(0, Number(durationMs) || 0);
  let t = 0;
  return w.map((x, i) => {
    const start = t;
    t = i === w.length - 1 ? d : t + (d * x) / total;
    return { start: Math.round(start), end: Math.round(t) };
  });
}

/**
 * Slide along the road, as fractions of its width (0 = left end): 'go' once a slide that started in
 * the left part has moved far enough to the right; otherwise 'wait'. Starting in the middle or
 * sliding back never starts the blend.
 */
export function slideDecision(startFrac, curFrac) {
  if (!(startFrac <= SLIDE_START_ZONE)) return 'wait';
  return curFrac - startFrac >= SLIDE_MIN_MOVE ? 'go' : 'wait';
}

/* ---------- mastery ---------- */

/** Rounds that count for mastery: those with a picture check (not "practised"). */
export const checkedRounds = (history) => (history || []).filter((r) => r && !r.p);

/**
 * A word's status: the same "solid" rule as sounds (5 of the last 6 first-try correct, over at least
 * 2 days) on its picture-check rounds. A word played only without a picture check is 'practised'.
 */
export function wordStatus(progress, id) {
  const hist = historyOf(progress, READ_STAGE, id);
  const checked = checkedRounds(hist);
  if (checked.length) return soundStatus(checked);
  return hist.length ? 'practised' : 'not_started';
}

/* ---------- unlock ---------- */

/** override: { on, at } | null (the parent's "ready to blend" switch). */
export function blendReady(readiness, override) {
  const days = readinessPassedDays(readiness);
  const byOverride = !!(override && override.on);
  return { ready: days >= READINESS_DAYS_NEEDED || byOverride, days, needed: READINESS_DAYS_NEEDED, byOverride, byCheck: days >= READINESS_DAYS_NEEDED };
}

/**
 * Stage 3 is available when (a) the readiness check was passed on 3 separate days or the parent
 * turned the switch on, and (b) at least one word is available.
 */
export function readingUnlock({ reading, progress, recorded, readiness, override }) {
  const r = blendReady(readiness, override);
  const available = reading ? availableWords(reading, progress, recorded) : [];
  return { ...r, hasData: !!reading, available, unlocked: !!reading && r.ready && available.length > 0 };
}

/* ---------- picture check ---------- */

/** Words with a picture. */
export const picturable = (w) => isStr(w.emoji);

/**
 * The other picture for a picture check: an available word with a different picture. Preferred in
 * order: same level and a different first sound; another level and a different first sound; same
 * level; any. Returns null when there is none (the round then has no picture check).
 */
export function pickDistractor(target, available, rng) {
  if (!picturable(target)) return null;
  const pool = available.filter((w) => w.word !== target.word && picturable(w) && w.emoji !== target.emoji);
  if (!pool.length) return null;
  const diffFirst = (w) => w.phonemes[0] !== target.phonemes[0];
  const tiers = [
    pool.filter((w) => w.level === target.level && diffFirst(w)),
    pool.filter((w) => w.level !== target.level && diffFirst(w)),
    pool.filter((w) => w.level === target.level),
    pool,
  ];
  const tier = tiers.find((t) => t.length);
  return pick(tier, rng);
}

/** The two picture choices in random order, or null. */
export function pictureChoices(target, available, rng) {
  const other = pickDistractor(target, available, rng);
  if (!other) return null;
  return shuffle([
    { word: target.word, emoji: target.emoji, correct: true },
    { word: other.word, emoji: other.emoji, correct: false },
  ], rng);
}

/* ---------- scheduling ---------- */

/** Round indices (0-based) of a session of `total` rounds that are reading rounds: every third. */
export function readingSlots(total) {
  const out = new Set();
  for (let i = READING_EVERY - 1; i < total; i += READING_EVERY) out.add(i);
  return out;
}

/**
 * Chooses the word for a reading round from the available words (never a word without a
 * recording: those are not available). Mostly learning (and practised) words, about a quarter
 * review of solid ones; a new word only while no more than 3 are learning, and never more than
 * MAX_NEW_WORDS_PER_SESSION per session. Returns { word, reason } or null (no suitable word).
 */
export function chooseWord({ available, progress, rng, newThisSession = 0, lastId = null }) {
  if (!available.length) return null;
  const st = (w) => wordStatus(progress, w.id);
  const learning = available.filter((w) => st(w) === 'learning' || st(w) === 'practised');
  const solid = available.filter((w) => st(w) === 'solid');
  const fresh = available.filter((w) => st(w) === 'not_started');
  const notLast = (list) => (list.length > 1 ? list.filter((w) => w.id !== lastId) : list);
  const canIntroduce = fresh.length > 0 && newThisSession < MAX_NEW_WORDS_PER_SESSION
    && available.filter((w) => st(w) === 'learning').length <= MAX_LEARNING_BEFORE_NEW;
  const r = rng();
  if (solid.length && (r < REVIEW_SHARE || (!learning.length && !canIntroduce))) return { word: pick(notLast(solid), rng), reason: 'review' };
  if (canIntroduce && (!learning.length || r < 0.6)) return { word: fresh[0], reason: 'new' };
  if (learning.length) return { word: pick(notLast(learning), rng), reason: 'learning' };
  if (canIntroduce) return { word: fresh[0], reason: 'new' };
  return null; // only new words left and this session's two are used: a sound round instead
}

/**
 * Plans a reading round, or null. speech: whether the fast version can be spoken (affects nothing
 * here, but kept in the plan for the screen). { word, reason, choices: [2] | null }.
 */
export function planReading({ reading, progress, recorded, rng, newThisSession = 0, lastId = null }) {
  const available = availableWords(reading, progress, recorded);
  const chosen = chooseWord({ available, progress, rng, newThisSession, lastId });
  if (!chosen) return null;
  return { word: chosen.word, reason: chosen.reason, choices: pictureChoices(chosen.word, available, rng) };
}
