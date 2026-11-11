// Parent screens: first-run welcome, parent menu, recording studio, progress, settings and backup.

import { h, mount, setMode, notice } from './ui.js';
import {
  canPlay, groupProgress, statusOf, targetEligibleIds, unlockedGroups,
  readinessByDate, readinessPassedDays, soundModes, MIN_WORDS_FOR_MODE,
} from './logic.js';
import * as audio from './audio.js';
import { checkBackup } from './storage.js';
import { STATUS_TEXT } from './sync.js';
import { TV } from './tv.js';
import { wordsToRecord, stretched, unsolidSounds, blendReady, READINESS_DAYS_NEEDED } from './reading.js';
import { ROUNDS_MIN, ROUNDS_MAX } from './syncdoc.js';
import { readingState } from './game.js';

const STATUS_LABEL = { not_started: 'not started', learning: 'learning', solid: 'solid' };

/** Short names of the position modes, for the parent. */
export const MODE_LABEL = { start: 'starts with', end: 'ends with', anywhere: 'anywhere in the word' };

/** One line about a sound's position mode, or why it is not a game target. */
export function modeLine(data, id) {
  const m = soundModes(data).get(id);
  if (!m) return '';
  if (m.mode === 'start') return `Game: find the picture that starts with this sound (${m.start} picture words start with it).`;
  if (m.mode === 'end') return `Game: find the picture that ends with this sound (fewer than ${MIN_WORDS_FOR_MODE} words start with it, ${m.end} end with it).`;
  if (m.mode === 'anywhere') return `Game: find the picture that has this sound in it (${m.anywhere} picture words have it, but fewer than ${MIN_WORDS_FOR_MODE} start or end with it).`;
  return notTargetReason(m);
}

export function notTargetReason(m) {
  return `Not a game target yet: it needs at least ${MIN_WORDS_FOR_MODE} picture words with this sound, and ${m.anywhere === 0 ? 'none have it' : `only ${m.anywhere} ${m.anywhere === 1 ? 'has' : 'have'} it`}.`;
}

/* ---------- sync status (parent screens only) ---------- */

