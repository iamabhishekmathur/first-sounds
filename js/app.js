// Boot, shared state and navigation.
// Test hooks (URL parameters): ?data=<path to sounds json> ?today=YYYY-MM-DD ?seed=<int> ?db=<IndexedDB name>
// ?syncRetry=<ms> ?syncDebounce=<ms> (see js/sync.js)

import { loadData } from './data.js';
import { openStorage } from './storage.js';
import { createSync } from './sync.js';
import { withIds } from './syncdoc.js';
import { dayKey, mulberry32 } from './logic.js';
import * as audio from './audio.js';
import * as game from './game.js';
import * as parent from './parent.js';
import * as tracker from './tracker-view.js';
import * as tv from './tv.js';

export const DEFAULT_SETTINGS = { speakWords: true, roundsPerSession: 6 };

globalThis.__fsLog = [];
const params = new URLSearchParams(location.search);

const screens = {
  welcome: parent.welcome,
  tvSetup: parent.tvSetup,
  parentMenu: parent.menu,
  studio: parent.studio,
  progress: parent.progressView,
  settings: parent.settings,
  tracker: tracker.trackerView,
  home: game.home,
};

const app = {
  params,
  data: null,
  report: null,
  store: null,
  settings: { ...DEFAULT_SETTINGS },
  progress: { s1: {}, s2: {} },
  readiness: [],
  sessions: [], // play sessions, for the parent's Tracker (see js/syncdoc.js)
  meta: { settingsAt: 0, resetAt: 0 }, // sync timestamps: last settings change, last progress reset
  recordings: new Map(),
  sync: null,
  session: null,
  saveError: null,
  rng: params.has('seed') ? mulberry32(Number(params.get('seed')) || 1) : Math.random,

  today() { return params.get('today') || dayKey(new Date()); },
  recorded() { return new Set(this.recordings.keys()); },

  async save(key) {
    try {
      if (key === 'settings') {
        this.meta.settingsAt = Date.now();
        await this.store.setKV('meta', this.meta);
      }
      await this.store.setKV(key, this[key]);
      this.saveError = null;
    } catch (e) { this.saveError = e.message || String(e); }
    this.sync?.changed(key);
  },

  async loadState() {
    const s = this.store;
    const safe = async (fn, fallback) => { try { return (await fn()) ?? fallback; } catch { return fallback; } };
    const settings = await safe(() => s.getKV('settings'), {});
    this.settings = normaliseSettings(settings);
    const meta = await safe(() => s.getKV('meta'), {});
    this.meta = { settingsAt: Number(meta.settingsAt) || 0, resetAt: Number(meta.resetAt) || 0 };
    const progress = await safe(() => s.getKV('progress'), {});
    const readiness = await safe(() => s.getKV('readiness'), []);
    // Every round and readiness result gets a stable id (in memory; saved with the next change).
    const ided = withIds({ s1: progress.s1 || {}, s2: progress.s2 || {} }, readiness);
    this.progress = { s1: ided.progress.s1, s2: ided.progress.s2 };
    this.readiness = ided.readiness;
    const sessions = await safe(() => s.getKV('sessions'), []);
    this.sessions = Array.isArray(sessions) ? sessions.filter((x) => x && typeof x.id === 'string') : [];
    const ids = new Set(this.data.sounds.map((x) => x.id));
    const recs = await safe(() => s.allRecordings(), []);
    this.recordings = new Map(recs.filter((r) => ids.has(r.id) && r.data).map((r) => [r.id, r]));
  },

  go(name, opts) {
    // The TV has no microphone and makes no backups: no recording welcome, no studio.
    if (tv.TV && name === 'welcome') name = 'tvSetup';
    if (tv.TV && name === 'studio') name = 'parentMenu';
    this.session = null;
    audio.stop();
    this.screen = name;
    screens[name](this, opts || {});
  },

  onRecordingReplaced(id) { audio.forget(id); },

  /** A sync brought new data. Only screens that are safe to redraw are refreshed. */
  onSynced() {
    if (this.session) return; // never interrupt the child mid-game
    if (this.screen === 'home' || this.screen === 'parentMenu' || this.screen === 'progress' || this.screen === 'tracker') this.go(this.screen);
  },
};

export function normaliseSettings(s) {
  const out = { ...DEFAULT_SETTINGS, ...(s && typeof s === 'object' ? s : {}) };
  out.speakWords = out.speakWords !== false;
  const n = Math.round(Number(out.roundsPerSession));
  out.roundsPerSession = Number.isFinite(n) ? Math.min(10, Math.max(4, n)) : 6;
  return out;
}

function installGuards() {
  // iOS Safari: stop pinch zoom, double-tap zoom and rubber-band scrolling on the child screens.
  document.addEventListener('gesturestart', (e) => e.preventDefault());
  document.addEventListener('dblclick', (e) => e.preventDefault(), { passive: false });
  document.addEventListener('touchmove', (e) => {
    if (document.body.dataset.mode === 'child') e.preventDefault();
  }, { passive: false });
  document.addEventListener('contextmenu', (e) => {
    if (document.body.dataset.mode === 'child') e.preventDefault();
  });
}

async function boot() {
  installGuards();
  tv.install(app); // remote keys, Back (window.FirstSoundsTV_onBack) and focus; arrow keys only outside TV mode
  const url = params.get('data') || 'data/sounds.json';
  app.dataUrl = url;
  try {
    const { data, report } = await loadData(url);
    app.data = data;
    app.report = report;
  } catch (e) {
    parent.dataError(app, [e.message]);
    document.body.dataset.ready = 'error';
    return;
  }
  if (!app.report.ok) {
    parent.dataError(app, app.report.errors);
    document.body.dataset.ready = 'error';
    return;
  }
  app.store = await openStorage(params.get('db') || 'first-sounds');
  await app.loadState();
  app.sync = createSync(app, {
    retryMs: Number(params.get('syncRetry')) || 5000,
    debounceMs: params.has('syncDebounce') ? Number(params.get('syncDebounce')) : 2500,
  });
  await app.sync.load();
  if (tv.TV) app.go(app.recordings.size === 0 && !app.sync.enabled ? 'tvSetup' : 'home'); // first run on the TV: the family code
  else app.go(app.recordings.size === 0 ? 'welcome' : 'home');
  document.body.dataset.ready = '1';
  app.sync.start(); // in the background: the app never waits for the network
}

globalThis.__fsApp = app; // for tests and debugging
boot();
