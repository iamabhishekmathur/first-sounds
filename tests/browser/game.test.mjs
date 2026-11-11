// Child-side flows: a full stage 1 session, stage 2 unlocking (2-day rule), the readiness check.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setup, newPage, url, open, seed, storedState, log, answerRound, hist, GROUP1 } from './helpers.mjs';

const data = JSON.parse(readFileSync(new URL('../fixtures/sounds.sample.json', import.meta.url), 'utf8'));
const WORDS = new Set(data.words.map((w) => w.word));
const byId = new Map(data.sounds.map((s) => [s.id, s]));

let env;
before(async () => { env = await setup(); });
after(async () => { await env.close(); });

// Records every speech synthesis call, so we can prove isolated sounds never use it.
const spySpeech = () => {
  window.__spoken = [];
  const orig = speechSynthesis.speak.bind(speechSynthesis);
  speechSynthesis.speak = (u) => { window.__spoken.push(u.text); return orig(u); };
};

const screen = (page) => page.getAttribute('[data-screen]', 'data-screen');
const solidAll = (ids, days = ['2026-11-08', '2026-11-08', '2026-11-08', '2026-11-09', '2026-11-09', '2026-11-09']) =>
  Object.fromEntries(ids.map((id) => [id, hist(days)]));

test('a full stage 1 session, with a wrong-then-right round, ends calmly', async () => {
  const { page, errors, context } = await newPage(env, { init: spySpeech });
  await open(page, url(env, { seed: 7, today: '2026-11-10' }));
  await seed(page, { recordings: GROUP1 });
  await open(page, url(env, { seed: 7, today: '2026-11-10' }));
  await page.tap('[data-testid="play"]');
  await page.waitForSelector('[data-screen="round"]');

  // Round 1: no letters anywhere, the target sound plays, two pictures.
  assert.equal(await page.getAttribute('[data-screen="round"]', 'data-mode'), 'hear');
  assert.equal(await page.locator('.letter').count(), 0, 'no letters on the Hear it screen');
  assert.equal(await page.locator('.choice').count(), 2);
  const target = await page.getAttribute('[data-screen="round"]', 'data-target');
  await page.waitForFunction((t) => globalThis.__fsLog.some((e) => e.type === 'sound' && e.id === t), target);

  // Wrong tap: wiggle + target replays, nothing else.
  await page.evaluate(() => { globalThis.__fsLog.length = 0; });
  const wrong = page.locator(`.choice:not([data-sound="${target}"])`).first();
  await wrong.tap();
  assert.match(await wrong.getAttribute('class'), /wiggle/);
  await page.waitForFunction((t) => globalThis.__fsLog.some((e) => e.type === 'sound' && e.id === t), target);
  assert.equal(await page.locator('.glow').count(), 0, 'no glow after one wrong tap');
  assert.ok(!(await log(page)).some((e) => e.type === 'tone'), 'no buzz or tone for a wrong tap');

  // Second wrong tap: the correct picture glows; the round waits for it.
  await wrong.tap();
  await page.waitForSelector(`.choice.glow[data-sound="${target}"]`);
  assert.equal(await screen(page), 'round');

  // Big replay button replays the sound at any time.
  await page.evaluate(() => { globalThis.__fsLog.length = 0; });
  await page.tap('[data-testid="replay"]');
  await page.waitForFunction((t) => globalThis.__fsLog.some((e) => e.type === 'sound' && e.id === t), target);

  // Picture speaker says the whole word, without answering.
  await page.locator('[data-testid="say-word"]').first().tap();
  assert.equal(await screen(page), 'round');

  await page.tap(`.choice[data-sound="${target}"]`);
  await page.waitForSelector('.choice.happy');
  assert.ok((await log(page)).some((e) => e.type === 'tone'), 'soft tone on success');
  assert.equal(await page.locator('.dot.on').count(), 1);
  // After the round resolves, tapping a picture says its word.
  await page.locator('.choice:not(.happy)').first().tap();
  await page.waitForFunction(() => !document.querySelector('.round.resolved'));

  // Rounds 2-10 answered first time (10 rounds is the default session length now).
  for (let i = 2; i <= 10; i++) {
    const info = await answerRound(page);
    assert.ok(info, `round ${i} shown`);
    assert.equal(info.stage, '1');
    assert.ok(GROUP1.includes(info.target));
  }
  await page.waitForSelector('[data-screen="done"]');
  assert.equal(await page.locator('[data-testid="play-again"]').count(), 0, 'no play again button straight away');
  await page.waitForTimeout(2000);
  assert.equal(await page.locator('[data-testid="play-again"]').count(), 0, 'still none after 2 s');
  await page.waitForSelector('[data-testid="play-again"]', { timeout: 2500 });

  const st = await storedState(page);
  const all = Object.entries(st.progress.s1).flatMap(([id, h]) => h.map((r) => ({ id, ...r })));
  assert.equal(all.length, 10, 'ten rounds recorded (the default)');
  assert.equal(st.progress.s1[target][0].c, 0, 'the wrong-then-right round does not count as correct');
  assert.equal(all.filter((r) => r.c === 1).length, 9);
  assert.ok(all.every((r) => r.d === '2026-11-10'), 'injected date used');
  assert.deepEqual(st.progress.s2, {});

  const spoken = (await page.evaluate(() => window.__spoken)).filter((t) => t.trim());
  assert.ok(spoken.length > 0, 'whole words were spoken');
  for (const t of spoken) assert.ok(WORDS.has(t), `speech used only for whole words, got "${t}"`);
  assert.deepEqual(errors, []);
  await context.close();
});

