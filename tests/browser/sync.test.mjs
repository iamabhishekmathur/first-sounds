// Sync with the family code against the local fake API (tests/server.mjs + api/_lib/core.js).
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setup, newPage, url, open, seed, storedState, holdGate, answerRound, GROUP1, FAMILY_CODE } from './helpers.mjs';

let env;
before(async () => { env = await setup(); });
after(async () => { await env.close(); });
beforeEach(() => {
  env.api.backend.blobs.clear();
  env.api.familyCode = FAMILY_CODE;
  env.api.down = false;
  env.api.fail = null;
});

const FAST = { syncRetry: 300, syncDebounce: 150 };
const syncUrl = (params = {}) => url(env, { ...FAST, ...params });
const server = () => env.api.readDoc();
const status = (page) => page.getAttribute('[data-testid="sync-status"]', 'data-status');
const waitStatus = (page, s, timeout = 8000) => page.waitForSelector(`[data-testid="sync-status"][data-status="${s}"]`, { timeout });
const roundsOf = (progress) => Object.entries(progress[`s1`] || {}).flatMap(([sid, list]) => list.map((r) => `${sid}:${r.id}`)).sort();

async function enterCode(page, code = FAMILY_CODE) {
  await page.fill('[data-testid="sync-code"]', code);
  await page.tap('[data-testid="sync-enter"]');
}

async function waitFor(fn, what, timeout = 8000) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function playRounds(page, n) {
  await page.tap('[data-testid="play"]');
  for (let i = 0; i < n; i++) {
    await page.waitForSelector('[data-screen="round"]:not(.resolved)');
    await answerRound(page);
  }
}

/** A device with group 1 recorded and a little progress, synced with the family code. */
async function syncedDevice({ seedData = true } = {}) {
  const d = await newPage(env);
  await open(d.page, syncUrl());
  if (seedData) {
    await seed(d.page, { recordings: GROUP1, progress: { s1: { m: [{ c: 1, d: '2026-11-08' }, { c: 0, d: '2026-11-09' }] }, s2: {} }, settings: { speakWords: false, roundsPerSession: 7 } });
    await open(d.page, syncUrl());
    await holdGate(d.page);
  }
  await enterCode(d.page); // on the welcome screen when the device is new
  await waitStatus(d.page, 'synced');
  return d;
}

test('entering the code uploads everything; a fresh device then pulls the same recordings and progress', async () => {
  const a = await syncedDevice();
  // First upload: all four recordings, the progress (with round ids) and the settings.
  const s = await waitFor(async () => { const x = await server(); return x && Object.keys(x.recordings).length === 4 && x; }, 'upload');
  assert.deepEqual(Object.keys(s.recordings).sort(), [...GROUP1].sort());
  assert.equal(s.progress.s1.m.length, 2);
  assert.deepEqual(s.settings, { speakWords: false, roundsPerSession: 7 });
  assert.match(await a.page.textContent('[data-testid="sync-status"]'), /Synced at \d\d:\d\d/);
  const aState = await storedState(a.page);
  const aBytes = await a.page.evaluate(() => [...new Uint8Array(globalThis.__fsApp.recordings.get('s').data)]);

  // A second, completely fresh browser profile: welcome screen, enter the code there.
  const b = await newPage(env);
  await open(b.page, syncUrl());
  assert.equal(await b.page.getAttribute('[data-screen]', 'data-screen'), 'welcome');
  await enterCode(b.page, '  Panda Kettle Moon 38 ');
  await b.page.waitForSelector('[data-screen="parent-menu"]');
  await waitStatus(b.page, 'synced');
  const bState = await storedState(b.page);
  assert.deepEqual(bState.recordings, aState.recordings);
  assert.deepEqual(roundsOf(bState.progress), roundsOf(await a.page.evaluate(() => globalThis.__fsApp.progress)));
  assert.deepEqual(roundsOf(bState.progress), roundsOf(s.progress));
  assert.deepEqual(bState.settings, { speakWords: false, roundsPerSession: 7 });
  assert.deepEqual(await b.page.evaluate(() => [...new Uint8Array(globalThis.__fsApp.recordings.get('s').data)]), aBytes, 'same audio bytes');

  // It survives a reload (cached locally) and the child can play straight away.
  await b.page.reload();
  await b.page.waitForFunction(() => document.body.dataset.ready);
  assert.equal(await b.page.getAttribute('[data-screen]', 'data-screen'), 'home');
  assert.ok(await b.page.isVisible('[data-testid="play"]'));
  assert.deepEqual(a.errors, []);
  assert.deepEqual(b.errors, []);
  await a.context.close();
  await b.context.close();
});

