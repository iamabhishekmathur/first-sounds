// Reading ("Read it", stage 3): the studio's Words tab, reading rounds by touch and on the TV, the
// parent override, the Learning path, migration of data from before reading, and word recordings
// syncing between devices.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setup, newPage, url, open, seed, holdGate, answerRound, hist, GROUP1, FAMILY_CODE } from './helpers.mjs';

let env;
before(async () => { env = await setup(); });
after(async () => { await env.close(); });
beforeEach(() => { env.api.backend.blobs.clear(); env.api.down = false; env.api.fail = null; });

const TODAY = '2026-11-10';
const DAYS = ['2026-11-08', '2026-11-08', '2026-11-08', '2026-11-09', '2026-11-09', '2026-11-09'];
const solid = (ids) => Object.fromEntries(ids.map((id) => [id, hist(DAYS)]));
const SOUNDS = ['m', 's', 'a', 't', 'n', 'u'];
// The readiness check already done today, so it does not take the reading slot.
const DONE_TODAY = [{ id: 'rq', d: TODAY, pair: 'dog+fish', asked: 'dogfish', chose: 'dogfish', correct: true, at: 1 }];
const ON = { on: true, at: 5 };
const screenName = (page) => page.getAttribute('#app > section', 'data-screen');

/** A device ready to read: sounds solid in See it, the given words recorded, the override on. */
async function reader(words, { params = {}, blend = ON, settings = { speakWords: true, roundsPerSession: 4 }, ctx = {} } = {}) {
  const d = await newPage(env, ctx);
  const href = url(env, { seed: 3, today: TODAY, ...params });
  await open(d.page, href);
  await seed(d.page, {
    recordings: [...SOUNDS, ...words.map((w) => `w:${w}`)], progress: { s1: solid(SOUNDS), s2: solid(SOUNDS) },
    readiness: DONE_TODAY, blend, settings,
  });
  await open(d.page, href);
  return { ...d, href };
}

/** Plays sound rounds (right first time) until a reading round shows. */
async function untilReading(page) {
  for (let i = 0; i < 12; i++) {
    await page.waitForSelector('[data-screen="round"]:not(.resolved), [data-screen="done"]');
    if (await screenName(page) === 'done') return false;
    if (await page.getAttribute('[data-screen="round"]', 'data-stage') === '3') return true;
    await answerRound(page);
  }
  return false;
}

const lights = (page) => page.evaluate(() => globalThis.__fsLog.filter((e) => e.type === 'light').map((e) => ({ i: e.i, t: e.t, word: e.word })));

/** A finger slide along the road with pointer events, from fraction a to b of the road's width. */
async function slide(page, a, b) {
  const box = await page.locator('[data-testid="road"]').boundingBox();
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width * a, y);
  await page.mouse.down();
  for (let k = 1; k <= 8; k++) await page.mouse.move(box.x + box.width * (a + ((b - a) * k) / 8), y);
  await page.mouse.up();
}

