// TV mode (?tv=1, or the Android TV wrapper's window.FirstSoundsTV): keyboard (remote) only, no
// touch, at 1920x1080 and 1280x720. Sync against the local fake API, the games, the readiness check,
// the OK-hold gate, the TV parent menu, Back, and speech through the wrapper's bridge.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setup, newPage, url, open, seed, storedState, holdGate, hist, GROUP1, FAMILY_CODE } from './helpers.mjs';
import { MODES_FIXTURE, realisticHistory, seedTracker } from './trackerdata.mjs';

const VIEWPORTS = [{ width: 1920, height: 1080 }, { width: 1280, height: 720 }];
const FAST = { syncRetry: 300, syncDebounce: 150 };

let env;
before(async () => { env = await setup(); });
after(async () => { await env.close(); });
beforeEach(() => {
  env.api.backend.blobs.clear();
  env.api.familyCode = FAMILY_CODE;
  env.api.down = false;
  env.api.fail = null;
});

const tvUrl = (params = {}) => url(env, { tv: 1, ...FAST, ...params });
const tvPage = (viewport, opts = {}) => newPage(env, { viewport, touch: false, ...opts });
const screen = (page) => page.getAttribute('#app [data-screen]', 'data-screen');
const back = (page) => page.evaluate(() => window.FirstSoundsTV_onBack());
const days = ['2026-11-08', '2026-11-08', '2026-11-08', '2026-11-09', '2026-11-09', '2026-11-09'];
const solidAll = (ids) => Object.fromEntries(ids.map((id) => [id, hist(days)]));

async function waitFor(fn, what, timeout = 8000) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** Focus is on a visible, enabled control inside the app. Returns a short description of it. */
async function assertFocus(page, where = '') {
  const f = await page.evaluate(() => {
    const a = document.activeElement;
    if (!a || a === document.body || !document.getElementById('app').contains(a)) return { ok: false, what: a ? a.tagName : 'none' };
    const r = a.getBoundingClientRect();
    const cs = getComputedStyle(a);
    const control = a.matches('button, [role="button"], input, select, summary');
    const visible = r.width > 4 && r.height > 4 && r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight && cs.visibility !== 'hidden';
    return {
      ok: control && visible && !a.disabled && !a.closest('[hidden]'),
      what: `${a.tagName.toLowerCase()}.${[...a.classList].join('.')}${a.dataset.testid ? `[${a.dataset.testid}]` : ''}`,
      cls: [...a.classList], testid: a.dataset.testid || null,
    };
  });
  assert.ok(f.ok, `focus lost ${where}: ${f.what}`);
  return f;
}

const focusedIs = (page, sel) => page.evaluate((s) => document.activeElement && document.activeElement.matches(s), sel);

/** An iPad that records group 1 (seeded) and syncs it with the family code, so the TV can load it. */
async function uploader(settings = { speakWords: true, roundsPerSession: 4 }) {
  const d = await newPage(env);
  await open(d.page, url(env, FAST));
  await seed(d.page, { recordings: GROUP1, settings });
  await open(d.page, url(env, FAST));
  await holdGate(d.page);
  await d.page.fill('[data-testid="sync-code"]', FAMILY_CODE);
  await d.page.tap('[data-testid="sync-enter"]');
  await waitFor(async () => { const x = await env.api.readDoc(); return x && Object.keys(x.recordings).length === 4; }, 'upload');
  return d;
}

/** On the TV code screen: type the code with the keyboard and submit it with the remote. */
async function enterCodeByKeys(page, { submit = 'button' } = {}) {
  await page.waitForSelector('[data-screen="tv-setup"]');
  assert.ok(await focusedIs(page, '[data-testid="sync-code"]'), 'focus starts in the code box');
  await page.keyboard.type(FAMILY_CODE);
  if (submit === 'button') {
    await page.keyboard.press('ArrowRight'); // the caret is at the end: Right leaves the box
    assert.ok(await focusedIs(page, '[data-testid="sync-enter"]'), 'Right reaches the Sync button');
  }
  await page.keyboard.press('Enter');
}

