import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findSpeechBounds, trimSamples, downsample, encodeWav, pickMimeType, micErrorKind } from '../../js/audio.js';

function signal(rate, parts) {
  // parts: [[seconds, amplitude], ...] of a 300 Hz sine (0 amplitude = silence)
  const total = parts.reduce((n, [s]) => n + Math.round(s * rate), 0);
  const out = new Float32Array(total);
  let i = 0;
  for (const [s, amp] of parts) {
    for (let k = 0; k < Math.round(s * rate); k++, i++) out[i] = amp * Math.sin((2 * Math.PI * 300 * i) / rate) + (Math.random() - 0.5) * 0.002;
  }
  return out;
}

test('findSpeechBounds trims leading and trailing silence with small padding', () => {
  const rate = 48000;
  const s = signal(rate, [[0.8, 0], [0.4, 0.5], [1.0, 0]]);
  const b = findSpeechBounds(s, rate);
  assert.equal(b.silent, false);
  assert.ok(Math.abs(b.start / rate - 0.77) < 0.02, `start ${b.start / rate}`);
  assert.ok(Math.abs(b.end / rate - 1.28) < 0.02, `end ${b.end / rate}`);
});

test('findSpeechBounds keeps a quiet stop consonant after a loud part', () => {
  const rate = 48000;
  const s = signal(rate, [[0.3, 0], [0.2, 0.6], [0.1, 0], [0.05, 0.12], [0.5, 0]]);
  const b = findSpeechBounds(s, rate);
  assert.ok(b.end / rate > 0.65, 'the quiet burst at 0.6-0.65s is kept');
});

test('silent input is flagged and left whole', () => {
  const s = new Float32Array(48000);
  assert.deepEqual(findSpeechBounds(s, 48000), { start: 0, end: 48000, silent: true });
});

test('trimSamples downsamples 48k to 24k and shortens the clip', () => {
  const rate = 48000;
  const s = signal(rate, [[1, 0], [0.5, 0.5], [1, 0]]);
  const t = trimSamples(s, rate);
  assert.equal(t.rate, 24000);
  assert.ok(t.samples.length / t.rate < 0.7);
  assert.ok(Math.abs(t.samples[0]) < 0.01, 'fades in');
});

test('downsample leaves low rates alone', () => {
  const s = new Float32Array(100);
  assert.equal(downsample(s, 22050).rate, 22050);
});

test('encodeWav writes a valid 16-bit mono header', () => {
  const buf = encodeWav(new Float32Array([0, 1, -1]), 24000);
  const v = new DataView(buf);
  const str = (o) => String.fromCharCode(...new Uint8Array(buf, o, 4));
  assert.equal(str(0), 'RIFF');
  assert.equal(str(8), 'WAVE');
  assert.equal(v.getUint32(24, true), 24000);
  assert.equal(v.getUint16(22, true), 1);
  assert.equal(buf.byteLength, 44 + 6);
  assert.equal(v.getInt16(46, true), 32767);
  assert.equal(v.getInt16(48, true), -32768);
});

test('pickMimeType prefers audio/mp4 (Safari) and falls back by feature detection', () => {
  const orig = globalThis.MediaRecorder;
  try {
    globalThis.MediaRecorder = { isTypeSupported: (t) => t === 'audio/mp4' };
    assert.equal(pickMimeType(), 'audio/mp4');
    globalThis.MediaRecorder = { isTypeSupported: (t) => t.startsWith('audio/webm') };
    assert.equal(pickMimeType(), 'audio/webm;codecs=opus');
    globalThis.MediaRecorder = { isTypeSupported: () => false };
    assert.equal(pickMimeType(), '');
    delete globalThis.MediaRecorder;
    assert.equal(pickMimeType(), '');
  } finally {
    if (orig) globalThis.MediaRecorder = orig;
  }
});

test('microphone errors map to parent-facing kinds', () => {
  assert.equal(micErrorKind({ name: 'NotAllowedError' }), 'denied');
  assert.equal(micErrorKind({ name: 'NotFoundError' }), 'nomic');
  assert.equal(micErrorKind({ name: 'NotReadableError' }), 'busy');
  assert.equal(micErrorKind(new Error('x')), 'error');
});