test('stage 2 stays locked while good rounds are all on one day, and opens once they span two days', async () => {
  const { page, errors, context } = await newPage(env, { init: spySpeech });
  const day1 = '2026-11-09';
  await open(page, url(env, { seed: 11, today: day1 }));
  await seed(page, {
    recordings: GROUP1,
    progress: { s1: solidAll(GROUP1, Array(6).fill(day1)), s2: {} },
    settings: { speakWords: true, roundsPerSession: 10 },
  });
  // Same day: 6 first-tap-correct rounds each, but one calendar day, so nothing is solid.
  await open(page, url(env, { seed: 11, today: day1 }));
  await page.tap('[data-testid="play"]');
  for (let i = 0; i < 10; i++) {
    await page.waitForSelector('[data-screen="round"]');
    const info = await answerRound(page);
    assert.equal(info.stage, '1', 'still stage 1: one day only');
  }
  await page.waitForSelector('[data-screen="done"]');

  // Next day: a sound answered correctly today spans two days and becomes solid, so "See it" opens
  // for it. Stage 2 rounds must only ever target sounds already answered first-time today.
  const day2 = '2026-11-10';
  const okToday = new Set();
  const modes = new Set();
  for (const sd of [12, 13, 14]) {
    await open(page, url(env, { seed: sd, today: day2 }));
    await page.tap('[data-testid="play"]');
    for (let i = 0; i < 10; i++) {
      await page.waitForSelector('[data-screen="round"]');
      const mode = await page.getAttribute('[data-screen="round"]', 'data-mode');
      const t = await page.getAttribute('[data-screen="round"]', 'data-target');
      if (mode === 'see-letter') {
        assert.equal(await page.textContent('.lead-letter'), byId.get(t).graphemes[0]);
        await page.tap('.lead-letter');
        await page.waitForFunction((id) => globalThis.__fsLog.some((e) => e.type === 'sound' && e.id === id), t);
      }
      const info = await answerRound(page);
      if (info.stage === '2') {
        assert.ok(okToday.has(info.target), `${info.target} reached stage 2 only once solid`);
        modes.add(info.mode);
        if (info.mode === 'pick-letter') {
          const letters = info.choices.map((c) => c.text);
          assert.equal(new Set(letters).size, letters.length, 'no two choices show the same grapheme');
          for (const l of letters) assert.equal(l, l.toLowerCase());
        }
      } else {
        okToday.add(info.target);
      }
    }
    await page.waitForSelector('[data-screen="done"]');
    if (modes.size === 2) break;
  }
  assert.deepEqual([...modes].sort(), ['pick-letter', 'see-letter']);
  const st = await storedState(page);
  assert.ok(Object.keys(st.progress.s2).length > 0, 'stage 2 results recorded');
  await page.evaluate(() => globalThis.__fsApp.go('progress'));
  assert.equal(await page.textContent(`[data-testid="s1-${[...okToday][0]}"]`), 'solid');
  assert.deepEqual(errors, []);
  await context.close();
});

async function playUntilReadiness(page) {
  for (let i = 0; i < 12; i++) {
    const s = await screen(page);
    if (s === 'readiness') return true;
    if (s === 'done') return false;
    await answerRound(page);
    await page.waitForSelector('[data-screen="round"], [data-screen="readiness"], [data-screen="done"]');
  }
  return false;
}

