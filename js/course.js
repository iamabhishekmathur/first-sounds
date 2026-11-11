// Figures for the Learning path (parent area): where the child is on the whole journey, from hearing
// the first sounds to reading words. Pure functions only (no DOM, storage or clock); the screen is
// js/course-view.js. Each milestone has a status ('done' | 'doing' | 'todo' | 'later'), numbers for
// its bar(s) and one plain sentence on what moves it forward.

import { targetEligibleIds, statusOf, historyOf } from './logic.js';
import {
  blendReady, orderedWords, wordStatus, picturable, availableWords, wordsToRecord, unsolidSounds, LEVELS, READ_STAGE,
} from './reading.js';

/** "m", "m and s", "m, s and a" */
export function listText(items) {
  const a = [...items];
  if (a.length <= 1) return a.join('');
  return `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}`;
}

const LEVEL_NAME = { 1: 'level 1', 2: 'level 2: starting with a short sound like t or p', 3: 'level 3: two consonants together, like st', 4: 'level 4: letter pairs like sh, and long sounds' };
export const LEVEL_SHORT = { 1: 'First words', 2: 'Level 2', 3: 'Level 3', 4: 'Level 4' };

/** Per level: words, the ones that can become solid (with a picture), solid, practised and started. */
export function levelFigures(reading, progress) {
  const words = reading ? orderedWords(reading) : [];
  return LEVELS.map((level) => {
    const list = words.filter((w) => w.level === level);
    const st = list.map((w) => ({ w, s: wordStatus(progress, w.id) }));
    return {
      level,
      words: list.length,
      total: list.filter(picturable).length,
      solid: st.filter((x) => x.s === 'solid').length,
      practised: st.filter((x) => x.s === 'practised').length,
      started: st.filter((x) => x.s !== 'not_started').length,
      name: LEVEL_NAME[level],
    };
  });
}

const stageStarted = (progress, stage, ids) => ids.some((id) => historyOf(progress, stage, id).length > 0);

/**
 * The whole path. reading: the word list ({ words }) or null when it is missing or invalid.
 * tv: word the next step for the TV (recording happens on the iPad or laptop).
 * Returns { milestones: [...], current, now, next }.
 */
