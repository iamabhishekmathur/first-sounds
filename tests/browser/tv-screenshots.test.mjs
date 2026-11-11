// Saves the TV screens to screenshots/tv-*.png at 1920x1080 (and one at 1280x720), driven by the
// keyboard only, with motion on so the focus scale-up shows. Run as part of the suite.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { setup, newPage, url, open, seed, hist, GROUP1 } from './helpers.mjs';
import { MODES_FIXTURE, realisticHistory, seedTracker } from './trackerdata.mjs';

const OUT = new URL('../../screenshots/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

let env;
before(async () => { env = await setup(); });
after(async () => { await env.close(); });

const FULL_HD = { width: 1920, height: 1080 };
const shot = async (page, name) => { await page.waitForTimeout(350); await page.screenshot({ path: `${OUT}${name}.png` }); };
const screen = (page) => page.getAttribute('#app [data-screen]', 'data-screen');
const days = ['2026-11-08', '2026-11-08', '2026-11-08', '2026-11-09', '2026-11-09', '2026-11-09'];
const solidAll = (ids) => Object.fromEntries(ids.map((id) => [id, hist(days)]));
const tv = (params) => url(env, { tv: 1, today: '2026-11-10', ...params });

async function tvWith(state, params, viewport = FULL_HD) {
  const p = await newPage(env, { viewport, touch: false, motion: 'no-preference' });
  await open(p.page, tv(params));
  if (state) {
    await seed(p.page, { recordings: GROUP1, ...state });
    await open(p.page, tv(params));
  }
  return p;
}

/** Answers the current round with the remote (Left/Right to the target, then OK). */
async function answer(page) {
  const target = await page.getAttribute('[data-screen="round"]', 'data-target');
  for (let i = 0; i < 6; i++) {
    const at = await page.evaluate((t) => {
      const els = [...document.querySelectorAll('.choice')];
      return { i: els.indexOf(document.activeElement), want: els.findIndex((e) => e.dataset.sound === t) };
    }, target);
    if (at.i === at.want) break;
    await page.keyboard.press(at.i < at.want ? 'ArrowRight' : 'ArrowLeft');
  }
  await page.keyboard.press('Enter');
  await page.waitForSelector('.round.resolved');
  await page.waitForFunction(() => !document.querySelector('.round.resolved'), null, { timeout: 6000 });
}

test('TV screenshots (1920x1080, keyboard only)', async () => {
  const first = await tvWith(null, {});
  await shot(first.page, 'tv-01-code-entry');
  await first.page.evaluate(async () => { await globalThis.__fsApp.sync.save('panda-kettle-moon-38'); globalThis.__fsApp.go('home'); });
  await first.page.waitForSelector('[data-waiting="1"]');
  await shot(first.page, 'tv-02-waiting-for-recordings');
  assert.deepEqual(first.errors.filter((e) => !/status of/.test(e)), []);
  await first.context.close();

  const p = await tvWith({ settings: { speakWords: true, roundsPerSession: 4 } }, { seed: 3 });
  const { page } = p;
  await shot(page, 'tv-03-home');
  await page.keyboard.press('Enter');
  await page.waitForSelector('[data-screen="round"]');
  await shot(page, 'tv-04-hear-it-focus');
  await page.keyboard.press('ArrowDown');
  await shot(page, 'tv-05-hear-it-speaker-focus');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowRight');
  const target = await page.getAttribute('[data-screen="round"]', 'data-target');
  if (await page.evaluate((t) => document.activeElement.matches(`.choice[data-sound="${t}"]`), target)) await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('Enter'); // wrong
  await page.keyboard.press('Enter'); // wrong again: the right picture glows
  await shot(page, 'tv-06-hear-it-glow-after-two-wrong');
  await answer(page);
  for (let i = 0; i < 6 && await screen(page) === 'round'; i++) await answer(page);
  await page.waitForSelector('[data-testid="play-again"]', { timeout: 6000 });
  await shot(page, 'tv-10-all-done');
  // The parent gate held with OK.
  await page.keyboard.press('ArrowUp');
  await page.keyboard.down('Enter');
  await page.waitForTimeout(1500);
  await shot(page, 'tv-11-gate-holding');
  await page.waitForSelector('[data-screen="parent-menu"]', { timeout: 3000 });
  await page.keyboard.up('Enter');
  await shot(page, 'tv-12-parent-menu');
  await page.keyboard.press('ArrowUp');
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowRight'); // Learning path, Tracker, Progress, Settings
  await page.keyboard.press('Enter');
  await page.waitForSelector('[data-screen="settings"]');
  await shot(page, 'tv-13-settings');
  assert.deepEqual(p.errors, []);
  await p.context.close();

  // See it
  const s = await tvWith({ progress: { s1: solidAll(GROUP1), s2: {} } }, { seed: 4 });
  let found = false;
  for (const sd of [4, 5, 6, 7]) {
    await open(s.page, tv({ seed: sd }));
    await s.page.keyboard.press('Enter');
    for (let i = 0; i < 6 && !found; i++) {
      await s.page.waitForSelector('[data-screen="round"], [data-screen="done"]');
      if (await screen(s.page) === 'done') break;
      if (await s.page.getAttribute('[data-screen="round"]', 'data-stage') === '2') { found = true; break; }
      await answer(s.page);
    }
    if (found) break;
  }
  assert.ok(found, 'a See it round');
  await shot(s.page, 'tv-07-see-it');
  await s.context.close();

  // Readiness
  const r = await tvWith({ progress: { s1: solidAll(GROUP1), s2: solidAll(GROUP1) } }, { seed: 5 });
  await r.page.keyboard.press('Enter');
  for (let i = 0; i < 6 && await screen(r.page) !== 'readiness'; i++) {
    await r.page.waitForSelector('[data-screen="round"], [data-screen="readiness"]');
    if (await screen(r.page) === 'round') await answer(r.page);
  }
  await r.page.waitForSelector('[data-screen="readiness"][data-phase="1"]');
  await shot(r.page, 'tv-08-readiness-press-ok');
  await r.page.keyboard.press('Enter');
  await r.page.waitForSelector('[data-screen="readiness"][data-phase="2"]');
  await shot(r.page, 'tv-09-readiness-which-one');
  await r.context.close();

  // Tracker
  const t = await newPage(env, { viewport: FULL_HD, touch: false, motion: 'no-preference' });
  await open(t.page, tv({ data: MODES_FIXTURE }));
  await seedTracker(t.page, { recordings: ['m', 's', 'ng', 'ue', 'n', 't', 'sh', 'k', 'p', 'i', 'u', 'l'], untrimmed: ['n'], ...realisticHistory('2026-11-10') });
  await open(t.page, tv({ data: MODES_FIXTURE }));
  await t.page.evaluate(() => globalThis.__fsApp.go('tracker'));
  await t.page.waitForSelector('[data-testid="tracker-summary"]');
  await shot(t.page, 'tv-14-tracker');
  for (let i = 0; i < 6; i++) await t.page.keyboard.press('ArrowDown');
  await shot(t.page, 'tv-15-tracker-scrolled');
  assert.deepEqual(t.errors, []);
  await t.context.close();

  // 1280x720, as Android TV WebViews often report
  const small = await tvWith({ settings: { speakWords: true, roundsPerSession: 4 } }, { seed: 3 }, { width: 1280, height: 720 });
  await small.page.keyboard.press('Enter');
  await small.page.waitForSelector('[data-screen="round"]');
  await shot(small.page, 'tv-720-hear-it-focus');
  await small.context.close();
});