test('studio Words tab: lists the next words to record and records one with the fake microphone', async () => {
  const { page, errors, context } = await newPage(env);
  const href = url(env, { seed: 1, today: TODAY });
  await open(page, href);
  await seed(page, { recordings: GROUP1, progress: { s1: solid(['m', 's', 'a', 't', 'n', 'u', 'e', 'i', 'p']), s2: solid(['m', 's', 'a', 't', 'n', 'u', 'e', 'i', 'p']) } });
  await open(page, href);
  await holdGate(page);
  await page.tap('[data-testid="open-studio"]');
  await page.tap('[data-testid="words-tab"]');
  // The next 5 words whose sounds are all solid in See it, level then file order.
  const listed = await page.$$eval('[data-testid="next-words"] .st-word', (els) => els.map((e) => e.dataset.word));
  assert.deepEqual(listed, ['am', 'mat', 'sat', 'man', 'map']);
  assert.match(await page.textContent('[data-testid="group-note"]'), /are ready to record/);
  // The first word, large and lowercase, with its stretched example.
  assert.equal(await page.getAttribute('[data-testid="detail"]', 'data-word'), 'am');
  await page.tap('.st-word[data-word="mat"]');
  assert.equal(await page.textContent('.st-big-word'), 'mat');
  assert.equal(await page.textContent('[data-testid="stretched"]'), 'mmmaaat');
  assert.match(await page.textContent('[data-testid="detail"]'), /Say it stretched, with no pauses: mmmaaat\..*Hold the sounds you can hold; keep the quick ones \(t, p, b\.\.\.\) short and joined on/s);
  // Record, stop, saved and played back.
  await page.tap('[data-testid="record"]');
  await page.waitForSelector('.p-btn.rec.recording');
  await page.waitForTimeout(1300);
  await page.tap('[data-testid="record"]');
  await page.waitForSelector('[data-testid="studio-msg"]');
  assert.match(await page.textContent('[data-testid="studio-msg"]'), /Saved "mat"/);
  const rec = await page.evaluate(async () => { const r = await globalThis.__fsApp.store.getRecording('w:mat'); return r && { mime: r.mime, bytes: r.data.byteLength }; });
  assert.ok(rec && rec.bytes > 1000, JSON.stringify(rec));
  // It leaves the "next" list (now recorded) and the next word is selected.
  const after = await page.$$eval('[data-testid="next-words"] .st-word', (els) => els.map((e) => e.dataset.word));
  assert.ok(!after.includes('mat'));
  assert.equal(after.length, 5);
  assert.notEqual(await page.getAttribute('[data-testid="detail"]', 'data-word'), 'mat');
  // Every word, by level; not-ready words say which sounds they wait for. Re-record from there.
  await page.tap('[data-testid="show-all-words"]');
  assert.equal(await page.locator('.st-word').count(), 22);
  assert.match(await page.textContent('.st-word[data-word="frog"]'), /needs f, r, o and g in See it|needs f, r, o, g in See it/);
  await page.tap('.st-word[data-word="mat"]');
  assert.match(await page.textContent('[data-testid="record"]'), /Re-record/);
  assert.match(await page.textContent('[data-testid="open-studio"], .p-tab-words'), /1\/22/);
  assert.deepEqual(errors, []);
  await context.close();
});

