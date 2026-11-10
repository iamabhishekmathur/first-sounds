// Vercel Blob backend. The store is private: blobs are only readable with the store's
// BLOB_READ_WRITE_TOKEN (a project environment variable), never by URL, so the app only ever gets
// audio through /api/recording after the family code check.
//
// Every blob is written once (create only) and never overwritten, so reads need no cache busting:
// a pathname always has the same bytes. Every call has a short timeout and at most one SDK retry,
// so a slow store makes the request fail fast (and the client retry) instead of hanging.
import { put, get, del, list, head } from '@vercel/blob';

const ACCESS = 'private';
const TIMEOUT_MS = 6000;
// The SDK retries failed calls up to 10 times with growing waits by default (minutes in total).
if (!process.env.VERCEL_BLOB_RETRIES) process.env.VERCEL_BLOB_RETRIES = '1';

const signal = () => AbortSignal.timeout(TIMEOUT_MS);

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const c of stream) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks);
}

export function vercelBackend() {
  return {
    async put(path, body, contentType) {
      try {
        await put(path, body, { access: ACCESS, contentType, addRandomSuffix: false, allowOverwrite: false, abortSignal: signal() });
      } catch (e) {
        // A create-only put fails if the pathname exists (or if a timed-out attempt in fact landed).
        const there = await head(path, { abortSignal: signal() }).catch(() => null);
        if (there) throw Object.assign(new Error('exists'), { exists: true });
        throw e;
      }
    },
    async get(path) {
      const r = await get(path, { access: ACCESS, abortSignal: signal() });
      if (!r || r.statusCode !== 200) return null;
      return { body: await streamToBuffer(r.stream), contentType: r.blob.contentType };
    },
    async del(paths) {
      for (let i = 0; i < paths.length; i += 100) await del(paths.slice(i, i + 100), { abortSignal: signal() });
    },
    async list(prefix) {
      const out = [];
      let cursor;
      do {
        const page = await list({ prefix: prefix || undefined, cursor, limit: 1000, abortSignal: signal() });
        out.push(...page.blobs.map((b) => ({ pathname: b.pathname, size: b.size })));
        cursor = page.hasMore ? page.cursor : undefined;
      } while (cursor);
      return out;
    },
  };
}
