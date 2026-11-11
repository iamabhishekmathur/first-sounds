// All local state lives in IndexedDB: store "recordings" (one record per sound id or word id "w:<word>", audio bytes +
// mime) and store "kv" (settings, progress, readiness, sessions, meta = sync timestamps, sync = the family
// code). With a family code the server is the source of truth and this is the local cache (js/sync.js). If IndexedDB is missing or fails to open, an
// in-memory backend is used so the app still runs (nothing persists; the parent is told).

const DB_VERSION = 1;
// "sessions" and "blend" (the parent's ready-to-blend switch) were added later: older stores and
// backups simply have none (read as [] and null).
export const KV_KEYS = ['settings', 'progress', 'readiness', 'sessions', 'blend', 'meta'];
const DEVICE_KEYS = ['sync']; // kept on this device: not exported, and kept when a backup is imported

function req2promise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function openIDB(name) {
  return new Promise((resolve, reject) => {
    const idb = globalThis.indexedDB;
    if (!idb) { reject(new Error('IndexedDB is not available in this browser.')); return; }
    let req;
    try { req = idb.open(name, DB_VERSION); } catch (e) { reject(e); return; }
    const timer = setTimeout(() => reject(new Error('Opening storage timed out.')), 5000);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('recordings')) db.createObjectStore('recordings', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
    };
    req.onsuccess = () => { clearTimeout(timer); resolve(req.result); };
    req.onerror = () => { clearTimeout(timer); reject(req.error || new Error('Could not open storage.')); };
    req.onblocked = () => { clearTimeout(timer); reject(new Error('Storage is blocked by another tab.')); };
  });
}

function idbBackend(db) {
  const run = (store, mode, fn) => {
    const tx = db.transaction(store, mode);
    const result = fn(tx.objectStore(store));
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve(result && 'result' in result ? result.result : undefined);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('Storage transaction aborted.'));
    });
  };
  return {
    persistent: true,
    get: (store, key) => run(store, 'readonly', (s) => s.get(key)),
    all: (store) => run(store, 'readonly', (s) => s.getAll()),
    put: (store, value, key) => run(store, 'readwrite', (s) => (key === undefined ? s.put(value) : s.put(value, key))),
    del: (store, key) => run(store, 'readwrite', (s) => s.delete(key)),
    clear: (store) => run(store, 'readwrite', (s) => s.clear()),
  };
}

function memoryBackend() {
  const stores = { recordings: new Map(), kv: new Map() };
  return {
    persistent: false,
    get: async (store, key) => stores[store].get(key),
    all: async (store) => [...stores[store].values()],
    put: async (store, value, key) => { stores[store].set(key === undefined ? value.id : key, value); },
    del: async (store, key) => { stores[store].delete(key); },
    clear: async (store) => { stores[store].clear(); },
  };
}

/* ---------- base64 for backups ---------- */

export function bufToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function base64ToBuf(b64) {
  const s = atob(b64);
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  return bytes.buffer;
}

/* ---------- public API ---------- */

export async function openStorage(name = 'first-sounds') {
  let backend;
  let problem = null;
  try {
    backend = idbBackend(await openIDB(name));
  } catch (e) {
    problem = e.message || String(e);
    backend = memoryBackend();
  }
  return makeStore(backend, problem);
}

function makeStore(b, problem) {
  const store = {
    persistent: b.persistent,
    problem,
    getKV: (k) => b.get('kv', k),
    setKV: (k, v) => b.put('kv', v, k),
    /** rec: { id, data: ArrayBuffer, mime, durationMs, trimmed, updatedAt } */
    putRecording: (rec) => b.put('recordings', rec),
    getRecording: (id) => b.get('recordings', id),
    deleteRecording: (id) => b.del('recordings', id),
    allRecordings: () => b.all('recordings'),

    async resetProgress() {
      await b.put('kv', { s1: {}, s2: {}, s3: {} }, 'progress');
      await b.put('kv', [], 'readiness');
      await b.put('kv', [], 'sessions');
    },

    async exportBackup() {
      const kv = {};
      for (const k of KV_KEYS) kv[k] = (await b.get('kv', k)) ?? null;
      const recs = await b.all('recordings');
      return {
        app: 'first-sounds',
        format: 1,
        exportedAt: new Date().toISOString(),
        kv,
        recordings: recs.map((r) => ({ ...r, data: bufToBase64(r.data) })),
      };
    },

    /** Replaces everything with the backup. Throws a readable Error if the file is not a backup. */
    async importBackup(obj) {
      const problemText = checkBackup(obj);
      if (problemText) throw new Error(problemText);
      const keep = {};
      for (const k of DEVICE_KEYS) keep[k] = await b.get('kv', k);
      await b.clear('recordings');
      await b.clear('kv');
      for (const k of DEVICE_KEYS) if (keep[k] != null) await b.put('kv', keep[k], k);
      for (const k of KV_KEYS) if (obj.kv[k] != null) await b.put('kv', obj.kv[k], k);
      for (const r of obj.recordings) await b.put('recordings', { ...r, data: base64ToBuf(r.data) });
    },
  };
  return store;
}

export function checkBackup(obj) {
  if (!obj || obj.app !== 'first-sounds') return 'This file is not a First Sounds backup.';
  if (obj.format !== 1) return `This backup format (${obj.format}) is not supported.`;
  if (!obj.kv || typeof obj.kv !== 'object' || !Array.isArray(obj.recordings)) return 'This backup file is incomplete.';
  for (const r of obj.recordings) {
    if (!r || typeof r.id !== 'string' || typeof r.data !== 'string') return 'A recording in this backup is damaged.';
  }
  return null;
}