test('a full reading round by touch: slide, the lights in order, say it fast, the picture check', async () => {
  const { page, errors, context } = await reader(['man', 'sun'], { ctx: { init: () => { window.__spoken = []; const o = speechSynthesis.speak.bind(speechSynthesis); speechSynthesis.speak = (u) => { window.__spoken.push([u.text, u.rate]); return o(u); }; } } });
  await page.tap('[data-testid="play"]');
  assert.ok(await untilReading(page), 'a reading round came');
  const word = await page.getAttribute('[data-screen="round"]', 'data-word');
  assert.ok(['man', 'sun'].includes(word));
  assert.equal(await page.getAttribute('[data-screen="round"]', 'data-check'), '1');
  // One tile per grapheme, lowercase, a dot under each, the go arrow, and the parent prompt.
  assert.deepEqual(await page.$$eval('.gtile', (els) => els.map((e) => e.textContent)), word.split(''));
  assert.equal(await page.locator('.road-dot').count(), 3);
  assert.equal(await page.textContent('.prompt'), 'Slide under the word together and stretch the sounds. Then say it fast!');
  assert.equal(await page.isVisible('[data-testid="say-fast"]'), false);

  // Starting from the middle, or sliding backwards, does nothing.
  await page.evaluate(() => { globalThis.__fsLog.length = 0; });
  await slide(page, 0.6, 0.95);
  await slide(page, 0.3, 0.02);
  await page.tap('[data-testid="road"]', { position: { x: 300, y: 20 } }).catch(() => {});
  await page.waitForTimeout(400);
  assert.equal(await page.getAttribute('[data-screen="round"]', 'data-phase'), 'ready');
  assert.equal((await lights(page)).length, 0);

  // A slide from the left end plays the stretched recording, and the tiles light up in turn.
  await slide(page, 0.03, 0.4);
  await page.waitForFunction(() => globalThis.__fsLog.some((e) => e.type === 'sound' && e.id.startsWith('w:')));
  await page.waitForSelector('.gtile.now');
  assert.equal(await page.getAttribute('[data-screen="round"]', 'data-phase'), 'blending');
  await page.waitForSelector('[data-phase="blended"]', { timeout: 5000 });
  const l = await lights(page);
  assert.deepEqual(l.map((x) => x.i), [0, 1, 2], 'each tile once, left to right');
  for (let i = 1; i < l.length; i++) assert.ok(l[i].t > l[i - 1].t, 'in turn');
  const blend = await page.evaluate(() => globalThis.__fsLog.find((e) => e.type === 'blend'));
  assert.ok(Math.abs(blend.durationMs - 1800) < 120, `timed to the recording: ${blend.durationMs}`);
  // m-a-n / s-u-n are all continuous: equal thirds.
  assert.deepEqual(blend.timings.map((x) => x.end - x.start), [600, 600, 600]);
  assert.equal(await page.locator('.gtile.lit').count(), 3);
  // Say it fast: the word at normal speed (speech), then the picture check.
  await page.tap('[data-testid="say-fast"]');
  await page.waitForSelector('.read-choices:not([hidden]) .choice');
  const spoken = await page.evaluate(() => window.__spoken.filter(([t]) => t.trim()));
  assert.deepEqual(spoken.at(-1), [word, 1], 'spoken at normal speed');
  assert.equal(await page.locator('.read-choices .choice').count(), 2);
  assert.match(await page.textContent('.prompt'), /Which picture is the word\?/);
  // Wrong first: wiggle, the stretched word plays again; never a failure.
  await page.evaluate(() => { globalThis.__fsLog.length = 0; });
  await page.tap('.read-choices .choice[data-correct="0"]');
  assert.match(await page.getAttribute('.read-choices .choice[data-correct="0"]', 'class'), /wiggle/);
  await page.waitForFunction(() => globalThis.__fsLog.some((e) => e.type === 'sound' && e.id.startsWith('w:')));
  assert.ok(!(await page.evaluate(() => globalThis.__fsLog.some((e) => e.type === 'tone'))), 'no tone for a wrong tap');
  await page.tap('.read-choices .choice[data-correct="1"]');
  await page.waitForSelector('.read-choices .choice.happy');
  await page.waitForSelector('[data-screen="round"]:not([data-stage="3"]), [data-screen="done"]', { timeout: 5000 });
  // Recorded like the other stages: in the session and the round log, with the wrong tap.
  const st = await page.evaluate(() => ({ p: globalThis.__fsApp.progress.s3, s: globalThis.__fsApp.sessions }));
  const r = st.p[`w:${word}`];
  assert.equal(r.length, 1);
  assert.equal(r[0].c, 0, 'not right first time');
  assert.equal(r[0].wrong.length, 1);
  assert.equal(r[0].ses, st.s[0].id);
  assert.ok(st.s[0].stages.includes(3));
  assert.deepEqual(errors, []);
  await context.close();
});

