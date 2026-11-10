import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateData, describeData, loadData } from '../../js/data.js';

const fixture = () => JSON.parse(readFileSync(new URL('../fixtures/sounds.sample.json', import.meta.url), 'utf8'));

test('fixture is valid with no warnings', () => {
  const r = validateData(fixture());
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.ok, true);
});

test('describeData derives non-target sounds and shared graphemes from the data', () => {
  const d = describeData(fixture());
  assert.ok(d.nonTargets.includes('ng'));
  assert.ok(!d.nonTargets.includes('m'));
  assert.deepEqual(d.sharedGraphemes, ['th: th_unvoiced, th_voiced']);
});

test('rejects non-objects and wrong version', () => {
  assert.equal(validateData(null).ok, false);
  assert.equal(validateData([]).ok, false);
  const d = fixture();
  d.version = 2;
  const r = validateData(d);
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /version/);
});

test('rejects missing arrays', () => {
  assert.equal(validateData({ version: 1, words: [] }).ok, false);
  assert.equal(validateData({ version: 1, sounds: [fixture().sounds[0]] }).ok, false);
});

const mutations = [
  ['duplicate id', (d) => { d.sounds[1].id = 'm'; }, /duplicated/],
  ['uppercase grapheme', (d) => { d.sounds[0].graphemes = ['M']; }, /lowercase/],
  ['empty graphemes', (d) => { d.sounds[0].graphemes = []; }, /graphemes/],
  ['bad kind', (d) => { d.sounds[0].kind = 'nasal'; }, /kind/],
  ['bad group', (d) => { d.sounds[0].group = 0; }, /group/],
  ['missing tip', (d) => { delete d.sounds[0].tip; }, /tip/],
  ['unknown confusable', (d) => { d.sounds[0].confusable = ['zz']; }, /unknown sound id "zz"/],
  ['confusable not array', (d) => { d.sounds[0].confusable = 'n'; }, /confusable/],
  ['unknown phoneme', (d) => { d.words[0].phonemes = ['m', 'oo']; }, /unknown sound id "oo"/],
  ['empty phonemes', (d) => { d.words[0].phonemes = []; }, /phonemes/],
  ['missing emoji', (d) => { d.words[0].emoji = ''; }, /emoji/],
  ['bad readiness pair', (d) => { d.readinessPairs[0].b = { name: 'fish' }; }, /readinessPairs\[0\]\.b/],
];
for (const [name, mutate, re] of mutations) {
  test(`rejects: ${name}`, () => {
    const d = fixture();
    mutate(d);
    const r = validateData(d);
    assert.equal(r.ok, false, `expected an error for ${name}`);
    assert.ok(r.errors.some((e) => re.test(e)), r.errors.join('\n'));
  });
}

test('warns (but accepts) an exampleWord missing from words, duplicate words, empty readiness', () => {
  const d = fixture();
  d.sounds[0].exampleWord = 'mango';
  d.words.push({ ...d.words[0] });
  d.readinessPairs = [];
  const r = validateData(d);
  assert.equal(r.ok, true);
  assert.equal(r.warnings.length, 3);
});

test('loadData reports fetch, HTTP and JSON failures readably', async () => {
  await assert.rejects(loadData('x', async () => { throw new Error('offline'); }), /Could not fetch x: offline/);
  await assert.rejects(loadData('x', async () => ({ ok: false, status: 404 })), /HTTP 404/);
  await assert.rejects(loadData('x', async () => ({ ok: true, json: async () => { throw new SyntaxError('bad'); } })), /not valid JSON/);
  const { report } = await loadData('x', async () => ({ ok: true, json: async () => fixture() }));
  assert.equal(report.ok, true);
});
