// The reading round ("Read it", stage 3). The word in big lowercase letters, one tile per grapheme,
// over a road with a dot under each tile. Sliding along the road (or the go arrow, or OK on the TV)
// plays the parent's stretched recording while each tile lights up in turn; then "say it fast"; then,
// when the word has a picture and another picture word is available, a two-picture check.
// The rules (timings, slide, distractor, scheduling) are pure functions in js/reading.js.

import { h, mount, setMode, icon } from './ui.js';
import { recordRound } from './logic.js';
import { graphemeTimings, slideDecision, SLIDE_START_ZONE, READ_STAGE } from './reading.js';
import * as audio from './audio.js';
import { newId, MAX_WRONG_TAPS } from './syncdoc.js';
import { TV } from './tv.js';

const RESOLVE_DELAY = 2200;
const log = (entry) => { if (globalThis.__fsLog) globalThis.__fsLog.push({ ...entry, t: Date.now() }); };

export const READ_PROMPT = TV
  ? 'Press OK on the road together and stretch the sounds. Then say it fast!'
  : 'Slide under the word together and stretch the sounds. Then say it fast!';

/**
 * ctx: { alive(), topbar(), noteRound(firstTry, t, practised), next() } from js/game.js.
 * plan: { word: entry with id, choices: [2] | null } from planReading.
 */
