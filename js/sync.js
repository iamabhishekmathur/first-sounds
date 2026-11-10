// Optional sync with the family's server storage (see api/ and README). IndexedDB stays the local
// cache: the app never waits for the network, and every change is saved locally first. Once a
// device has the family code, each sync cycle pulls the server doc, merges it into local state
// (js/syncdoc.js rules), downloads newer recordings, uploads newer local ones and pushes the merged
// state back. Failures are retried with a backoff; the status is shown in the parent area only.
//
// Test hooks: ?syncRetry=<ms> (first retry delay), ?syncDebounce=<ms> (progress push delay).

import { mergeDocs, coreOf, canon, normaliseCode } from './syncdoc.js';

export const SYNC_KEY = 'sync'; // IndexedDB kv key for { code }; never included in backups

export const STATUS_TEXT = {
  off: 'Not syncing',
  syncing: 'Syncing…',
  synced: 'Synced',
  offline: 'Offline: changes are kept on this device and will sync later',
  'wrong-code': 'The family code was not accepted',
  error: 'The server could not be reached: will try again',
};

class ApiError extends Error {
  constructor(status, network = false) { super(network ? 'network' : `http ${status}`); this.status = status; this.network = network; }
}

/** The app's local state as a sync doc. */
export function docFromApp(app) {
  const recordings = {};
  for (const [id, r] of app.recordings) {
    recordings[id] = { updatedAt: r.updatedAt || 0, mime: r.mime, durationMs: r.durationMs, trimmed: !!r.trimmed };
  }
  return {
    settings: { speakWords: app.settings.speakWords, roundsPerSession: app.settings.roundsPerSession },
    settingsAt: app.meta.settingsAt || 0,
    progress: { s1: app.progress.s1 || {}, s2: app.progress.s2 || {} },
    resetAt: app.meta.resetAt || 0,
    readiness: app.readiness,
    sessions: app.sessions || [],
    recordings,
  };
}

// A progress or settings push reuses the server doc fetched this recently instead of fetching it
// again: the Blob store's monthly operation allowance counts every listing (see api/_lib/core.js).
const FRESH_MS = 60 * 1000;

