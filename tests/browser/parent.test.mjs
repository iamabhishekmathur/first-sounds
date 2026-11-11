// Parent-side flows: first run, recording, persistence, the gate, microphone problems, storage problems.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setup, newPage, url, open, seed, storedState, log, holdGate, GROUP1 } from './helpers.mjs';

let env;
before(async () => { env = await setup(); });
after(async () => { await env.close(); });

const screen = (page) => page.getAttribute('[data-screen]', 'data-screen');

test('first run shows the parent welcome, which leads into recording group 1', async () => {
  const { page, errors, context } = await newPage(env);
  await open(page, url(env));
  assert.equal(await screen(page), 'welcome');
  await page.tap('[data-testid="start-recording"]');
  assert.equal(await screen(page), 'studio');
  assert.equal(await page.getAttribute('.p-tab.on', 'data-group'), '1');
  assert.equal(await page.getAttribute('[data-testid="detail"]', 'data-sound'), 'm');
  assert.match(await page.textContent('[data-testid="detail"]'), /mmm/);
  assert.match(await page.textContent('[data-testid="detail"]'), /Hum it with lips closed/);
  assert.match(await page.textContent('[data-testid="detail"]'), /🌙/);
  assert.match(await page.textContent('.p-tab.on'), /0\/4/);
  assert.deepEqual(errors, []);
  await context.close();
});

test('record, trim, play back, re-record, and it persists across a reload', async () => {
  const { page, errors, context } = await newPage(env);
  await open(page, url(env));
  await page.tap('[data-testid="start-recording"]');

  await page.tap('[data-testid="record"]');
  await page.waitForSelector('.p-btn.rec.recording');
  await page.waitForTimeout(1500);
  await page.tap('[data-testid="record"]');
  await page.waitForSelector('[data-testid="studio-msg"]');
  assert.match(await page.textContent('[data-testid="studio-msg"]'), /Saved|quiet/);

  let st = await storedState(page);
  assert.equal(st.recordings.length, 1);
  const rec = st.recordings[0];
  assert.equal(rec.id, 'm');
  assert.equal(rec.mime, 'audio/wav', 'decoded with Web Audio and stored as trimmed WAV');
  assert.equal(rec.trimmed, true);
  assert.ok(rec.durationMs > 0 && rec.durationMs < 1700, `trimmed duration ${rec.durationMs}ms`);
  const l = await log(page);
  const start = l.find((e) => e.type === 'record-start');
  assert.ok(start, 'recording started');
  assert.ok(/^audio\//.test(start.mime), `recorder mime picked by feature detection: ${start.mime}`);
  assert.ok(l.some((e) => e.type === 'sound' && e.id === 'm'), 'played back after saving');
  assert.match(await page.textContent('.p-tab.on'), /1\/4/);
  assert.equal(await page.getAttribute('[data-testid="detail"]', 'data-sound'), 's', 'moves on to the next unrecorded sound');

  // Re-record m.
  await page.tap('.st-tile[data-sound="m"]');
  assert.match(await page.textContent('[data-testid="record"]'), /Re-record/);
  const before = (await page.evaluate(() => globalThis.__fsApp.recordings.get('m').updatedAt));
  await page.tap('[data-testid="record"]');
  await page.waitForSelector('.p-btn.rec.recording');
  await page.waitForTimeout(800);
  await page.tap('[data-testid="record"]');
  await page.waitForSelector('[data-testid="studio-msg"]');
  const afterTs = (await page.evaluate(() => globalThis.__fsApp.recordings.get('m').updatedAt));
  assert.ok(afterTs > before);

  // Reload: recordings survive, the app no longer shows the first-run welcome.
  await page.reload();
  await page.waitForFunction(() => document.body.dataset.ready);
  assert.equal(await screen(page), 'home');
  st = await storedState(page);
  assert.deepEqual(st.recordings.map((r) => r.id), ['m']);
  await holdGate(page);
  await page.tap('[data-testid="open-studio"]');
  await page.tap('.st-tile[data-sound="m"]');
  assert.ok(await page.isEnabled('[data-testid="playback"]'));
  await page.evaluate(() => { globalThis.__fsLog.length = 0; });
  await page.tap('[data-testid="playback"]');
  await page.waitForFunction(() => globalThis.__fsLog.some((e) => e.type === 'sound' && e.id === 'm'));
  assert.deepEqual(errors, []);
  await context.close();
});

test('recording all of group 1 makes the game playable', async () => {
  const { page, errors, context } = await newPage(env);
  await open(page, url(env));
  await page.tap('[data-testid="start-recording"]');
  for (const id of GROUP1) {
    assert.equal(await page.getAttribute('[data-testid="detail"]', 'data-sound'), id);
    await page.tap('[data-testid="record"]');
    await page.waitForSelector('.p-btn.rec.recording');
    await page.waitForTimeout(700);
    await page.tap('[data-testid="record"]');
    await page.waitForSelector(`.st-tile.done[data-sound="${id}"]`);
  }
  assert.match(await page.textContent('[data-testid="group-note"]'), /your child can play/);
  await page.tap('[data-testid="go-play"]');
  assert.equal(await screen(page), 'home');
  assert.ok(await page.isVisible('[data-testid="play"]'));
  assert.deepEqual(errors, []);
  await context.close();
});

test('parent gate: a tap or short press does nothing, a 2 second hold opens the parent area', async () => {
  const { page, context } = await newPage(env);
  await open(page, url(env));
  await seed(page, { recordings: GROUP1 });
  await open(page, url(env));
  assert.equal(await screen(page), 'home');
  await page.tap('[data-testid="gate"]');
  await page.waitForTimeout(2300);
  assert.equal(await screen(page), 'home', 'tap');
  await holdGate(page, 900);
  await page.waitForTimeout(1500);
  assert.equal(await screen(page), 'home', 'short hold');
  // Hold interrupted by sliding off.
  const gate = await page.waitForSelector('[data-testid="gate"]');
  await gate.dispatchEvent('pointerdown', { pointerId: 1, pointerType: 'touch' });
  await page.waitForTimeout(1000);
  await gate.dispatchEvent('pointerleave', { pointerId: 1, pointerType: 'touch' });
  await page.waitForTimeout(1500);
  assert.equal(await screen(page), 'home', 'slid off');
  await holdGate(page, 2200);
  assert.equal(await screen(page), 'parent-menu');
  // The gate also works in the middle of a game.
  await page.tap('[data-testid="back-to-child"]');
  await page.tap('[data-testid="play"]');
  await page.waitForSelector('[data-screen="round"]');
  await holdGate(page, 2200);
  assert.equal(await screen(page), 'parent-menu');
  await page.waitForTimeout(2500);
  assert.equal(await screen(page), 'parent-menu', 'game timers do not pull the screen back');
  await context.close();
});

test('microphone permission denied gives a clear explanation, not a broken screen', async () => {
  const { page, errors, context } = await newPage(env, {
    mic: false,
    init: () => {
      navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('Permission denied', 'NotAllowedError'));
    },
  });
  await open(page, url(env));
  await page.tap('[data-testid="start-recording"]');
  await page.tap('[data-testid="record"]');
  await page.waitForSelector('.notice-error');
  const text = await page.textContent('.notice-error');
  assert.match(text, /Microphone access is blocked/);
  assert.match(text, /Settings/);
  assert.ok(await page.isEnabled('[data-testid="record"]'), 'can try again after fixing the permission');
  assert.equal(await screen(page), 'studio');
  assert.deepEqual(errors, []);
  await context.close();
});

