// The sync document and its merge rules. Pure functions, shared by the app (js/sync.js) and the
// server functions (api/_lib/core.js), so both sides merge in exactly the same way.
//
// doc = {
//   settings:   { speakWords, roundsPerSession } | null,  settingsAt: ms   (last writer wins)
//               settingsAt 0 means "never changed": roundsPerSession is then the current default.
//   progress:   { s1: { [soundId]: [round] }, s2: {...}, s3: { [wordId]: [round] } },  resetAt: ms
//               (union of rounds by id; s3 is reading, keyed by word id "w:<word>")
//   blendOverride: { on: bool, at: ms } | null    the parent's "ready to blend" switch (last writer wins)
//   readiness:  [ { id, d, pair, asked, chose, correct, at } ]              (union by id)
//   sessions:   [ session ]                                                (union by id)
//   recordings: { [soundId]: { updatedAt, mime, durationMs, trimmed, size } } (last writer wins)
// }
// round = { c: 1|0, d: 'YYYY-MM-DD', id, t: ms, ses?: session id, wrong?: [tap], p?: 1 }
//   p: 1 marks a reading round with no picture check ("practised"): it never counts for mastery.
//   tap = { w: word } (a picture) or { g: grapheme } (a letter), plus s: the sound it stands for
//   (absent for a picture in an "anywhere" round). Rounds played before sessions have neither.
// session = { id, d: 'YYYY-MM-DD', start: ms, end: ms, stages: [1|2|3], rounds, correct, practised? }
//   practised: how many of its rounds were practised reading rounds (no right or wrong answer).
//   A session grows while it is played (same id), so of two versions the one with more rounds wins.
// A progress reset is a tombstone: rounds, readiness results and sessions older than resetAt are dropped.
// Documents written before sessions (or reading) existed simply have none: every field is optional on input.

import { HISTORY_KEEP, WORD_HISTORY_KEEP } from './logic.js';

export const STAGES = ['s1', 's2', 's3'];
/** Sessions kept (newest): about a year of daily play, a few tens of KB. */
export const SESSION_KEEP = 500;
export const MAX_WRONG_TAPS = 8;
export { WORD_HISTORY_KEEP };
/** At most this many words with reading rounds are kept (the doc stays well under its size limit). */
export const MAX_WORDS = 1000;

/* ---------- settings ---------- */

export const ROUNDS_DEFAULT = 10;
export const ROUNDS_MIN = 4;
export const ROUNDS_MAX = 20;

/**
 * Settings as stored and used: speakWords (default on) and roundsPerSession (4 to 20). A family that
 * never changed its settings (settingsAt 0) gets the current default number of rounds, so raising
 * the default reaches them even though their devices sent the old default before.
 */
export function cleanSettings(s, settingsAt = 0) {
  const src = s && typeof s === 'object' ? s : {};
  const n = Math.round(Number(src.roundsPerSession));
  const rounds = Number.isFinite(n) && src.roundsPerSession != null ? Math.min(ROUNDS_MAX, Math.max(ROUNDS_MIN, n)) : ROUNDS_DEFAULT;
  return { speakWords: src.speakWords !== false, roundsPerSession: Number(settingsAt) > 0 ? rounds : ROUNDS_DEFAULT };
}

/* ---------- word ids (reading) ---------- */

/** Reading words are plain lowercase letters; their ids live in their own namespace ("w:mat"). */
export const WORD_RE = /^[a-z]{1,20}$/;
export const WORD_ID_RE = /^w:[a-z]{1,20}$/;
export const wordId = (word) => `w:${word}`;
export const isWordId = (id) => typeof id === 'string' && WORD_ID_RE.test(id);

/**
 * The ids the server accepts: every sound id of sounds.json, plus "w:<word>" for each well-formed
 * word of reading.json (if there is one). Sound ids never contain ":", so the two cannot collide.
 */
export function knownIds(soundsData, readingData = null) {
  const ids = new Set(((soundsData && soundsData.sounds) || []).map((s) => s.id).filter((id) => typeof id === 'string' && !id.includes(':')));
  const words = readingData && Array.isArray(readingData.words) ? readingData.words : [];
  for (const w of words) if (w && WORD_RE.test(w.word)) ids.add(wordId(w.word));
  return ids;
}

