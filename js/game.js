// Child screens: home, the "Hear it" / "See it" rounds, the readiness bonus round, and "all done".
// Nothing on these screens needs reading; the one line of small text is a prompt for the parent.

import { h, mount, setMode, holdGate, icon } from './ui.js';
import { planRound, recordRound, readinessEligible, planReadiness, canPlay } from './logic.js';
import * as audio from './audio.js';
import { newId, MAX_WRONG_TAPS } from './syncdoc.js';
import { TV } from './tv.js';

const RESOLVE_DELAY = 2200;
const TAP = TV ? 'choose' : 'tap'; // the parent prompt's verb: the TV has a remote, not a touch screen

/** How the parent prompt names each position mode ("…tap the picture that <phrase>."). */
export const POSITION_PHRASE = { start: 'starts with this sound', end: 'ends with this sound', anywhere: 'has this sound in it' };

/** Adds a played round to the session record and saves the record into app.sessions. */
function noteSessionRound(app, s, stage, firstTry, t) {
  const r = s.record;
  r.rounds += 1;
  if (firstTry) r.correct += 1;
  r.end = Math.max(r.start, t);
  if (!r.stages.includes(stage)) r.stages = [...r.stages, stage].sort();
  const copy = { ...r, stages: [...r.stages] };
  app.sessions = [...(app.sessions || []).filter((x) => x.id !== r.id), copy];
}

function topbar(app, s) {
  const gate = holdGate(() => app.go('parentMenu'));
  const dots = s
    ? h('div', { class: 'dots', 'aria-hidden': 'true' },
      Array.from({ length: s.total }, (_, i) => h('span', { class: `dot${i < s.done ? ' on' : ''}` })))
    : h('div', { class: 'dots' });
  return h('div', { class: 'topbar' }, gate, dots, h('span', { class: 'topbar-spacer' }));
}

function prompt(text, ...extra) {
  return h('p', { class: 'prompt' }, text, ...extra);
}

export function home(app) {
  setMode('child');
  const playable = canPlay(app.data, app.recorded(), app.progress);
  if (!playable && TV) { tvWaiting(app); return; }
  const body = playable
    ? h('button', { class: 'big-play', type: 'button', 'aria-label': 'Play', 'data-testid': 'play', 'data-autofocus': TV, onclick: () => startSession(app) }, icon('play'))
    : h('div', { class: 'home-wait', 'aria-hidden': 'true' }, '🎙️');
  mount(h('section', { class: 'screen child home', 'data-screen': 'home' },
    topbar(app, null),
    h('div', { class: 'home-center' }, body),
    prompt(playable
      ? (TV ? 'Press OK together to start.' : 'Tap the big button together to start.')
      : 'Record the group 1 sounds first: hold the corner button for 2 seconds to open the parent area.')));
}

/** TV, before the synced recordings are there: a calm note for the parent instead of the games. */
function tvWaiting(app) {
  const synced = app.sync && app.sync.enabled;
  const bar = topbar(app, null);
  bar.querySelector('.gate').dataset.autofocus = '';
  mount(h('section', { class: 'screen child home tv-wait', 'data-screen': 'home', 'data-waiting': '1' },
    bar,
    h('div', { class: 'home-center' },
      h('div', { class: 'home-wait', 'aria-hidden': 'true' }, '🌱'),
      h('p', { class: 'tv-wait-text', 'data-testid': 'tv-waiting' }, synced
        ? 'The games start once the group 1 sounds are recorded. Record them on the iPad or laptop: they arrive here by themselves.'
        : 'Enter your family code to load your recordings.')),
    prompt('For the parent area, hold OK on the gear for 3 seconds.')));
}

export function startSession(app) {
  // This runs inside the tap, which is what unlocks audio and speech on iPad Safari.
  audio.unlock();
  const total = app.settings.roundsPerSession;
  const s = { total, done: 0, lastId: null, lastWord: null, newCount: { 1: 0, 2: 0 }, readinessDone: false, readinessAt: Math.floor(total / 2) };
  // The session record for the parent's Tracker. Saved from its first played round on, and updated
  // after every round; it rides along with the round's (debounced) progress push.
  const now = Date.now();
  s.record = { id: newId(), d: app.today(), start: now, end: now, stages: [], rounds: 0, correct: 0 };
  app.session = s;
  next(app, s);
}

function alive(app, s) { return app.session === s; }

function next(app, s) {
  if (!alive(app, s)) return;
  if (s.done >= s.total) { done(app, s); return; }
  if (!s.readinessDone && s.done === s.readinessAt) {
    s.readinessDone = true;
    if (readinessEligible({ data: app.data, recorded: app.recorded(), progress: app.progress, results: app.readiness, today: app.today() })) {
      readiness(app, s);
      return;
    }
  }
  const round = planRound({
    data: app.data, recorded: app.recorded(), progress: app.progress, rng: app.rng,
    lastId: s.lastId, lastWord: s.lastWord, newCount: s.newCount,
  });
  if (!round) { app.go('home'); return; }
  if (round.reason === 'new') s.newCount[round.stage] += 1;
  s.lastId = round.target.id;
  const answer = round.choices.find((c) => c.correct);
  s.lastWord = answer.word || null;
  renderRound(app, s, round);
}

