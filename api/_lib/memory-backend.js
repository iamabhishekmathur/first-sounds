// In-memory blob backend with the same semantics as the Vercel one (etag checks included).
// Used by tests/server.mjs; never deployed as a function (files under api/_lib are not routes).
import crypto from 'node:crypto';

export function memoryBackend() {
  const blobs = new Map(); // path -> { body: Buffer, contentType, etag }
  const etag = () => crypto.randomBytes(8).toString('hex');
  return {
    blobs,
    async readJSON(path) {
      const b = blobs.get(path);
      return b ? { value: JSON.parse(b.body.toString('utf8')), etag: b.etag } : null;
    },
    async writeJSON(path, value, { etag: expected }) {
      const cur = blobs.get(path);
      if (expected == null ? cur : !cur || cur.etag !== expected) throw Object.assign(new Error('conflict'), { conflict: true });
      blobs.set(path, { body: Buffer.from(JSON.stringify(value)), contentType: 'application/json', etag: etag() });
    },
    async putBytes(path, body, contentType) { blobs.set(path, { body: Buffer.from(body), contentType, etag: etag() }); },
    async getBytes(path) { const b = blobs.get(path); return b ? { body: b.body, contentType: b.contentType } : null; },
    async del(paths) { for (const p of paths) blobs.delete(p); },
    async list(prefix) { return [...blobs.keys()].filter((k) => k.startsWith(prefix)); },
  };
}
