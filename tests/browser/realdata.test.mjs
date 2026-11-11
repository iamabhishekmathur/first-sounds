// Checks against the real content file data/sounds.json (written separately). Skipped if it is absent.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { validateData, describeData } from '../../js/data.js';
import * as L from '../../js/logic.js';
import { setup, newPage, open, seed, answerRound } from './helpers.mjs';

const FILE = new URL('../../data/sounds.json', import.meta.url);
const present = existsSync(FILE);
const skip = present ? false : 'data/sounds.json is not present';

let env;
before(async () => { if (present) env = await setup(); });
after(async () => { if (env) await env.close(); });

test('real data/sounds.json passes the schema validator', { skip }, () => {
  const data = JSON.parse(readFileSync(FILE, 'utf8'));
  const r = validateData(data);
  assert.deepEqual(r.errors, []);
  const d = describeData(data);
  console.log(`# real data: ${d.sounds} sounds, ${d.words} words, groups ${d.groups.join(',')}, ${d.readinessPairs} readiness pairs`);
  console.log(`# not game targets (< 3 words): ${d.nonTargets.join(', ')}`);
  console.log(`# shared display graphemes: ${d.sharedGraphemes.join(' | ')}`);
  if (r.warnings.length) console.log(`# warnings: ${r.warnings.join(' | ')}`);
});

test('round rules hold on the real data for every target', { skip }, () => {
  const data = JSON.parse(readFileSync(FILE, 'utf8'));
  const byId = new Map(data.sounds.map((s) => [s.id, s]));
  const eligible = L.targetEligibleIds(data);
  for (const target of data.sounds.filter((s) => eligible.has(s.id))) {
    for (const status of ['learning', 'solid']) {
      const blocked = L.blockedIds(data, target, status);
      for (let seed = 1; seed <= 40; seed++) {
        const pics = L.pickPictureChoices({ data, target, targetStatus: status, n: 3, rng: L.mulberry32(seed) });
        assert.equal(pics.length, 3, `${target.id}: 3 pictures`);
        for (const c of pics.filter((x) => !x.correct)) assert.ok(!blocked.has(c.soundId), `${target.id}/${status}: ${c.word}`);
        const letters = L.pickLetterChoices({ data, target, targetStatus: status, n: 3, rng: L.mulberry32(seed) });
        assert.equal(new Set(letters.map((c) => c.grapheme)).size, 3, `${target.id}: distinct graphemes`);
        for (const c of letters.filter((x) => !x.correct)) {
          assert.notEqual(byId.get(c.soundId).graphemes[0], target.graphemes[0]);
          if (status === 'learning') assert.ok(!target.confusable.includes(c.soundId));
        }
      }
    }
  }
});

test('a right answer always has the target as a full (not reduced) sound; no u-round accepts a reduced-vowel word', { skip }, () => {
  const data = JSON.parse(readFileSync(FILE, 'utf8'));
  const words = new Map(data.words.map((w) => [w.word, w]));
  const reducedU = new Set(data.words.filter((w) => (w.reduced || []).some((i) => w.phonemes[i] === 'u')
    && !w.phonemes.some((p, i) => p === 'u' && !(w.reduced || []).includes(i))).map((w) => w.word));
  assert.ok(reducedU.has('apple') && reducedU.has('banana') && reducedU.has('giraffe'), 'the data marks schwa words');
  const eligible = L.targetEligibleIds(data);
  for (const target of data.sounds.filter((s) => eligible.has(s.id))) {
    const mode = L.positionMode(data, target.id);
    for (const w of L.wordsWithSound(data, target.id, mode)) {
      const idx = mode === 'start' ? [0] : mode === 'end' ? [w.phonemes.length - 1] : w.phonemes.map((p, i) => (p === target.id ? i : -1)).filter((i) => i >= 0);
      assert.ok(idx.some((i) => w.phonemes[i] === target.id && !(w.reduced || []).includes(i)), `${target.id}: ${w.word}`);
    }
    for (const status of ['learning', 'solid']) {
      for (let seed = 1; seed <= (target.id === 'u' ? 400 : 20); seed++) {
        const ans = L.pickPictureChoices({ data, target, targetStatus: status, n: 3, rng: L.mulberry32(seed) }).find((c) => c.correct);
        if (target.id === 'u') assert.ok(!reducedU.has(ans.word), `u round answered by ${ans.word}`);
        assert.ok(L.hasSoundAt(words.get(ans.word), target.id, mode));
      }
    }
  }
  const uAnswers = L.wordsWithSound(data, 'u', L.positionMode(data, 'u')).map((w) => w.word);
  for (const wd of ['apple', 'needle', 'eagle', 'banana', 'balloon', 'giraffe']) assert.ok(!uAnswers.includes(wd), wd);
});

