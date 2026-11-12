// Builds the JSON body for a Vercel deployment of the committed site (used by scripts/deploy.sh).
// Usage: node scripts/deploy-body.mjs <exported-tree> <out.json> <production|preview>
import fs from 'node:fs';
import path from 'node:path';

const [root, out, target] = process.argv.slice(2);
// Everything the site and its API functions need; tests, screenshots and tv-app sources stay out.
const include = ['tv.apk', 'index.html', 'manifest.webmanifest', 'icons', 'css', 'js', 'data', 'api',
  'package.json', 'package-lock.json', 'vercel.json'];
const files = [];
const walk = (rel) => {
  const abs = path.join(root, rel);
  if (!fs.existsSync(abs)) return;
  if (fs.statSync(abs).isDirectory()) fs.readdirSync(abs).forEach((f) => walk(path.join(rel, f)));
  else files.push({ file: rel.split(path.sep).join('/'), data: fs.readFileSync(abs).toString('base64'), encoding: 'base64' });
};
include.forEach(walk);
const body = {
  name: 'first-sounds',
  ...(target === 'production' ? { target: 'production' } : {}),
  files,
  projectSettings: { framework: null, buildCommand: null, installCommand: null, outputDirectory: null },
};
fs.writeFileSync(out, JSON.stringify(body));
console.log(`${files.length} files, target ${target === 'production' ? 'production' : 'preview'}`);
