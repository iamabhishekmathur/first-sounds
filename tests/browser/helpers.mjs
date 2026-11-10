// Shared setup for the browser tests: static server + Chromium with a fake microphone.
import { createRequire } from 'node:module';
import { startServer } from '../server.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

export const FIXTURE = 'tests/fixtures/sounds.sample.json';
export const IPAD_LANDSCAPE = { width: 1180, height: 820 };

export async function setup() {
  const { server, port } = await startServer(0);
  const browser = await chromium.launch({
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=user-gesture-required'],
  });
  return {
    browser,
    base: `http://127.0.0.1:${port}/`,
    async close() { await browser.close(); server.close(); },
  };
}

/** A fresh, isolated context (own IndexedDB) with an iPad-landscape touch viewport. */
// Tests run with reduced motion by default (looping animations make Playwright wait for stability);
// screenshots pass motion: 'no-preference'.
export async function newPage(env, { viewport = IPAD_LANDSCAPE, scale = 1, mic = true, init, isMobile = false, motion = 'reduce' } = {}) {
  const context = await env.browser.newContext({
    viewport, deviceScaleFactor: scale, hasTouch: true, isMobile, reducedMotion: motion,
    permissions: mic ? ['microphone'] : [],
    acceptDownloads: true,
  });
  if (init) await context.addInitScript(init);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  return { context, page, errors };
}

export function url(env, params = {}) {
  const q = new URLSearchParams({ data: FIXTURE, ...params });
  return `${env.base}index.html?${q}`;
}

export async function open(page, href) {
  await page.goto(href);
  await page.waitForFunction(() => document.body.dataset.ready);
}

/** Seed IndexedDB through the app's own storage module, then reload. */
export async function seed(page, { recordings = [], progress, readiness, settings } = {}) {
  await page.evaluate(async ({ recordings, progress, readiness, settings }) => {
    const { encodeWav } = await import('./js/audio.js');
    const app = globalThis.__fsApp;
    for (const id of recordings) {
      const rate = 24000;
      const s = new Float32Array(rate * 0.4);
      for (let i = 0; i < s.length; i++) s[i] = 0.3 * Math.sin((2 * Math.PI * 220 * i) / rate);
      await app.store.putRecording({ id, data: encodeWav(s, rate), mime: 'audio/wav', durationMs: 400, trimmed: true, updatedAt: Date.now() });
    }
    if (progress) await app.store.setKV('progress', progress);
    if (readiness) await app.store.setKV('readiness', readiness);
    if (settings) await app.store.setKV('settings', settings);
  }, { recordings, progress, readiness, settings });
}

export async function storedState(page) {
  return page.evaluate(async () => {
    const app = globalThis.__fsApp;
    const recs = await app.store.allRecordings();
    return {
      progress: await app.store.getKV('progress'),
      readiness: await app.store.getKV('readiness'),
      settings: await app.store.getKV('settings'),
      recordings: recs.map((r) => ({ id: r.id, mime: r.mime, bytes: r.data.byteLength, trimmed: r.trimmed, durationMs: r.durationMs })),
    };
  });
}

export const log = (page) => page.evaluate(() => globalThis.__fsLog);

/** Press and hold the parent gate. */
export async function holdGate(page, ms = 2200) {
  const gate = await page.waitForSelector('[data-testid="gate"]');
  await gate.dispatchEvent('pointerdown', { pointerId: 1, pointerType: 'touch', isPrimary: true });
  await page.waitForTimeout(ms);
  // The gate may already be gone (screen changed), so dispatch on the handle, not a locator.
  await gate.evaluate((el) => el.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, pointerType: 'touch', bubbles: true })));
}

/** History entries for seeding: n rounds, all correct unless given, spread over days. */
export function hist(days, correct = true) {
  return days.map((d) => ({ c: correct ? 1 : 0, d }));
}

export const GROUP1 = ['m', 's', 'a', 't'];

/** Answer the current round correctly and wait for the next screen. Returns round info. */
export async function answerRound(page, { wrongFirst = 0 } = {}) {
  const info = await page.evaluate(() => {
    const el = document.querySelector('[data-screen="round"]');
    return el ? { stage: el.dataset.stage, mode: el.dataset.mode, target: el.dataset.target } : null;
  });
  if (!info) return null;
  const sel = '.choice:not(.happy)';
  for (let i = 0; i < wrongFirst; i++) {
    await page.locator(`${sel}:not([data-sound="${info.target}"])`).first().tap();
    await page.waitForTimeout(150);
  }
  info.choices = await page.$$eval('.choice', (els) => els.map((e) => ({ sound: e.dataset.sound, word: e.dataset.word, text: e.textContent })));
  await page.locator(`.choice[data-sound="${info.target}"]`).tap();
  await page.waitForFunction(() => !document.querySelector('.round.resolved'), null, { timeout: 5000 });
  return info;
}