test('a new recording is uploaded as soon as it is saved, and reaches the other device', async () => {
  const a = await syncedDevice({ seedData: false });
  const b = await syncedDevice({ seedData: false });
  await a.page.tap('[data-testid="start-recording"]');
  await a.page.waitForTimeout(1200);
  await a.page.tap('[data-testid="record"]');
  await a.page.waitForSelector('.p-btn.rec.recording');
  await a.page.waitForTimeout(900);
  await a.page.tap('[data-testid="record"]');
  await a.page.waitForSelector('[data-testid="studio-msg"]');
  const s = await waitFor(async () => { const x = await server(); return x && x.recordings.m && x; }, 'upload of m');
  assert.equal(s.recordings.m.updatedAt, await a.page.evaluate(() => globalThis.__fsApp.recordings.get('m').updatedAt));
  // The other device picks it up when it comes back to the foreground (or on start).
  await b.page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await waitFor(() => b.page.evaluate(() => globalThis.__fsApp.recordings.has('m')), 'download on b');
  assert.equal((await storedState(b.page)).recordings[0].id, 'm');
  await a.context.close();
  await b.context.close();
});

test('a wrong code is refused and nothing is saved or sent', async () => {
  const { page, context, errors } = await newPage(env);
  await open(page, syncUrl());
  await seed(page, { recordings: GROUP1 });
  await open(page, syncUrl());
  await holdGate(page);
  await enterCode(page, 'panda-kettle-moon-39');
  await page.waitForFunction(() => /not accepted/.test(document.querySelector('[data-testid="sync-msg"]').textContent));
  assert.equal(await page.locator('[data-testid="sync-status"]').count(), 0, 'not syncing');
  assert.equal(await server(), null);
  assert.equal(env.api.backend.blobs.size, 0);
  assert.equal(await page.evaluate(() => globalThis.__fsApp.store.getKV('sync')), undefined, 'code not stored');
  await page.reload();
  await page.waitForFunction(() => document.body.dataset.ready);
  assert.equal(await page.evaluate(() => globalThis.__fsApp.sync.enabled), false);

  // A saved code that stops working shows "wrong code" in the parent area only.
  await holdGate(page);
  await enterCode(page);
  await waitStatus(page, 'synced');
  env.api.familyCode = 'a-new-code-00';
  await page.tap('[data-testid="sync-now"]');
  await waitStatus(page, 'wrong-code');
  assert.ok(await page.isVisible('[data-testid="sync-code"]'), 'asks for the code again');
  await page.tap('[data-testid="back-to-child"]');
  assert.equal(await page.locator('[data-testid="sync-status"], .notice').count(), 0, 'child screen shows nothing');
  env.api.familyCode = FAMILY_CODE;
  await holdGate(page);
  await enterCode(page);
  await waitStatus(page, 'synced');
  // Expected 401 responses show up as console errors in Chromium ("Failed to load resource").
  assert.deepEqual(errors.filter((e) => !/401/.test(e)), []);
  await context.close();
});

