// In-memory blob backend with the same semantics as the Vercel one (create-only puts).
// Used by tests/server.mjs; never deployed as a function (files under api/_lib are not routes).
//
// Test knobs: latencyMs (each operation waits up to this long, so concurrent requests interleave)
// and listLagMs (a new blob only shows up in list() after this long, like an eventually consistent
// listing). seed() writes old-layout blobs for migration tests.

export function memoryBackend({ latencyMs = 0, listLagMs = 0 } = {}) {
  const blobs = new Map(); // path -> { body: Buffer, contentType, at }
  const knobs = { latencyMs, listLagMs };
  const wait = () => (knobs.latencyMs ? new Promise((r) => setTimeout(r, Math.random() * knobs.latencyMs)) : null);
  const stats = { put: 0, get: 0, del: 0, list: 0 };
  return {
    blobs,
    knobs,
    stats,
    async list(prefix) {
      stats.list++;
      await wait();
      const now = Date.now();
      return [...blobs.entries()]
        .filter(([k, b]) => k.startsWith(prefix || '') && now - b.at >= knobs.listLagMs)
        .map(([k, b]) => ({ pathname: k, size: b.body.length }))
        .sort((a, b) => (a.pathname < b.pathname ? -1 : 1));
    },
    async put(path, body, contentType) {
      stats.put++;
      await wait();
      if (blobs.has(path)) throw Object.assign(new Error('exists'), { exists: true });
      blobs.set(path, { body: Buffer.from(body), contentType, at: Date.now() });
    },
    async get(path) {
      stats.get++;
      await wait();
      const b = blobs.get(path);
      return b ? { body: b.body, contentType: b.contentType } : null;
    },
    async del(paths) { stats.del++; await wait(); for (const p of paths) blobs.delete(p); },
    /** Test helper: writes a blob at once, bypassing the create-only rule (old-layout data). */
    seed(path, body, contentType) { blobs.set(path, { body: Buffer.from(body), contentType, at: 0 }); },
  };
}