/** Moves focus along the choices with Left/Right until it is on the choice for `sound`, then presses OK. */
async function chooseByKeys(page, sound) {
  for (let i = 0; i < 6; i++) {
    const at = await page.evaluate(() => {
      const els = [...document.querySelectorAll('.choice')];
      return { i: els.indexOf(document.activeElement), sounds: els.map((e) => e.dataset.sound) };
    });
    const want = at.sounds.indexOf(sound);
    assert.ok(want >= 0, `choice ${sound} is on screen`);
    if (at.i === want) break;
    await page.keyboard.press(at.i < 0 || at.i < want ? 'ArrowRight' : 'ArrowLeft');
    await assertFocus(page, 'moving between choices');
  }
  assert.ok(await page.evaluate((s) => document.activeElement.matches(`.choice[data-sound="${s}"]`), sound));
  await page.keyboard.press('Enter');
}

/** Answers the current round with the remote, optionally wrong first. Returns the round info. */
async function answerByKeys(page, { wrongFirst = false } = {}) {
  await page.waitForSelector('[data-screen="round"]:not(.resolved)');
  const info = await page.evaluate(() => {
    const el = document.querySelector('[data-screen="round"]');
    return { stage: el.dataset.stage, mode: el.dataset.mode, target: el.dataset.target, sounds: [...el.querySelectorAll('.choice')].map((c) => c.dataset.sound) };
  });
  assert.ok(await focusedIs(page, '.choice:first-of-type'), 'focus starts on the first choice');
  await assertFocus(page, 'at the start of a round');
  if (wrongFirst) {
    const wrong = info.sounds.find((s) => s !== info.target);
    await chooseByKeys(page, wrong);
    await page.waitForSelector(`.choice.wiggle[data-sound="${wrong}"]`);
    assert.equal(await page.locator('.round.resolved').count(), 0, 'a wrong choice does not end the round');
    await page.waitForFunction((t) => globalThis.__fsLog.filter((e) => e.type === 'sound' && e.id === t).length >= 2, info.target);
    await assertFocus(page, 'after a wrong choice');
  }
  await chooseByKeys(page, info.target);
  await page.waitForSelector(`.round.resolved .choice.happy[data-sound="${info.target}"]`);
  await assertFocus(page, 'after the right choice');
  assert.equal(await back(page), true, 'Back during a game is handled (and does nothing)');
  assert.equal(await screen(page), 'round');
  await page.waitForFunction(() => !document.querySelector('.round.resolved'), null, { timeout: 6000 });
  return info;
}

