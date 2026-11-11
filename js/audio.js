// Audio: the parent's recordings (record, trim, play), the soft success tone (oscillator), and
// whole-word speech. Isolated sounds are ONLY ever the parent's recordings, never speech synthesis.
// The pure helpers at the top (findSpeechBounds, downsample, encodeWav) are unit tested in Node.

const log = (entry) => { if (globalThis.__fsLog) globalThis.__fsLog.push({ ...entry, t: Date.now() }); };

/* ---------- pure helpers ---------- */

/** Find where sound starts and ends in mono samples, padded a little so stops like "t" are not clipped. */
export function findSpeechBounds(samples, rate, opts = {}) {
  const { win = 0.01, padStart = 0.03, padEnd = 0.08, rel = 0.1, abs = 0.008 } = opts;
  const w = Math.max(1, Math.round(rate * win));
  const n = Math.floor(samples.length / w);
  const rms = new Float32Array(n);
  let peak = 0;
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let j = i * w; j < (i + 1) * w; j++) sum += samples[j] * samples[j];
    rms[i] = Math.sqrt(sum / w);
    if (rms[i] > peak) peak = rms[i];
  }
  if (n === 0 || peak < abs) return { start: 0, end: samples.length, silent: true };
  const th = Math.max(abs, peak * rel);
  let first = 0;
  while (first < n && rms[first] < th) first++;
  let last = n - 1;
  while (last > first && rms[last] < th) last--;
  const start = Math.max(0, Math.round(first * w - padStart * rate));
  const end = Math.min(samples.length, Math.round((last + 1) * w + padEnd * rate));
  return { start, end, silent: false };
}

/** Integer-factor downsample with averaging (good enough for speech). */
export function downsample(samples, rate, maxRate = 24000) {
  const factor = Math.max(1, Math.floor(rate / maxRate));
  if (factor === 1) return { samples, rate };
  const out = new Float32Array(Math.floor(samples.length / factor));
  for (let i = 0; i < out.length; i++) {
    let s = 0;
    for (let j = 0; j < factor; j++) s += samples[i * factor + j];
    out[i] = s / factor;
  }
  return { samples: out, rate: rate / factor };
}

/** 16-bit PCM mono WAV. */
export function encodeWav(samples, rate) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const x = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, x < 0 ? x * 0x8000 : x * 0x7fff, true);
  }
  return buf;
}

/** Trim, apply 5 ms fades, downsample. Returns { samples, rate, silent }. */
export function trimSamples(samples, rate) {
  const { start, end, silent } = findSpeechBounds(samples, rate);
  const cut = samples.slice(start, end);
  const fade = Math.min(Math.round(rate * 0.005), Math.floor(cut.length / 2));
  for (let i = 0; i < fade; i++) {
    const g = i / fade;
    cut[i] *= g;
    cut[cut.length - 1 - i] *= g;
  }
  const ds = downsample(cut, rate);
  return { ...ds, silent };
}

/* ---------- context and unlocking ---------- */

let ctx = null;
export function context() {
  if (!ctx) {
    const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AC) return null;
    try { ctx = new AC(); } catch { return null; }
  }
  return ctx;
}

/** Call synchronously inside a tap handler (Safari only unlocks audio from a user gesture). */
export function unlock() {
  const c = context();
  if (c) {
    if (c.state !== 'running') c.resume().catch(() => {});
    const b = c.createBuffer(1, 1, 22050);
    const s = c.createBufferSource();
    s.buffer = b;
    s.connect(c.destination);
    s.start(0);
  }
  const ss = globalThis.speechSynthesis;
  if (ss && !unlock.spoke) {
    try {
      const u = new SpeechSynthesisUtterance(' ');
      u.volume = 0;
      ss.speak(u);
      unlock.spoke = true;
    } catch { /* speech is optional */ }
  }
}

function decode(c, arrayBuffer) {
  // Callback form for older Safari; copy because decodeAudioData detaches the buffer.
  const copy = arrayBuffer.slice(0);
  return new Promise((resolve, reject) => {
    const p = c.decodeAudioData(copy, resolve, reject);
    if (p && p.then) p.then(resolve, reject);
  });
}

/* ---------- playing recordings ---------- */

const cache = new Map(); // id -> { updatedAt, buffer }
let current = null;

export function forget(id) { cache.delete(id); }

export function stop() {
  if (current) { try { current.stop(); } catch { /* already stopped */ } current = null; }
}

/** Play a stored recording { id, data, mime, updatedAt }. Resolves when playback ends. */
export async function playRecording(rec) {
  if (!rec) return;
  log({ type: 'sound', id: rec.id });
  stop();
  const c = context();
  if (c) {
    try {
      if (c.state !== 'running') await c.resume().catch(() => {});
      let entry = cache.get(rec.id);
      if (!entry || entry.updatedAt !== rec.updatedAt) {
        entry = { updatedAt: rec.updatedAt, buffer: await decode(c, rec.data) };
        cache.set(rec.id, entry);
      }
      const src = c.createBufferSource();
      src.buffer = entry.buffer;
      src.connect(c.destination);
      current = src;
      const ended = new Promise((resolve) => { src.onended = resolve; });
      src.start();
      await ended;
      if (current === src) current = null;
      return;
    } catch { /* fall back to an <audio> element below */ }
  }
  const url = URL.createObjectURL(new Blob([rec.data], { type: rec.mime }));
  const el = new Audio(url);
  try { await el.play(); await new Promise((r) => { el.onended = r; el.onerror = r; }); } catch { /* ignore */ }
  URL.revokeObjectURL(url);
}

