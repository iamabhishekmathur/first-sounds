// Export everything to one file, wipe the device, import it back.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setup, newPage, url, open, seed, storedState, holdGate, GROUP1 } from './helpers.mjs';

let env;
before(async () => { env = await setup(); });
after(async () => { await env.close(); });

test('export then import restores recordings, progress, readiness and settings', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'fs-backup-'));
  const progress = { s1: { m: [{ c: 1, d: '2026-11-08' }, { c: 0, d: '2026-11-09' }] }, s2: {} };
  const readiness = [{ d: '2026-11-09', pair: 'dog+fish', asked: 'fishdog', chose: 'fishdog', correct: true }];

  const a = await newPage(env);
  await open(a.page, url(env));
  await seed(a.page, { recordings: GROUP1, progress, readiness, settings: { speakWords: false, roundsPerSession: 8 } });
  await open(a.page, url(env));
  const original = await storedState(a.page);
  const originalBytes = await a.page.evaluate(() => [...new Uint8Array(globalThis.__fsApp.recordings.get('s').data)].slice(0, 200));
  await holdGate(a.page);
  await a.page.tap('[data-testid="open-settings"]');
  const [download] = await Promise.all([a.page.waitForEvent('download'), a.page.tap('[data-testid="export"]')]);
  assert.match(download.suggestedFilename(), /^first-sounds-backup-\d{4}-\d{2}-\d{2}\.json$/);
  const file = path.join(dir, download.suggestedFilename());
  await download.saveAs(file);
  await a.page.waitForFunction(() => /Backup saved: 4 recordings/.test(document.querySelector('[data-testid="export-status"]').textContent));
  const backup = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(backup.app, 'first-sounds');
  assert.equal(backup.recordings.length, 4);
  await a.context.close();

  // A brand new device (fresh context = empty IndexedDB): first-run welcome offers the restore.
  const b = await newPage(env);
  await open(b.page, url(env));
  assert.equal(await b.page.getAttribute('[data-screen]', 'data-screen'), 'welcome');
  await b.page.setInputFiles('[data-testid="import-file"]', file);
  await b.page.waitForSelector('[data-screen="parent-menu"]');
  const restored = await storedState(b.page);
  assert.deepEqual(restored, original);
  const restoredBytes = await b.page.evaluate(() => [...new Uint8Array(globalThis.__fsApp.recordings.get('s').data)].slice(0, 200));
  assert.deepEqual(restoredBytes, originalBytes, 'audio bytes identical');

  // Restored recordings play, and survive a reload.
  await b.page.reload();
  await b.page.waitForFunction(() => document.body.dataset.ready);
  assert.equal(await b.page.getAttribute('[data-screen]', 'data-screen'), 'home');
  assert.deepEqual((await storedState(b.page)).progress, progress);

  // Importing over existing data asks first; a non-backup file is refused politely.
  await holdGate(b.page);
  await b.page.tap('[data-testid="open-settings"]');
  const junk = path.join(dir, 'junk.json');
  await writeFile(junk, JSON.stringify({ hello: 'world' }));
  await b.page.setInputFiles('[data-testid="import-file"]', junk);
  await b.page.waitForFunction(() => /not a First Sounds backup/.test(document.querySelector('[data-testid="import-status"]').textContent));
  assert.deepEqual(await storedState(b.page), original, 'nothing changed');
  // A real backup over existing data needs an explicit confirmation.
  await b.page.setInputFiles('[data-testid="import-file"]', file);
  await b.page.waitForSelector('[data-testid="confirm-import"]');
  assert.equal(await b.page.getAttribute('[data-screen]', 'data-screen'), 'settings', 'not replaced until confirmed');
  await b.page.tap('[data-testid="confirm-import"]');
  await b.page.waitForSelector('[data-screen="parent-menu"]');
  assert.deepEqual(await storedState(b.page), original);
  assert.deepEqual(b.errors, []);
  await b.context.close();
});