test('a word without a picture: blend and the fast version, no picture check, marked practised', async () => {
  const { page, errors, context } = await reader(['mat']);
  await page.tap('[data-testid="play"]');
  assert.ok(await untilReading(page));
  assert.equal(await page.getAttribute('[data-screen="round"]', 'data-word'), 'mat');
  assert.equal(await page.getAttribute('[data-screen="round"]', 'data-check'), '0');
  await page.tap('[data-testid="go"]');
  await page.waitForSelector('[data-phase="blended"]', { timeout: 5000 });
  const blend = await page.evaluate(() => globalThis.__fsLog.find((e) => e.type === 'blend'));
  // m and a held (1.0 each), t short (0.4): 750, 750, 300 of 1800 ms.
  assert.deepEqual(blend.timings.map((x) => x.end - x.start), [750, 750, 300]);
  await page.tap('[data-testid="say-fast"]');
  await page.waitForSelector('[data-phase="done"]', { timeout: 4000 });
  assert.equal(await page.locator('.read-choices .choice').count(), 0);
  await page.waitForSelector('[data-screen="round"]:not([data-stage="3"]), [data-screen="done"]', { timeout: 5000 });
  const st = await page.evaluate(() => ({ p: globalThis.__fsApp.progress.s3, s: globalThis.__fsApp.sessions[0] }));
  assert.deepEqual(st.p['w:mat'].map((r) => [r.c, r.p]), [[0, 1]], 'practised, not right or wrong');
  assert.equal(st.s.practised, 1);
  assert.deepEqual(errors, []);
  await context.close();
});

test('TV: a reading round with the keyboard only (OK on the road, say it fast, the pictures); Back does nothing', async () => {
  const { page, errors, context } = await reader(['man', 'sun'], { params: { tv: '1' }, ctx: { viewport: { width: 1920, height: 1080 }, touch: false } });
  await page.keyboard.press('Enter'); // Play
  for (let i = 0; i < 4; i++) {
    await page.waitForSelector('[data-screen="round"]:not(.resolved)');
    if (await page.getAttribute('[data-screen="round"]', 'data-stage') === '3') break;
    const target = await page.getAttribute('[data-screen="round"]', 'data-target');
    for (let k = 0; k < 4 && !(await page.evaluate((t) => document.activeElement.matches(`.choice[data-sound="${t}"]`), target)); k++) await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => !document.querySelector('.round.resolved'), null, { timeout: 6000 });
  }
  assert.equal(await page.getAttribute('[data-screen="round"]', 'data-stage'), '3');
  assert.ok(await page.evaluate(() => document.activeElement.matches('[data-testid="road"]')), 'focus starts on the road');
  assert.match(await page.textContent('.prompt'), /Press OK on the road together/);
  await page.keyboard.press('Escape'); // Back during a round: nothing
  assert.equal(await page.getAttribute('[data-screen="round"]', 'data-stage'), '3');
  assert.equal(await page.evaluate(() => globalThis.FirstSoundsTV_onBack()), true);
  await page.keyboard.press('Enter');
  await page.waitForSelector('.gtile.now');
  await page.waitForSelector('[data-phase="blended"]', { timeout: 5000 });
  assert.deepEqual((await lights(page)).map((x) => x.i), [0, 1, 2]);
  await page.waitForFunction(() => document.activeElement.matches('[data-testid="say-fast"]'));
  await page.keyboard.press('Enter');
  await page.waitForSelector('.read-choices:not([hidden]) .choice');
  await page.waitForFunction(() => document.activeElement.matches('.read-choices .choice'));
  for (let k = 0; k < 3 && !(await page.evaluate(() => document.activeElement.dataset.correct === '1')); k++) await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.read-choices .choice.happy');
  // Focus is never lost.
  assert.ok(await page.evaluate(() => document.activeElement && document.activeElement !== document.body));
  await page.waitForSelector('[data-screen="round"]:not([data-stage="3"]), [data-screen="done"]', { timeout: 5000 });
  assert.ok(await page.evaluate(() => document.activeElement && document.activeElement !== document.body));
  const s3 = await page.evaluate(() => globalThis.__fsApp.progress.s3);
  assert.equal(Object.values(s3).flat()[0].c, 1, 'right first time');
  assert.deepEqual(errors, []);
  await context.close();
});