export function emptyDoc() {
  return { settings: null, settingsAt: 0, progress: { s1: {}, s2: {}, s3: {} }, resetAt: 0, readiness: [], sessions: [], blendOverride: null, recordings: {} };
}

export function newId() {
  const b = new Uint8Array(9);
  globalThis.crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

/** Family codes are compared after this, so "Tiger Lamp Rose 42" and "tiger-lamp-rose-42" match. */
export function normaliseCode(code) {
  return String(code ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

const num = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0);
// For entries without a time: the earliest moment of that calendar day in any time zone (UTC+14),
// so such an entry always sorts before rounds played later that day.
const dayTime = (d) => { const t = Date.parse(`${d}T00:00:00Z`); return Number.isFinite(t) ? t - 14 * 3600e3 : 0; };

function hashStr(s) {
  // Small stable hash (FNV-1a) for ids of entries made before rounds had ids.
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16);
}

/**
 * Gives every round and readiness result a stable id and time. Entries recorded before sync existed
 * get a deterministic id, so the same old data on two devices (for example via a backup) dedupes.
 */
export function withIds(progress, readiness) {
  const p = { ...(progress || {}) };
  for (const st of STAGES) {
    const stage = {};
    for (const [sid, hist] of Object.entries((progress && progress[st]) || {})) {
      if (!Array.isArray(hist)) continue;
      stage[sid] = hist.map((r, i) => (r && r.id && Number.isFinite(r.t) ? r : {
        ...r,
        id: r && r.id ? r.id : `L${st}-${sid}-${i}-${r && r.d}-${r && r.c}`,
        t: r && Number.isFinite(r.t) ? r.t : dayTime(r && r.d) + i,
      }));
    }
    p[st] = stage;
  }
  const rd = (Array.isArray(readiness) ? readiness : []).map((r, i) => (r && r.id && Number.isFinite(r.at) ? r : {
    ...r,
    id: r && r.id ? r.id : `L${hashStr(JSON.stringify([r && r.d, r && r.pair, r && r.asked, r && r.chose, r && r.correct, r && r.at, i]))}`,
    at: r && Number.isFinite(r.at) ? r.at : dayTime(r && r.d) + i,
  }));
  return { progress: p, readiness: rd };
}

const byTimeThenId = (ta) => (a, b) => (a[ta] - b[ta]) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

function unionById(a, b) {
  const map = new Map();
  for (const x of a || []) if (x && x.id) map.set(x.id, x);
  for (const x of b || []) if (x && x.id && !map.has(x.id)) map.set(x.id, x);
  return [...map.values()];
}

/** Of two versions of one session, the more complete one (more rounds, then later end) wins. */
function newerSession(x, y) {
  const rx = num(x.rounds);
  const ry = num(y.rounds);
  if (rx !== ry) return rx > ry ? x : y;
  const ex = num(x.end);
  const ey = num(y.end);
  if (ex !== ey) return ex > ey ? x : y;
  return canon(x) >= canon(y) ? x : y;
}

export function mergeSessions(a, b) {
  const map = new Map();
  for (const x of [...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])]) {
    if (!x || !x.id) continue;
    const cur = map.get(x.id);
    map.set(x.id, cur ? newerSession(cur, x) : x);
  }
  return [...map.values()];
}