function statusText(app) {
  const st = app.sync ? app.sync.status : 'off';
  if (st === 'synced' && app.sync.lastSynced) {
    const t = new Date(app.sync.lastSynced);
    return `${STATUS_TEXT.synced} at ${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
  }
  return STATUS_TEXT[st] || st;
}

let statusListening = false;
function syncStatusEl(app) {
  if (!app.sync || !app.sync.enabled) return null;
  if (!statusListening) {
    statusListening = true;
    app.sync.onChange(() => {
      for (const el of document.querySelectorAll('[data-testid="sync-status"]')) {
        el.dataset.status = app.sync.status;
        el.textContent = statusText(app);
      }
      for (const el of document.querySelectorAll('[data-sync-card]')) {
        const had = TV && el.contains(document.activeElement) ? document.activeElement.dataset.testid : null;
        const fresh = syncCard(app, el.dataset.syncCard);
        el.replaceWith(fresh);
        if (had) (fresh.querySelector(`[data-testid="${had}"]`) || fresh.querySelector('button, input'))?.focus(); // keep the remote's place
      }
    });
  }
  return h('span', { class: 'p-sync', 'data-testid': 'sync-status', 'data-status': app.sync.status, role: 'status' }, statusText(app));
}

/** "Sync with your family code": enter the code, or see the status and sync now / stop. */
function syncCard(app, where) {
  const sync = app.sync;
  if (!sync) return null;
  const msg = h('p', { class: 'p-sub', 'data-testid': 'sync-msg' });
  let card;
  if (!sync.enabled || sync.status === 'wrong-code') {
    const input = h('input', {
      type: 'text', class: 'p-input', 'data-testid': 'sync-code', autocomplete: 'off', autocapitalize: 'none',
      autocorrect: 'off', spellcheck: 'false', enterkeyhint: 'go', placeholder: 'for example: apple-river-moon-42', 'aria-label': 'Family code',
      'data-autofocus': where === 'tv',
    });
    const btn = h('button', { class: 'p-btn primary', type: 'button', 'data-testid': 'sync-enter' }, 'Sync');
    const go = async () => {
      btn.disabled = true;
      msg.textContent = 'Checking the code…';
      const r = await sync.enter(input.value);
      btn.disabled = false;
      if (r === 'empty') { msg.textContent = 'Type your family code first.'; return; }
      if (r === 'wrong-code') { msg.textContent = 'That code was not accepted. Check it and try again.'; input.select(); return; }
      if (where === 'tv') { app.go('home'); return; } // the games, or a calm note until recordings arrive
      if (where === 'welcome' && app.recordings.size > 0) { app.go('parentMenu'); return; }
      app.go(where === 'welcome' ? 'welcome' : 'parentMenu');
    };
    btn.addEventListener('click', go);
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      if (TV && !input.value.trim()) return; // OK on the empty field opens the TV's keyboard
      go();
    });
    card = h('div', { class: 'p-card', 'data-sync-card': where, 'data-testid': 'sync-card' },
      h('h2', {}, 'Sync with your family code'),
      sync.status === 'wrong-code' ? notice('warn', 'The family code saved on this device was not accepted. Enter it again.') : null,
      h('p', {}, TV
        ? 'Loads the recordings you made on the iPad or laptop, and keeps progress and settings in step with them. Enter the code once on this TV: select the box and press OK to type, then choose Sync.'
        : 'Saves recordings, progress and settings on your family\'s server, so they follow you to your other devices. Enter the code once on each device.'),
      h('div', { class: 'p-actions' }, input, btn),
      msg);
  } else {
    card = h('div', { class: 'p-card', 'data-sync-card': where, 'data-testid': 'sync-card' },
      h('h2', {}, 'Sync'),
      h('p', {}, 'This device syncs recordings, progress and settings with your family code. The status is shown at the top of each parent page.'),
      h('div', { class: 'p-actions' },
        h('button', { class: 'p-btn', type: 'button', 'data-testid': 'sync-now', onclick: () => sync.now() }, 'Sync now'),
        h('button', {
          class: 'p-btn', type: 'button', 'data-testid': 'sync-forget',
          onclick: async () => { await sync.forget(); app.go(where === 'welcome' ? 'welcome' : where === 'tv' ? 'tvSetup' : 'parentMenu'); },
        }, 'Stop syncing on this device')),
      h('p', { class: 'p-muted' }, 'Stopping keeps everything on this device and on the server.'));
  }
  return card;
}

export function page(screenName, title, { back } = {}, ...kids) {
  setMode('parent');
  const header = h('header', { class: 'p-header' },
    back ? h('button', { class: 'p-back', type: 'button', onclick: back.go }, `‹ ${back.label}`) : null,
    h('h1', {}, title),
    syncStatusEl(globalThis.__fsApp || {}));
  const el = h('section', { class: 'screen parent', 'data-screen': screenName }, h('div', { class: 'p-inner' }, header, ...kids));
  mount(el);
  return el;
}

export function storageNotices(app) {
  return [
    app.store && !app.store.persistent
      ? notice('warn', `Storage is not available (${app.store.problem}). The app works, but recordings and progress will be lost when this page closes. Private browsing can cause this.`)
      : null,
    app.saveError ? notice('warn', `Saving failed: ${app.saveError}`) : null,
  ];
}

function dataWarnings(app) {
  const w = (app.report && app.report.warnings) || [];
  const rd = app.reading && app.reading.report;
  return [
    w.length ? h('details', { class: 'p-details' }, h('summary', {}, `Sound data: ${w.length} warning${w.length > 1 ? 's' : ''}`),
      h('ul', {}, w.map((x) => h('li', {}, x)))) : null,
    rd && rd.ok && rd.warnings.length ? h('details', { class: 'p-details', 'data-testid': 'reading-warnings' }, h('summary', {}, `Reading words: ${rd.warnings.length} warning${rd.warnings.length > 1 ? 's' : ''}`),
      h('ul', {}, rd.warnings.slice(0, 60).map((x) => h('li', {}, x))), rd.warnings.length > 60 ? h('p', {}, `…and ${rd.warnings.length - 60} more.`) : null) : null,
  ];
}

/** A parent-facing note when the reading words could not be used (stage 3 is then not offered). */
export function readingNote(app) {
  const rd = app.reading && app.reading.report;
  if (!rd || rd.ok) return null;
  return notice('warn', h('span', { 'data-testid': 'reading-unavailable' },
    rd.missing ? 'Reading (stage 3) is not available: the word list data/reading.json could not be loaded. Everything else works as before.'
      : 'Reading (stage 3) is not available: the word list data/reading.json has problems. Everything else works as before.'),
    rd.missing ? null : h('ul', { class: 'p-errors' }, rd.errors.slice(0, 10).map((e) => h('li', {}, e))));
}

/** The menu's note about blending: ready (by the check or the parent) and whether reading is on. */
function blendNotice(app) {
  const st = readingState(app);
  if (!st.ready) return null;
  if (st.unlocked) return notice('good', h('span', { 'data-testid': 'reading-on' }, `Reading is on: every third round is a reading round (${st.available.length} word${st.available.length === 1 ? '' : 's'} ready).`));
  const how = st.byCheck ? `Your child picked the right order in the readiness check on ${st.days} different days.` : 'You turned on "ready to blend" in Settings.';
  return notice('good', how, ' ', st.hasData
    ? (TV ? 'Reading starts once a word is ready: its sounds solid in See it and recorded on the iPad or laptop (studio, Words tab).' : 'Reading starts once a word is ready: its sounds solid in See it and recorded by you (Recording studio, Words tab).')
    : 'Reading needs the word list, which is not available (see below).');
}

/* ---------- data error ---------- */

export function dataError(app, errors) {
  page('data-error', 'The sound list could not be loaded', {},
    h('p', {}, `The app reads its sounds and pictures from ${app.dataUrl}. It has these problems:`),
    h('ul', { class: 'p-errors' }, errors.slice(0, 30).map((e) => h('li', {}, e))),
    errors.length > 30 ? h('p', {}, `…and ${errors.length - 30} more.`) : null,
    h('button', { class: 'p-btn', type: 'button', onclick: () => location.reload() }, 'Try again'));
}

/* ---------- first run ---------- */

export function welcome(app) {
  const first = groupProgress(app.data, app.recorded())[0];
  page('welcome', 'Welcome to First Sounds', {},
    ...storageNotices(app),
    h('p', { class: 'p-lead' }, 'This app helps your child hear the sounds of English before reading. It uses your voice: you record each sound once, and the games play your recordings.'),
    h('ul', { class: 'p-points' },
      h('li', {}, h('strong', {}, 'Sounds, not letter names. '), 'Say "mmm", never "em".'),
      h('li', {}, h('strong', {}, 'Pure sounds. '), 'A hummed "mmm" and a clipped "b", never "muh" or "buh". Each sound card has a tip.'),
      h('li', {}, h('strong', {}, 'Short and kind. '), '3 to 5 minutes together. A wrong tap is never punished.')),
    h('p', {}, `To start playing you only need group 1: ${first.total} sounds, about two minutes of recording. Later groups open for your child as you record them and as earlier sounds become solid.`),
    h('div', { class: 'p-actions' },
      h('button', { class: 'p-btn primary', type: 'button', 'data-testid': 'start-recording', onclick: () => app.go('studio', { group: first.group }) }, 'Record group 1')),
    syncCard(app, 'welcome'),
    h('div', { class: 'p-card' },
      h('h2', {}, 'Moving from another device?'),
      importControl(app)));
}

/* ---------- first run on the TV ---------- */

/** The TV has no microphone: its first screen asks for the family code, to load the recordings. */
export function tvSetup(app) {
  page('tv-setup', 'First Sounds on the TV', {},
    ...storageNotices(app),
    h('p', { class: 'p-lead' }, 'Enter your family code to load your recordings.'),
    h('p', {}, 'You record the sounds on the iPad or laptop. The code is in the parent area there, under Sync. Once it is entered here, the recordings and progress come to this TV by themselves.'),
    syncCard(app, 'tv'),
    app.sync && app.sync.enabled
      ? h('div', { class: 'p-actions' }, h('button', { class: 'p-btn primary', type: 'button', 'data-testid': 'back-to-child', onclick: () => app.go('home') }, 'Go to the child screen'))
      : null);
}

/* ---------- parent menu ---------- */

function tvMenu(app) {
  const groups = groupProgress(app.data, app.recorded());
  const playable = canPlay(app.data, app.recorded(), app.progress);
  const tile = (label, sub, onclick, testid) => h('button', { class: 'p-tile', type: 'button', onclick, 'data-testid': testid }, h('strong', {}, label), h('span', {}, sub));
  const recordedTotal = groups.reduce((n, g) => n + g.recorded, 0);
  page('parent-menu', 'Parent area', {},
    ...storageNotices(app),
    blendNotice(app),
    readingNote(app),
    !playable ? notice('info', 'Record all of group 1 on the iPad or laptop to start playing here.') : null,
    h('div', { class: 'p-tiles' },
      tile('Learning path', 'Where your child is on the whole journey', () => app.go('path'), 'open-path'),
      tile('Tracker', 'Practice days, sessions, accuracy, mix-ups', () => app.go('tracker'), 'open-tracker'),
      tile('Progress', 'Per sound, per stage, and readiness', () => app.go('progress'), 'open-progress'),
      tile('Settings', 'Word speech, session length, ready to blend', () => app.go('settings'), 'open-settings')),
    h('div', { class: 'p-actions' },
      h('button', { class: 'p-btn primary', type: 'button', 'data-testid': 'back-to-child', 'data-autofocus': '', onclick: () => app.go('home') }, 'Back to the child screen')),
    syncCard(app, 'menu'),
    h('div', { class: 'p-card', 'data-testid': 'tv-record-note' },
      h('h2', {}, 'Recording'),
      h('p', {}, `${recordedTotal} of ${app.data.sounds.length} sounds recorded. Recording is done on the iPad or laptop (parent area, Recording studio): this TV has no microphone. New recordings arrive here through sync.`)),
    dataWarnings(app));
}

export function menu(app) {
  if (TV) { tvMenu(app); return; }
  const groups = groupProgress(app.data, app.recorded());
  const playable = canPlay(app.data, app.recorded(), app.progress);
  const tile = (label, sub, onclick, testid) => h('button', { class: 'p-tile', type: 'button', onclick, 'data-testid': testid }, h('strong', {}, label), h('span', {}, sub));
  const recordedTotal = groups.reduce((n, g) => n + g.recorded, 0);
  page('parent-menu', 'Parent area', {},
    ...storageNotices(app),
    blendNotice(app),
    readingNote(app),
    !playable ? notice('info', 'Record all of group 1 to start playing.') : null,
    h('div', { class: 'p-tiles' },
      tile('Recording studio', `${recordedTotal} of ${app.data.sounds.length} sounds recorded${wordsRecordedText(app)}`, () => app.go('studio'), 'open-studio'),
      tile('Learning path', 'Where your child is on the whole journey', () => app.go('path'), 'open-path'),
      tile('Tracker', 'Practice days, sessions, accuracy, mix-ups', () => app.go('tracker'), 'open-tracker'),
      tile('Progress', 'Per sound, per stage, and readiness', () => app.go('progress'), 'open-progress'),
      tile('Settings and backup', 'Word speech, session length, ready to blend, export and import', () => app.go('settings'), 'open-settings')),
    h('div', { class: 'p-actions' },
      h('button', { class: 'p-btn primary', type: 'button', 'data-testid': 'back-to-child', onclick: () => app.go('home') }, 'Back to the child screen')),
    syncCard(app, 'menu'),
    dataWarnings(app));
}

/* ---------- recording studio ---------- */

function wordsRecordedText(app) {
  const words = (app.reading && app.reading.data && app.reading.data.words) || [];
  if (!words.length) return '';
  const n = words.filter((w) => app.recordings.has(`w:${w.word}`)).length;
  return n ? `, ${n} word${n === 1 ? '' : 's'}` : '';
}

const MIC_HELP = {
  denied: 'Microphone access is blocked, so nothing can be recorded. On iPad open Settings, then Apps, then Safari, then Microphone, and choose Ask or Allow. Then come back and tap Record again. (In Safari you can also tap the aA button in the address bar, then Website Settings, then Microphone.)',
  nomic: 'No microphone was found on this device.',
  busy: 'The microphone is being used by another app. Close it and try again.',
  unsupported: 'This browser cannot record audio here. Recording needs Safari on iPadOS 14.5 or later, or a recent Chrome or Edge.',
  insecure: 'Recording only works when the app is opened from a secure (https://) address or from localhost.',
  error: 'Something went wrong with the microphone. Please try again.',
};

const MODE_TAG = { start: 'start', end: 'end', anywhere: 'anywhere', none: 'not a target' };

export function studio(app, opts = {}) {
  const groups = groupProgress(app.data, app.recorded());
  let group = opts.group ?? (groups.find((g) => g.recorded < g.total) || groups[0]).group; // a group number, or 'words'
  let selected = opts.sound || null; // a sound id, or a word id ("w:mat") on the Words tab
  let showAllWords = false;
  let state = 'idle'; // idle | starting | recording | saving
  let message = null;
  let micError = audio.recordingSupport() === 'ok' ? null : audio.recordingSupport();
  let active = null;
  let autoStop = null;
  const eligible = targetEligibleIds(app.data);
  const words = new Map(app.data.words.map((w) => [w.word, w]));
  const reading = app.reading && app.reading.data;
  const wordById = new Map(((reading && reading.words) || []).map((w) => [`w:${w.word}`, w]));
  const soundG = (id) => (app.data.sounds.find((x) => x.id === id) || { graphemes: [id] }).graphemes[0];

  function recordButtons(rec, idleLabel = 'Record') {
    const busy = state !== 'idle';
    const recordLabel = state === 'recording' ? 'Stop' : state === 'starting' ? 'Starting…' : state === 'saving' ? 'Saving…' : rec ? 'Re-record' : idleLabel;
    return [
      micError ? notice('error', h('strong', {}, 'Microphone problem. '), MIC_HELP[micError] || MIC_HELP.error) : null,
      h('div', { class: 'st-buttons' },
        h('button', {
          class: `p-btn rec${state === 'recording' ? ' recording' : ''}`, type: 'button', 'data-testid': 'record',
          disabled: state === 'starting' || state === 'saving' || micError === 'unsupported' || micError === 'insecure',
          onclick: () => (state === 'recording' ? stop() : start()),
        }, h('span', { class: 'rec-dot', 'aria-hidden': 'true' }), recordLabel),
        h('button', {
          class: 'p-btn', type: 'button', 'data-testid': 'playback', disabled: !rec || busy,
          onclick: () => { audio.unlock(); audio.playRecording(rec); },
        }, '▶ Play')),
    ];
  }

  function savedLine(rec) {
    return rec ? h('p', { class: 'st-meta' }, rec.trimmed ? `Saved, ${(rec.durationMs / 1000).toFixed(1)} s after trimming silence.` : 'Saved (silence could not be trimmed on this device).') : null;
  }

  function tabsEl(gp) {
    const busy = state !== 'idle';
    const wordTab = reading ? (() => {
      const all = [...wordById.keys()];
      const done = all.filter((id) => app.recordings.has(id)).length;
      return h('button', {
        class: `p-tab p-tab-words${group === 'words' ? ' on' : ''}`, type: 'button', role: 'tab', 'data-testid': 'words-tab',
        'aria-selected': group === 'words' ? 'true' : 'false', 'data-group': 'words', disabled: busy,
        onclick: () => { group = 'words'; selected = null; message = null; render(); },
      }, h('span', {}, 'Words'), h('small', {}, `${done}/${all.length}`));
    })() : null;
    return h('div', { class: 'p-tabs', role: 'tablist' }, gp.map((g) => h('button', {
      class: `p-tab${g.group === group ? ' on' : ''}${g.recorded === g.total ? ' complete' : ''}`, type: 'button', role: 'tab',
      'aria-selected': g.group === group ? 'true' : 'false', 'data-group': String(g.group), disabled: busy,
      onclick: () => { group = g.group; selected = null; message = null; render(); },
    }, h('span', {}, `Group ${g.group}`), h('small', {}, `${g.recorded}/${g.total}`))), wordTab);
  }

  function back() { return { label: 'Parent area', go: () => { cleanup(); app.go('parentMenu'); } }; }

  function render() {
    if (group === 'words' && reading) { renderWords(); return; }
    if (group === 'words') group = groups[0].group;
    const gp = groupProgress(app.data, app.recorded());
    const open = unlockedGroups(app.data, app.recorded(), app.progress);
    const cur = gp.find((g) => g.group === group);
    if (!selected || !cur.sounds.some((s) => s.id === selected)) {
      selected = (cur.sounds.find((s) => !app.recordings.has(s.id)) || cur.sounds[0]).id;
    }
    const sound = app.data.sounds.find((s) => s.id === selected);
    const rec = app.recordings.get(sound.id);
    const ex = words.get(sound.exampleWord);
    const busy = state !== 'idle';

    const groupNote = cur.group === gp[0].group
      ? (cur.recorded === cur.total ? 'Group 1 is recorded: your child can play.' : 'Record every sound in this group to start playing.')
      : open.has(cur.group)
        ? 'This group is open for your child as each sound is recorded.'
        : 'Your child will reach this group once the earlier groups are solid. You can record it now.';

    const tiles = h('div', { class: 'st-tiles' }, cur.sounds.map((s) => h('button', {
      class: `st-tile${s.id === selected ? ' on' : ''}${app.recordings.has(s.id) ? ' done' : ''}`, type: 'button',
      'data-sound': s.id, disabled: busy, 'aria-label': `${s.graphemes[0]} (${s.say})${app.recordings.has(s.id) ? ', recorded' : ''}`,
      onclick: () => { selected = s.id; message = null; render(); },
    }, h('span', { class: 'st-g' }, s.graphemes[0]), h('span', { class: 'st-say' }, s.say),
    h('span', { class: `st-mode-tag mode-${soundModes(app.data).get(s.id).mode || 'none'}` }, MODE_TAG[soundModes(app.data).get(s.id).mode || 'none']),
    app.recordings.has(s.id) ? h('span', { class: 'st-check', 'aria-hidden': 'true' }, '✓') : null)));

    const detail = h('div', { class: 'st-detail', 'data-testid': 'detail', 'data-sound': sound.id },
      h('div', { class: 'st-big' }, sound.graphemes.join(' ')),
      h('p', { class: 'st-sayline' }, 'Say: ', h('strong', {}, sound.say)),
      h('p', { class: 'st-tip' }, sound.tip),
      h('p', { class: 'st-example' }, ex ? h('span', { class: 'st-ex-emoji' }, ex.emoji) : null, ' as in ', h('strong', {}, sound.exampleWord)),
      h('p', { class: eligible.has(sound.id) ? 'st-mode' : 'st-note', 'data-testid': 'studio-mode', 'data-mode': soundModes(app.data).get(sound.id).mode || 'none' },
        modeLine(app.data, sound.id)),
      ...recordButtons(rec),
      state === 'recording' ? h('p', { class: 'st-hint' }, 'Recording… say the sound once, then tap Stop.') : null,
      message ? h('p', { class: `st-msg ${message.kind}`, 'data-testid': 'studio-msg' }, message.text) : null,
      savedLine(rec));

    const after = canPlay(app.data, app.recorded(), app.progress)
      ? h('div', { class: 'p-actions' }, h('button', { class: 'p-btn primary', type: 'button', 'data-testid': 'go-play', disabled: busy, onclick: () => app.go('home') }, 'Go to the child screen'))
      : null;

    page('studio', 'Recording studio', { back: back() },
      ...storageNotices(app),
      tabsEl(gp),
      h('p', { class: 'p-sub', 'data-testid': 'group-note' }, groupNote),
      h('div', { class: 'st-grid' }, tiles, detail),
      after);
  }

  /** The Words tab: the next words to record (their sounds all solid in See it), or every word. */
  function renderWords() {
    const gp = groupProgress(app.data, app.recorded());
    const list = wordsToRecord(reading, app.progress, app.recorded(), 5);
    const shown = showAllWords ? list.all : list.next;
    if (!selected || !wordById.has(selected) || (!showAllWords && !shown.some((w) => w.id === selected) && !app.recordings.has(selected))) {
      selected = shown.length ? shown[0].id : null;
    }
    const busy = state !== 'idle';
    const ready = new Set(list.ready.map((w) => w.id));
    const row = (w) => {
      const need = unsolidSounds(w, app.progress);
      return h('button', {
        class: `st-word${w.id === selected ? ' on' : ''}${app.recordings.has(w.id) ? ' done' : ''}${ready.has(w.id) ? '' : ' waiting'}`, type: 'button',
        'data-word': w.word, disabled: busy, 'aria-label': `${w.word}${app.recordings.has(w.id) ? ', recorded' : ''}`,
        onclick: () => { selected = w.id; message = null; render(); },
      }, h('span', { class: 'st-word-text' }, w.word),
      h('span', { class: 'st-word-meta' }, ready.has(w.id) ? `level ${w.level}${w.emoji ? ` ${w.emoji}` : ''}` : `needs ${need.map(soundG).join(', ')} in See it`),
      app.recordings.has(w.id) ? h('span', { class: 'st-check', 'aria-hidden': 'true' }, '✓') : null);
    };
    const levelsEl = showAllWords
      ? [1, 2, 3, 4].map((lv) => {
        const ws = list.all.filter((w) => w.level === lv);
        return ws.length ? h('div', { class: 'st-level' }, h('h3', {}, `Level ${lv}`), h('div', { class: 'st-words' }, ws.map(row))) : null;
      })
      : [h('div', { class: 'st-words', 'data-testid': 'next-words' }, shown.map(row))];
    const summary = list.ready.length
      ? `${list.ready.length} word${list.ready.length === 1 ? ' is' : 's are'} ready to record (all their sounds are solid in See it); ${list.todo.length} still to record.`
      : 'No words are ready yet: a word comes here once all its sounds are solid in See it. You can still record words ahead of time from the full list.';
    const toggle = h('button', {
      class: 'p-btn', type: 'button', 'data-testid': 'show-all-words', disabled: busy,
      onclick: () => { showAllWords = !showAllWords; message = null; render(); },
    }, showAllWords ? 'Show only the next words' : `Show all ${list.all.length} words`);

    let detail;
    if (!selected) {
      detail = h('div', { class: 'st-detail', 'data-testid': 'detail' },
        h('p', {}, list.ready.length ? 'Every ready word is recorded. New words arrive here as more sounds become solid in See it.' : 'Nothing to record here yet.'));
    } else {
      const w = wordById.get(selected);
      const entry = { ...w, id: selected };
      const rec = app.recordings.get(selected);
      detail = h('div', { class: 'st-detail', 'data-testid': 'detail', 'data-word': w.word },
        h('div', { class: 'st-big st-big-word' }, w.word),
        h('p', { class: 'st-sayline', 'data-testid': 'word-instruction' }, 'Say it stretched, with no pauses: ', h('strong', { 'data-testid': 'stretched' }, stretched(entry, app.data)), '.'),
        h('p', { class: 'st-tip' }, 'Hold the sounds you can hold; keep the quick ones (t, p, b...) short and joined on. Every letter keeps its own sound.'),
        !ready.has(selected) ? h('p', { class: 'st-note' }, `Your child will meet this word once ${listOf(unsolidSounds(w, app.progress).map(soundG))} ${unsolidSounds(w, app.progress).length === 1 ? 'is' : 'are'} solid in See it.`) : null,
        ...recordButtons(rec),
        state === 'recording' ? h('p', { class: 'st-hint' }, 'Recording… say the word stretched once, then tap Stop.') : null,
        message ? h('p', { class: `st-msg ${message.kind}`, 'data-testid': 'studio-msg' }, message.text) : null,
        savedLine(rec));
    }
    page('studio', 'Recording studio', { back: back() },
      ...storageNotices(app),
      tabsEl(gp),
      h('p', { class: 'p-sub', 'data-testid': 'group-note' }, summary),
      h('div', { class: 'st-grid st-grid-words' },
        h('div', {}, ...levelsEl, h('div', { class: 'p-actions' }, toggle)),
        detail));
  }

  function cleanup() {
    clearTimeout(autoStop);
    if (active) { active.stop().catch(() => {}); active = null; }
  }

  async function start() {
    audio.unlock();
    audio.stop();
    state = 'starting';
    message = null;
    render();
    try {
      active = await audio.startRecording();
      micError = null;
      state = 'recording';
      render();
      // A stretched word takes longer than a sound.
      autoStop = setTimeout(() => { if (state === 'recording') stop(); }, String(selected).startsWith('w:') ? 7000 : 4000);
    } catch (e) {
      active = null;
      state = 'idle';
      micError = e.kind || 'error';
      render();
      return;
    }
  }

  async function stop() {
    clearTimeout(autoStop);
    if (!active) return;
    state = 'saving';
    render();
    const id = selected;
    const isWord = String(id).startsWith('w:');
    try {
      const raw = await active.stop();
      active = null;
      const processed = await audio.processRecording(raw);
      const rec = { id, data: processed.data, mime: processed.mime, durationMs: processed.durationMs, trimmed: processed.trimmed, updatedAt: Date.now() };
      try {
        await app.store.putRecording(rec);
      } catch (e) {
        app.saveError = e.message || String(e);
      }
      const wasNew = !app.recordings.has(id);
      app.recordings.set(id, rec);
      audio.forget(id);
      app.sync?.changed('recording'); // uploaded straight away (in the background)
      state = 'idle';
      const g = isWord ? id.slice(2) : app.data.sounds.find((s) => s.id === id).graphemes[0];
      if (processed.silent) {
        message = { kind: 'warn', text: `"${g}" was very quiet. Listen, and re-record closer to the microphone if needed.` };
      } else {
        message = { kind: 'good', text: `Saved "${g}" and playing it back.${wasNew ? (isWord ? ' To re-record it later, use "Show all words".' : ' Tap its tile to re-record.') : ''}` };
        // After a first recording, move on to the next unrecorded sound in this group (or word).
        if (wasNew && !isWord) {
          const nextUp = groupProgress(app.data, app.recorded()).find((x) => x.group === group).sounds.find((s) => !app.recordings.has(s.id));
          if (nextUp) selected = nextUp.id;
        } else if (wasNew && isWord) {
          const list = wordsToRecord(reading, app.progress, app.recorded(), 5);
          const pool = showAllWords ? list.all.filter((w) => !app.recordings.has(w.id)) : list.next;
          if (pool.length) selected = pool[0].id;
        }
      }
      render();
      audio.playRecording(rec);
    } catch (e) {
      active = null;
      state = 'idle';
      message = { kind: 'warn', text: `Recording failed: ${e.message || e}. Please try again.` };
      render();
    }
  }

  render();
}

const listOf = (a) => (a.length <= 1 ? a.join('') : `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}`);

/* ---------- progress ---------- */

export function progressView(app) {
  const eligible = targetEligibleIds(app.data);
  const modes = soundModes(app.data);
  const chip = (st, testid) => h('span', { class: `chip ${st}`, 'data-testid': testid }, STATUS_LABEL[st]);
  const groups = groupProgress(app.data, app.recorded());
  const table = h('table', { class: 'p-table' },
    h('thead', {}, h('tr', {}, h('th', {}, 'Sound'), h('th', {}, 'Recorded'), h('th', {}, 'Mode'), h('th', {}, 'Hear it'), h('th', {}, 'See it'))),
    groups.map((g) => h('tbody', {},
      h('tr', { class: 'p-group-row' }, h('th', { colspan: '5' }, `Group ${g.group}`)),
      g.sounds.map((s) => h('tr', { 'data-sound': s.id },
        h('td', {}, h('span', { class: 'p-g' }, s.graphemes[0]), ' ', h('small', {}, s.say)),
        h('td', {}, app.recordings.has(s.id) ? 'yes' : 'no'),
        eligible.has(s.id)
          ? [h('td', { 'data-testid': `mode-${s.id}` }, MODE_LABEL[modes.get(s.id).mode]),
            h('td', {}, chip(statusOf(app.progress, 1, s.id), `s1-${s.id}`)), h('td', {}, chip(statusOf(app.progress, 2, s.id), `s2-${s.id}`))]
          : h('td', { colspan: '3', class: 'p-muted', 'data-testid': `mode-${s.id}` }, notTargetReason(modes.get(s.id))))))));

  const byDate = readinessByDate(app.readiness);
  const passed = readinessPassedDays(app.readiness);
  page('progress', 'Progress', { back: { label: 'Parent area', go: () => app.go('parentMenu') } },
    h('p', { class: 'p-sub' }, 'A sound is solid when at least 5 of its last 6 rounds were right first time, across at least 2 different days. "See it" opens for a sound once it is solid in "Hear it".'),
    h('p', { class: 'p-sub' }, `Mode is where the sound is in the picture word your child looks for: at the start when at least ${MIN_WORDS_FOR_MODE} picture words start with it, otherwise at the end, otherwise anywhere in the word. It is worked out from the word list.`),
    passed >= READINESS_DAYS_NEEDED ? notice('good', `Passed the readiness check on ${passed} different days: your child is ready to blend, so reading is open (see the Learning path).`) : null,
    h('h2', {}, 'Sounds'),
    table,
    h('h2', {}, 'Readiness check'),
    byDate.length
      ? h('table', { class: 'p-table', 'data-testid': 'readiness-table' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Date'), h('th', {}, 'Asked'), h('th', {}, 'Child chose'), h('th', {}, 'Result'))),
        h('tbody', {}, byDate.flatMap((d) => d.list.map((r) => h('tr', {},
          h('td', {}, r.d), h('td', {}, r.asked), h('td', {}, r.chose), h('td', {}, r.correct ? 'right order' : 'other order'))))))
      : h('p', { class: 'p-muted' }, 'Not tried yet. It appears as an occasional bonus round (at most once a day) once group 1 is solid in "See it".'),
    h('p', { class: 'p-muted' }, `Days with a right answer: ${passed} of the ${READINESS_DAYS_NEEDED} needed.`));
}

/* ---------- settings and backup ---------- */

/**
 * The parent's override: "your child is ready to blend". Turning it on asks for a confirmation that
 * explains the readiness check; turning it off is immediate. It syncs (last change wins).
 */
function blendCard(app) {
  const box = h('div', {});
  const br = blendReady(app.readiness, app.blendOverride);
  const set = async (on) => {
    app.blendOverride = { on, at: Date.now() };
    await app.save('blend');
    app.go('settings');
  };
  const input = h('input', {
    type: 'checkbox', checked: br.byOverride, 'data-testid': 'blend-override',
    onchange: (e) => {
      if (!e.target.checked) { set(false); return; }
      e.target.checked = false; // only once confirmed
      box.replaceChildren(
        notice('info',
          h('p', {}, `Reading (blending sounds into words) normally starts once your child has passed the readiness check on ${READINESS_DAYS_NEEDED} separate days. The check is a bonus round, at most once a day: your child sees two pictures, hears them said together as one word, and picks the order that matches (${br.days} of ${READINESS_DAYS_NEEDED} days so far).`),
          h('p', {}, 'Turn this on if you are sure your child can already hear how sounds join up, for example if they can tell you that "mmmaaat" is mat. Words still only appear once their sounds are solid in See it and you have recorded them. You can turn it off again at any time.')),
        h('div', { class: 'p-actions' },
          h('button', { class: 'p-btn primary', type: 'button', 'data-testid': 'confirm-blend', onclick: () => set(true) }, 'Yes, my child is ready to blend'),
          h('button', { class: 'p-btn', type: 'button', 'data-testid': 'cancel-blend', onclick: () => box.replaceChildren() }, 'Cancel')));
      box.querySelector('[data-testid="confirm-blend"]')?.focus();
    },
  });
  return h('div', { class: 'p-card', 'data-testid': 'blend-card' },
    h('h2', {}, 'Reading'),
    br.byCheck
      ? notice('good', `Your child passed the readiness check on ${br.days} different days, so reading is open.`)
      : null,
    h('label', { class: 'p-row' }, input, h('span', {}, 'Your child is ready to blend', h('br'), h('small', { class: 'p-muted' }, 'Opens reading (stage 3) without waiting for the readiness check.'))),
    box,
    readingNote(app));
}

function importControl(app) {
  const status = h('p', { class: 'p-sub', 'data-testid': 'import-status' });
  const confirmBox = h('div', {});
  const input = h('input', {
    type: 'file', accept: '.json,application/json', 'data-testid': 'import-file', class: 'p-file',
    onchange: async () => {
      const file = input.files && input.files[0];
      if (!file) return;
      let obj;
      try { obj = JSON.parse(await file.text()); } catch { status.textContent = 'That file could not be read as a backup.'; return; }
      const bad = checkBackup(obj);
      if (bad) { status.textContent = bad; input.value = ''; return; }
      const doImport = async () => {
        try {
          await app.store.importBackup(obj);
          await app.loadState();
          app.sync?.changed('import');
          app.go('parentMenu');
        } catch (e) {
          status.textContent = e.message;
        }
      };
      const hasData = app.recordings.size > 0 || Object.keys(app.progress.s1).length > 0;
      if (!hasData) { await doImport(); return; }
      confirmBox.replaceChildren(
        notice('warn', `This replaces everything on this device with the backup from ${String(obj.exportedAt || 'an unknown date').slice(0, 10)} (${(obj.recordings || []).length} recordings).`,
          app.sync?.enabled ? ' This device syncs, so the backup is then merged with what is on the server: nothing is removed there.' : ''),
        h('div', { class: 'p-actions' },
          h('button', { class: 'p-btn danger', type: 'button', 'data-testid': 'confirm-import', onclick: doImport }, 'Replace everything'),
          h('button', { class: 'p-btn', type: 'button', onclick: () => { confirmBox.replaceChildren(); input.value = ''; } }, 'Cancel')));
    },
  });
  return h('div', { class: 'p-import' }, h('label', { class: 'p-label' }, 'Restore from a backup file ', input), confirmBox, status);
}

export function settings(app) {
  const save = () => app.save('settings');
  const roundsOut = h('output', { 'data-testid': 'rounds-value' }, String(app.settings.roundsPerSession));
  const resetBox = h('div', {});
  const exportStatus = h('p', { class: 'p-sub', 'data-testid': 'export-status' });

  const askReset = () => resetBox.replaceChildren(
    notice('warn', 'This erases all progress (sounds and words), readiness results and the Tracker\'s session history. Your recordings, settings and the "ready to blend" switch are kept.'),
    h('div', { class: 'p-actions' },
      h('button', {
        class: 'p-btn danger', type: 'button', 'data-testid': 'confirm-reset',
        onclick: async () => {
          await app.store.resetProgress();
          app.progress = { s1: {}, s2: {}, s3: {} };
          app.readiness = [];
          app.sessions = [];
          app.meta.resetAt = Date.now(); // synced devices drop everything played before this
          await app.save('meta');
          app.sync?.changed('reset');
          resetBox.replaceChildren(notice('good', 'Progress has been reset.'));
        },
      }, 'Yes, erase progress'),
      h('button', { class: 'p-btn', type: 'button', onclick: () => resetBox.replaceChildren() }, 'Cancel')));

  const doExport = async () => {
    exportStatus.textContent = 'Preparing…';
    try {
      const backup = await app.store.exportBackup();
      const blob = new Blob([JSON.stringify(backup)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = h('a', { href: url, download: `first-sounds-backup-${app.today()}.json` });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      exportStatus.textContent = `Backup saved: ${backup.recordings.length} recordings, ${(blob.size / 1024 / 1024).toFixed(1)} MB.`;
    } catch (e) {
      exportStatus.textContent = `Export failed: ${e.message}`;
    }
  };

  page('settings', TV ? 'Settings' : 'Settings and backup', { back: { label: 'Parent area', go: () => app.go('parentMenu') } },
    ...storageNotices(app),
    h('div', { class: 'p-card' },
      h('h2', {}, 'Game'),
      h('label', { class: 'p-row' },
        h('input', {
          type: 'checkbox', checked: app.settings.speakWords, 'data-testid': 'speak-words',
          onchange: (e) => { app.settings.speakWords = e.target.checked; save(); },
        }),
        h('span', {}, `Say whole words aloud (device voice) when a picture or its speaker is ${TV ? 'chosen' : 'tapped'}. Single sounds always use your recordings.`)),
      h('label', { class: 'p-row' },
        h('span', {}, 'Rounds per session'),
        h('input', {
          type: 'range', min: String(ROUNDS_MIN), max: String(ROUNDS_MAX), step: '1', value: String(app.settings.roundsPerSession), 'data-testid': 'rounds',
          oninput: (e) => { app.settings.roundsPerSession = Number(e.target.value); roundsOut.textContent = e.target.value; save(); },
        }),
        roundsOut),
      h('p', { class: 'p-muted' }, 'About 3 to 5 minutes is plenty at this age. Once reading has started, every third round is a reading round.')),
    blendCard(app),
    TV ? null : h('div', { class: 'p-card' }, // no backups on the TV: they are made on the iPad or laptop
      h('h2', {}, 'Backup'),
      h('p', {}, 'One file with all recordings, progress and settings. Keep it somewhere safe or use it to move to another device.'),
      h('div', { class: 'p-actions' }, h('button', { class: 'p-btn primary', type: 'button', 'data-testid': 'export', onclick: doExport }, 'Export backup')),
      exportStatus,
      importControl(app)),
    h('div', { class: 'p-card' },
      h('h2', {}, 'Reset'),
      h('div', { class: 'p-actions' }, h('button', { class: 'p-btn danger', type: 'button', 'data-testid': 'reset', onclick: askReset }, 'Reset progress…')),
      resetBox));
}