test('microphone unavailable (no MediaRecorder) is explained up front', async () => {
  const { page, errors, context } = await newPage(env, { init: () => { delete window.MediaRecorder; } });
  await open(page, url(env));
  await page.tap('[data-testid="start-recording"]');
  assert.match(await page.textContent('.notice-error'), /cannot record audio/);
  assert.equal(await page.isEnabled('[data-testid="record"]'), false);
  assert.deepEqual(errors, []);
  await context.close();
});

test('storage unavailable: the app still runs and tells the parent', async () => {
  const { page, errors, context } = await newPage(env, {
    init: () => { Object.defineProperty(window, 'indexedDB', { get() { return undefined; } }); },
  });
  await open(page, url(env));
  assert.equal(await screen(page), 'welcome');
  assert.match(await page.textContent('.notice-warn'), /Storage is not available/);
  assert.deepEqual(errors, []);
  await context.close();
});

test('broken data file shows a parent-readable error', async () => {
  const { page, context } = await newPage(env);
  await open(page, url(env, { data: 'tests/fixtures/does-not-exist.json' }));
  assert.equal(await screen(page), 'data-error');
  assert.match(await page.textContent('.p-errors'), /HTTP 404/);
  await context.close();
});

test('settings: word speech toggle and rounds per session persist', async () => {
  const { page, context } = await newPage(env);
  await open(page, url(env));
  await seed(page, { recordings: GROUP1 });
  await open(page, url(env));
  await holdGate(page);
  await page.tap('[data-testid="open-settings"]');
  await page.uncheck('[data-testid="speak-words"]');
  await page.fill('[data-testid="rounds"]', '4');
  await page.waitForTimeout(200);
  const st = await storedState(page);
  assert.deepEqual(st.settings, { speakWords: false, roundsPerSession: 4 });
  await page.reload();
  await page.waitForFunction(() => document.body.dataset.ready);
  await page.tap('[data-testid="play"]');
  await page.waitForSelector('[data-screen="round"]');
  assert.equal(await page.locator('.dot').count(), 4);
  assert.equal(await page.locator('[data-testid="say-word"]').count(), 0, 'no word speakers when speech is off');
  await context.close();
});

test('reset progress asks for confirmation and keeps recordings', async () => {
  const { page, context } = await newPage(env);
  await open(page, url(env));
  await seed(page, { recordings: GROUP1, progress: { s1: { m: [{ c: 1, d: '2026-11-01' }] }, s2: {} }, readiness: [{ d: '2026-11-01', correct: true }] });
  await open(page, url(env));
  await holdGate(page);
  await page.tap('[data-testid="open-settings"]');
  await page.tap('[data-testid="reset"]');
  let st = await storedState(page);
  assert.equal(st.progress.s1.m.length, 1, 'nothing erased before confirming');
  await page.tap('[data-testid="confirm-reset"]');
  await page.waitForSelector('.notice-good');
  st = await storedState(page);
  assert.deepEqual(st.progress, { s1: {}, s2: {}, s3: {} });
  assert.deepEqual(st.readiness, []);
  assert.equal(st.recordings.length, 4);
  await context.close();
});