test('the parent override: "your child is ready to blend" with a confirmation unlocks stage 3', async () => {
  const { page, errors, context } = await reader(['man', 'sun'], { blend: null, params: { syncDebounce: 100 } });
  // Not ready yet: sessions have no reading rounds.
  await page.tap('[data-testid="play"]');
  for (let i = 0; i < 4; i++) {
    await page.waitForSelector('[data-screen="round"]:not(.resolved)');
    assert.notEqual(await page.getAttribute('[data-screen="round"]', 'data-stage'), '3');
    await answerRound(page);
  }
  await page.waitForSelector('[data-screen="done"]');
  await page.evaluate(() => globalThis.__fsApp.go('home'));
  await holdGate(page);
  await page.tap('[data-testid="open-settings"]');
  // Turning it on asks first, explaining the readiness check (no name: "your child").
  await page.click('[data-testid="blend-override"]');
  await page.waitForSelector('[data-testid="confirm-blend"]');
  assert.equal(await page.isChecked('[data-testid="blend-override"]'), false, 'not on until confirmed');
  const text = await page.textContent('[data-testid="blend-card"]');
  assert.match(text, /Your child is ready to blend/);
  assert.match(text, /readiness check on 3 separate days/);
  assert.doesNotMatch(text, /Mantra/);
  await page.tap('[data-testid="cancel-blend"]');
  assert.equal(await page.evaluate(() => globalThis.__fsApp.blendOverride), null);
  await page.click('[data-testid="blend-override"]');
  await page.tap('[data-testid="confirm-blend"]');
  await page.waitForSelector('[data-testid="blend-override"]:checked');
  const stored = await page.evaluate(() => globalThis.__fsApp.store.getKV('blend'));
  assert.equal(stored.on, true);
  // The menu says reading is on, and the next session has a reading round.
  await page.tap('.p-back');
  assert.match(await page.textContent('[data-testid="reading-on"]'), /Reading is on/);
  await page.tap('[data-testid="back-to-child"]');
  await page.tap('[data-testid="play"]');
  assert.ok(await untilReading(page), 'a reading round after the override');
  // Turning it off again closes stage 3 at once.
  await page.evaluate(() => { const app = globalThis.__fsApp; app.go('settings'); });
  await page.click('[data-testid="blend-override"]');
  await page.waitForFunction(() => globalThis.__fsApp.blendOverride && globalThis.__fsApp.blendOverride.on === false);
  assert.deepEqual(errors, []);
  await context.close();
});