export function renderReading(app, s, plan, ctx) {
  setMode('child');
  const entry = plan.word;
  const rec = app.recordings.get(entry.id);
  const check = plan.choices;
  const n = entry.graphemes.length;
  let phase = 'ready'; // ready | blending | blended | fast | check | done
  let wrongs = 0;
  const wrongTaps = [];
  let resolved = false;
  let blendRun = 0; // a new blend cancels the lights of the one before
  const lightTimers = new Set(); // the lights of the current blend (a new blend or the answer clears them)
  const timer = (set) => (fn, ms) => { const id = setTimeout(() => { set.delete(id); if (ctx.alive()) fn(); }, ms); set.add(id); return id; };
  const lightsLater = timer(lightTimers);
  const later = timer(new Set());
  const clearLights = () => { for (const id of lightTimers) clearTimeout(id); lightTimers.clear(); };

  const tiles = entry.graphemes.map((g, i) => h('span', { class: 'gtile', 'data-i': String(i), style: `grid-column:${i + 2};grid-row:1` }, h('span', { class: 'letter' }, g)));
  const dots = entry.graphemes.map((_, i) => h('span', { class: 'road-dot', 'data-i': String(i), style: `grid-column:${i + 2}` }));
  const go = h('span', { class: 'road-go', 'data-testid': 'go', 'aria-hidden': 'true', style: 'grid-column:1' }, icon('play'));
  const fill = h('span', { class: 'road-fill', 'aria-hidden': 'true' });
  const knob = h('span', { class: 'road-knob', 'aria-hidden': 'true' });
  const road = h('button', {
    class: 'road', type: 'button', 'data-testid': 'road', 'aria-label': `${entry.word}: ${TV ? 'press OK' : 'slide along'} to hear it stretched`,
    'data-autofocus': TV, style: `grid-template-columns: subgrid; grid-column: 1 / span ${n + 1}; grid-row: 2`,
  }, h('span', { class: 'road-bar', 'aria-hidden': 'true' }), fill, knob, go, dots);
  // Columns: the go arrow, one per tile, and a spacer as wide as the arrow so the word stays centred.
  const word = h('div', { class: 'read-word', style: `--n:${n}` }, h('span', { class: 'read-spacer', style: 'grid-column:1;grid-row:1' }), tiles,
    h('span', { class: 'read-spacer', style: `grid-column:${n + 2};grid-row:1` }), road);

  const fast = h('button', {
    class: 'say-fast', type: 'button', 'data-testid': 'say-fast', 'aria-label': 'say it fast', hidden: true,
    onclick: () => sayFast(),
  }, h('span', { class: 'say-fast-icon', 'aria-hidden': 'true' }, '🐇'));
  const reveal = h('div', { class: 'read-reveal', 'aria-hidden': 'true', hidden: true }, entry.emoji || '');
  const choicesBox = h('div', { class: 'choices n2 read-choices', hidden: true });
  const next = h('div', { class: 'read-next' }, fast, reveal, choicesBox);
  const promptEl = h('p', { class: 'prompt' }, READ_PROMPT);

  const screen = h('section', {
    class: 'screen child round reading', 'data-screen': 'round', 'data-stage': String(READ_STAGE), 'data-mode': 'read',
    'data-target': entry.id, 'data-word': entry.word, 'data-check': check ? '1' : '0', 'data-phase': phase,
  }, ctx.topbar(), h('div', { class: 'read-area' }, word, next), promptEl);

  const setPhase = (p) => { phase = p; screen.dataset.phase = p; };

  /* ----- the blend: the stretched recording, with the lights in turn ----- */

  function positions() {
    // The fill runs from the go arrow to the centre of each dot, then to the end of the road.
    const r = road.getBoundingClientRect();
    const at = (el) => { const b = el.getBoundingClientRect(); return r.width ? ((b.left + b.width / 2) - r.left) / r.width : 0; };
    return { start: at(go), dots: dots.map(at) };
  }

  function setFill(frac, ms) {
    const pct = `${Math.max(0, Math.min(1, frac)) * 100}%`;
    for (const el of [fill, knob]) el.style.transitionDuration = `${Math.max(0, ms)}ms`;
    fill.style.width = pct;
    knob.style.left = pct;
  }

  function startLights(run, durationMs) {
    if (run !== blendRun) return;
    const times = graphemeTimings(entry, app.data, durationMs);
    log({ type: 'blend', word: entry.word, durationMs: Math.round(durationMs), timings: times });
    const pos = positions();
    tiles.forEach((t) => t.classList.remove('lit', 'now'));
    dots.forEach((d) => d.classList.remove('on'));
    setFill(pos.start, 0);
    times.forEach((tm, i) => {
      lightsLater(() => {
        if (run !== blendRun) return;
        tiles.forEach((t, k) => t.classList.toggle('now', k === i));
        tiles[i].classList.add('lit');
        dots[i].classList.add('on');
        log({ type: 'light', word: entry.word, i });
        setFill(pos.dots[i], 0);
        // Glide on towards the next dot during this sound.
        requestAnimationFrame(() => run === blendRun && setFill(i + 1 < n ? pos.dots[i + 1] : 1, tm.end - tm.start));
      }, tm.start);
    });
    lightsLater(() => {
      if (run !== blendRun) return;
      tiles.forEach((t) => { t.classList.remove('now'); t.classList.add('lit'); });
      word.classList.add('whole');
      blendDone();
    }, Math.max(0, durationMs) + 120);
  }

  function blend() {
    if (!ctx.alive() || phase === 'blending' || resolved) return;
    audio.unlock();
    const run = ++blendRun;
    clearLights();
    const before = phase;
    setPhase('blending');
    if (before === 'check') screen.dataset.rechecking = '1';
    word.classList.remove('whole', 'fast');
    let lit = false;
    const lights = (ms) => { if (!lit) { lit = true; startLights(run, ms); } };
    audio.playRecording(rec, { onStart: lights });
    // If the sound does not start (no audio here), the lights still run on the stored length.
    lightsLater(() => lights(rec && rec.durationMs ? rec.durationMs : 1500), 1500);
    blendDone = () => {
      if (run !== blendRun || resolved) return;
      if (before === 'check' || (before === 'fast' && check)) { setPhase('check'); delete screen.dataset.rechecking; return; }
      if (before === 'fast' || before === 'done') { setPhase(before); return; }
      setPhase('blended');
      fast.hidden = false;
      fast.classList.add('invite');
      if (TV && (!document.activeElement || document.activeElement === road || document.activeElement === document.body)) fast.focus({ preventScroll: true });
    };
  }
  let blendDone = () => {};

  /* ----- say it fast, then the picture check ----- */

  function sayFast() {
    if (!ctx.alive() || resolved || phase === 'blending' || phase === 'ready') return;
    fast.classList.remove('invite');
    word.classList.add('fast');
    const spoken = app.settings.speakWords && audio.canSpeak();
    if (spoken) audio.speakWord(entry.word, true, { rate: 1 });
    log({ type: 'fast', word: entry.word, spoken });
    if (phase === 'check' || phase === 'done') return; // again, just for fun
    setPhase('fast');
    if (check) {
      later(showCheck, spoken ? 900 : 300);
      return;
    }
    // No picture check: the round ends after the fast version (the picture shows when there is
    // no voice to say it).
    if (!spoken && entry.emoji) { reveal.hidden = false; }
    later(finishPractised, spoken ? 1400 : 1800);
  }

  function showCheck() {
    if (resolved) return;
    setPhase('check');
    screen.classList.add('checking');
    fast.hidden = true;
    choicesBox.hidden = false;
    promptEl.textContent = TV ? 'Which picture is the word? Press OK on the one you read.' : 'Which picture is the word? Tap the one you read.';
    if (TV) choiceEls[0].focus({ preventScroll: true });
  }

  const choiceEls = (check || []).map((ch) => {
    const el = h('button', {
      class: 'choice choice-word', type: 'button', 'data-word': ch.word, 'data-correct': ch.correct ? '1' : '0', 'aria-label': ch.word,
    }, h('span', { class: 'emoji', 'aria-hidden': 'true' }, ch.emoji));
    el.addEventListener('click', () => onPick(el, ch));
    return el;
  });
  choicesBox.append(...choiceEls);
  const correctEl = choiceEls.find((el) => el.dataset.correct === '1');

  function onPick(el, ch) {
    if (!ctx.alive() || phase !== 'check' && phase !== 'blending') return;
    if (resolved) return;
    if (ch.correct) {
      resolved = true;
      clearLights();
      const extra = { id: newId(), t: Date.now(), ses: s.record.id };
      if (wrongTaps.length) extra.wrong = wrongTaps;
      app.progress = recordRound(app.progress, READ_STAGE, entry.id, wrongs === 0, app.today(), extra);
      ctx.noteRound(wrongs === 0, extra.t, false);
      el.classList.remove('glow');
      el.classList.add('happy');
      screen.classList.add('resolved');
      setPhase('done');
      audio.tone('happy');
      if (app.settings.speakWords) setTimeout(() => ctx.alive() && audio.speakWord(entry.word, true), 500);
      setTimeout(() => ctx.next(), RESOLVE_DELAY);
      return;
    }
    wrongs += 1;
    if (wrongTaps.length < MAX_WRONG_TAPS) wrongTaps.push({ w: ch.word });
    el.classList.remove('wiggle');
    void el.offsetWidth; // restart the animation
    el.classList.add('wiggle');
    // As in the other stages: the target plays again (here the stretched word, with its lights).
    setTimeout(() => ctx.alive() && !resolved && blend(), 250);
    if (wrongs >= 2) correctEl.classList.add('glow');
  }

  function finishPractised() {
    if (resolved) return;
    resolved = true;
    const extra = { id: newId(), t: Date.now(), ses: s.record.id, p: 1 };
    app.progress = recordRound(app.progress, READ_STAGE, entry.id, false, app.today(), extra);
    ctx.noteRound(false, extra.t, true);
    setPhase('done');
    word.classList.add('happy');
    screen.classList.add('resolved');
    audio.tone('soft');
    setTimeout(() => ctx.next(), 1600);
  }

  /* ----- touch: slide along the road, or tap the go arrow ----- */

  let down = null; // { id, start } fraction of the road where the finger came down
  const frac = (x) => { const r = road.getBoundingClientRect(); return r.width ? (x - r.left) / r.width : 0; };
  word.addEventListener('pointerdown', (e) => {
    down = { id: e.pointerId, start: frac(e.clientX), went: false, moved: 0 };
    word.setPointerCapture?.(e.pointerId);
  });
  word.addEventListener('pointermove', (e) => {
    if (!down || down.id !== e.pointerId || down.went) return;
    const f = frac(e.clientX);
    down.moved = Math.max(down.moved, Math.abs(f - down.start));
    if (slideDecision(down.start, f) === 'go') { down.went = true; blend(); }
  });
  // `down` stays until the click that follows (a touch's click can come a while after the finger
  // lifts); a cancelled touch has no click.
  word.addEventListener('pointercancel', (e) => { if (down && down.id === e.pointerId) down = null; });
  road.addEventListener('click', (e) => {
    // OK on the TV (a click with no pointer: detail 0) starts the blend. A tap starts it only when it
    // came down at the go arrow end; a tap in the middle of the road, or a slide the wrong way, does
    // nothing. A slide to the right has already started it.
    const d = down;
    down = null;
    if (e.detail !== 0 && !(d && !d.went && d.moved <= 0.03 && d.start <= SLIDE_START_ZONE)) return;
    blend();
  });

  mount(screen);
  if (TV) road.focus({ preventScroll: true });
  go.classList.add('invite');
  return { screen };
}