test('offline: the child keeps playing, the parent sees "offline", and it syncs on reconnect', async () => {
  const a = await syncedDevice();
  await waitFor(async () => { const x = await server(); return x && Object.keys(x.recordings).length === 4; }, 'upload');
  const before = roundsOf((await server()).progress);
  await a.page.tap('[data-testid="back-to-child"]');
  await a.context.setOffline(true);
  await playRounds(a.page, 3);
  // The child screens never show sync state, and nothing blocks.
  assert.equal(await a.page.locator('[data-testid="sync-status"], [data-testid="sync-card"]').count(), 0);
  await waitFor(() => a.page.evaluate(() => globalThis.__fsApp.sync.status === 'offline'), 'offline status');
  assert.deepEqual(roundsOf((await server()).progress), before, 'nothing reached the server');
  const local = roundsOf((await storedState(a.page)).progress);
  assert.equal(local.length, before.length + 3, 'rounds kept locally');
  // Parent area: small status.
  await a.page.evaluate(() => globalThis.__fsApp.go('parentMenu'));
  assert.equal(await status(a.page), 'offline');
  assert.match(await a.page.textContent('[data-testid="sync-status"]'), /Offline/);
  // Reconnect: retried, and the rounds arrive.
  await a.context.setOffline(false);
  await waitStatus(a.page, 'synced');
  await waitFor(async () => roundsOf((await server()).progress).length === local.length, 'rounds on server');
  assert.deepEqual(roundsOf((await server()).progress), local);
  await a.context.close();
});

test('server down: retries quietly until it is back', async () => {
  const a = await syncedDevice();
  env.api.down = true;
  await a.page.tap('[data-testid="sync-now"]');
  await waitStatus(a.page, 'error');
  const before = env.api.requests.length;
  await a.page.waitForTimeout(1000);
  assert.ok(env.api.requests.length > before, 'retried');
  env.api.down = false;
  await waitStatus(a.page, 'synced', 10000);
  await a.context.close();
});

test('recordings whose upload failed stay queued and go up by themselves once the server works', async () => {
  // As in production: the code is accepted, but most recording uploads time out (504).
  env.api.fail = (req, u) => req.method === 'PUT' && u.pathname === '/api/recording' && u.searchParams.get('id') !== 'm';
  const d = await newPage(env);
  await open(d.page, syncUrl());
  await seed(d.page, { recordings: GROUP1 });
  await open(d.page, syncUrl());
  await holdGate(d.page);
  await enterCode(d.page);
  await waitStatus(d.page, 'error');
  assert.deepEqual(Object.keys((await server()).recordings), ['m'], 'only m reached the server');
  await d.page.waitForTimeout(700);
  const tries = env.api.requests.filter((r) => r === 'PUT /api/recording?id=s').length;
  assert.ok(tries >= 2, `s retried on its own (${tries} tries)`);
  assert.ok(env.api.requests.filter((r) => r === 'PUT /api/recording?id=t').length >= 2, 'a failure does not hold up the others');

  // Server fixed: no taps, no reload. The retry timer uploads everything.
  env.api.fail = null;
  await waitFor(async () => { const x = await server(); return x && Object.keys(x.recordings).length === 4; }, 'all uploads', 10000);
  await waitStatus(d.page, 'synced');

  // Reopening the app (a fresh start with the saved code) also sends anything still queued.
  env.api.fail = () => true;
  await d.page.evaluate(async () => {
    const app = globalThis.__fsApp;
    const r = { ...app.recordings.get('a'), updatedAt: Date.now() };
    await app.store.putRecording(r);
  });
  await open(d.page, syncUrl({ syncRetry: 60000 }));
  await waitFor(() => d.page.evaluate(() => globalThis.__fsApp.sync.status === 'error'), 'failed start'); // child screen: no status shown
  env.api.fail = null;
  await open(d.page, syncUrl({ syncRetry: 60000 }));
  const local = await d.page.evaluate(() => globalThis.__fsApp.recordings.get('a').updatedAt);
  await waitFor(async () => (await server()).recordings.a.updatedAt === local, 'queued a after reopening');
  await d.context.close();
});

test('progress pushes reuse a recently fetched server doc (fewer store operations)', async () => {
  const a = await syncedDevice();
  await open(a.page, syncUrl());
  await waitFor(() => a.page.evaluate(() => globalThis.__fsApp.sync.status === 'synced'), 'start sync');
  const from = env.api.requests.length;
  await playRounds(a.page, 2);
  await waitFor(async () => roundsOf((await server()).progress).length >= 4, 'rounds pushed');
  const reqs = env.api.requests.slice(from);
  assert.ok(reqs.includes('PUT /api/state'), reqs.join(', '));
  assert.ok(!reqs.includes('GET /api/state'), `no fetch before each push: ${reqs.join(', ')}`);
  await a.context.close();
});

