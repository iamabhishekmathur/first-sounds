// Saves a screenshot of every screen to screenshots/ (device scale 2). Run as part of the suite.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { setup, newPage, url, open, seed, holdGate, hist, answerRound, GROUP1 } from './helpers.mjs';

const OUT = new URL('../../screenshots/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

let env;
before(async () => { env = await setup(); });
after(async () => { await env.close(); });

const shot = (page, name) => page.screenshot({ path: `${OUT}${name}.png` });
const days = ['2026-11-08', '2026-11-08', '2026-11-08', '2026-11-09', '2026-11-09', '2026-11-09'];
const solid = (ids) => Object.fromEntries(ids.map((id) => [id, hist(days)]));
const goingWell = (ids) => Object.fromEntries(ids.map((id) => [id, [{ c: 1, d: '2026-11-09' }, { c: 1, d: '2026-11-09' }, { c: 1, d: '2026-11-09' }, { c: 1, d: '2026-11-09' }]]));

async function freshWithRecordings(env, opts, params, state) {
  const p = await newPage(env, { scale: 2, ...opts });
  await open(p.page, url(env, params));
  await seed(p.page, { recordings: GROUP1, ...state });
  await open(p.page, url(env, params));
  return p;
}

async function untilMode(page, mode, max = 30) {
  for (let i = 0; i < max; i++) {
    await page.waitForSelector('[data-screen="round"], [data-screen="done"]');
    if (await page.getAttribute('[data-screen]', 'data-screen') === 'done') await page.tap('[data-testid="play-again"]', { timeout: 5000 });
    else if (await page.getAttribute('[data-screen="round"]', 'data-mode') === mode) return true;
    else await answerRound(page);
  }
  return false;
}

test('parent screens', async () => {
  const { page, context, errors } = await newPage(env, { scale: 2 });
  await open(page, url(env, { today: '2026-11-10' }));
  await shot(page, '01-welcome');
  await page.tap('[data-testid="start-recording"]');
  await shot(page, '02-studio-empty');
  await page.tap('[data-testid="record"]');
  await page.waitForSelector('.p-btn.rec.recording');
  await shot(page, '03-studio-recording');
  await page.waitForTimeout(1000);
  await page.tap('[data-testid="record"]');
  await page.waitForSelector('[data-testid="studio-msg"]');
  await page.tap('.st-tile[data-sound="m"]');
  await shot(page, '04-studio-recorded');
  await seed(page, {
    recordings: ['s', 'a', 't'],
    progress: { s1: { ...solid(['m', 's']), a: [{ c: 1, d: '2026-11-10' }, { c: 0, d: '2026-11-10' }] }, s2: { m: [{ c: 1, d: '2026-11-10' }] } },
    readiness: [{ d: '2026-11-09', pair: 'dog+fish', asked: 'fishdog', chose: 'fishdog', correct: true }],
  });
  await open(page, url(env, { today: '2026-11-10' }));
  await shot(page, '10-home');
  const gate = await page.waitForSelector('[data-testid="gate"]');
  await gate.dispatchEvent('pointerdown', { pointerId: 1, pointerType: 'touch' });
  await page.waitForTimeout(1000);
  await page.screenshot({ path: `${OUT}11-gate-holding.png`, clip: { x: 0, y: 0, width: 300, height: 120 } });
  await page.waitForTimeout(1200);
  await shot(page, '05-parent-menu');
  await page.tap('[data-testid="open-progress"]');
  await shot(page, '06-progress');
  await page.screenshot({ path: `${OUT}06b-progress-full.png`, fullPage: true });
  await page.tap('.p-back');
  await page.tap('[data-testid="open-settings"]');
  await page.tap('[data-testid="reset"]');
  await shot(page, '07-settings');
  assert.deepEqual(errors, []);
  await context.close();
});

test('microphone denied, data error, not yet playable', async () => {
  const a = await newPage(env, { scale: 2, init: () => { navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('no', 'NotAllowedError')); } });
  await open(a.page, url(env));
  await a.page.tap('[data-testid="start-recording"]');
  await a.page.tap('[data-testid="record"]');
  await a.page.waitForSelector('.notice-error');
  await shot(a.page, '08-studio-mic-denied');
  await a.context.close();

  const b = await newPage(env, { scale: 2 });
  await open(b.page, url(env, { data: 'tests/fixtures/missing.json' }));
  await shot(b.page, '09-data-error');
  await open(b.page, url(env));
  await seed(b.page, { recordings: ['m'] });
  await open(b.page, url(env));
  await shot(b.page, '10b-home-not-ready');
  await b.context.close();
});

