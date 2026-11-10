// Wires the API core to Vercel: Blob storage, the FAMILY_CODE environment variable and the sound ids
// from data/sounds.json.
import fs from 'node:fs';
import { makeApi } from './core.js';
import { vercelBackend } from './vercel-backend.js';

let api = null;

export function handler(route) {
  return (req, res) => {
    if (!api) {
      const data = JSON.parse(fs.readFileSync(new URL('../../data/sounds.json', import.meta.url), 'utf8'));
      api = makeApi({ backend: vercelBackend(), familyCode: process.env.FAMILY_CODE || '', validIds: new Set(data.sounds.map((s) => s.id)) });
    }
    return api(route)(req, res);
  };
}
