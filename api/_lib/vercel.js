// Wires the API core to Vercel: Blob storage, the FAMILY_CODE environment variable and the sound ids
// from data/sounds.json. DATA_PREFIX (preview deployments only, such as "test-abc/") keeps every
// blob of that deployment under its own prefix, away from the family's data.
import fs from 'node:fs';
import { makeApi, withPrefix } from './core.js';
import { vercelBackend } from './vercel-backend.js';

let api = null;

export function handler(route) {
  return (req, res) => {
    if (!api) {
      const data = JSON.parse(fs.readFileSync(new URL('../../data/sounds.json', import.meta.url), 'utf8'));
      const backend = withPrefix(vercelBackend(), process.env.DATA_PREFIX || '');
      api = makeApi({ backend, familyCode: process.env.FAMILY_CODE || '', validIds: new Set(data.sounds.map((s) => s.id)) });
    }
    return api(route)(req, res);
  };
}