test('stage 1 screens', async () => {
  const { page, context, errors } = await freshWithRecordings(env, {}, { seed: 2, today: '2026-11-10' });
  await page.tap('[data-testid="play"]');
  await page.waitForSelector('[data-screen="round"]');
  await shot(page, '12-hear-it');
  const t = await page.getAttribute('[data-screen="round"]', 'data-target');
  const wrong = page.locator(`.choice:not([data-sound="${t}"])`).first();
  await wrong.tap();
  await wrong.tap();
  await page.waitForSelector('.choice.glow');
  await page.waitForTimeout(600);
  await shot(page, '13-hear-it-glow-after-two-wrong');
  await page.tap(`.choice[data-sound="${t}"]`);
  await page.waitForTimeout(800);
  await shot(page, '14-hear-it-correct');
  await context.close();

  const p3 = await freshWithRecordings(env, {}, { seed: 4, today: '2026-11-10' }, { progress: { s1: goingWell(GROUP1), s2: {} } });
  await p3.page.tap('[data-testid="play"]');
  await p3.page.waitForSelector('.choices.n3');
  await shot(p3.page, '15-hear-it-three-choices');
  assert.deepEqual(errors, []);
  await p3.context.close();
});

test('stage 2, readiness and done screens', async () => {
  const { page, context, errors } = await freshWithRecordings(env, {}, { seed: 9, today: '2026-11-10' }, { progress: { s1: solid(GROUP1), s2: {} } });
  await page.tap('[data-testid="play"]');
  assert.ok(await untilMode(page, 'see-letter'));
  await shot(page, '16-see-it-letter-to-picture');
  assert.ok(await untilMode(page, 'pick-letter'));
  await shot(page, '17-see-it-pick-the-letter');
  await context.close();

  const r = await freshWithRecordings(env, {}, { seed: 5, today: '2026-11-10' }, { progress: { s1: solid(GROUP1), s2: solid(GROUP1) } });
  await r.page.tap('[data-testid="play"]');
  for (let i = 0; i < 3; i++) await answerRound(r.page);
  await r.page.waitForSelector('[data-screen="readiness"]');
  await shot(r.page, '18-readiness-slide');
  await r.page.tap('.prompt-link');
  await r.page.waitForSelector('[data-phase="2"]');
  await shot(r.page, '19-readiness-which-one');
  await r.page.tap('.ready-row');
  for (let i = 0; i < 3; i++) { await r.page.waitForSelector('[data-screen="round"]'); await answerRound(r.page); }
  await r.page.waitForSelector('[data-screen="done"]');
  await r.page.waitForTimeout(500);
  await shot(r.page, '20-all-done-first-3-seconds');
  await r.page.waitForSelector('[data-testid="play-again"]');
  await r.page.waitForTimeout(700);
  await shot(r.page, '21-all-done-after-3-seconds');
  assert.deepEqual(errors, []);
  await r.context.close();
});

test('portrait: phone and iPad', async () => {
  const phone = await freshWithRecordings(env, { viewport: { width: 390, height: 844 }, isMobile: true }, { seed: 4, today: '2026-11-10' }, { progress: { s1: goingWell(GROUP1), s2: {} } });
  await phone.page.tap('[data-testid="play"]');
  await phone.page.waitForSelector('[data-screen="round"]');
  await shot(phone.page, '22-phone-portrait-hear-it');
  await phone.context.close();

  const phone2 = await freshWithRecordings(env, { viewport: { width: 390, height: 844 }, isMobile: true }, { seed: 9, today: '2026-11-10' }, { progress: { s1: solid(GROUP1), s2: {} } });
  await phone2.page.tap('[data-testid="play"]');
  assert.ok(await untilMode(phone2.page, 'see-letter'));
  await shot(phone2.page, '23-phone-portrait-see-it');
  await phone2.page.evaluate(() => globalThis.__fsApp.go('studio'));
  await shot(phone2.page, '24-phone-portrait-studio');
  await phone2.context.close();

  const ipad = await freshWithRecordings(env, { viewport: { width: 820, height: 1180 } }, { seed: 2, today: '2026-11-10' });
  await ipad.page.tap('[data-testid="play"]');
  await ipad.page.waitForSelector('[data-screen="round"]');
  await shot(ipad.page, '25-ipad-portrait-hear-it');
  await ipad.context.close();

  const land = await freshWithRecordings(env, { viewport: { width: 844, height: 390 }, isMobile: true }, { seed: 4, today: '2026-11-10' }, { progress: { s1: goingWell(GROUP1), s2: {} } });
  await land.page.tap('[data-testid="play"]');
  await land.page.waitForSelector('[data-screen="round"]');
  await shot(land.page, '26-phone-landscape-hear-it');
  await land.context.close();
});