test('the Learning path: at the start, and after seeded progress; the compact path on the Tracker', async () => {
  const { page, errors, context } = await newPage(env);
  const href = url(env, { seed: 1, today: TODAY });
  await open(page, href);
  await seed(page, { recordings: GROUP1 });
  await open(page, href);
  await holdGate(page);
  await page.tap('[data-testid="open-path"]');
  const statuses = () => page.$$eval('[data-testid="learning-path"] > li', (els) => els.map((e) => [e.dataset.testid, e.dataset.status]));
  assert.deepEqual(await statuses(), [['lp-hear', 'todo'], ['lp-letters', 'todo'], ['lp-ready', 'todo'], ['lp-first', 'todo'], ['lp-harder', 'todo'], ['lp-sentences', 'later']]);
  assert.equal(await page.textContent('[data-testid="lp-next"]'), 'Next: get m, s, a and t solid in Hear it and then in See it, so the readiness check can start.');
  assert.match(await page.textContent('[data-testid="lp-hear"]'), /0 of 17/);
  assert.match(await page.textContent('[data-testid="lp-ready"]'), /0 of 3 days/);
  assert.match(await page.textContent('[data-testid="lp-sentences"]'), /coming later/);
  // The Tracker's compact path, linking to the full screen.
  await page.tap('.p-back');
  await page.tap('[data-testid="open-tracker"]');
  assert.match(await page.textContent('[data-testid="lpc-next"]'), /Next: get m, s, a and t solid/);
  await page.tap('[data-testid="open-path"]');
  await page.waitForSelector('[data-screen="path"]');

  // After progress: sounds solid, ready by the check on 3 days, two words solid.
  const S = ['m', 's', 'a', 't', 'n', 'u', 'e'];
  const three = ['2026-11-01', '2026-11-02', '2026-11-03'].map((d, i) => ({ id: `r${i}`, d, correct: true, at: i + 1 }));
  await seed(page, {
    recordings: ['w:man', 'w:sun', 'w:mat'],
    progress: { s1: solid(S), s2: solid(S.slice(0, 6)), s3: { 'w:man': hist(DAYS), 'w:sun': hist(DAYS), 'w:mat': [{ c: 0, d: TODAY, p: 1 }] } },
    readiness: three,
  });
  await open(page, href);
  await page.evaluate(() => globalThis.__fsApp.go('path'));
  assert.deepEqual(await statuses(), [['lp-hear', 'doing'], ['lp-letters', 'doing'], ['lp-ready', 'done'], ['lp-first', 'doing'], ['lp-harder', 'todo'], ['lp-sentences', 'later']]);
  assert.match(await page.textContent('[data-testid="lp-hear"]'), /7 of 17/);
  assert.match(await page.textContent('[data-testid="lp-letters"]'), /6 of 17/);
  assert.match(await page.textContent('[data-testid="lp-ready"]'), /3 of 3 days/);
  assert.match(await page.textContent('[data-testid="lp-first"]'), /2 of 5/);
  assert.match(await page.textContent('[data-testid="lp-first"]'), /Also 1 word without a picture practised/);
  assert.equal(await page.locator('[data-testid="lp-harder"] [data-testid="lp-bar"]').count(), 3, 'one bar per level');
  assert.match(await page.textContent('[data-testid="lp-now"]'), /Blending first words: 2 of 5 level 1 words solid\./);
  assert.equal(await page.getAttribute('[data-testid="lp-first"]', 'class'), 'lp-step doing current');
  // Read-only on the TV too.
  const tv = await newPage(env, { viewport: { width: 1920, height: 1080 }, touch: false });
  await open(tv.page, url(env, { seed: 1, today: TODAY, tv: '1' }));
  await seed(tv.page, { recordings: GROUP1 });
  await open(tv.page, url(env, { seed: 1, today: TODAY, tv: '1' }));
  await tv.page.evaluate(() => globalThis.__fsApp.go('parentMenu'));
  await tv.page.waitForSelector('[data-testid="open-path"]');
  await tv.page.focus('[data-testid="open-path"]');
  await tv.page.keyboard.press('Enter');
  await tv.page.waitForSelector('[data-screen="path"]');
  assert.match(await tv.page.textContent('[data-testid="lp-next"]'), /Next:/);
  assert.equal(await tv.page.locator('[data-screen="path"] input, [data-screen="path"] [data-testid="record"]').count(), 0);
  await tv.page.keyboard.press('Escape');
  await tv.page.waitForSelector('[data-screen="parent-menu"]');
  assert.deepEqual(tv.errors, []);
  await tv.context.close();
  assert.deepEqual(errors, []);
  await context.close();
});