export function learningPath({ data, reading = null, progress, recorded, readiness, override = null, tv = false }) {
  const targets = [...targetEligibleIds(data)];
  const solid = (stage) => targets.filter((id) => statusOf(progress, stage, id) === 'solid').length;
  const s1 = solid(1);
  const s2 = solid(2);
  const total = targets.length;
  const br = blendReady(readiness, override);
  const levels = levelFigures(reading, progress);
  const [l1, ...harder] = levels;
  const anyWordRounds = levels.some((l) => l.started > 0);

  const status = (done, doing) => (done ? 'done' : doing ? 'doing' : 'todo');
  const milestones = [
    {
      id: 'hear', title: 'Hear the sounds',
      status: status(total > 0 && s1 === total, stageStarted(progress, 1, targets)),
      bars: [{ label: 'Solid in Hear it', value: s1, total }],
      text: 'Play Hear it together: a sound is solid when 5 of its last 6 rounds are right first time, on at least 2 different days.',
    },
    {
      id: 'letters', title: 'Know the letters',
      status: status(total > 0 && s2 === total, stageStarted(progress, 2, targets)),
      bars: [{ label: 'Solid in See it', value: s2, total }],
      text: 'A sound comes to See it once it is solid in Hear it, and becomes solid there by the same rule.',
    },
    {
      id: 'ready', title: 'Ready to blend',
      status: status(br.ready, (readiness || []).length > 0),
      bars: [{ label: 'Readiness check passed', value: Math.min(br.days, br.needed), total: br.needed, unit: 'days', override: br.byOverride && !br.byCheck }],
      text: br.byOverride && !br.byCheck
        ? 'Turned on by you in Settings, so reading has started. The readiness check still runs as a bonus round.'
        : 'The readiness check is a bonus round, at most once a day, once group 1 is solid in See it. A right answer counts on 3 separate days. You can also turn on "ready to blend" in Settings.',
    },
    {
      id: 'first', title: 'Blend first words',
      status: !reading ? 'todo' : status(l1.total > 0 && l1.solid === l1.total, l1.started > 0),
      bars: [{ label: 'Level 1 words solid', value: l1.solid, total: l1.total, practised: l1.practised }],
      text: reading
        ? 'A word is ready once all its sounds are solid in See it and you have recorded it (studio, Words tab). It is solid after 5 of its last 6 picture choices are right first time, on 2 different days.'
        : 'Reading words are not available: the word list (data/reading.json) is missing or has problems.',
    },
    {
      id: 'harder', title: 'Blend harder words',
      status: !reading ? 'todo' : status(harder.every((l) => l.total === 0 || l.solid === l.total) && harder.some((l) => l.total > 0), harder.some((l) => l.started > 0)),
      bars: harder.map((l) => ({ label: LEVEL_SHORT[l.level], value: l.solid, total: l.total, practised: l.practised, hint: l.name })),
      text: 'The same, for words that start with a short sound like t (level 2), have two consonants together like st (level 3), or use letter pairs like sh (level 4).',
    },
    {
      id: 'sentences', title: 'Read sentences', status: 'later', bars: [], locked: true,
      text: 'Coming later.',
    },
  ];

  // Where the child is now, and the single next step.
  const studio = tv ? 'on the iPad or laptop (studio, Words tab)' : 'in the studio\'s Words tab';
  const first = Math.min(...data.sounds.map((s) => s.group));
  const eligible = new Set(targets);
  const g1 = data.sounds.filter((s) => s.group === first && eligible.has(s.id));
  const g1name = (ids) => ids.map((id) => data.sounds.find((s) => s.id === id).graphemes[0]);
  let current;
  let now;
  let next;
  if (!br.ready) {
    current = s1 > 0 || stageStarted(progress, 2, targets) ? 'letters' : 'hear';
    now = current === 'hear' ? `Hearing the first sounds: ${s1} of ${total} solid in Hear it.` : `Learning the letters: ${s2} of ${total} solid in See it.`;
    const unrecorded = g1.filter((s) => !recorded.has(s.id));
    const notS1 = g1.filter((s) => statusOf(progress, 1, s.id) !== 'solid').map((s) => s.id);
    const notS2 = g1.filter((s) => statusOf(progress, 2, s.id) !== 'solid').map((s) => s.id);
    if (unrecorded.length) {
      next = `Next: record the group 1 sounds (${listText(g1name(unrecorded.map((s) => s.id)))}) ${tv ? 'on the iPad or laptop' : 'in the recording studio'}, so the games can start.`;
    } else if (notS1.length) {
      next = `Next: get ${listText(g1name(notS1))} solid in Hear it and then in See it${notS2.length > notS1.length ? ` (with ${listText(g1name(notS2.filter((id) => !notS1.includes(id))))})` : ''}, so the readiness check can start.`;
    } else if (notS2.length) {
      next = `Next: get ${listText(g1name(notS2))} solid in See it, so the readiness check can start.`;
    } else {
      next = `Next: the readiness check, a bonus round at most once a day. It needs a right answer on ${br.needed} separate days (${br.days} so far).`;
    }
  } else if (!reading) {
    current = 'first';
    now = 'Ready to blend.';
    next = 'Next: reading words are not available yet, because the word list (data/reading.json) is missing or has problems.';
  } else {
    const avail = availableWords(reading, progress, recorded);
    const rec = wordsToRecord(reading, progress, recorded, 3);
    const l1done = l1.total > 0 && l1.solid === l1.total;
    const allDone = levels.every((l) => l.solid === l.total);
    current = !l1done ? 'first' : !allDone ? 'harder' : 'sentences';
    const solidWords = levels.reduce((n, l) => n + l.solid, 0);
    now = current === 'first' ? `Blending first words: ${l1.solid} of ${l1.total} level 1 words solid.`
      : current === 'harder' ? `Blending harder words: ${solidWords} words solid so far.`
        : 'Every word is solid.';
    if (current === 'sentences') {
      next = 'Next: reading sentences, which comes in a later version.';
    } else if (!avail.length && !rec.next.length) {
      const words = orderedWords(reading);
      // The word closest to ready: fewest sounds still to make solid in See it (then level and file order).
      const best = words.map((w) => ({ w, need: unsolidSounds(w, progress) })).sort((a, b) => a.need.length - b.need.length)[0];
      const names = best ? best.need.map((id) => (data.sounds.find((s) => s.id === id) || { graphemes: [id] }).graphemes[0]) : [];
      next = best ? `Next: get ${listText(names)} solid in See it, so the first words (like ${best.w.word}) can be read.` : 'Next: keep playing See it.';
    } else if (rec.next.length && avail.length < 4) {
      next = `Next: record ${avail.length ? 'more' : 'the first'} words ${studio}: ${listText(rec.next.map((w) => w.word))}.`;
    } else if (!anyWordRounds) {
      next = 'Next: play together: every third round is now a reading round.';
    } else {
      next = `Next: keep playing together. ${current === 'first' ? 'Level 1 words' : 'Words'} become solid with 5 of 6 right picture choices over 2 days${rec.next.length ? `; you can also record more words ${studio}` : ''}.`;
    }
  }
  for (const m of milestones) m.current = m.id === current;
  return { milestones, current, now, next, stage: READ_STAGE };
}
