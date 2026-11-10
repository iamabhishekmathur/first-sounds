// Content data: loading and schema validation. No DOM here, so it runs in Node tests too.

const KINDS = new Set(['continuous', 'stop']);

const isStr = (v) => typeof v === 'string' && v.trim().length > 0;

/**
 * Validate the sounds.json contract.
 * Returns { ok, errors, warnings }. Errors make the app refuse to start;
 * warnings are shown to the parent but the app still runs.
 */
export function validateData(d) {
  const errors = [];
  const warnings = [];
  if (!d || typeof d !== 'object' || Array.isArray(d)) {
    return { ok: false, errors: ['The data must be a JSON object.'], warnings };
  }
  if (d.version !== 1) errors.push(`version must be 1 (found ${JSON.stringify(d.version)}).`);

  if (!Array.isArray(d.sounds) || d.sounds.length === 0) {
    errors.push('sounds must be a non-empty array.');
  }
  if (!Array.isArray(d.words)) errors.push('words must be an array.');
  if (d.readinessPairs !== undefined && !Array.isArray(d.readinessPairs)) {
    errors.push('readinessPairs must be an array.');
  }
  if (errors.length) return { ok: false, errors, warnings };

  const ids = new Set();
  d.sounds.forEach((s, i) => {
    const at = `sounds[${i}]${s && isStr(s.id) ? ` (${s.id})` : ''}`;
    if (!s || typeof s !== 'object') { errors.push(`${at} must be an object.`); return; }
    if (!isStr(s.id)) errors.push(`${at}.id must be a non-empty string.`);
    else if (ids.has(s.id)) errors.push(`${at}.id is duplicated.`);
    else ids.add(s.id);
    if (!Array.isArray(s.graphemes) || s.graphemes.length === 0 || !s.graphemes.every(isStr)) {
      errors.push(`${at}.graphemes must be a non-empty array of strings.`);
    } else {
      for (const g of s.graphemes) {
        if (g !== g.toLowerCase()) errors.push(`${at}.graphemes "${g}" must be lowercase.`);
      }
    }
    if (!Number.isInteger(s.group) || s.group < 1) errors.push(`${at}.group must be a whole number from 1.`);
    if (!KINDS.has(s.kind)) errors.push(`${at}.kind must be "continuous" or "stop" (found ${JSON.stringify(s.kind)}).`);
    for (const f of ['say', 'tip', 'exampleWord']) {
      if (!isStr(s[f])) errors.push(`${at}.${f} must be a non-empty string.`);
    }
    if (!Array.isArray(s.confusable) || !s.confusable.every((c) => typeof c === 'string')) {
      errors.push(`${at}.confusable must be an array of sound ids.`);
    }
  });

  // Cross references (only meaningful once ids are known).
  d.sounds.forEach((s, i) => {
    if (!s || !Array.isArray(s.confusable)) return;
    for (const c of s.confusable) {
      if (c === s.id) warnings.push(`sounds[${i}] (${s.id}) lists itself as confusable.`);
      else if (!ids.has(c)) errors.push(`sounds[${i}] (${s.id}).confusable has unknown sound id "${c}".`);
    }
  });

  const wordSet = new Set();
  d.words.forEach((w, i) => {
    const at = `words[${i}]${w && isStr(w.word) ? ` (${w.word})` : ''}`;
    if (!w || typeof w !== 'object') { errors.push(`${at} must be an object.`); return; }
    if (!isStr(w.word)) errors.push(`${at}.word must be a non-empty string.`);
    else if (wordSet.has(w.word)) warnings.push(`${at} is listed more than once.`);
    else wordSet.add(w.word);
    if (!isStr(w.emoji)) errors.push(`${at}.emoji must be a non-empty string.`);
    if (!Array.isArray(w.phonemes) || w.phonemes.length === 0) {
      errors.push(`${at}.phonemes must be a non-empty array.`);
    } else {
      for (const p of w.phonemes) {
        if (!ids.has(p)) errors.push(`${at}.phonemes has unknown sound id ${JSON.stringify(p)}.`);
      }
    }
  });

  d.sounds.forEach((s) => {
    if (s && isStr(s.exampleWord) && !wordSet.has(s.exampleWord)) {
      warnings.push(`Sound ${s.id}: exampleWord "${s.exampleWord}" is not in words (its emoji will not show).`);
    }
  });

  const pairs = d.readinessPairs || [];
  if (pairs.length === 0) warnings.push('readinessPairs is empty, so the readiness check never appears.');
  pairs.forEach((p, i) => {
    for (const side of ['a', 'b']) {
      const v = p && p[side];
      if (!v || !isStr(v.name) || !isStr(v.emoji)) {
        errors.push(`readinessPairs[${i}].${side} must have a name and an emoji.`);
      }
    }
  });

  return { ok: errors.length === 0, errors, warnings };
}

/** Short facts about the data, for the parent and the report. */
export function describeData(d) {
  const starts = new Map();
  for (const w of d.words) starts.set(w.phonemes[0], (starts.get(w.phonemes[0]) || 0) + 1);
  const nonTargets = d.sounds.filter((s) => (starts.get(s.id) || 0) < 3).map((s) => s.id);
  const byGrapheme = new Map();
  for (const s of d.sounds) {
    const g = s.graphemes[0];
    byGrapheme.set(g, [...(byGrapheme.get(g) || []), s.id]);
  }
  const shared = [...byGrapheme.entries()].filter(([, v]) => v.length > 1);
  return {
    sounds: d.sounds.length,
    words: d.words.length,
    groups: [...new Set(d.sounds.map((s) => s.group))].sort((a, b) => a - b),
    nonTargets,
    sharedGraphemes: shared.map(([g, v]) => `${g}: ${v.join(', ')}`),
    readinessPairs: (d.readinessPairs || []).length,
  };
}

/** Fetch and validate. Throws an Error with a parent-readable message on failure. */
export async function loadData(url, fetchFn = globalThis.fetch) {
  let res;
  try {
    res = await fetchFn(url, { cache: 'no-cache' });
  } catch (e) {
    throw new Error(`Could not fetch ${url}: ${e.message}`);
  }
  if (!res.ok) throw new Error(`Could not fetch ${url} (HTTP ${res.status}).`);
  let json;
  try {
    json = await res.json();
  } catch (e) {
    throw new Error(`${url} is not valid JSON: ${e.message}`);
  }
  const report = validateData(json);
  return { data: json, report };
}