for (const vp of VIEWPORTS) {
  const tag = `${vp.width}x${vp.height}`;

  test(`TV ${tag}: first run goes to code entry; with no recordings yet the TV shows a calm note`, async () => {
    const { page, context, errors } = await tvPage(vp);
    await open(page, tvUrl());
    assert.equal(await screen(page), 'tv-setup');
    assert.ok(await page.evaluate(() => document.documentElement.classList.contains('tv')));
    assert.match(await page.textContent('.p-lead'), /Enter your family code to load your recordings/);
    assert.equal(await page.locator('[data-testid="start-recording"], [data-testid="import-file"], [data-testid="export"]').count(), 0, 'no recording welcome or backup');
    await assertFocus(page, 'on the code screen');
    // OK on the empty box (opens the TV keyboard) does not complain.
    await page.keyboard.press('Enter');
    assert.equal(await page.textContent('[data-testid="sync-msg"]'), '');
    // A wrong code is refused and focus stays usable.
    await page.keyboard.type('wrong-code-11');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => /not accepted/.test(document.querySelector('[data-testid="sync-msg"]').textContent));
    await assertFocus(page, 'after a wrong code');
    await page.fill('[data-testid="sync-code"]', '');
    await enterCodeByKeys(page, { submit: tag === '1920x1080' ? 'button' : 'enter' });
    await page.waitForSelector('[data-screen="home"][data-waiting="1"]');
    assert.match(await page.textContent('[data-testid="tv-waiting"]'), /arrive here by themselves/);
    assert.equal(await page.locator('[data-testid="play"]').count(), 0, 'no games until recordings exist');
    const f = await assertFocus(page, 'on the waiting screen');
    assert.equal(f.testid, 'gate');
    assert.equal(await back(page), false, 'Back on the child home screen lets Android exit');
    // A reload in the wrapper keeps TV mode (remembered) even without ?tv=1.
    await open(page, url(env, FAST));
    assert.ok(await page.evaluate(() => document.documentElement.classList.contains('tv')));
    assert.equal(await screen(page), 'home');
    assert.deepEqual(errors.filter((e) => !/status of 401/.test(e)), [], 'only the refused code\'s 401');
    await context.close();
  });

  test(`TV ${tag}: sync with the code, then a Hear it session (wrong then right) and a See it round, keyboard only`, async () => {
    const ipad = await uploader();
    const { page, context, errors } = await tvPage(vp);
    await open(page, tvUrl({ seed: 7, today: '2026-11-10' }));
    await enterCodeByKeys(page);
    await page.waitForSelector('[data-testid="play"]');
    assert.equal(await page.evaluate(() => globalThis.__fsApp.recordings.size), 4, 'recordings loaded through sync');
    assert.ok(await focusedIs(page, '[data-testid="play"]'), 'focus starts on Play');
    assert.equal(await back(page), false);

    await page.keyboard.press('Enter'); // the first gesture is a key press: sound must still work
    await page.waitForSelector('[data-screen="round"]');
    await page.waitForFunction(() => globalThis.__fsLog.some((e) => e.type === 'sound'));
    assert.equal(await page.evaluate(async () => (await import('./js/audio.js')).context().state), 'running', 'audio unlocked by the key press');
    // The replay button is reachable and plays the sound again.
    await page.keyboard.press('ArrowLeft');
    assert.ok(await focusedIs(page, '[data-testid="replay"]'), 'Left from the first picture reaches the replay button');
    const before = await page.evaluate(() => globalThis.__fsLog.filter((e) => e.type === 'sound').length);
    await page.keyboard.press('Enter');
    await page.waitForFunction((n) => globalThis.__fsLog.filter((e) => e.type === 'sound').length > n, before);
    await page.keyboard.press('ArrowDown'); // nothing below: focus stays
    assert.ok(await focusedIs(page, '[data-testid="replay"]'));
    await page.keyboard.press('ArrowRight');
    assert.ok(await focusedIs(page, '.choice:first-of-type'));
    // Down from a picture reaches its speaker; OK says the word without answering; Up goes back.
    await page.keyboard.press('ArrowDown');
    assert.ok(await focusedIs(page, '.choice:first-of-type > .speaker'), 'Down reaches the picture\'s speaker');
    await assertFocus(page, 'on a speaker');
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('.round.resolved, .choice.wiggle').count(), 0, 'the speaker does not answer');
    await page.keyboard.press('ArrowUp');
    assert.ok(await focusedIs(page, '.choice:first-of-type'));

    const total = await page.locator('.dot').count();
    const r1 = await answerByKeys(page, { wrongFirst: true });
    assert.equal(r1.mode, 'hear');
    for (let i = 1; i < total; i++) {
      await page.waitForSelector('[data-screen="round"], [data-screen="done"]');
      if (await screen(page) === 'done') break;
      await answerByKeys(page);
    }
    await page.waitForSelector('[data-screen="done"]');
    await assertFocus(page, 'on all done');
    await page.waitForSelector('[data-testid="play-again"]', { timeout: 5000 });
    await page.waitForFunction(() => document.activeElement && document.activeElement.dataset.testid === 'play-again');
    await assertFocus(page, 'when play again appears');
    const st = await storedState(page);
    const rounds = Object.values(st.progress.s1).flat();
    assert.equal(rounds.length, total);
    assert.equal(rounds.filter((r) => r.c === 0).length, 1, 'the wrong-then-right round counts as not first time');
    assert.ok(rounds.some((r) => r.wrong && r.wrong.length === 1), 'the wrong choice is noted for the Tracker');
    assert.equal(await back(page), true, 'Back on all done is handled: home, not out of the app');
    assert.equal(await screen(page), 'home');

    // See it: once group 1 is solid in Hear it (seeded), play until a See it round comes up.
    await seed(page, { progress: { s1: solidAll(GROUP1), s2: {} } });
    let seen = null;
    for (const sd of [3, 4, 5, 6]) {
      await open(page, tvUrl({ seed: sd, today: '2026-11-10' }));
      await page.keyboard.press('Enter');
      for (let i = 0; i < 4 && !seen; i++) {
        await page.waitForSelector('[data-screen="round"], [data-screen="done"]');
        if (await screen(page) === 'done') break;
        const mode = await page.getAttribute('[data-screen="round"]', 'data-mode');
        if (mode === 'see-letter') {
          // The letter is the replay button here: Left reaches it and OK plays the sound.
          const t = await page.getAttribute('[data-screen="round"]', 'data-target');
          await page.keyboard.press('ArrowLeft');
          assert.ok(await focusedIs(page, '.lead-letter'));
          await page.keyboard.press('Enter');
          await page.waitForFunction((id) => globalThis.__fsLog.some((e) => e.type === 'sound' && e.id === id), t);
          await page.keyboard.press('ArrowRight');
        }
        const info = await answerByKeys(page);
        if (info.stage === '2') seen = info;
      }
      if (seen) break;
    }
    assert.ok(seen, 'a See it round was played with the remote');
    assert.ok(['see-letter', 'pick-letter'].includes(seen.mode));
    assert.deepEqual(errors, []);
    await context.close();
    await ipad.context.close();
  });

  test(`TV ${tag}: the readiness check with the remote`, async () => {
    const { page, context, errors } = await tvPage(vp);
    const today = '2026-11-10';
    await open(page, tvUrl({ seed: 5, today }));
    await seed(page, { recordings: GROUP1, progress: { s1: solidAll(GROUP1), s2: solidAll(GROUP1) } });
    await open(page, tvUrl({ seed: 5, today }));
    assert.equal(await screen(page), 'home');
    await page.keyboard.press('Enter');
    for (let i = 0; i < 6; i++) {
      await page.waitForSelector('[data-screen="round"], [data-screen="readiness"]');
      if (await screen(page) === 'readiness') break;
      await answerByKeys(page);
    }
    await page.waitForSelector('[data-screen="readiness"][data-phase="1"]');
    const prompt = await page.textContent('.prompt');
    assert.match(prompt, /^Point at each picture from left to right and say: this is (\w+)\. Then press OK\.$/);
    assert.doesNotMatch(prompt, /finger|slide/i);
    assert.ok(await focusedIs(page, '[data-testid="ready-track"]'), 'focus on the pictures');
    await assertFocus(page, 'readiness phase 1');
    assert.equal(await back(page), true);
    await page.keyboard.press('Enter');
    await page.waitForSelector('[data-screen="readiness"][data-phase="2"]');
    assert.ok(await focusedIs(page, '.ready-row:first-child'));
    await assertFocus(page, 'readiness phase 2');
    await page.keyboard.press('ArrowDown');
    assert.ok(await focusedIs(page, '.ready-row:nth-child(2)'), 'Down reaches the second row');
    await page.keyboard.press('ArrowDown'); // clamps
    assert.ok(await focusedIs(page, '.ready-row:nth-child(2)'));
    const chose = await page.getAttribute('.ready-row:nth-child(2)', 'aria-label');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.ready-row.happy');
    await assertFocus(page, 'after the readiness answer');
    await page.waitForSelector('[data-screen="round"]');
    const st = await storedState(page);
    assert.equal(st.readiness.length, 1);
    assert.equal(st.readiness[0].chose, chose);
    assert.deepEqual(errors, []);
    await context.close();
  });

  test(`TV ${tag}: holding OK on the gear for 3 s opens the TV parent menu; a short press does not`, async () => {
    const { page, context, errors } = await tvPage(vp);
    await open(page, tvUrl({ data: MODES_FIXTURE, today: '2026-11-10' }));
    const hist30 = realisticHistory('2026-11-10');
    await seedTracker(page, { recordings: ['m', 's', 'ng', 'ue', 'n', 't', 'sh', 'k', 'p', 'i', 'u', 'l'], ...hist30 });
    await open(page, tvUrl({ data: MODES_FIXTURE, today: '2026-11-10' }));
    assert.ok(await focusedIs(page, '[data-testid="play"]'));
    await page.keyboard.press('ArrowUp');
    assert.ok(await focusedIs(page, '[data-testid="gate"]'), 'Up from Play reaches the gear');
    assert.match(await page.getAttribute('[data-testid="gate"]', 'aria-label'), /hold OK for 3 seconds/);
    await page.keyboard.press('Enter'); // a press
    await page.keyboard.down('Enter');
    await page.waitForTimeout(1500); // a short hold
    await page.keyboard.up('Enter');
    await page.waitForTimeout(2000);
    assert.equal(await screen(page), 'home', 'a press or a short hold does not open the parent area');
    await page.keyboard.down('Enter');
    await page.waitForTimeout(2600);
    assert.equal(await screen(page), 'home', 'not before 3 seconds');
    await page.waitForSelector('[data-screen="parent-menu"]', { timeout: 1500 });
    await page.keyboard.up('Enter');
    assert.equal(await screen(page), 'parent-menu', 'releasing OK does not press what has focus now');

    // The TV parent menu: no recording studio or backup; a note on where recording happens.
    await assertFocus(page, 'on the parent menu');
    assert.equal(await page.locator('[data-testid="open-studio"]').count(), 0, 'no recording studio');
    assert.match(await page.textContent('[data-testid="tv-record-note"]'), /Recording is done on the iPad or laptop/);
    assert.ok(await page.isVisible('[data-testid="sync-card"] [data-testid="sync-code"]'), 'code entry in the menu');
    await page.evaluate(() => globalThis.__fsApp.go('studio'));
    assert.equal(await screen(page), 'parent-menu', 'the studio is not reachable on the TV');

    // Settings with the remote: no export or import.
    for (let i = 0; i < 4 && !(await focusedIs(page, '[data-testid="open-settings"]')); i++) {
      await page.keyboard.press(await focusedIs(page, '.p-tile') ? 'ArrowRight' : 'ArrowUp');
    }
    assert.ok(await focusedIs(page, '[data-testid="open-settings"]'), 'the Settings tile is reachable');
    await page.keyboard.press('Enter');
    await page.waitForSelector('[data-screen="settings"]');
    assert.equal(await page.locator('[data-testid="export"], [data-testid="import-file"]').count(), 0, 'no backup export or import on the TV');
    await assertFocus(page, 'on settings');
    // The checkbox toggles with OK.
    for (let i = 0; i < 4 && !(await focusedIs(page, '[data-testid="speak-words"]')); i++) await page.keyboard.press('ArrowDown');
    assert.ok(await focusedIs(page, '[data-testid="speak-words"]'));
    const was = await page.isChecked('[data-testid="speak-words"]');
    await page.keyboard.press('Enter');
    assert.equal(await page.isChecked('[data-testid="speak-words"]'), !was);
    await page.keyboard.press('Enter');
    assert.equal(await back(page), true);
    assert.equal(await screen(page), 'parent-menu', 'Back goes up a level');

    // The Tracker scrolls with the remote, to the very end.
    await page.focus('[data-testid="open-tracker"]');
    await page.keyboard.press('Enter');
    await page.waitForSelector('[data-testid="tracker-summary"]');
    await assertFocus(page, 'on the Tracker');
    assert.equal(await page.locator('.screen.parent button', { hasText: 'recording studio' }).count(), 0, 'no studio link in the Tracker');
    const scroll = () => page.evaluate(() => { const s = document.querySelector('.screen.parent'); return { top: s.scrollTop, max: s.scrollHeight - s.clientHeight }; });
    assert.ok((await scroll()).max > 200, 'the Tracker is longer than the screen');
    let last = -1;
    for (let i = 0; i < 80; i++) {
      await page.keyboard.press('ArrowDown');
      const s = await scroll();
      if (s.top >= s.max - 2 && s.top === last) break;
      last = s.top;
    }
    const end = await scroll();
    assert.ok(end.top >= end.max - 2, `scrolled to the end (${end.top} of ${end.max})`);
    assert.ok(await page.evaluate(() => { const r = document.querySelector('[data-testid="tracker-recordings"]').getBoundingClientRect(); return r.top < innerHeight && r.bottom > 0; }), 'the last section is on screen');
    for (let i = 0; i < 80 && (await scroll()).top > 0; i++) await page.keyboard.press('ArrowUp');
    assert.equal((await scroll()).top, 0, 'and back up to the top');

    // Back up the levels, then out of the app from the child home screen.
    assert.equal(await back(page), true);
    assert.equal(await screen(page), 'parent-menu');
    assert.equal(await back(page), true);
    assert.equal(await screen(page), 'home');
    assert.equal(await back(page), false);
    // Escape works the same in a normal browser.
    await holdGateMouse(page);
    await page.waitForSelector('[data-screen="parent-menu"]');
    await page.keyboard.press('Escape');
    assert.equal(await screen(page), 'home');
    assert.deepEqual(errors, []);
    await context.close();
  });
}

