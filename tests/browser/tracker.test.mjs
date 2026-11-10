// Position modes in the child rounds, the Tracker, and loading data saved by the previous version.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setup, newPage, url, open, seed, storedState, holdGate, answerRound, GROUP1, FAMILY_CODE } from './helpers.mjs';
import { MODES_FIXTURE } from './trackerdata.mjs';

let env;
before(async () => { env = await setup(); });
after(async () => { await env.close(); });
beforeEach(() => { env.api.backend.blobs.clear(); env.api.familyCode = FAMILY_CODE; env.api.down = false; env.api.fail = null; });

const MODES_G1 = ['m', 's', 'ng', 'ue'];
const PROMPT = {
  start: 'Listen, then tap the picture that starts with this sound.',
  end: 'Listen, then tap the picture that ends with this sound.',
  anywhere: 'Listen, then tap the picture that has this sound in it.',
};
const roundInfo = (page) => page.evaluate(() => {
  const el = document.querySelector('[data-screen="round"]');
  return el ? { target: el.dataset.target, mode: el.dataset.mode, position: el.dataset.position, prompt: el.querySelector('.prompt').textContent, words: [...el.querySelectorAll('.choice')].map((c) => c.dataset.word) } : null;
});
const learning = (day) => [{ c: 1, d: day }, { c: 0, d: day }];
const WORDS = {
  ng: { ring: ['r', 'i', 'ng'], king: ['k', 'i', 'ng'], sing: ['s', 'i', 'ng'], tongue: ['t', 'u', 'ng'] },
};

test('"ends with" and "has this sound" rounds, each with the right parent prompt; the session and wrong taps are recorded and shown in the Tracker', async () => {
  const { page, errors, context } = await newPage(env);
  const params = { data: MODES_FIXTURE, seed: 3, today: '2026-11-10', syncDebounce: 100 };
  await open(page, url(env, params));
  await seed(page, { recordings: MODES_G1, progress: { s1: { m: learning('2026-11-09'), s: learning('2026-11-09') }, s2: {} } });
  await open(page, url(env, params));
  await page.tap('[data-testid="play"]');
  const seen = {};
  let wrongs = 0;
  for (let i = 0; i < 6; i++) {
    await page.waitForSelector('[data-screen="round"]:not(.resolved)');
    const info = await roundInfo(page);
    assert.equal(info.mode, 'hear');
    assert.equal(info.prompt, PROMPT[info.position], `${info.target}: prompt for ${info.position}`);
    seen[info.position] = seen[info.position] || info;
    if (info.target === 'ng') {
      assert.equal(info.position, 'end');
      const answer = info.words.find((w) => WORDS.ng[w]);
      assert.ok(answer, `an ng picture is offered: ${info.words}`);
      for (const w of info.words.filter((x) => x !== answer)) assert.ok(!['monkey', 'ring', 'king', 'sing', 'tongue'].includes(w), `${w} has ng`);
    }
    if (info.target === 'ue') {
      assert.equal(info.position, 'anywhere');
      assert.equal(info.words.filter((w) => ['moon', 'spoon', 'boot', 'shoe', 'tooth'].includes(w)).length, 1, `only the answer has oo: ${info.words}`);
    }
    const wrongFirst = i < 2 ? 1 : 0; // a wrong tap in each of the first two rounds
    wrongs += wrongFirst;
    await answerRound(page, { wrongFirst });
  }
  await page.waitForSelector('[data-screen="done"]');
  assert.ok(seen.end, 'an "ends with" round was played');
  assert.ok(seen.anywhere, 'a "has this sound" round was played');

  // Stored: one session (6 rounds, 4 right first time) and the rounds point to it, with their wrong taps.
  const st = await page.evaluate(async () => ({ sessions: await globalThis.__fsApp.store.getKV('sessions'), progress: await globalThis.__fsApp.store.getKV('progress') }));
  assert.equal(st.sessions.length, 1);
  const ses = st.sessions[0];
  assert.deepEqual([ses.d, ses.rounds, ses.correct, ses.stages], ['2026-11-10', 6, 4, [1]]);
  assert.ok(ses.end >= ses.start);
  const played = Object.values(st.progress.s1).flat().filter((r) => r.d === '2026-11-10');
  assert.equal(played.length, 6);
  assert.ok(played.every((r) => r.ses === ses.id));
  const taps = played.filter((r) => r.wrong).flatMap((r) => r.wrong);
  assert.equal(taps.length, wrongs);
  for (const tap of taps) assert.ok(typeof tap.w === 'string');

  // The Tracker shows the session, the summary and the mix-ups.
  await page.evaluate(() => globalThis.__fsApp.go('tracker'));
  await page.waitForSelector('[data-screen="tracker"]');
  assert.equal(await page.locator('[data-testid="tracker-empty"]').count(), 0);
  assert.match(await page.textContent('[data-testid="stat-days"]'), /2 of the last 7/, 'today and the seeded rounds yesterday');
  assert.match(await page.textContent('[data-testid="stat-sessions"]'), /1 session/);
  const rows = page.locator('[data-testid="tracker-sessions"] tbody tr');
  assert.equal(await rows.count(), 1);
  assert.match(await rows.first().textContent(), /today.*Hear it.*6.*4 of 6/);
  assert.equal(await page.locator('[data-testid="mixup"]').count(), 2);
  assert.equal(await page.textContent('[data-testid="tk-mode-ng"]'), 'ends with');
  assert.equal(await page.textContent('[data-testid="tk-mode-ue"]'), 'anywhere');
  assert.match(await page.textContent('[data-testid="tk-mode-z"]'), /not a game target: 1 picture word with it \(needs 4\)/);
  assert.match(await page.getAttribute('[data-testid="tk-mode-z"]', 'title'), /only 1 has it/);
  for (const c of ['chart-rounds', 'chart-accuracy', 'chart-solid']) assert.equal(await page.locator(`[data-testid="${c}"] svg`).count(), 1, c);
  // Sorting works and keeps every sound.
  const before = await page.locator('[data-testid="tracker-sounds"] tbody tr').count();
  await page.selectOption('[data-testid="tk-sort"]', 'group');
  assert.equal(await page.locator('[data-testid="tracker-sounds"] tbody tr').first().getAttribute('data-sound'), 'm');
  assert.equal(await page.locator('[data-testid="tracker-sounds"] tbody tr').count(), before);
  assert.deepEqual(errors, []);
  await context.close();
});