function renderRound(app, s, round) {
  setMode('child');
  const rec = app.recordings.get(round.target.id);
  const playTarget = () => audio.playRecording(rec);
  const speak = (w) => audio.speakWord(w, app.settings.speakWords);
  let wrongs = 0;
  const wrongTaps = []; // what was tapped wrongly, for the Tracker's mix-ups
  let resolved = false;

  const choiceEls = round.choices.map((ch) => {
    const inner = ch.kind === 'word'
      ? [h('span', { class: 'emoji', 'aria-hidden': 'true' }, ch.emoji)]
      : [h('span', { class: 'letter' }, ch.grapheme)];
    const el = h('button', {
      class: `choice choice-${ch.kind}`, type: 'button',
      'data-sound': ch.soundId, 'data-word': ch.word || null,
      'aria-label': ch.kind === 'word' ? ch.word : `letter ${ch.grapheme}`,
    }, ...inner);
    if (ch.kind === 'word' && app.settings.speakWords) {
      const sp = h('span', {
        class: 'speaker', role: 'button', 'aria-label': `say ${ch.word}`, 'data-testid': 'say-word',
        tabindex: TV ? '0' : null, 'data-nav-explicit': TV,
        onpointerdown: (e) => e.stopPropagation(),
        onclick: (e) => { e.stopPropagation(); speak(ch.word); },
      }, icon('speaker'));
      el.append(sp);
      if (TV) { el.__nav = { down: sp }; sp.__nav = { up: el }; } // on the remote: Down from a picture to its speaker
    }
    el.addEventListener('click', () => onTap(el, ch));
    return el;
  });
  const correctEl = choiceEls[round.choices.findIndex((c) => c.correct)];

  function onTap(el, ch) {
    if (!alive(app, s)) return;
    if (resolved) { if (ch.kind === 'word') speak(ch.word); return; }
    if (ch.correct) {
      resolved = true;
      const extra = { id: newId(), t: Date.now(), ses: s.record.id };
      if (wrongTaps.length) extra.wrong = wrongTaps;
      app.progress = recordRound(app.progress, round.stage, round.target.id, wrongs === 0, app.today(), extra);
      noteSessionRound(app, s, round.stage, wrongs === 0, extra.t);
      app.save('progress');
      app.save('sessions');
      s.done += 1;
      el.classList.remove('glow');
      el.classList.add('happy');
      screen.classList.add('resolved');
      screen.querySelectorAll('.dot').forEach((d, i) => d.classList.toggle('on', i < s.done));
      audio.tone('happy');
      if (ch.kind === 'word') setTimeout(() => alive(app, s) && speak(ch.word), 500);
      setTimeout(() => next(app, s), RESOLVE_DELAY);
      return;
    }
    wrongs += 1;
    if (wrongTaps.length < MAX_WRONG_TAPS) {
      const tap = ch.kind === 'word' ? { w: ch.word } : { g: ch.grapheme };
      if (ch.soundId) tap.s = ch.soundId;
      wrongTaps.push(tap);
    }
    el.classList.remove('wiggle');
    void el.offsetWidth; // restart the animation
    el.classList.add('wiggle');
    setTimeout(() => alive(app, s) && !resolved && playTarget(), 250);
    if (wrongs >= 2) correctEl.classList.add('glow');
  }

  let lead;
  let text;
  if (round.mode === 'see-letter') {
    lead = h('button', {
      class: 'lead-letter', type: 'button', 'data-testid': 'replay', 'aria-label': 'hear the sound',
      onclick: () => { lead.classList.remove('invite'); playTarget(); },
    }, h('span', { class: 'letter' }, round.target.graphemes[0]));
    lead.classList.add('invite');
    text = `${TV ? 'Press OK on the letter' : 'Tap the letter'} to hear it, then find the picture that ${POSITION_PHRASE[round.position] || POSITION_PHRASE.start}.`;
  } else {
    lead = h('button', {
      class: 'replay', type: 'button', 'data-testid': 'replay', 'aria-label': 'hear the sound again',
      onclick: () => playTarget(),
    }, icon('speaker'));
    text = round.mode === 'hear'
      ? `Listen, then ${TAP} the picture that ${POSITION_PHRASE[round.position] || POSITION_PHRASE.start}.`
      : `Listen, then ${TAP} the letter that makes this sound.`;
  }

  const screen = h('section', {
    class: `screen child round mode-${round.mode}`,
    'data-screen': 'round', 'data-stage': String(round.stage), 'data-mode': round.mode, 'data-target': round.target.id,
    'data-position': round.position,
  },
  topbar(app, s),
  h('div', { class: 'play-area' }, h('div', { class: 'lead' }, lead), h('div', { class: `choices n${choiceEls.length}` }, choiceEls)),
  prompt(text));
  mount(screen);
  if (round.mode !== 'see-letter') setTimeout(() => alive(app, s) && playTarget(), 350);
}