test('migration: an old local store (no reading, settings never changed) loads without loss and gets 10 rounds', async () => {
  const { page, errors, context } = await newPage(env);
  const href = url(env, { seed: 2, today: TODAY });
  await open(page, href);
  // What the previous version stored: progress without s3, old default settings, no meta, no blend.
  const old = { s1: { m: [{ c: 1, d: '2026-11-08' }, { c: 0, d: '2026-11-09', id: 'k1', t: 5 }] }, s2: { m: [{ c: 1, d: '2026-11-09' }] } };
  await page.evaluate(async (old) => {
    const app = globalThis.__fsApp;
    await app.store.setKV('progress', old);
    await app.store.setKV('settings', { speakWords: false, roundsPerSession: 6 });
    await app.store.setKV('readiness', [{ d: '2026-11-07', pair: 'dog+fish', asked: 'dogfish', chose: 'dogfish', correct: true }]);
    await app.store.setKV('sessions', [{ id: 'S0', d: '2026-11-09', start: 1, end: 2, stages: [1], rounds: 2, correct: 1 }]);
  }, old);
  await seed(page, { recordings: GROUP1 });
  await open(page, href);
  const app = await page.evaluate(() => { const a = globalThis.__fsApp; return { p: a.progress, set: a.settings, r: a.readiness, s: a.sessions, b: a.blendOverride }; });
  assert.deepEqual(app.p.s1.m.map((r) => [r.c, r.d]), [[1, '2026-11-08'], [0, '2026-11-09']]);
  assert.equal(app.p.s1.m[1].id, 'k1');
  assert.equal(app.p.s2.m.length, 1);
  assert.deepEqual(app.p.s3, {});
  assert.deepEqual(app.set, { speakWords: false, roundsPerSession: 10 }, 'never changed: the new default; speech choice kept');
  assert.equal(app.r.length, 1);
  assert.equal(app.s.length, 1);
  assert.equal(app.b, null);
  // A session is now 10 rounds; nothing old is lost.
  await page.tap('[data-testid="play"]');
  for (let i = 0; i < 10; i++) { await page.waitForSelector('[data-screen="round"]:not(.resolved)'); await answerRound(page); }
  await page.waitForSelector('[data-screen="done"]');
  const st = await page.evaluate(() => globalThis.__fsApp.store.getKV('progress'));
  assert.equal(st.s1.m.filter((r) => r.d < TODAY).length, 2);
  assert.equal(st.s2.m.filter((r) => r.d < TODAY).length, 1);
  // A setting the parent did change is kept.
  await page.evaluate(async () => { const a = globalThis.__fsApp; a.settings.roundsPerSession = 15; await a.save('settings'); });
  await open(page, href);
  assert.equal(await page.evaluate(() => globalThis.__fsApp.settings.roundsPerSession), 15);
  assert.deepEqual(errors, []);
  await context.close();
});