/** The gate still opens with a mouse or touch hold on the TV (3 s there). */
async function holdGateMouse(page) {
  const gate = await page.waitForSelector('[data-testid="gate"]');
  await gate.dispatchEvent('pointerdown', { pointerId: 1, pointerType: 'mouse', isPrimary: true });
  await page.waitForTimeout(1800);
  assert.equal(await screen(page), 'home', 'not after 2 s on the TV');
  await page.waitForTimeout(1400);
  await gate.evaluate((el) => el.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, pointerType: 'mouse', bubbles: true })));
}

test('TV: the wrapper bridge turns TV mode on, and FirstSoundsTV.speak says the words', async () => {
  const { page, context, errors } = await tvPage(VIEWPORTS[0], {
    init: () => {
      window.__tvSpoken = [];
      window.__webSpoken = [];
      window.FirstSoundsTV = { speak(t) { window.__tvSpoken.push(t); } };
      if (window.speechSynthesis) {
        const orig = speechSynthesis.speak.bind(speechSynthesis);
        speechSynthesis.speak = (u) => { window.__webSpoken.push(u.text); return orig(u); };
      }
    },
  });
  await open(page, url(env, { seed: 7, today: '2026-11-10' })); // no ?tv=1: the bridge alone
  assert.equal(await screen(page), 'tv-setup');
  assert.equal(typeof await back(page), 'boolean');
  await seed(page, { recordings: GROUP1, settings: { speakWords: true, roundsPerSession: 4 } });
  await open(page, url(env, { seed: 7, today: '2026-11-10' }));
  await page.keyboard.press('Enter');
  await page.waitForSelector('[data-screen="round"]');
  const word = await page.getAttribute('.choice:first-of-type', 'data-word');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await waitFor(() => page.evaluate((w) => window.__tvSpoken.includes(w), word), 'bridge speech');
  await page.keyboard.press('ArrowUp');
  const info = await answerByKeys(page);
  await waitFor(() => page.evaluate(() => window.__tvSpoken.length >= 2), 'the right word said after the answer');
  assert.ok(info);
  assert.deepEqual(await page.evaluate(() => window.__webSpoken.filter((t) => t.trim())), [], 'Web Speech is not used when the bridge speaks');
  assert.deepEqual(errors, []);
  await context.close();
});