test('the app loads the real data by default and plays a session', { skip }, async () => {
  const data = JSON.parse(readFileSync(FILE, 'utf8'));
  const group1 = data.sounds.filter((s) => s.group === 1).map((s) => s.id);
  const { page, errors, context } = await newPage(env);
  const href = `${env.base}index.html?seed=3&today=2026-11-10`;
  await open(page, href);
  assert.equal(await page.getAttribute('[data-screen]', 'data-screen'), 'welcome');
  await page.tap('[data-testid="start-recording"]');
  assert.equal(await page.locator('.p-tab:not(.p-tab-words)').count(), new Set(data.sounds.map((s) => s.group)).size);
  assert.equal(await page.locator('.st-tile').count(), group1.length);
  await seed(page, { recordings: group1 });
  await open(page, href);
  await page.tap('[data-testid="play"]');
  for (let i = 0; i < 10; i++) {
    await page.waitForSelector('[data-screen="round"]');
    const info = await answerRound(page);
    assert.ok(group1.includes(info.target));
  }
  await page.waitForSelector('[data-screen="done"]');
  assert.deepEqual(errors, []);
  await context.close();
});

/* ---------- the real data/reading.json (written separately; skipped if absent) ---------- */

const RFILE = new URL('../../data/reading.json', import.meta.url);
const rskip = present && existsSync(RFILE) ? false : 'data/reading.json is not present';

test('real data/reading.json passes the reading validator against the real sounds', { skip: rskip }, async () => {
  const { validateReading } = await import('../../js/reading.js');
  const sounds = JSON.parse(readFileSync(FILE, 'utf8'));
  const r = validateReading(JSON.parse(readFileSync(RFILE, 'utf8')), sounds);
  assert.deepEqual(r.errors, []);
  const left = r.warnings.filter((w) => /left out/.test(w));
  const levels = [1, 2, 3, 4].map((l) => r.words.filter((w) => w.level === l).length);
  console.log(`# real reading: ${r.words.length} usable words (levels ${levels.join('/')}), ${r.words.filter((w) => w.emoji).length} with a picture, ${left.length} left out, ${r.warnings.length} warnings`);
  for (const w of r.warnings) console.log(`#   ${w}`);
});

test('the app runs a reading round on the real word list', { skip: rskip }, async () => {
  const sounds = JSON.parse(readFileSync(FILE, 'utf8'));
  const group1 = sounds.sounds.filter((s) => s.group === 1).map((s) => s.id);
  const days = ['2026-11-08', '2026-11-08', '2026-11-08', '2026-11-09', '2026-11-09', '2026-11-09'];
  const solid = Object.fromEntries(['m', 'a', 't', ...group1].map((id) => [id, days.map((d) => ({ c: 1, d }))]));
  const { page, errors, context } = await newPage(env);
  const href = `${env.base}index.html?seed=3&today=2026-11-10`;
  await open(page, href);
  await seed(page, {
    recordings: [...group1, 't', 'w:mat'], progress: { s1: solid, s2: solid }, blend: { on: true, at: 1 },
    readiness: [{ id: 'r', d: '2026-11-10', pair: 'x', asked: 'x', chose: 'x', correct: true, at: 1 }], settings: { speakWords: true, roundsPerSession: 4 },
  });
  await open(page, href);
  assert.equal(await page.evaluate(() => globalThis.__fsApp.reading.report.ok), true);
  await page.tap('[data-testid="play"]');
  for (let i = 0; i < 3; i++) {
    await page.waitForSelector('[data-screen="round"]:not(.resolved)');
    if (await page.getAttribute('[data-screen="round"]', 'data-stage') === '3') break;
    await answerRound(page);
  }
  assert.equal(await page.getAttribute('[data-screen="round"]', 'data-word'), 'mat');
  await page.tap('[data-testid="go"]');
  await page.waitForSelector('[data-phase="blended"]', { timeout: 6000 });
  await page.tap('[data-testid="say-fast"]');
  await page.waitForSelector('[data-phase="done"]', { timeout: 5000 });
  await page.evaluate(() => globalThis.__fsApp.go('parentMenu'));
  assert.equal(await page.locator('[data-testid="reading-unavailable"]').count(), 0);
  assert.deepEqual(errors, []);
  await context.close();
});
