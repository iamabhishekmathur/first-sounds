// Vercel Blob backend. The store is private: blobs are only readable with the store's
// BLOB_READ_WRITE_TOKEN (a project environment variable), never by URL, so the app only ever gets
// audio through /api/recording after the family code check.
import { put, get, del, list, BlobPreconditionFailedError } from '@vercel/blob';

const ACCESS = 'private';

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const c of stream) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks);
}

export function vercelBackend() {
  return {
    async readJSON(path) {
      const r = await get(path, { access: ACCESS, useCache: false });
      if (!r || r.statusCode !== 200) return null;
      return { value: JSON.parse((await streamToBuffer(r.stream)).toString('utf8')), etag: r.blob.etag };
    },
    async writeJSON(path, value, { etag }) {
      const body = JSON.stringify(value);
      const opts = { access: ACCESS, contentType: 'application/json', addRandomSuffix: false, cacheControlMaxAge: 60 };
      try {
        if (etag) await put(path, body, { ...opts, ifMatch: etag });
        else await put(path, body, { ...opts, allowOverwrite: false });
      } catch (e) {
        if (e instanceof BlobPreconditionFailedError) throw Object.assign(new Error('conflict'), { conflict: true });
        // Create-only write: the blob appeared meanwhile.
        if (!etag && await this.readJSON(path)) throw Object.assign(new Error('conflict'), { conflict: true });
        throw e;
      }
    },
    async putBytes(path, body, contentType) {
      await put(path, body, { access: ACCESS, contentType, addRandomSuffix: false, allowOverwrite: false });
    },
    async getBytes(path) {
      const r = await get(path, { access: ACCESS });
      if (!r || r.statusCode !== 200) return null;
      return { body: await streamToBuffer(r.stream), contentType: r.blob.contentType };
    },
    async del(paths) { if (paths.length) await del(paths); },
    async list(prefix) {
      const out = [];
      let cursor;
      do {
        const page = await list({ prefix: prefix || undefined, cursor, limit: 1000 });
        out.push(...page.blobs.map((b) => b.pathname));
        cursor = page.hasMore ? page.cursor : undefined;
      } while (cursor);
      return out;
    },
  };
}