/* ---------- readiness bonus round ---------- */

function readiness(app, s) {
  setMode('child');
  const plan = planReadiness(app.data, app.rng);
  const { a, b } = plan.pair;
  const word = (order) => (order === 'ab' ? a.name + b.name : b.name + a.name);
  const pic = (x) => h('span', { class: 'ready-pic', 'aria-label': x.name }, x.emoji);
  const pairEls = (order) => (order === 'ab' ? [pic(a), pic(b)] : [pic(b), pic(a)]);

  // Phase 1: show a then b; the parent slides the child's finger left to right.
  let advanced = false;
  const track = h('div', { class: 'ready-track', 'data-testid': 'ready-track' }, ...pairEls('ab'));
  const arrow = h('div', { class: 'ready-arrow', 'aria-hidden': 'true' }, icon('arrow'));
  const goPhase2 = () => {
    if (advanced || !alive(app, s)) return;
    advanced = true;
    track.classList.add('swiped');
    audio.tone('soft');
    setTimeout(() => phase2(), 700);
  };
  let startX = null;
  track.addEventListener('pointerdown', (e) => { startX = e.clientX; track.setPointerCapture?.(e.pointerId); });
  track.addEventListener('pointermove', (e) => {
    if (startX == null) return;
    const dx = e.clientX - startX;
    track.style.setProperty('--slide', `${Math.max(0, Math.min(1, dx / track.clientWidth))}`);
    if (dx > track.clientWidth * 0.35) goPhase2();
  });
  const endSlide = () => { startX = null; };
  track.addEventListener('pointerup', endSlide);
  track.addEventListener('pointercancel', endSlide);
  if (TV) {
    // No finger to slide on the TV: the parent points along the pictures, then presses OK.
    track.setAttribute('role', 'button');
    track.setAttribute('tabindex', '0');
    track.setAttribute('aria-label', `${word('ab')}: press OK`);
    track.dataset.autofocus = '';
    track.addEventListener('click', goPhase2);
  }

  mount(h('section', { class: 'screen child readiness', 'data-screen': 'readiness', 'data-phase': '1' },
    topbar(app, s),
    h('div', { class: 'ready-area' }, track, arrow),
    TV
      ? prompt(`Point at each picture from left to right and say: this is ${word('ab')}. Then press OK.`)
      : prompt(`Slide a finger left to right and say: this is ${word('ab')}.`,
        ' ', h('button', { class: 'prompt-link', type: 'button', onclick: goPhase2 }, 'next'))));

  function phase2() {
    if (!alive(app, s)) return;
    let answered = false;
    const rows = plan.rows.map((order) => {
      const row = h('button', {
        class: 'ready-row', type: 'button', 'data-order': order, 'aria-label': word(order), 'data-autofocus': TV && order === plan.rows[0],
        onclick: () => {
          if (answered || !alive(app, s)) return;
          answered = true;
          app.readiness = [...app.readiness, {
            id: newId(), d: app.today(), pair: `${a.name}+${b.name}`, asked: word(plan.ask), chose: word(order), correct: order === plan.ask, at: Date.now(),
          }];
          app.save('readiness');
          row.classList.add('happy'); // whatever the child picks, the response is the same gentle one
          audio.tone('happy');
          setTimeout(() => next(app, s), 1800);
        },
      }, ...pairEls(order));
      return row;
    });
    mount(h('section', { class: 'screen child readiness', 'data-screen': 'readiness', 'data-phase': '2', 'data-ask': plan.ask },
      topbar(app, s),
      h('div', { class: 'ready-rows' }, rows),
      prompt(`Which one is ${word(plan.ask)}?`)));
  }
}

/* ---------- all done ---------- */

function done(app, s) {
  setMode('child');
  audio.tone('done');
  const again = h('button', {
    class: 'big-play again', type: 'button', 'aria-label': 'Play again', 'data-testid': 'play-again',
    onclick: () => startSession(app),
  }, icon('play'));
  const slot = h('div', { class: 'again-slot' });
  const bar = topbar(app, s);
  if (TV) bar.querySelector('.gate').dataset.autofocus = ''; // until "play again" appears
  mount(h('section', { class: 'screen child done', 'data-screen': 'done' },
    bar,
    h('div', { class: 'done-center' },
      h('div', { class: 'done-pic', 'aria-hidden': 'true' }, '🌻'),
      h('p', { class: 'done-text' }, 'all done'),
      slot),
    prompt('All done for today. A cuddle and a chat about the pictures is a lovely way to finish.')));
  // No way to restart for 3 seconds, so the session has a calm ending.
  setTimeout(() => {
    if (!alive(app, s)) return;
    slot.append(again);
    if (TV && !document.activeElement?.closest('.gate.holding')) again.focus({ preventScroll: true });
  }, 3000);
}
