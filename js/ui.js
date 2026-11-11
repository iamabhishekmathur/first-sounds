// Tiny DOM helpers shared by the screens.

import { TV, focusDefault, isOK } from './tv.js';

export function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === false || v == null) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = !!v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

export function mount(el) {
  const root = document.getElementById('app');
  root.replaceChildren(el);
  root.scrollTop = 0;
  window.scrollTo(0, 0);
  if (TV) focusDefault(); // on the TV, focus always starts on the screen's first choice or button
}

/** 'child' screens lock scrolling, selection and zoom; 'parent' screens scroll normally. */
export function setMode(mode) {
  document.body.dataset.mode = mode;
}

const ICONS = {
  speaker: '<svg viewBox="0 0 48 48" aria-hidden="true"><path d="M8 18h8l11-9v30l-11-9H8z" fill="currentColor"/><path d="M33 16a10 10 0 0 1 0 16M37 11a17 17 0 0 1 0 26" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round"/></svg>',
  play: '<svg viewBox="0 0 48 48" aria-hidden="true"><path d="M16 9l25 15-25 15z" fill="currentColor" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/></svg>',
  gear: '<svg viewBox="0 0 48 48" aria-hidden="true"><circle cx="24" cy="24" r="7" fill="none" stroke="currentColor" stroke-width="4"/><path d="M24 5v6M24 37v6M5 24h6M37 24h6M10.6 10.6l4.2 4.2M33.2 33.2l4.2 4.2M10.6 37.4l4.2-4.2M33.2 14.8l4.2-4.2" stroke="currentColor" stroke-width="4" stroke-linecap="round"/></svg>',
  arrow: '<svg viewBox="0 0 96 32" aria-hidden="true"><path d="M6 16h78M70 5l14 11-14 11" fill="none" stroke="currentColor" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

export function icon(name) {
  return h('span', { class: `icon icon-${name}`, html: ICONS[name] });
}

/**
 * Parent gate: press and hold for `ms`. A ring fills while held; letting go early cancels.
 * Toddlers tap; they rarely hold still on one small spot for two seconds.
 * On the TV it is 3 seconds, and holding OK on the remote works too (keydown with no keyup).
 */
export function holdGate(onOpen, ms = TV ? 3000 : 2000) {
  const ring = '<svg viewBox="0 0 64 64" aria-hidden="true" class="gate-ring"><circle cx="32" cy="32" r="28"/></svg>';
  const secs = Math.round(ms / 1000);
  const btn = h('button', {
    class: 'gate', type: 'button', 'data-testid': 'gate',
    'aria-label': TV ? `Parent area: hold OK for ${secs} seconds` : `Parent area: press and hold for ${secs} seconds`,
    style: `--hold:${ms}ms`,
  }, h('span', { html: ring }), icon('gear'));
  let timer = null;
  const cancel = () => { clearTimeout(timer); timer = null; btn.classList.remove('holding'); };
  const begin = () => {
    if (timer) return;
    btn.classList.add('holding');
    timer = setTimeout(() => { timer = null; btn.classList.remove('holding'); onOpen(); }, ms);
  };
  btn.addEventListener('pointerdown', (e) => { e.preventDefault(); begin(); });
  for (const t of ['pointerup', 'pointercancel', 'pointerleave']) btn.addEventListener(t, cancel);
  btn.addEventListener('contextmenu', (e) => e.preventDefault());
  btn.addEventListener('click', (e) => e.preventDefault());
  if (TV) {
    btn.dataset.hold = '';
    btn.addEventListener('keydown', (e) => {
      if (!isOK(e)) return;
      e.preventDefault();
      if (!e.repeat) begin(); // a remote may repeat keydown while OK is held: the first one starts the hold
    });
    btn.addEventListener('keyup', (e) => { if (isOK(e)) { e.preventDefault(); cancel(); } });
    btn.addEventListener('blur', cancel);
  }
  return btn;
}

export function notice(kind, ...kids) {
  return h('div', { class: `notice notice-${kind}`, role: kind === 'error' ? 'alert' : 'status' }, ...kids);
}
