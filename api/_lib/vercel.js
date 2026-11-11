// Wires the API core to Vercel: Blob storage, the FAMILY_CODE environment variable and the ids it
// accepts: the sound ids from data/sounds.json and "w:<word>" for the words of data/reading.json
// (optional: without it only sounds are accepted). DATA_PREFIX (preview deployments only, such as "test-abc/") keeps every
// blob of that deployment under its own prefix, away from the family's data.
import fs from 'node:fs';
import { makeApi, withPrefix } from './core.js';
import { knownIds } from '../../js/syncdoc.js';
import { vercelBackend } from './vercel-backend.js';

let api = null;

export function handler(route) {
  return (req, res) => {
    if (!api) {
      const data = JSON.parse(fs.readFileSync(new URL('../../data/sounds.json', import.meta.url), 'utf8'));
      let reading = null;
      try { reading = JSON.parse(fs.readFileSync(new URL('../../data/reading.json', import.meta.url), 'utf8')); } catch { /* no reading words */ }
      const backend = withPrefix(vercelBackend(), process.env.DATA_PREFIX || '');
      api = makeApi({ backend, familyCode: process.env.FAMILY_CODE || '', validIds: knownIds(data, reading) });
    }
    return api(route)(req, res);
  };
}