test('two devices play offline at the same time: both keep every round after syncing', async () => {
  const a = await syncedDevice();
  await waitFor(async () => { const x = await server(); return x && Object.keys(x.recordings).length === 4; }, 'upload');
  const b = await newPage(env);
  await open(b.page, syncUrl());
  await enterCode(b.page);
  await b.page.waitForSelector('[data-screen="parent-menu"]');
  await waitStatus(b.page, 'synced');

  await a.context.setOffline(true);
  await b.context.setOffline(true);
  await a.page.tap('[data-testid="back-to-child"]');
  await b.page.tap('[data-testid="back-to-child"]');
  await playRounds(a.page, 3);
  await playRounds(b.page, 2);
  // b also changes a setting later than a did (settings: last writer wins).
  await b.page.evaluate(async () => { const app = globalThis.__fsApp; app.settings.roundsPerSession = 9; await app.save('settings'); });
  const ra = roundsOf((await storedState(a.page)).progress);
  const rb = roundsOf((await storedState(b.page)).progress);
  const union = [...new Set([...ra, ...rb])].sort();
  assert.equal(union.length, 2 + 3 + 2);

  await a.context.setOffline(false);
  await waitFor(() => a.page.evaluate(() => globalThis.__fsApp.sync.status === 'synced'), 'a synced');
  await b.context.setOffline(false);
  await waitFor(() => b.page.evaluate(() => globalThis.__fsApp.sync.status === 'synced'), 'b synced');
  assert.deepEqual(roundsOf((await server()).progress), union, 'server has every round');
  assert.deepEqual(roundsOf((await storedState(b.page)).progress), union, 'b has every round');
  // a pulls b's rounds on its next sync (start, foreground, or after a change).
  await a.page.evaluate(() => globalThis.__fsApp.sync.now());
  assert.deepEqual(roundsOf((await storedState(a.page)).progress), union, 'a has every round');
  assert.equal((await storedState(a.page)).settings.roundsPerSession, 9);
  assert.equal((await server()).settings.roundsPerSession, 9);
  await a.context.close();
  await b.context.close();
});

test('a progress reset on one device reaches the others; recordings stay', async () => {
  const a = await syncedDevice();
  const b = await newPage(env);
  await open(b.page, syncUrl());
  await enterCode(b.page);
  await b.page.waitForSelector('[data-screen="parent-menu"]');
  assert.equal((await storedState(b.page)).progress.s1.m.length, 2);
  await a.page.tap('[data-testid="open-settings"]');
  await a.page.tap('[data-testid="reset"]');
  await a.page.tap('[data-testid="confirm-reset"]');
  await waitFor(async () => { const x = await server(); return x && !x.progress.s1.m; }, 'reset on server');
  await b.page.evaluate(() => globalThis.__fsApp.sync.now());
  const st = await storedState(b.page);
  assert.deepEqual(st.progress, { s1: {}, s2: {}, s3: {} });
  assert.equal(st.recordings.length, 4);
  await a.context.close();
  await b.context.close();
});

test('backup export and import still work on a synced device, and merge with the server', async () => {
  const a = await syncedDevice();
  await a.page.tap('[data-testid="open-settings"]');
  const [download] = await Promise.all([a.page.waitForEvent('download'), a.page.tap('[data-testid="export"]')]);
  const backup = JSON.parse(await (await import('node:fs/promises')).readFile(await download.path(), 'utf8'));
  assert.equal(backup.recordings.length, 4);
  assert.equal(backup.kv.sync, undefined, 'the family code is not in backups');
  assert.ok(!JSON.stringify(backup).includes(FAMILY_CODE));
  await a.page.setInputFiles('[data-testid="import-file"]', await download.path());
  await a.page.waitForSelector('[data-testid="confirm-import"]');
  assert.match(await a.page.textContent('.notice-warn'), /merged with what is on the server/);
  await a.page.tap('[data-testid="confirm-import"]');
  await a.page.waitForSelector('[data-screen="parent-menu"]');
  assert.equal(await a.page.evaluate(() => globalThis.__fsApp.sync.enabled), true, 'still syncing after import');
  await waitStatus(a.page, 'synced');
  assert.equal(Object.keys((await server()).recordings).length, 4);
  await a.context.close();
});
