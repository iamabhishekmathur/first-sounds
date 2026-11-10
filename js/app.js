// Boot, shared state and navigation.
// Test hooks (URL parameters): ?data=<path to sounds json> ?today=YYYY-MM-DD ?seed=<int> ?db=<IndexedDB name>

import { loadData } from './data.js';
import { openStorage } from './storage.js';
import { dayKey, mulberry32 } from './logic.js';
import * as audio from './audio.js';
import * as game from './game.js';
import * as parent from './parent.js';

export const DEFAULT_SETTINGS = { speakWords: true, roundsPerSession: 6 };

globalThis.__fsLog = [];
const params = new URLSearchParams(location.search);

const screens = {
  welcome: parent.welcome,
  parentMenu: parent.menu,
  studio: parent.studio,
  progress: parent.progressView,
  settings: parent.settings,
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
  recordings: new Map(),
  session: null,
  saveError: null,
  rng: params.has('seed') ? mulberry32(Number(params.get('seed')) || 1) : Math.random,

  today() { return params.get('today') || dayKey(new Date()); },
  recorded() { return new Set(this.recordings.keys()); },

  async save(key) {
    try { await this.store.setKV(key, this[key]); this.saveError = null; } catch (e) { this.saveError = e.message || String(e); }
  },

  async loadState() {
    const s = this.store;
    const safe = async (fn, fallback) => { try { return (await fn()) ?? fallback; } catch { return fallback; } };
    const settings = await safe(() => s.getKV('settings'), {});
    this.settings = normaliseSettings(settings);
    const progress = await safe(() => s.getKV('progress'), {});
    this.progress = { s1: progress.s1 || {}, s2: progress.s2 || {} };
    const readiness = await safe(() => s.getKV('readiness'), []);
    this.readiness = Array.isArray(readiness) ? readiness : [];
    const ids = new Set(this.data.sounds.map((x) => x.id));
    const recs = await safe(() => s.allRecordings(), []);
    this.recordings = new Map(recs.filter((r) => ids.has(r.id) && r.data).map((r) => [r.id, r]));
  },

  go(name, opts) {
    this.session = null;
    audio.stop();
    screens[name](this, opts || {});
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
  app.go(app.recordings.size === 0 ? 'welcome' : 'home');
  document.body.dataset.ready = '1';
}

globalThis.__fsApp = app; // for tests and debugging
boot();
