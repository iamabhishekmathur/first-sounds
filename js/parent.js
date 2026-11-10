// Parent screens: first-run welcome, parent menu, recording studio, progress, settings and backup.

import { h, mount, setMode, notice } from './ui.js';
import {
  canPlay, groupProgress, statusOf, targetEligibleIds, unlockedGroups,
  readinessByDate, readinessPassedDays, wordsStartingWith,
} from './logic.js';
import * as audio from './audio.js';

const STATUS_LABEL = { not_started: 'not started', learning: 'learning', solid: 'solid' };

function page(screenName, title, { back } = {}, ...kids) {
  setMode('parent');
  const header = h('header', { class: 'p-header' },
    back ? h('button', { class: 'p-back', type: 'button', onclick: back.go }, `‹ ${back.label}`) : null,
    h('h1', {}, title));
  const el = h('section', { class: 'screen parent', 'data-screen': screenName }, h('div', { class: 'p-inner' }, header, ...kids));
  mount(el);
  return el;
}

function storageNotices(app) {
  return [
    app.store && !app.store.persistent
      ? notice('warn', `Storage is not available (${app.store.problem}). The app works, but recordings and progress will be lost when this page closes. Private browsing can cause this.`)
      : null,
    app.saveError ? notice('warn', `Saving failed: ${app.saveError}`) : null,
  ];
}

function dataWarnings(app) {
  const w = (app.report && app.report.warnings) || [];
  if (!w.length) return null;
  return h('details', { class: 'p-details' }, h('summary', {}, `Sound data: ${w.length} warning${w.length > 1 ? 's' : ''}`),
    h('ul', {}, w.map((x) => h('li', {}, x))));
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
    h('div', { class: 'p-card' },
      h('h2', {}, 'Moving from another device?'),
      importControl(app)));
}

/* ---------- parent menu ---------- */

export function menu(app) {
  const groups = groupProgress(app.data, app.recorded());
  const playable = canPlay(app.data, app.recorded());
  const passed = readinessPassedDays(app.readiness);
  const tile = (label, sub, onclick, testid) => h('button', { class: 'p-tile', type: 'button', onclick, 'data-testid': testid }, h('strong', {}, label), h('span', {}, sub));
  const recordedTotal = groups.reduce((n, g) => n + g.recorded, 0);
  page('parent-menu', 'Parent area', {},
    ...storageNotices(app),
    passed >= 3 ? notice('good', `Your child picked the right order in the readiness check on ${passed} different days. They may be ready for blending, which comes in a later version.`) : null,
    !playable ? notice('info', 'Record all of group 1 to start playing.') : null,
    h('div', { class: 'p-tiles' },
      tile('Recording studio', `${recordedTotal} of ${app.data.sounds.length} sounds recorded`, () => app.go('studio'), 'open-studio'),
      tile('Progress', 'Per sound, per stage, and readiness', () => app.go('progress'), 'open-progress'),
      tile('Settings and backup', 'Word speech, session length, export and import', () => app.go('settings'), 'open-settings')),
    h('div', { class: 'p-actions' },
      h('button', { class: 'p-btn primary', type: 'button', 'data-testid': 'back-to-child', onclick: () => app.go('home') }, 'Back to the child screen')),
    dataWarnings(app));
}

/* ---------- recording studio ---------- */

const MIC_HELP = {
  denied: 'Microphone access is blocked, so nothing can be recorded. On iPad open Settings, then Apps, then Safari, then Microphone, and choose Ask or Allow. Then come back and tap Record again. (In Safari you can also tap the aA button in the address bar, then Website Settings, then Microphone.)',
  nomic: 'No microphone was found on this device.',
  busy: 'The microphone is being used by another app. Close it and try again.',
  unsupported: 'This browser cannot record audio here. Recording needs Safari on iPadOS 14.5 or later, or a recent Chrome or Edge.',
  insecure: 'Recording only works when the app is opened from a secure (https://) address or from localhost.',
  error: 'Something went wrong with the microphone. Please try again.',
};