test('See it letter-to-picture rounds use the same position wording', async () => {
  const { page, errors, context } = await newPage(env);
  const solid = ['2026-11-08', '2026-11-08', '2026-11-08', '2026-11-09', '2026-11-09', '2026-11-09'].map((d) => ({ c: 1, d }));
  const params = (sd) => ({ data: MODES_FIXTURE, seed: sd, today: '2026-11-10' });
  await open(page, url(env, params(1)));
  await seed(page, { recordings: MODES_G1, progress: { s1: { m: solid, s: solid, ng: solid, ue: solid }, s2: {} }, settings: { speakWords: true, roundsPerSession: 10 } });
  const got = {};
  for (let sd = 1; sd <= 6 && !(got.end && got.anywhere); sd++) {
    await open(page, url(env, params(sd)));
    await page.tap('[data-testid="play"]');
    for (let i = 0; i < 10; i++) {
      await page.waitForSelector('[data-screen="round"]:not(.resolved), [data-screen="readiness"]');
      const info = await roundInfo(page);
      if (!info) break;
      if (info.mode === 'see-letter') {
        const want = { start: 'starts with this sound', end: 'ends with this sound', anywhere: 'has this sound in it' }[info.position];
        assert.equal(info.prompt, `Tap the letter to hear it, then find the picture that ${want}.`);
        got[info.position] = true;
      }
      await answerRound(page);
    }
  }
  assert.ok(got.end && got.anywhere, `see-letter rounds seen: ${Object.keys(got)}`);
  assert.deepEqual(errors, []);
  await context.close();
});

test('Tracker empty state on a brand-new install', async () => {
  const { page, errors, context } = await newPage(env);
  await open(page, url(env, { today: '2026-11-10' }));
  await page.evaluate(() => globalThis.__fsApp.go('tracker'));
  await page.waitForSelector('[data-testid="tracker-empty"]');
  assert.match(await page.textContent('[data-testid="tracker-empty"]'), /Nothing played yet/);
  assert.equal(await page.locator('[data-testid="tracker-summary"]').count(), 0, 'no wall of zeros');
  assert.match(await page.textContent('[data-testid="tracker-recordings"]'), /0 of 30 sounds recorded/);
  assert.equal(await page.locator('[data-testid="tk-missing"] .tk-sound').first().getAttribute('data-sound'), 'm');
  // Reached from the parent menu too.
  await seed(page, { recordings: GROUP1 });
  await open(page, url(env, { today: '2026-11-10' }));
  await holdGate(page);
  await page.tap('[data-testid="open-tracker"]');
  await page.waitForSelector('[data-testid="tracker-empty"]');
  assert.match(await page.textContent('[data-testid="tracker-empty"]'), /Everything is ready/);
  assert.deepEqual(errors, []);
  await context.close();
});