test('TV: no speechSynthesis (Android WebView) and no bridge: speech is skipped without errors', async () => {
  const { page, context, errors } = await tvPage(VIEWPORTS[1], {
    init: () => {
      Object.defineProperty(window, 'speechSynthesis', { value: undefined, configurable: true });
      Object.defineProperty(window, 'SpeechSynthesisUtterance', { value: undefined, configurable: true });
    },
  });
  await open(page, tvUrl({ seed: 7, today: '2026-11-10' }));
  assert.equal(await page.evaluate(() => window.speechSynthesis), undefined);
  await seed(page, { recordings: GROUP1, settings: { speakWords: true, roundsPerSession: 4 } });
  await open(page, tvUrl({ seed: 7, today: '2026-11-10' }));
  await page.keyboard.press('Enter');
  await page.waitForSelector('[data-screen="round"]');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter'); // the speaker: nothing to say it with
  await page.keyboard.press('ArrowUp');
  for (let i = 0; i < 4; i++) {
    await page.waitForSelector('[data-screen="round"], [data-screen="done"]');
    if (await screen(page) === 'done') break;
    await answerByKeys(page, { wrongFirst: i === 0 });
  }
  await page.waitForSelector('[data-screen="done"]');
  assert.ok(await page.evaluate(() => globalThis.__fsLog.some((e) => e.type === 'sound')), 'recordings still play');
  assert.deepEqual(errors, []);
  await context.close();
});