/* ---------- tones (no audio files) ---------- */

export function tone(kind = 'happy') {
  log({ type: 'tone', kind });
  const c = context();
  if (!c) return;
  const notes = kind === 'done' ? [523.25, 659.25, 783.99] : kind === 'soft' ? [587.33] : [523.25, 783.99];
  const t0 = c.currentTime + 0.02;
  notes.forEach((f, i) => {
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = 'sine';
    o.frequency.value = f;
    const t = t0 + i * 0.12;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.18, t + 0.03);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.45);
    o.connect(g);
    g.connect(c.destination);
    o.start(t);
    o.stop(t + 0.5);
  });
}

/* ---------- whole words only ---------- */

/**
 * Whole-word speech: the TV wrapper's bridge (Android WebView has no speechSynthesis) if present,
 * else the Web Speech API, else nothing (speech is optional and never throws).
 */
export function speakWord(word, enabled = true) {
  if (!enabled) return;
  const bridge = globalThis.FirstSoundsTV;
  if (bridge && typeof bridge.speak === 'function') {
    log({ type: 'word', word, via: 'tv' });
    try { bridge.speak(String(word)); } catch { /* speech is optional */ }
    return;
  }
  const ss = globalThis.speechSynthesis;
  if (!ss || !globalThis.SpeechSynthesisUtterance) return;
  log({ type: 'word', word });
  try {
    ss.cancel();
    const u = new SpeechSynthesisUtterance(word);
    u.rate = 0.8;
    u.lang = 'en';
    ss.speak(u);
  } catch { /* speech is optional */ }
}

/* ---------- recording ---------- */

export function recordingSupport() {
  if (!globalThis.isSecureContext) return 'insecure';
  if (!globalThis.navigator || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return 'unsupported';
  if (!globalThis.MediaRecorder) return 'unsupported';
  return 'ok';
}

/** Feature-detect the container: Safari gives audio/mp4, Chrome/Firefox webm or ogg. */
export function pickMimeType() {
  const MR = globalThis.MediaRecorder;
  if (!MR || typeof MR.isTypeSupported !== 'function') return '';
  const options = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];
  return options.find((t) => { try { return MR.isTypeSupported(t); } catch { return false; } }) || '';
}

export function micErrorKind(err) {
  const name = err && err.name;
  if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') return 'denied';
  if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'DevicesNotFoundError') return 'nomic';
  if (name === 'NotReadableError') return 'busy';
  return 'error';
}

/** Starts recording. Resolves to { mime, stop(): Promise<{ data: ArrayBuffer, mime }> }. Rejects with err.kind set. */
export async function startRecording() {
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (e) {
    const err = new Error(e && e.message ? e.message : 'Microphone unavailable');
    err.kind = micErrorKind(e);
    throw err;
  }
  const mime = pickMimeType();
  let rec;
  try {
    rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  } catch (e) {
    stream.getTracks().forEach((t) => t.stop());
    const err = new Error(e.message);
    err.kind = 'unsupported';
    throw err;
  }
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  const finished = new Promise((resolve, reject) => {
    rec.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      const type = rec.mimeType || mime || 'audio/mp4';
      const blob = new Blob(chunks, { type });
      resolve({ data: await blob.arrayBuffer(), mime: type });
    };
    rec.onerror = (e) => { stream.getTracks().forEach((t) => t.stop()); reject(e.error || e); };
  });
  rec.start();
  log({ type: 'record-start', mime: rec.mimeType || mime });
  return {
    mime: rec.mimeType || mime,
    stop() { if (rec.state !== 'inactive') rec.stop(); return finished; },
  };
}

/**
 * Decode with Web Audio, mix to mono, trim leading/trailing silence and store as WAV.
 * If decoding fails the original bytes are kept untrimmed (trimmed: false).
 */
export async function processRecording({ data, mime }) {
  const c = context();
  if (c) {
    try {
      const audioBuf = await decode(c, data);
      const len = audioBuf.length;
      const mono = new Float32Array(len);
      for (let ch = 0; ch < audioBuf.numberOfChannels; ch++) {
        const d = audioBuf.getChannelData(ch);
        for (let i = 0; i < len; i++) mono[i] += d[i] / audioBuf.numberOfChannels;
      }
      const t = trimSamples(mono, audioBuf.sampleRate);
      return {
        data: encodeWav(t.samples, t.rate),
        mime: 'audio/wav',
        durationMs: Math.round((t.samples.length / t.rate) * 1000),
        originalMs: Math.round((len / audioBuf.sampleRate) * 1000),
        trimmed: true,
        silent: t.silent,
      };
    } catch { /* keep the original below */ }
  }
  return { data, mime, durationMs: null, trimmed: false, silent: false };
}
