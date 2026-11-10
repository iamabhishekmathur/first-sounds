// The sync document and its merge rules. Pure functions, shared by the app (js/sync.js) and the
// server functions (api/_lib/core.js), so both sides merge in exactly the same way.
//
// doc = {
//   settings:   { speakWords, roundsPerSession } | null,  settingsAt: ms   (last writer wins)
//   progress:   { s1: { [soundId]: [round] }, s2: {...} },  resetAt: ms     (union of rounds by id)
//   readiness:  [ { id, d, pair, asked, chose, correct, at } ]              (union by id)
//   sessions:   [ session ]                                                (union by id)
//   recordings: { [soundId]: { updatedAt, mime, durationMs, trimmed, size } } (last writer wins)
// }
// round = { c: 1|0, d: 'YYYY-MM-DD', id, t: ms, ses?: session id, wrong?: [tap] }
//   tap = { w: word } (a picture) or { g: grapheme } (a letter), plus s: the sound it stands for
//   (absent for a picture in an "anywhere" round). Rounds played before sessions have neither.
// session = { id, d: 'YYYY-MM-DD', start: ms, end: ms, stages: [1|2], rounds, correct }
//   A session grows while it is played (same id), so of two versions the one with more rounds wins.
// A progress reset is a tombstone: rounds, readiness results and sessions older than resetAt are dropped.
// Documents written before sessions existed simply have none: every field is optional on input.

import { HISTORY_KEEP } from './logic.js';

export const STAGES = ['s1', 's2'];
/** Sessions kept (newest): about a year of daily play, a few tens of KB. */
export const SESSION_KEEP = 500;
export const MAX_WRONG_TAPS = 8;

export function emptyDoc() {
  return { settings: null, settingsAt: 0, progress: { s1: {}, s2: {} }, resetAt: 0, readiness: [], sessions: [], recordings: {} };
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
      const list = unionById(pa[sid], pb[sid]).filter((r) => num(r.t) >= resetAt).sort(byTimeThenId('t')).slice(-HISTORY_KEEP);
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

  return { settings, settingsAt, progress, resetAt, readiness, sessions, recordings };
}

/** The parts of a doc a client sends with PUT /api/state (recordings travel separately). */
export function coreOf(doc) {
  const d = doc || emptyDoc();
  return {
    settings: d.settings || null, settingsAt: num(d.settingsAt), progress: d.progress || { s1: {}, s2: {} },
    resetAt: num(d.resetAt), readiness: d.readiness || [], sessions: d.sessions || [],
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
    const n = Math.round(Number(d.settings.roundsPerSession));
    out.settings = { speakWords: d.settings.speakWords !== false, roundsPerSession: Number.isFinite(n) ? Math.min(10, Math.max(4, n)) : 6 };
    out.settingsAt = Math.max(0, num(d.settingsAt));
  }
  out.resetAt = Math.max(0, num(d.resetAt));
  for (const st of STAGES) {
    const stage = (d.progress && d.progress[st]) || {};
    if (typeof stage !== 'object') continue;
    for (const [sid, hist] of Object.entries(stage)) {
      if (!validIds.has(sid) || !Array.isArray(hist)) continue;
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
  o.stages = Array.isArray(x.stages) ? [...new Set(x.stages.filter((v) => v === 1 || v === 2))].sort() : [];
  o.correct = Math.min(o.correct, o.rounds);
  return o;
}