export function studio(app, opts = {}) {
  const groups = groupProgress(app.data, app.recorded());
  let group = opts.group ?? (groups.find((g) => g.recorded < g.total) || groups[0]).group;
  let selected = opts.sound || null;
  let state = 'idle'; // idle | starting | recording | saving
  let message = null;
  let micError = audio.recordingSupport() === 'ok' ? null : audio.recordingSupport();
  let active = null;
  let autoStop = null;
  const eligible = targetEligibleIds(app.data);
  const words = new Map(app.data.words.map((w) => [w.word, w]));

  function render() {
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

    const tabs = h('div', { class: 'p-tabs', role: 'tablist' }, gp.map((g) => h('button', {
      class: `p-tab${g.group === group ? ' on' : ''}${g.recorded === g.total ? ' complete' : ''}`, type: 'button', role: 'tab',
      'aria-selected': g.group === group ? 'true' : 'false', 'data-group': String(g.group), disabled: busy,
      onclick: () => { group = g.group; selected = null; message = null; render(); },
    }, h('span', {}, `Group ${g.group}`), h('small', {}, `${g.recorded}/${g.total}`))));

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
    app.recordings.has(s.id) ? h('span', { class: 'st-check', 'aria-hidden': 'true' }, '✓') : null)));

    const recordLabel = state === 'recording' ? 'Stop' : state === 'starting' ? 'Starting…' : state === 'saving' ? 'Saving…' : rec ? 'Re-record' : 'Record';
    const detail = h('div', { class: 'st-detail', 'data-testid': 'detail', 'data-sound': sound.id },
      h('div', { class: 'st-big' }, sound.graphemes.join(' ')),
      h('p', { class: 'st-sayline' }, 'Say: ', h('strong', {}, sound.say)),
      h('p', { class: 'st-tip' }, sound.tip),
      h('p', { class: 'st-example' }, ex ? h('span', { class: 'st-ex-emoji' }, ex.emoji) : null, ' as in ', h('strong', {}, sound.exampleWord)),
      !eligible.has(sound.id)
        ? h('p', { class: 'st-note' }, `Fewer than 3 picture words start with this sound (${wordsStartingWith(app.data, sound.id).length}), so it is not a game target yet.`)
        : null,
      micError ? notice('error', h('strong', {}, 'Microphone problem. '), MIC_HELP[micError] || MIC_HELP.error) : null,
      h('div', { class: 'st-buttons' },
        h('button', {
          class: `p-btn rec${state === 'recording' ? ' recording' : ''}`, type: 'button', 'data-testid': 'record',
          disabled: state === 'starting' || state === 'saving' || micError === 'unsupported' || micError === 'insecure',
          onclick: () => (state === 'recording' ? stop() : start(sound)),
        }, h('span', { class: 'rec-dot', 'aria-hidden': 'true' }), recordLabel),
        h('button', {
          class: 'p-btn', type: 'button', 'data-testid': 'playback', disabled: !rec || busy,
          onclick: () => { audio.unlock(); audio.playRecording(rec); },
        }, '▶ Play')),
      state === 'recording' ? h('p', { class: 'st-hint' }, 'Recording… say the sound once, then tap Stop.') : null,
      message ? h('p', { class: `st-msg ${message.kind}`, 'data-testid': 'studio-msg' }, message.text) : null,
      rec ? h('p', { class: 'st-meta' }, rec.trimmed ? `Saved, ${(rec.durationMs / 1000).toFixed(1)} s after trimming silence.` : 'Saved (silence could not be trimmed on this device).') : null);

    const after = canPlay(app.data, app.recorded())
      ? h('div', { class: 'p-actions' }, h('button', { class: 'p-btn primary', type: 'button', 'data-testid': 'go-play', disabled: busy, onclick: () => app.go('home') }, 'Go to the child screen'))
      : null;

    page('studio', 'Recording studio', { back: { label: 'Parent area', go: () => { cleanup(); app.go('parentMenu'); } } },
      ...storageNotices(app),
      tabs,
      h('p', { class: 'p-sub', 'data-testid': 'group-note' }, groupNote),
      h('div', { class: 'st-grid' }, tiles, detail),
      after);
  }

  function cleanup() {
    clearTimeout(autoStop);
    if (active) { active.stop().catch(() => {}); active = null; }
  }

  async function start(sound) {
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
      autoStop = setTimeout(() => { if (state === 'recording') stop(); }, 4000);
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
      app.recordings.set(id, rec);
      audio.forget(id);
      state = 'idle';
      message = processed.silent
        ? { kind: 'warn', text: 'That was very quiet. Play it back, and re-record closer to the microphone if needed.' }
        : { kind: 'good', text: 'Saved. Playing it back now.' };
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

/* ---------- progress ---------- */

export function progressView(app) {
  const eligible = targetEligibleIds(app.data);
  const chip = (st, testid) => h('span', { class: `chip ${st}`, 'data-testid': testid }, STATUS_LABEL[st]);
  const groups = groupProgress(app.data, app.recorded());
  const table = h('table', { class: 'p-table' },
    h('thead', {}, h('tr', {}, h('th', {}, 'Sound'), h('th', {}, 'Recorded'), h('th', {}, 'Hear it'), h('th', {}, 'See it'))),
    groups.map((g) => h('tbody', {},
      h('tr', { class: 'p-group-row' }, h('th', { colspan: '4' }, `Group ${g.group}`)),
      g.sounds.map((s) => h('tr', { 'data-sound': s.id },
        h('td', {}, h('span', { class: 'p-g' }, s.graphemes[0]), ' ', h('small', {}, s.say)),
        h('td', {}, app.recordings.has(s.id) ? 'yes' : 'no'),
        eligible.has(s.id)
          ? [h('td', {}, chip(statusOf(app.progress, 1, s.id), `s1-${s.id}`)), h('td', {}, chip(statusOf(app.progress, 2, s.id), `s2-${s.id}`))]
          : h('td', { colspan: '2', class: 'p-muted' }, 'not a game target yet (fewer than 3 picture words)'))))));

  const byDate = readinessByDate(app.readiness);
  const passed = readinessPassedDays(app.readiness);
  page('progress', 'Progress', { back: { label: 'Parent area', go: () => app.go('parentMenu') } },
    h('p', { class: 'p-sub' }, 'A sound is solid when at least 5 of its last 6 rounds were right first time, across at least 2 different days. "See it" opens for a sound once it is solid in "Hear it".'),
    passed >= 3 ? notice('good', `Passed the readiness check on ${passed} different days: your child may be ready for blending (a later version).`) : null,
    h('h2', {}, 'Sounds'),
    table,
    h('h2', {}, 'Readiness check'),
    byDate.length
      ? h('table', { class: 'p-table', 'data-testid': 'readiness-table' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Date'), h('th', {}, 'Asked'), h('th', {}, 'Child chose'), h('th', {}, 'Result'))),
        h('tbody', {}, byDate.flatMap((d) => d.list.map((r) => h('tr', {},
          h('td', {}, r.d), h('td', {}, r.asked), h('td', {}, r.chose), h('td', {}, r.correct ? 'right order' : 'other order'))))))
      : h('p', { class: 'p-muted' }, 'Not tried yet. It appears as an occasional bonus round (at most once a day) once group 1 is solid in "See it".'),
    h('p', { class: 'p-muted' }, `Days with a right answer: ${passed} of the 3 needed.`));
}

/* ---------- settings and backup ---------- */

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
      const doImport = async () => {
        try {
          await app.store.importBackup(obj);
          await app.loadState();
          app.go('parentMenu');
        } catch (e) {
          status.textContent = e.message;
        }
      };
      const hasData = app.recordings.size > 0 || Object.keys(app.progress.s1).length > 0;
      if (!hasData) { await doImport(); return; }
      confirmBox.replaceChildren(
        notice('warn', `This replaces everything on this device with the backup from ${String(obj.exportedAt || 'an unknown date').slice(0, 10)} (${(obj.recordings || []).length} recordings).`),
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
    notice('warn', 'This erases all progress and readiness results. Your recordings and settings are kept.'),
    h('div', { class: 'p-actions' },
      h('button', {
        class: 'p-btn danger', type: 'button', 'data-testid': 'confirm-reset',
        onclick: async () => {
          await app.store.resetProgress();
          app.progress = { s1: {}, s2: {} };
          app.readiness = [];
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

  page('settings', 'Settings and backup', { back: { label: 'Parent area', go: () => app.go('parentMenu') } },
    ...storageNotices(app),
    h('div', { class: 'p-card' },
      h('h2', {}, 'Game'),
      h('label', { class: 'p-row' },
        h('input', {
          type: 'checkbox', checked: app.settings.speakWords, 'data-testid': 'speak-words',
          onchange: (e) => { app.settings.speakWords = e.target.checked; save(); },
        }),
        h('span', {}, 'Say whole words aloud (device voice) when a picture or its speaker is tapped. Single sounds always use your recordings.')),
      h('label', { class: 'p-row' },
        h('span', {}, 'Rounds per session'),
        h('input', {
          type: 'range', min: '4', max: '10', step: '1', value: String(app.settings.roundsPerSession), 'data-testid': 'rounds',
          oninput: (e) => { app.settings.roundsPerSession = Number(e.target.value); roundsOut.textContent = e.target.value; save(); },
        }),
        roundsOut)),
    h('div', { class: 'p-card' },
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
