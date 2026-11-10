// Realistic Tracker data for browser tests and screenshots: about a month of play on the modes
// fixture, the first ten days played before sessions and wrong taps were recorded.
import { readFileSync } from 'node:fs';
import * as L from '../../js/logic.js';

export const MODES_FIXTURE = 'tests/fixtures/sounds.modes.json';
const data = JSON.parse(readFileSync(new URL('../fixtures/sounds.modes.json', import.meta.url), 'utf8'));

const addDays = (day, n) => new Date(Date.parse(`${day}T12:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const localMs = (day, h, m) => new Date(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)), h, m).getTime();

/** { progress, sessions, readiness } for the 30 days ending `today`. */
export function realisticHistory(today = '2026-11-10', seed = 4) {
  const rng = L.mulberry32(seed);
  const intro = [['m', 0], ['s', 0], ['ng', 5], ['ue', 9], ['n', 14], ['t', 18], ['sh', 22], ['k', 26]];
  const skill = { m: 0.78, s: 0.82, ng: 0.62, ue: 0.5, n: 0.6, t: 0.7, sh: 0.66, k: 0.55 };
  const played = new Map();
  let progress = { s1: {}, s2: {} };
  const sessions = [];
  let n = 0;
  for (let i = 29; i >= 0; i--) {
    const day = addDays(today, -i);
    const idx = 29 - i;
    if ([3, 7, 11, 12, 17, 24, 27].includes(idx)) continue; // days without play
    const tracked = idx >= 10; // sessions and wrong taps recorded from day 10 on
    const sessionsToday = idx % 5 === 1 ? 2 : 1;
    for (let k = 0; k < sessionsToday; k++) {
      const hour = k === 0 ? 8 + Math.floor(rng() * 3) : 17 + Math.floor(rng() * 2);
      const start = localMs(day, hour, Math.floor(rng() * 50));
      const ses = { id: `ses${day}${k}`, d: day, start, end: start, stages: [], rounds: 0, correct: 0 };
      const open = intro.filter(([, from]) => from <= idx).map(([id]) => id);
      let t = start;
      for (let r = 0; r < 6; r++) {
        const id = open[Math.floor(rng() * open.length)];
        const stage = L.statusOf(progress, 1, id) === 'solid' && rng() < 0.45 ? 2 : 1;
        const count = played.get(`${stage}${id}`) || 0;
        played.set(`${stage}${id}`, count + 1);
        const p = Math.min(0.95, skill[id] + count * 0.012 - (stage === 2 ? 0.1 : 0));
        const ok = rng() < p;
        t += 25000 + Math.floor(rng() * 20000);
        const extra = { id: `g${n++}`, t };
        if (tracked) {
          extra.ses = ses.id;
          if (!ok) {
            const target = data.sounds.find((s) => s.id === id);
            const choices = L.pickPictureChoices({ data, target, targetStatus: L.statusOf(progress, stage, id), n: 3, rng });
            const wrong = choices.find((c) => !c.correct);
            extra.wrong = [wrong.soundId ? { w: wrong.word, s: wrong.soundId } : { w: wrong.word }];
          }
        }
        progress = L.recordRound(progress, stage, id, ok, day, extra);
        if (tracked) {
          ses.rounds += 1;
          if (ok) ses.correct += 1;
          if (!ses.stages.includes(stage)) ses.stages = [...ses.stages, stage].sort();
          ses.end = t;
        }
      }
      if (tracked) sessions.push(ses);
    }
  }
  const readiness = [
    { id: 'rd1', d: addDays(today, -6), pair: 'cup+cake', asked: 'cupcake', chose: 'cupcake', correct: true, at: localMs(addDays(today, -6), 9, 30) },
    { id: 'rd2', d: addDays(today, -3), pair: 'cup+cake', asked: 'cakecup', chose: 'cupcake', correct: false, at: localMs(addDays(today, -3), 9, 30) },
  ];
  return { progress, sessions, readiness };
}

/** Seeds IndexedDB with recordings (trimmed unless listed in `untrimmed`) and Tracker state. */
export async function seedTracker(page, { recordings, untrimmed = [], progress, sessions, readiness }) {
  await page.evaluate(async ({ recordings, untrimmed, progress, sessions, readiness }) => {
    const { encodeWav } = await import('./js/audio.js');
    const app = globalThis.__fsApp;
    for (const id of recordings) {
      const rate = 24000;
      const s = new Float32Array(rate * 0.4);
      for (let i = 0; i < s.length; i++) s[i] = 0.3 * Math.sin((2 * Math.PI * 220 * i) / rate);
      await app.store.putRecording({ id, data: encodeWav(s, rate), mime: 'audio/wav', durationMs: 400, trimmed: !untrimmed.includes(id), updatedAt: Date.now() });
    }
    if (progress) await app.store.setKV('progress', progress);
    if (sessions) await app.store.setKV('sessions', sessions);
    if (readiness) await app.store.setKV('readiness', readiness);
  }, { recordings, untrimmed, progress, sessions, readiness });
}