test('migration: an old server doc (no reading, old default) syncs to a new device and keeps everything after reading rounds', async () => {
  const oldDoc = {
    settings: { speakWords: true, roundsPerSession: 6 }, settingsAt: 0,
    progress: { s1: { m: [{ c: 1, d: '2026-11-08', id: 'o1', t: 1 }], s: [{ c: 1, d: '2026-11-09', id: 'o3', t: 3, ses: 'S0', wrong: [{ w: 'sun', s: 's' }] }] }, s2: { m: [{ c: 0, d: '2026-11-09', id: 'o2', t: 2 }] } },
    resetAt: 0, readiness: [{ id: 'rq', at: 4, d: '2026-11-09', pair: 'dog+fish', asked: 'dogfish', chose: 'dogfish', correct: true }],
    sessions: [{ id: 'S0', d: '2026-11-09', start: 3, end: 9, stages: [1], rounds: 1, correct: 1 }],
  };
  await env.api.backend.put('state/push/0000000000001-old.json', Buffer.from(JSON.stringify(oldDoc)), 'application/json');
  const { page, errors, context } = await reader(['man', 'sun'], { params: { syncRetry: 300, syncDebounce: 150 }, settings: null });
  await holdGate(page);
  await page.fill('[data-testid="sync-code"]', FAMILY_CODE);
  await page.tap('[data-testid="sync-enter"]');
  await page.waitForSelector('[data-testid="sync-status"][data-status="synced"]');
  const local = await page.evaluate(() => ({ p: globalThis.__fsApp.progress, set: globalThis.__fsApp.settings }));
  assert.deepEqual(local.p.s1.m.find((r) => r.id === 'o1'), oldDoc.progress.s1.m[0]);
  assert.equal(local.set.roundsPerSession, 10, 'the old default, never changed: now 10');
  await page.tap('[data-testid="back-to-child"]');
  await page.tap('[data-testid="play"]');
  assert.ok(await untilReading(page));
  await page.tap('[data-testid="go"]');
  await page.waitForSelector('[data-testid="say-fast"]:not([hidden])', { timeout: 5000 });
  await page.tap('[data-testid="say-fast"]');
  await page.waitForSelector('.read-choices:not([hidden]) .choice');
  await page.tap('.read-choices .choice[data-correct="1"]');
  await page.waitForSelector('[data-screen="round"]:not([data-stage="3"]), [data-screen="done"]', { timeout: 5000 });
  const end = Date.now() + 8000;
  let doc;
  for (;;) {
    doc = await env.api.readDoc();
    if (doc && Object.keys(doc.progress.s3 || {}).length) break;
    if (Date.now() > end) throw new Error('reading round not synced');
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.deepEqual(doc.progress.s1.m.find((r) => r.id === 'o1'), oldDoc.progress.s1.m[0]);
  assert.deepEqual(doc.progress.s1.s.find((r) => r.id === 'o3'), oldDoc.progress.s1.s[0]);
  assert.deepEqual(doc.progress.s2.m.find((r) => r.id === 'o2'), oldDoc.progress.s2.m[0]);
  assert.deepEqual(doc.readiness, oldDoc.readiness);
  assert.ok(doc.sessions.some((s) => s.id === 'S0'));
  assert.deepEqual(doc.blendOverride, ON, 'the override reached the server');
  assert.equal(Object.values(doc.progress.s3).flat()[0].c, 1);
  assert.equal(doc.settings.roundsPerSession, 10);
  assert.deepEqual(errors, []);
  await context.close();
});

test('a word recording syncs to a second, fresh profile through the fake API', async () => {
  const a = await reader(['man'], { params: { syncRetry: 300, syncDebounce: 150 } });
  await holdGate(a.page);
  await a.page.fill('[data-testid="sync-code"]', FAMILY_CODE);
  await a.page.tap('[data-testid="sync-enter"]');
  await a.page.waitForSelector('[data-testid="sync-status"][data-status="synced"]');
  assert.ok(env.api.requests.some((r) => r.startsWith('PUT /api/recording?id=w%3Aman')), 'uploaded under its word id');
  const paths = [...env.api.backend.blobs.keys()].filter((p) => p.startsWith('recordings/w.man/'));
  assert.equal(paths.length, 1, 'stored as its own blob, under a path that cannot collide with a sound');
  assert.equal((await env.api.readDoc()).recordings['w:man'].durationMs, 1800);

  const b = await newPage(env);
  const href = url(env, { syncRetry: 300, syncDebounce: 150 });
  await open(b.page, href);
  await b.page.fill('[data-testid="sync-code"]', FAMILY_CODE);
  await b.page.tap('[data-testid="sync-enter"]');
  await b.page.waitForFunction(() => globalThis.__fsApp.recordings.has('w:man'), null, { timeout: 8000 });
  const got = await b.page.evaluate(async () => { const r = await globalThis.__fsApp.store.getRecording('w:man'); return { bytes: r.data.byteLength, ms: r.durationMs }; });
  const want = await a.page.evaluate(async () => (await globalThis.__fsApp.store.getRecording('w:man')).data.byteLength);
  assert.equal(got.bytes, want);
  assert.equal(got.ms, 1800);
  assert.deepEqual(await b.page.evaluate(() => globalThis.__fsApp.blendOverride), ON, 'the override came too');
  // The fresh device can now read the word: sounds and the override synced too.
  await b.page.evaluate(() => globalThis.__fsApp.go('studio', { group: 'words' }));
  await b.page.tap('[data-testid="show-all-words"]');
  assert.match(await b.page.getAttribute('.st-word[data-word="man"]', 'class'), /done/);
  // An unknown word id is refused by the server.
  const res = await fetch(`${env.base}api/recording?id=w%3Azebra`, { method: 'PUT', headers: { 'x-family-code': FAMILY_CODE, 'content-type': 'audio/wav', 'x-updated-at': '5' }, body: Buffer.alloc(100) });
  assert.equal(res.status, 400);
  assert.deepEqual([...a.errors, ...b.errors].filter((e) => !/status of/.test(e)), []);
  await a.context.close();
  await b.context.close();
});