test('outside TV mode the iPad is unchanged: no TV class, no bridge, no focus moves, 2 s gate, touch flows', async () => {
  const { page, context, errors } = await newPage(env);
  await open(page, url(env, { seed: 7, today: '2026-11-10' }));
  assert.equal(await screen(page), 'welcome');
  assert.equal(await page.evaluate(() => document.documentElement.classList.contains('tv')), false);
  assert.equal(await page.evaluate(() => typeof window.FirstSoundsTV_onBack), 'undefined');
  await seed(page, { recordings: GROUP1 });
  await open(page, url(env, { seed: 7, today: '2026-11-10' }));
  assert.match(await page.getAttribute('[data-testid="gate"]', 'aria-label'), /press and hold for 2 seconds/);
  await page.tap('[data-testid="play"]');
  await page.waitForSelector('[data-screen="round"]');
  assert.equal(await page.evaluate(() => document.activeElement === document.body || document.activeElement.dataset.testid === 'play' || null), true, 'focus is not moved to a choice');
  assert.equal(await page.locator('.speaker[tabindex]').count(), 0, 'speakers are not made focusable');
  assert.match(await page.textContent('.prompt'), /then tap the picture/);
  await page.keyboard.press('Escape');
  assert.equal(await screen(page), 'round', 'Escape does nothing outside TV mode');
  await holdGate(page);
  await page.waitForSelector('[data-screen="parent-menu"]');
  assert.equal(await page.locator('[data-testid="open-studio"]').count(), 1, 'the studio is there');
  assert.equal(await page.locator('[data-testid="tv-record-note"]').count(), 0);
  await page.tap('[data-testid="open-settings"]');
  assert.equal(await page.locator('[data-testid="export"]').count(), 1, 'export is there');
  assert.deepEqual(errors, []);
  await context.close();
});

test('?tv=0 turns a remembered TV mode off', async () => {
  const { page, context } = await tvPage(VIEWPORTS[1]);
  await open(page, tvUrl());
  assert.ok(await page.evaluate(() => document.documentElement.classList.contains('tv')));
  await open(page, url(env, { tv: 0 }));
  assert.equal(await page.evaluate(() => document.documentElement.classList.contains('tv')), false);
  assert.equal(await screen(page), 'welcome');
  await open(page, url(env));
  assert.equal(await page.evaluate(() => document.documentElement.classList.contains('tv')), false);
  await context.close();
});