/* ---------- migration: data saved by the previous version ---------- */

// Exactly what the previous version stored: rounds without ids (before sync) or with { id, t } but
// no session or wrong taps, readiness results, and no "sessions" key at all.
const OLD_PROGRESS = {
  s1: {
    m: [{ c: 1, d: '2026-11-01' }, { c: 1, d: '2026-11-01' }, { c: 1, d: '2026-11-01' }, { c: 1, d: '2026-11-02', id: 'k1', t: 1793620800000 }, { c: 1, d: '2026-11-02', id: 'k2', t: 1793620900000 }, { c: 1, d: '2026-11-02', id: 'k3', t: 1793621000000 }],
    s: [{ c: 0, d: '2026-11-08' }, { c: 1, d: '2026-11-09' }],
    a: [{ c: 1, d: '2026-11-09' }],
  },
  s2: { m: [{ c: 0, d: '2026-11-09' }] },
};
const OLD_READINESS = [{ d: '2026-11-07', pair: 'dog+fish', asked: 'fishdog', chose: 'fishdog', correct: true }];

test('migration: an old-format local store loads unchanged, shows in the Tracker, and keeps every round after new play', async () => {
  const { page, errors, context } = await newPage(env);
  const href = url(env, { seed: 4, today: '2026-11-10' });
  await open(page, href);
  await seed(page, { recordings: GROUP1, progress: OLD_PROGRESS, readiness: OLD_READINESS, settings: { speakWords: false, roundsPerSession: 4 } });
  await page.evaluate(() => globalThis.__fsApp.store.setKV('meta', { settingsAt: 5 }));
  await open(page, href);
  assert.equal(await page.getAttribute('[data-screen]', 'data-screen'), 'home');
  const app = await page.evaluate(() => ({ p: globalThis.__fsApp.progress, s: globalThis.__fsApp.sessions, r: globalThis.__fsApp.readiness, set: globalThis.__fsApp.settings }));
  assert.deepEqual(app.s, []);
  assert.deepEqual(app.set, { speakWords: false, roundsPerSession: 4 });
  assert.deepEqual(app.p.s1.m.map((r) => [r.c, r.d]), OLD_PROGRESS.s1.m.map((r) => [r.c, r.d]), 'rounds read exactly');
  assert.deepEqual(app.p.s1.m.slice(3).map((r) => r.id), ['k1', 'k2', 'k3'], 'existing ids kept');
  assert.equal(app.r.length, 1);

  await page.evaluate(() => globalThis.__fsApp.go('progress'));
  assert.equal(await page.textContent('[data-testid="s1-m"]'), 'solid');
  assert.equal(await page.textContent('[data-testid="s1-s"]'), 'learning');
  assert.equal(await page.textContent('[data-testid="s2-m"]'), 'learning');

  await page.evaluate(() => globalThis.__fsApp.go('tracker'));
  assert.equal(await page.locator('[data-testid="tracker-empty"]').count(), 0, 'old play counts');
  assert.match(await page.textContent('[data-testid="stat-days"]'), /2 of the last 7.*4 of the last 30/);
  assert.match(await page.textContent('[data-testid="stat-sessions"]'), /none yet/);
  assert.match(await page.textContent('[data-testid="tracker-sessions"]'), /No sessions recorded yet/);
  assert.match(await page.textContent('[data-testid="tracker-mixups"]'), /No mix-ups recorded yet/);
  assert.match(await page.textContent('[data-testid="stat-solid-1"]'), /1 of \d+ sounds/);
  assert.match(await page.textContent('[data-testid="stat-readiness"]'), /passed on 1 of 3 days/);
  assert.match(await page.textContent('[data-testid="tk-s1-m"]'), /solid 6\/6/);

  // Play a session: the old rounds stay, the new ones carry the session.
  await page.evaluate(() => globalThis.__fsApp.go('home'));
  await page.tap('[data-testid="play"]');
  for (let i = 0; i < 4; i++) { await page.waitForSelector('[data-screen="round"]:not(.resolved)'); await answerRound(page); }
  await page.waitForSelector('[data-screen="done"]');
  const st = await storedState(page);
  const all = [...Object.values(st.progress.s1), ...Object.values(st.progress.s2)].flat();
  assert.deepEqual(st.progress.s1.s.slice(0, 2).map((r) => [r.c, r.d]), [[0, '2026-11-08'], [1, '2026-11-09']], 'old rounds of s are kept');
  assert.equal(st.progress.s1.m.filter((r) => r.d < '2026-11-10').length, 6, 'old rounds of m are kept (history now holds 30)');
  assert.deepEqual(st.progress.s2.m[0], { ...app.p.s2.m[0] }, 'the old See it round is kept with its id');
  assert.equal(all.filter((r) => r.d === '2026-11-10').length, 4);
  const sessions = await page.evaluate(() => globalThis.__fsApp.store.getKV('sessions'));
  assert.equal(sessions.length, 1);
  assert.deepEqual(st.readiness.map((r) => r.d), ['2026-11-07']);
  assert.deepEqual(errors, []);
  await context.close();
});