export function createSync(app, { base = 'api/', retryMs = 5000, debounceMs = 2500, freshMs = FRESH_MS } = {}) {
  let code = null;
  let known = null; // the last server doc and when it was fetched: { doc, at }
  let full = true; // the next cycle fetches the server doc whatever its age
  let status = 'off';
  let lastSynced = 0;
  let running = null;
  let again = false;
  let timer = null;
  let retryTimer = null;
  let retryDelay = retryMs;
  const listeners = new Set();
  const log = (type, extra = {}) => { (globalThis.__fsLog || []).push({ type, ...extra }); };

  function setStatus(s) {
    if (status === s) return;
    status = s;
    log('sync-status', { status: s });
    for (const fn of listeners) { try { fn(s); } catch { /* ignore */ } }
  }

  // A request that hangs (a stalled mobile connection) is abandoned, so the cycle ends, a retry is
  // scheduled and later triggers (foreground, online) are not stuck behind it.
  async function api(method, path, { body, headers = {}, raw = false, withCode = code, timeoutMs = 30000 } = {}) {
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctl && setTimeout(() => ctl.abort(), timeoutMs);
    try {
      let res;
      try {
        res = await fetch(`${base}${path}`, { method, body, headers: { 'x-family-code': withCode, ...headers }, cache: 'no-store', signal: ctl?.signal });
      } catch {
        throw new ApiError(0, true);
      }
      if (!res.ok) throw new ApiError(res.status);
      return raw ? res : await res.json();
    } catch (e) {
      throw e instanceof ApiError ? e : new ApiError(0, true);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Merge a server doc into the app's state and the local cache. Synchronous up to the writes. */
  async function applyDoc(server) {
    const local = docFromApp(app);
    const merged = mergeDocs(local, server);
    const writes = [];
    if (canon(merged.progress) !== canon(local.progress)) {
      app.progress = merged.progress;
      writes.push(app.store.setKV('progress', app.progress));
    }
    if (canon(merged.readiness) !== canon(local.readiness)) {
      app.readiness = merged.readiness;
      writes.push(app.store.setKV('readiness', app.readiness));
    }
    if (canon(merged.sessions) !== canon(local.sessions)) {
      app.sessions = merged.sessions;
      writes.push(app.store.setKV('sessions', app.sessions));
    }
    if (merged.settings && (canon(merged.settings) !== canon(local.settings) || merged.settingsAt !== local.settingsAt)) {
      app.settings = { ...app.settings, ...merged.settings };
      app.meta.settingsAt = merged.settingsAt;
      writes.push(app.store.setKV('settings', app.settings));
    }
    if (merged.resetAt !== local.resetAt || merged.settingsAt !== local.settingsAt) {
      app.meta.resetAt = merged.resetAt;
      app.meta.settingsAt = merged.settingsAt;
      writes.push(app.store.setKV('meta', app.meta));
    }
    await Promise.all(writes.map((p) => p.catch((e) => { app.saveError = e.message || String(e); })));
    return writes.length > 0;
  }

  async function download(id, meta) {
    const v = meta.version ? `&v=${encodeURIComponent(meta.version)}` : '';
    const res = await api('GET', `recording?id=${encodeURIComponent(id)}${v}`, { raw: true });
    const data = await res.arrayBuffer();
    const rec = {
      id, data,
      mime: (res.headers.get('content-type') || meta.mime || 'audio/wav').split(';')[0],
      durationMs: Number(res.headers.get('x-duration-ms')) || meta.durationMs || 0,
      trimmed: res.headers.get('x-trimmed') === '1',
      updatedAt: Number(res.headers.get('x-updated-at')) || meta.updatedAt,
    };
    const cur = app.recordings.get(id);
    if (cur && (cur.updatedAt || 0) >= rec.updatedAt) return false; // re-recorded here meanwhile
    try { await app.store.putRecording(rec); } catch (e) { app.saveError = e.message || String(e); }
    app.recordings.set(id, rec);
    app.onRecordingReplaced?.(id);
    log('sync-download', { id });
    return true;
  }

  async function upload(rec) {
    const out = await api('PUT', `recording?id=${encodeURIComponent(rec.id)}`, {
      body: rec.data,
      headers: { 'content-type': rec.mime || 'audio/wav', 'x-updated-at': String(rec.updatedAt || Date.now()), 'x-duration-ms': String(Math.round(rec.durationMs || 0)), 'x-trimmed': rec.trimmed ? '1' : '0' },
    });
    log('sync-upload', { id: rec.id, stored: out.stored });
    return out.recording;
  }

  async function cycle() {
    setStatus('syncing');
    const fetchNow = full || !known || Date.now() - known.at > freshMs;
    full = false;
    let server;
    let changed = false;
    if (fetchNow) {
      server = await api('GET', 'state');
      known = { doc: server, at: Date.now() };
      changed = await applyDoc(server);
    } else {
      server = known.doc;
    }
    const remote = { ...(server.recordings || {}) };
    const ids = [...new Set([...app.recordings.keys(), ...Object.keys(remote)])];
    // Every recording that is newer here than on the server is the upload queue. One that fails
    // does not hold up the others; the cycle then fails as a whole, so it is retried with the rest.
    let failed = null;
    for (const id of ids) {
      const l = app.recordings.get(id);
      const s = remote[id];
      try {
        if (s && (!l || s.updatedAt > (l.updatedAt || 0))) {
          if (await download(id, s)) changed = true;
        } else if (l && l.data && (!s || (l.updatedAt || 0) > s.updatedAt)) {
          const meta = await upload(l);
          if (meta) remote[id] = meta;
        }
      } catch (e) {
        if (e.status === 401) throw e;
        failed = failed || e;
        log('sync-item-error', { id, status: e.status || 0 });
      }
    }
    const want = coreOf(docFromApp(app));
    if (canon(want) !== canon(coreOf(server))) {
      const stored = await api('PUT', 'state', { body: JSON.stringify(want), headers: { 'content-type': 'application/json' } });
      if (await applyDoc(stored)) changed = true;
      // The server now has at least what was sent, merged with what it had.
      known = { doc: { ...mergeDocs(server, stored), recordings: remote }, at: known ? known.at : Date.now() };
    } else if (known) {
      known = { ...known, doc: { ...known.doc, recordings: remote } };
    }
    if (failed) throw failed;
    return changed;
  }

  function scheduleRetry() {
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => { retryTimer = null; run(); }, retryDelay);
    retryDelay = Math.min(retryDelay * 2, 5 * 60 * 1000);
  }

  /**
   * Runs one sync cycle (or queues another one if a cycle is already running). fetch: false lets a
   * progress push reuse a recently fetched server doc; everything else fetches it.
   */
  function run(fetch = true) {
    if (fetch !== false) full = true;
    if (!code) return Promise.resolve(status);
    clearTimeout(timer);
    timer = null;
    if (running) { again = true; return running; }
    running = (async () => {
      try {
        do {
          again = false;
          const changed = await cycle();
          lastSynced = Date.now();
          retryDelay = retryMs;
          clearTimeout(retryTimer);
          setStatus('synced');
          if (changed) app.onSynced?.();
        } while (again && code);
      } catch (e) {
        full = true; // after a failure, start from the server's doc again
        if (e.status === 401) { setStatus('wrong-code'); }
        else {
          setStatus(e.network || (typeof navigator !== 'undefined' && navigator.onLine === false) ? 'offline' : 'error');
          scheduleRetry();
        }
        log('sync-error', { status: e.status || 0 });
      } finally {
        running = null;
      }
      return status;
    })();
    return running;
  }

  const sync = {
    get status() { return status; },
    get lastSynced() { return lastSynced; },
    get enabled() { return !!code; },
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },

    async load() {
      try {
        const cfg = await app.store.getKV(SYNC_KEY);
        if (cfg && typeof cfg.code === 'string' && cfg.code) code = cfg.code;
      } catch { /* no saved code */ }
      if (code) setStatus('synced');
    },

    /**
     * Checks a code with the server and, if accepted, saves it and syncs.
     * Returns 'ok', 'wrong-code', 'empty' or 'offline' (offline: saved, will sync later).
     */
    async enter(input) {
      const c = normaliseCode(input);
      if (!c) return 'empty';
      try {
        await api('GET', 'state', { withCode: c });
      } catch (e) {
        if (e.status === 401) return 'wrong-code';
        await this.save(c);
        setStatus('offline');
        scheduleRetry();
        return 'offline';
      }
      await this.save(c);
      await run();
      return status === 'synced' ? 'ok' : status;
    },

    async save(c) {
      code = c;
      retryDelay = retryMs;
      try { await app.store.setKV(SYNC_KEY, { code: c }); } catch { /* kept for this session */ }
    },

    async forget() {
      code = null;
      clearTimeout(timer);
      clearTimeout(retryTimer);
      try { await app.store.setKV(SYNC_KEY, null); } catch { /* ignore */ }
      setStatus('off');
    },

    /** Something changed locally. Recordings and resets push at once; progress and settings debounce. */
    changed(kind) {
      if (!code) return;
      if (kind === 'recording' || kind === 'reset' || kind === 'import') { run(); return; }
      if (running) { again = true; return; }
      clearTimeout(timer);
      timer = null;
      timer = setTimeout(() => run(false), kind === 'settings' ? Math.min(debounceMs, 1000) : debounceMs);
    },

    now: () => run(),

    start() {
      if (typeof document !== 'undefined') {
        document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') run(); });
      }
      if (typeof window !== 'undefined') {
        window.addEventListener('online', () => { retryDelay = retryMs; run(); });
        window.addEventListener('pageshow', (e) => { if (e.persisted) run(); });
      }
      return run();
    },
  };
  return sync;
}