/** Canonical JSON (sorted keys), used for tie-breaks and change detection. */
export function canon(v) {
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`;
  return JSON.stringify(v ?? null);
}

/**
 * Merges two docs without losing data. Commutative: merge(a, b) equals merge(b, a).
 * - rounds: union by id, minus those before the latest reset, oldest first, last HISTORY_KEEP per sound
 * - readiness: union by id, minus those before the latest reset, oldest first
 * - sessions: union by id (the version with more rounds wins), minus those started before the
 *   latest reset, oldest first, the last SESSION_KEEP
 * - settings and each recording: the newer timestamp wins (ties broken deterministically)
 */
export function mergeDocs(a, b) {
  a = a || emptyDoc();
  b = b || emptyDoc();
  const resetAt = Math.max(num(a.resetAt), num(b.resetAt));

  const progress = {};
  for (const st of STAGES) {
    const pa = (a.progress && a.progress[st]) || {};
    const pb = (b.progress && b.progress[st]) || {};
    const out = {};
    for (const sid of [...new Set([...Object.keys(pa), ...Object.keys(pb)])].sort()) {
      const list = unionById(pa[sid], pb[sid]).filter((r) => num(r.t) >= resetAt).sort(byTimeThenId('t')).slice(st === 's3' ? -WORD_HISTORY_KEEP : -HISTORY_KEEP);
      if (list.length) out[sid] = list;
    }
    progress[st] = out;
  }

  const readiness = unionById(a.readiness, b.readiness).filter((r) => num(r.at) >= resetAt).sort(byTimeThenId('at'));
  const sessions = mergeSessions(a.sessions, b.sessions).filter((x) => num(x.start) >= resetAt)
    .sort(byTimeThenId('start')).slice(-SESSION_KEEP);

  let settings;
  let settingsAt;
  if (!a.settings || !b.settings) {
    settings = a.settings || b.settings || null;
    settingsAt = a.settings ? num(a.settingsAt) : b.settings ? num(b.settingsAt) : 0;
  } else {
    const ta = num(a.settingsAt);
    const tb = num(b.settingsAt);
    const pickA = ta !== tb ? ta > tb : canon(a.settings) >= canon(b.settings);
    settings = pickA ? a.settings : b.settings;
    settingsAt = Math.max(ta, tb);
  }
  // Never changed: the current default number of rounds (older devices sent the old default).
  if (settings && !settingsAt && settings.roundsPerSession !== ROUNDS_DEFAULT) settings = { ...settings, roundsPerSession: ROUNDS_DEFAULT };

  const blendOverride = newerOverride(a.blendOverride, b.blendOverride);

  const recordings = {};
  const ra = a.recordings || {};
  const rb = b.recordings || {};
  for (const id of [...new Set([...Object.keys(ra), ...Object.keys(rb)])].sort()) {
    const x = ra[id];
    const y = rb[id];
    if (!x || !y) { recordings[id] = x || y; continue; }
    const tx = num(x.updatedAt);
    const ty = num(y.updatedAt);
    recordings[id] = tx !== ty ? (tx > ty ? x : y) : (canon(x) >= canon(y) ? x : y);
  }

  return { settings, settingsAt, progress, resetAt, readiness, sessions, blendOverride, recordings };
}

/** The parent's "ready to blend" switch: the later change wins (ties: on wins). */
function newerOverride(x, y) {
  const ok = (o) => o && typeof o === 'object' && Number.isFinite(Number(o.at));
  if (!ok(x)) return ok(y) ? { on: !!y.on, at: num(y.at) } : null;
  if (!ok(y)) return { on: !!x.on, at: num(x.at) };
  const tx = num(x.at);
  const ty = num(y.at);
  const w = tx !== ty ? (tx > ty ? x : y) : (x.on ? x : y);
  return { on: !!w.on, at: num(w.at) };
}

/** The parts of a doc a client sends with PUT /api/state (recordings travel separately). */
export function coreOf(doc) {
  const d = doc || emptyDoc();
  return {
    settings: d.settings || null, settingsAt: num(d.settingsAt), progress: d.progress || { s1: {}, s2: {}, s3: {} },
    resetAt: num(d.resetAt), readiness: d.readiness || [], sessions: d.sessions || [], blendOverride: d.blendOverride || null,
  };
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const ID = /^[A-Za-z0-9_.:+-]{1,120}$/;
const str = (x, max) => (typeof x === 'string' && x.length <= max ? x : null);

/**
 * Server-side input check: keeps only well-formed entries for known sound ids, so a buggy or hostile
 * client cannot store arbitrary data. Returns a core doc (no recordings).
 */
export function sanitiseCore(input, validIds) {
  const d = input && typeof input === 'object' ? input : {};
  const out = coreOf(emptyDoc());
  if (d.settings && typeof d.settings === 'object') {
    out.settingsAt = Math.max(0, num(d.settingsAt));
    out.settings = cleanSettings(d.settings, out.settingsAt);
  }
  out.resetAt = Math.max(0, num(d.resetAt));
  const bo = d.blendOverride;
  if (bo && typeof bo === 'object' && Number.isFinite(Number(bo.at)) && Number(bo.at) >= 0) out.blendOverride = { on: !!bo.on, at: num(bo.at) };
  for (const st of STAGES) {
    const stage = (d.progress && d.progress[st]) || {};
    if (typeof stage !== 'object') continue;
    let words = 0;
    for (const [sid, hist] of Object.entries(stage)) {
      if (!Array.isArray(hist)) continue;
      if (st === 's3') {
        // Reading: any well-formed word id, so a change to the word list never drops a child's
        // rounds (bounded by MAX_WORDS). Sound stages: known sound ids only.
        if (!isWordId(sid) || ++words > MAX_WORDS) continue;
      } else if (!validIds.has(sid) || isWordId(sid)) continue;
      const list = hist.slice(-200).filter((r) => r && typeof r === 'object' && typeof r.id === 'string' && ID.test(r.id)
        && Number.isFinite(r.t) && typeof r.d === 'string' && (DAY.test(r.d) || r.d.length <= 20))
        .map(cleanRound);
      if (list.length) out.progress[st][sid] = list;
    }
  }
  out.readiness = (Array.isArray(d.readiness) ? d.readiness : []).slice(-2000)
    .filter((r) => r && typeof r === 'object' && typeof r.id === 'string' && ID.test(r.id) && Number.isFinite(r.at))
    .map((r) => {
      const o = { id: r.id, at: r.at };
      for (const [k, max] of [['d', 20], ['pair', 80], ['asked', 80], ['chose', 80]]) if (str(r[k], max) != null) o[k] = r[k];
      if ('correct' in r) o.correct = !!r.correct;
      return o;
    });
  out.sessions = (Array.isArray(d.sessions) ? d.sessions : []).slice(-SESSION_KEEP * 2).map(cleanSession).filter(Boolean);
  return out;
}

const count = (x) => Math.min(10000, Math.max(0, Math.round(num(x))));

/** A round as stored: the fields a client writes, nothing else. Older rounds have no ses or wrong. */
function cleanRound(r) {
  const o = { c: r.c ? 1 : 0, d: r.d, id: r.id, t: r.t };
  if (typeof r.ses === 'string' && ID.test(r.ses)) o.ses = r.ses;
  if (r.p) { o.p = 1; o.c = 0; }
  if (Array.isArray(r.wrong)) {
    const taps = r.wrong.slice(0, MAX_WRONG_TAPS).map((x) => {
      if (!x || typeof x !== 'object') return null;
      const tap = {};
      if (str(x.w, 40) != null) tap.w = x.w;
      else if (str(x.g, 12) != null) tap.g = x.g;
      else return null;
      // Any well-formed id is kept (not only known sounds), so a client and the server always agree.
      if (typeof x.s === 'string' && ID.test(x.s)) tap.s = x.s;
      return tap;
    }).filter(Boolean);
    if (taps.length) o.wrong = taps;
  }
  return o;
}

function cleanSession(x) {
  if (!x || typeof x !== 'object' || typeof x.id !== 'string' || !ID.test(x.id)) return null;
  if (!Number.isFinite(x.start) || !Number.isFinite(x.end)) return null;
  const o = { id: x.id, start: x.start, end: Math.max(x.start, x.end), rounds: count(x.rounds), correct: count(x.correct) };
  if (typeof x.d === 'string' && DAY.test(x.d)) o.d = x.d;
  o.stages = Array.isArray(x.stages) ? [...new Set(x.stages.filter((v) => v === 1 || v === 2 || v === 3))].sort() : [];
  o.correct = Math.min(o.correct, o.rounds);
  if (x.practised != null && count(x.practised) > 0) o.practised = Math.min(count(x.practised), o.rounds - o.correct);
  return o;
}