test('readiness check: bonus round once group 1 is solid in stage 2, at most once a day, never a failure', async () => {
  const { page, errors, context } = await newPage(env);
  const today = '2026-11-10';
  await open(page, url(env, { seed: 5, today }));
  await seed(page, {
    recordings: GROUP1,
    progress: { s1: solidAll(GROUP1), s2: solidAll(GROUP1) },
    readiness: [
      { d: '2026-11-07', pair: 'dog+fish', asked: 'fishdog', chose: 'fishdog', correct: true },
      { d: '2026-11-08', pair: 'dog+fish', asked: 'dogfish', chose: 'fishdog', correct: false },
      { d: '2026-11-09', pair: 'cup+cake', asked: 'cupcake', chose: 'cupcake', correct: true },
    ],
  });
  await open(page, url(env, { seed: 5, today }));
  await page.tap('[data-testid="play"]');
  assert.ok(await playUntilReadiness(page), 'readiness round appeared');
  assert.equal(await page.locator('.dot.on').count(), 5, 'it comes half way through the session');

  // Phase 1: pair side by side, parent prompt.
  const prompt1 = await page.textContent('.prompt');
  const m = prompt1.match(/Slide a finger left to right and say: this is (\w+)\./);
  assert.ok(m, prompt1);
  const pics = await page.$$eval('.ready-track .ready-pic', (els) => els.map((e) => e.getAttribute('aria-label')));
  assert.equal(pics.join(''), m[1], 'prompt matches the left-to-right order shown');
  const box = await page.locator('[data-testid="ready-track"]').boundingBox();
  await page.mouse.move(box.x + 20, box.y + box.height / 2);
  await page.mouse.down();
  for (let x = 20; x < box.width - 20; x += 40) await page.mouse.move(box.x + x, box.y + box.height / 2);
  await page.mouse.up();

  // Phase 2: both orders stacked, "Which one is ...?"
  await page.waitForSelector('[data-screen="readiness"][data-phase="2"]');
  assert.equal(await page.locator('.ready-row').count(), 2);
  const ask = await page.getAttribute('[data-screen="readiness"]', 'data-ask');
  const askedWord = (await page.textContent('.prompt')).match(/Which one is (\w+)\?/)[1];
  assert.equal(await page.getAttribute(`.ready-row[data-order="${ask}"]`, 'aria-label'), askedWord);
  // The child picks the WRONG order: the response is the same gentle one.
  const other = ask === 'ab' ? 'ba' : 'ab';
  await page.tap(`.ready-row[data-order="${other}"]`);
  await page.waitForSelector('.ready-row.happy');
  await page.waitForSelector('[data-screen="round"], [data-screen="done"]');
  let st = await storedState(page);
  assert.equal(st.readiness.length, 4);
  assert.deepEqual([st.readiness[3].d, st.readiness[3].correct, st.readiness[3].asked], [today, false, askedWord]);
  assert.equal(await page.locator('.dot.on').count(), 5, 'bonus round does not use up a session round');

  // Same day again: no second readiness round.
  await open(page, url(env, { seed: 5, today }));
  await page.tap('[data-testid="play"]');
  assert.equal(await playUntilReadiness(page), false, 'at most once per day');

  // Next day: pass it. That makes 3 separate passing days, so the parent sees the blending note.
  await open(page, url(env, { seed: 5, today: '2026-11-11' }));
  await page.tap('[data-testid="play"]');
  assert.ok(await playUntilReadiness(page));
  await page.tap('.prompt-link'); // the parent's small "next" link also advances
  await page.waitForSelector('[data-screen="readiness"][data-phase="2"]');
  const ask2 = await page.getAttribute('[data-screen="readiness"]', 'data-ask');
  await page.tap(`.ready-row[data-order="${ask2}"]`);
  await page.waitForSelector('[data-screen="round"], [data-screen="done"]');
  st = await storedState(page);
  assert.equal(st.readiness.at(-1).correct, true);

  await page.evaluate(() => globalThis.__fsApp.go('parentMenu'));
  assert.match(await page.textContent('.notice-good'), /3 different days.*Reading starts once a word is ready/);
  await page.tap('[data-testid="open-progress"]');
  const table = await page.textContent('[data-testid="readiness-table"]');
  for (const d of ['2026-11-07', '2026-11-08', '2026-11-09', '2026-11-10', '2026-11-11']) assert.ok(table.includes(d), d);
  assert.equal(await page.textContent('[data-testid="s1-m"]'), 'solid');
  assert.deepEqual(errors, []);
  await context.close();
});

test('readiness is not offered before group 1 is solid in stage 2', async () => {
  const { page, context } = await newPage(env);
  await open(page, url(env, { seed: 5, today: '2026-11-10' }));
  await seed(page, { recordings: GROUP1, progress: { s1: solidAll(GROUP1), s2: solidAll(['m', 's', 'a']) } });
  await open(page, url(env, { seed: 5, today: '2026-11-10' }));
  await page.tap('[data-testid="play"]');
  assert.equal(await playUntilReadiness(page), false);
  await context.close();
});