test('migration: an old-format server doc syncs to a new device, and the first new session reaches the server with the old data intact', async () => {
  // What the previous server version stored: a push blob without sessions or wrong taps.
  const oldDoc = {
    settings: { speakWords: true, roundsPerSession: 4 }, settingsAt: 10,
    progress: { s1: { m: [{ c: 1, d: '2026-11-08', id: 'o1', t: 1 }, { c: 0, d: '2026-11-09', id: 'o2', t: 2 }], s: [{ c: 1, d: '2026-11-09', id: 'o3', t: 3 }] }, s2: {} },
    resetAt: 0, readiness: [{ id: 'rq', at: 4, d: '2026-11-09', pair: 'dog+fish', asked: 'dogfish', chose: 'dogfish', correct: true }],
  };
  await env.api.backend.put('state/push/0000000000001-old.json', Buffer.from(JSON.stringify(oldDoc)), 'application/json');
  const { page, errors, context } = await newPage(env);
  const href = url(env, { seed: 2, today: '2026-11-10', syncRetry: 300, syncDebounce: 150 });
  await open(page, href);
  await seed(page, { recordings: GROUP1 });
  await open(page, href);
  await holdGate(page);
  await page.fill('[data-testid="sync-code"]', FAMILY_CODE);
  await page.tap('[data-testid="sync-enter"]');
  await page.waitForSelector('[data-testid="sync-status"][data-status="synced"]');
  const local = await page.evaluate(() => ({ p: globalThis.__fsApp.progress, s: globalThis.__fsApp.sessions, r: globalThis.__fsApp.readiness }));
  assert.deepEqual(local.p.s1.m, oldDoc.progress.s1.m, 'old server rounds read exactly');
  assert.deepEqual(local.s, []);
  assert.equal(local.r.length, 1);
  await page.tap('[data-testid="open-tracker"]');
  assert.match(await page.textContent('[data-testid="stat-days"]'), /2 of the last 7/);

  await page.tap('.p-back');
  await page.tap('[data-testid="back-to-child"]');
  await page.tap('[data-testid="play"]');
  for (let i = 0; i < 4; i++) { await page.waitForSelector('[data-screen="round"]:not(.resolved)'); await answerRound(page, { wrongFirst: i === 0 ? 1 : 0 }); }
  await page.waitForSelector('[data-screen="done"]');
  const end = Date.now() + 8000;
  let doc;
  for (;;) {
    doc = await env.api.readDoc();
    if (doc && doc.sessions && doc.sessions[0] && doc.sessions[0].rounds === 4) break;
    if (Date.now() > end) throw new Error(`session not synced: ${JSON.stringify(doc && doc.sessions)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.deepEqual(doc.progress.s1.m.filter((r) => r.id === 'o1' || r.id === 'o2'), oldDoc.progress.s1.m);
  assert.deepEqual(doc.progress.s1.s.find((r) => r.id === 'o3'), oldDoc.progress.s1.s[0]);
  assert.deepEqual(doc.readiness, oldDoc.readiness);
  const newRounds = Object.values(doc.progress.s1).flat().filter((r) => r.ses);
  assert.equal(newRounds.length, 4);
  assert.equal(newRounds.filter((r) => r.wrong).length, 1, 'the wrong tap reached the server');
  // Sessions ride along with the progress pushes: once synced, nothing more is written.
  const puts = () => env.api.requests.filter((r) => r === 'PUT /api/state').length;
  await page.waitForTimeout(600);
  const settled = puts();
  assert.ok(settled <= 6, `state pushes: ${settled}`);
  await page.evaluate(() => globalThis.__fsApp.sync.now());
  await page.waitForTimeout(600);
  assert.equal(puts(), settled, 'no further pushes once the server has everything');
  assert.deepEqual(errors, []);
  await context.close();
});
