// Saves the reading screens to screenshots/ (iPad landscape at scale 2, and the TV at 1920x1080):
// the studio's Words tab, a reading round before, during and after the blend, the picture check,
// the Learning path empty and in progress, and the top of the Tracker. Run as part of the suite.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { setup, newPage, url, open, seed, hist, answerRound, GROUP1 } from './helpers.mjs';

const OUT = new URL('../../screenshots/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

let env;
before(async () => { env = await setup(); });
after(async () => { await env.close(); });

const TODAY = '2026-11-10';
const DAYS = ['2026-11-08', '2026-11-08', '2026-11-08', '2026-11-09', '2026-11-09', '2026-11-09'];
const solid = (ids) => Object.fromEntries(ids.map((id) => [id, hist(DAYS)]));
const SOUNDS = ['m', 's', 'a', 't', 'n', 'u', 'e', 'p', 'i'];
const shot = async (page, name, opts = {}) => { await page.waitForTimeout(250); await page.screenshot({ path: `${OUT}${name}.png`, ...opts }); };
const READY = { progress: { s1: solid(SOUNDS), s2: solid(SOUNDS) }, readiness: [{ id: 'rq', d: TODAY, pair: 'dog+fish', asked: 'dogfish', chose: 'dogfish', correct: true, at: 1 }], blend: { on: true, at: 5 }, settings: { speakWords: true, roundsPerSession: 4 } };

async function device(words, state = READY, { tv = false } = {}) {
  const p = await newPage(env, tv ? { viewport: { width: 1920, height: 1080 }, touch: false, motion: 'no-preference' } : { scale: 2 });
  const href = url(env, { seed: 3, today: TODAY, ...(tv ? { tv: '1' } : {}) });
  await open(p.page, href);
  await seed(p.page, { recordings: [...SOUNDS, ...words.map((w) => `w:${w}`)], ...state, wordMs: 2400 });
  await open(p.page, href);
  return p;
}

async function untilReading(page, tv) {
  for (let i = 0; i < 10; i++) {
    await page.waitForSelector('[data-screen="round"]:not(.resolved)');
    if (await page.getAttribute('[data-screen="round"]', 'data-stage') === '3') return true;
    if (!tv) { await answerRound(page); continue; }
    const target = await page.getAttribute('[data-screen="round"]', 'data-target');
    for (let k = 0; k < 4 && !(await page.evaluate((t) => document.activeElement.matches(`.choice[data-sound="${t}"]`), target)); k++) await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => !document.querySelector('.round.resolved'), null, { timeout: 6000 });
  }
  return false;
}

test('reading screenshots (iPad landscape)', async () => {
  // The studio's Words tab.
  const st = await device(['man', 'sun', 'mat']);
  await st.page.evaluate(() => globalThis.__fsApp.go('studio', { group: 'words' }));
  await st.page.tap('.st-word[data-word="map"]');
  await shot(st.page, '33-studio-words');
  await st.page.tap('[data-testid="show-all-words"]');
  await shot(st.page, '33b-studio-words-all', { fullPage: true });
  await st.context.close();

  // A round: before, during and after the blend, then the picture check.
  const { page, errors, context } = await device(['map', 'nut']);
  await page.tap('[data-testid="play"]');
  assert.ok(await untilReading(page, false));
  await shot(page, '34-read-before');
  await page.tap('[data-testid="go"]');
  await page.waitForSelector('.gtile.now[data-i="1"]');
  await page.screenshot({ path: `${OUT}35-read-during.png` });
  await page.waitForSelector('[data-phase="blended"]', { timeout: 6000 });
  await shot(page, '36-read-after');
  await page.tap('[data-testid="say-fast"]');
  await page.waitForSelector('.read-choices:not([hidden]) .choice');
  await shot(page, '37-read-picture-check');
  assert.deepEqual(errors, []);
  await context.close();

  // The Learning path: at the start, and in progress; the Tracker's top.
  const empty = await newPage(env, { scale: 2 });
  await open(empty.page, url(env, { today: TODAY }));
  await seed(empty.page, { recordings: GROUP1 });
  await open(empty.page, url(env, { today: TODAY }));
  await empty.page.evaluate(() => globalThis.__fsApp.go('path'));
  await shot(empty.page, '38-learning-path-empty', { fullPage: true });
  await empty.context.close();

  const S = ['m', 's', 'a', 't', 'n', 'u', 'e', 'p', 'i', 'o', 'g'];
  const prog = await device(['man', 'sun', 'nut', 'map', 'mat', 'tap'], {
    progress: { s1: solid([...S, 'f', 'sh']), s2: solid(S), s3: { 'w:man': hist(DAYS), 'w:sun': hist(DAYS), 'w:nut': [{ c: 1, d: '2026-11-09' }, { c: 0, d: TODAY }], 'w:mat': [{ c: 0, d: TODAY, p: 1 }], 'w:tap': [{ c: 1, d: TODAY }] } },
    readiness: ['2026-11-01', '2026-11-03', '2026-11-05'].map((d, i) => ({ id: `r${i}`, d, pair: 'cup+cake', asked: 'cupcake', chose: 'cupcake', correct: true, at: i + 1 })),
    sessions: [{ id: 'S1', d: '2026-11-09', start: Date.parse('2026-11-09T09:00:00'), end: Date.parse('2026-11-09T09:05:00'), stages: [1, 2, 3], rounds: 10, correct: 8, practised: 1 }],
  });
  await prog.page.evaluate(() => globalThis.__fsApp.go('path'));
  await shot(prog.page, '39-learning-path-progress', { fullPage: true });
  await prog.page.evaluate(() => globalThis.__fsApp.go('tracker'));
  await shot(prog.page, '40-tracker-top');
  await prog.context.close();
});

test('reading screenshots (TV 1920x1080, keyboard only)', async () => {
  const { page, errors, context } = await device(['map', 'nut'], READY, { tv: true });
  await page.keyboard.press('Enter');
  assert.ok(await untilReading(page, true));
  await shot(page, 'tv-16-read-before');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.gtile.now[data-i="1"]');
  await page.screenshot({ path: `${OUT}tv-17-read-during.png` });
  await page.waitForSelector('[data-phase="blended"]', { timeout: 6000 });
  await page.waitForFunction(() => document.activeElement.matches('[data-testid="say-fast"]'));
  await shot(page, 'tv-18-read-after');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.read-choices:not([hidden]) .choice');
  await shot(page, 'tv-19-read-picture-check');
  await page.evaluate(() => { globalThis.__fsApp.session = null; globalThis.__fsApp.go('path'); });
  await shot(page, 'tv-20-learning-path');
  assert.deepEqual(errors, []);
  await context.close();
});
