// TV mode's pure parts: turning it on, and choosing where the remote's arrows move focus.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tvMode, bestCandidate, keyOf } from '../../js/tv.js';

test('TV mode: ?tv=1 turns it on and is remembered, the bridge always turns it on, ?tv=0 forgets', () => {
  assert.deepEqual(tvMode('?tv=1', false, false), { tv: true, remember: true });
  assert.deepEqual(tvMode('', false, true), { tv: true, remember: null });
  assert.deepEqual(tvMode('?data=x', false, false), { tv: false, remember: null });
  assert.deepEqual(tvMode('', true, false), { tv: true, remember: null });
  assert.deepEqual(tvMode('?tv=0', false, true), { tv: false, remember: false });
  assert.deepEqual(tvMode('?tv=0', true, true), { tv: true, remember: false });
});

const R = (left, top, w, h) => ({ left, top, right: left + w, bottom: top + h, width: w, height: h });

test('arrows: the nearest control that way, lined-up ones first, and none past the edge', () => {
  const replay = R(100, 400, 200, 200);
  const a = R(400, 300, 400, 400);
  const b = R(850, 300, 400, 400);
  const gate = R(50, 50, 80, 80);
  const all = [replay, a, b, gate];
  assert.equal(bestCandidate('right', replay, all), 1);
  assert.equal(bestCandidate('right', a, all), 2);
  assert.equal(bestCandidate('right', b, all), -1, 'clamped at the right edge');
  assert.equal(bestCandidate('left', b, all), 1);
  assert.equal(bestCandidate('left', a, all), 0);
  assert.equal(bestCandidate('up', a, all), 3, 'up reaches the gear');
  assert.equal(bestCandidate('down', a, all), -1);
  // Two rows: Down picks the one below, not the nearer one off to the side.
  const top = R(100, 100, 300, 100);
  const below = R(100, 300, 300, 100);
  const side = R(500, 220, 300, 100);
  assert.equal(bestCandidate('down', top, [below, side]), 0);
});

test('keys: D-pad codes from older WebViews map to the same keys', () => {
  assert.equal(keyOf({ key: 'Unidentified', keyCode: 38 }), 'ArrowUp');
  assert.equal(keyOf({ key: 'Unidentified', keyCode: 23 }), 'Enter');
  assert.equal(keyOf({ key: 'Enter', code: 'NumpadEnter' }), 'Enter');
  assert.equal(keyOf({ key: ' ', code: 'Space' }), ' ');
  assert.equal(keyOf({ key: 'ArrowLeft' }), 'ArrowLeft');
});
