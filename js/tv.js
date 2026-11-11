// TV mode: the child's games on a television, played with the remote (D-pad, OK, Back).
// On when the URL has ?tv=1 (remembered on this device; ?tv=0 forgets it) or when the Android TV
// wrapper's bridge window.FirstSoundsTV exists. Outside TV mode nothing here changes the iPad:
// only the arrow keys move focus on the child screens (harmless on a laptop).
//
// Bridge contract (see README):
//   window.FirstSoundsTV.speak(text)  optional, provided by the wrapper: whole-word speech
//   window.FirstSoundsTV_onBack()     provided here: true = handled, false = let Android exit

import * as audio from './audio.js';

const STORE_KEY = 'first-sounds-tv';

/** Pure: is TV mode on? `stored` is the remembered flag; returns { tv, remember } (remember: true/false/null = leave). */
export function tvMode(search, hasBridge, stored) {
  const p = new URLSearchParams(search || '');
  const q = p.get('tv');
  if (q === '1') return { tv: true, remember: true };
  if (q === '0') return { tv: !!hasBridge, remember: false };
  return { tv: !!hasBridge || !!stored, remember: null };
}

function detect() {
  if (typeof location === 'undefined') return false;
  let stored = false;
  try { stored = localStorage.getItem(STORE_KEY) === '1'; } catch { /* storage blocked */ }
  const r = tvMode(location.search, !!globalThis.FirstSoundsTV, stored);
  try {
    if (r.remember === true) localStorage.setItem(STORE_KEY, '1');
    if (r.remember === false) localStorage.removeItem(STORE_KEY);
  } catch { /* storage blocked: the URL still works */ }
  return r.tv;
}

export const TV = detect();
if (TV && typeof document !== 'undefined') document.documentElement.classList.add('tv');

/* ---------- spatial navigation ---------- */

const FOCUSABLE = 'button, [tabindex]:not([tabindex="-1"]), input:not([type="hidden"]), select, textarea, a[href], summary';

/** Focusable, enabled and visible (not hidden, not inside a closed <details>, not zero-sized). */
export function usable(el) {
  if (!el || !el.isConnected || el.disabled || el.matches?.(':disabled')) return false;
  if (el.closest('[hidden], [inert]')) return false;
  if (!el.getClientRects().length) return false;
  const b = el.getBoundingClientRect();
  if (b.width < 2 || b.height < 2) return false;
  return getComputedStyle(el).visibility !== 'hidden';
}

function root() { return document.getElementById('app'); }

export function focusables(r = root()) {
  return r ? [...r.querySelectorAll(FOCUSABLE)].filter(usable) : [];
}

const center = (r) => ({ x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2 });
const gap = (a1, a2, b1, b2) => Math.max(0, b1 - a2, a1 - b2); // distance between two intervals

/**
 * Pure: the index of the best candidate rect in direction dir ('up'|'down'|'left'|'right') from rect a,
 * or -1. A candidate must lie that way (centre and near edge beyond a's); nearer wins, and lining up
 * on the other axis matters twice as much as distance.
 */
export function bestCandidate(dir, a, rects) {
  const ac = center(a);
  let best = -1;
  let bestScore = Infinity;
  rects.forEach((b, i) => {
    const bc = center(b);
    let ok;
    let primary;
    let ortho;
    let off;
    if (dir === 'right') { ok = bc.x > ac.x + 1 && b.left > a.left + 1; primary = Math.max(0, b.left - a.right); ortho = gap(a.top, a.bottom, b.top, b.bottom); off = Math.abs(bc.y - ac.y); }
    else if (dir === 'left') { ok = bc.x < ac.x - 1 && b.right < a.right - 1; primary = Math.max(0, a.left - b.right); ortho = gap(a.top, a.bottom, b.top, b.bottom); off = Math.abs(bc.y - ac.y); }
    else if (dir === 'down') { ok = bc.y > ac.y + 1 && b.top > a.top + 1; primary = Math.max(0, b.top - a.bottom); ortho = gap(a.left, a.right, b.left, b.right); off = Math.abs(bc.x - ac.x); }
    else { ok = bc.y < ac.y - 1 && b.bottom < a.bottom - 1; primary = Math.max(0, a.top - b.bottom); ortho = gap(a.left, a.right, b.left, b.right); off = Math.abs(bc.x - ac.x); }
    if (!ok) return;
    const score = primary + 2 * ortho + 0.25 * off;
    if (score < bestScore) { bestScore = score; best = i; }
  });
  return best;
}

/** The element focus should start on: [data-autofocus], else the first choice, else the first focusable. */
export function defaultTarget(r = root()) {
  if (!r) return null;
  const marked = [...r.querySelectorAll('[data-autofocus]')].find(usable);
  if (marked) return marked;
  const choice = [...r.querySelectorAll('.choice')].find(usable);
  if (choice) return choice;
  const all = focusables(r);
  return all.find((el) => el.dataset.hold == null) || all[0] || null; // the parent gate last
}

function focusEl(el) {
  if (!el) return false;
  const child = document.body.dataset.mode === 'child';
  el.focus({ preventScroll: child });
  if (!child && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
  return document.activeElement === el;
}

export function focusDefault() { return focusEl(defaultTarget()); }

function current() {
  const a = document.activeElement;
  return a && a !== document.body && root()?.contains(a) && usable(a) ? a : null;
}

/** Parent pages on TV scroll inside .screen.parent; elsewhere the document scrolls. */
function scroller() {
  return document.querySelector('#app > .screen.parent') || document.scrollingElement || document.documentElement;
}

function viewRect(sc) {
  if (sc === document.scrollingElement || sc === document.documentElement) return { top: 0, bottom: innerHeight, left: 0, right: innerWidth };
  return sc.getBoundingClientRect();
}

/** Moves focus one step in dir. On parent pages, Up/Down scroll when there is nothing to focus nearby. */
export function move(dir) {
  const cur = current();
  if (!cur) return focusDefault();
  const override = cur.__nav && cur.__nav[dir];
  if (override && usable(override)) return focusEl(override);
  const parentPage = document.body.dataset.mode !== 'child';
  const sc = parentPage ? scroller() : null;
  const view = sc ? viewRect(sc) : null;
  let a = cur.getBoundingClientRect();
  const curVisible = !view || (a.bottom > view.top && a.top < view.bottom);
  if (view && !curVisible && (dir === 'up' || dir === 'down')) {
    // Focus was scrolled away: look from the edge of what is on screen.
    const y = dir === 'down' ? view.top : view.bottom;
    a = { left: view.left, right: view.right, top: y - 1, bottom: y };
  }
  // [data-nav-explicit] (the picture speakers) is reached only through its own __nav link.
  const list = focusables().filter((el) => el !== cur && !cur.contains(el) && !el.contains(cur) && el.dataset.navExplicit == null);
  const rects = list.map((el) => el.getBoundingClientRect());
  const i = bestCandidate(dir, a, rects);
  if (!parentPage || dir === 'left' || dir === 'right') return i >= 0 ? focusEl(list[i]) : false; // clamp at the edges
  const step = Math.max(80, (view.bottom - view.top) * 0.6);
  if (i >= 0) {
    const b = rects[i];
    const onScreen = b.bottom > view.top && b.top < view.bottom;
    const near = dir === 'down' ? b.top - view.bottom < step : view.top - b.bottom < step;
    if (onScreen || near) return focusEl(list[i]);
  }
  const before = sc.scrollTop;
  sc.scrollBy({ top: dir === 'down' ? step : -step, behavior: 'auto' });
  return sc.scrollTop !== before;
}

/* ---------- keys ---------- */

const KEYCODE = { 37: 'ArrowLeft', 38: 'ArrowUp', 39: 'ArrowRight', 40: 'ArrowDown', 13: 'Enter', 23: 'Enter', 66: 'Enter', 27: 'Escape', 8: 'Backspace', 4: 'GoBack', 166: 'BrowserBack' };
const DIR = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };
const BACK = new Set(['Escape', 'Backspace', 'GoBack', 'BrowserBack']);

export function keyOf(e) {
  if (e.code === 'NumpadEnter') return 'Enter';
  if (e.key === ' ' || e.code === 'Space') return ' ';
  if (e.key && e.key !== 'Unidentified') return e.key;
  return KEYCODE[e.keyCode] || '';
}

/** OK (Enter, NumpadEnter or space) for buttons and other controls. */
export function isOK(e) { const k = keyOf(e); return k === 'Enter' || k === ' '; }

const isText = (el) => !!el && (el.matches('textarea, [contenteditable=""], [contenteditable="true"]')
  || (el.matches('input') && !['checkbox', 'radio', 'range', 'button', 'submit', 'reset', 'file', 'color'].includes(el.type)));

function activate(el) {
  if (el.dataset.hold != null) return false; // the parent gate: hold, not press (js/ui.js)
  if (isText(el) || el.matches('select, input[type="range"], input[type="file"]')) return false;
  el.click();
  return true;
}

/** Back, as the wrapper's onBack and the Escape/Backspace keys: true = handled. */
export function back(app) {
  if (!app || !document.body.dataset.ready || document.body.dataset.ready === 'error') return false;
  if (app.session) {
    // A toddler cannot leave a game by accident. "All done" goes back home (never out of the app).
    if (document.querySelector('#app [data-screen="done"]')) app.go('home');
    return true;
  }
  if (app.screen === 'home') return false;
  if (app.screen === 'tracker' || app.screen === 'progress' || app.screen === 'settings') app.go('parentMenu');
  else app.go('home');
  return true;
}

export function install(app) {
  if (TV) {
    globalThis.FirstSoundsTV_onBack = () => {
      try { return back(app) === true; } catch { return !!app.session; }
    };
    // Audio unlock from the remote: the first gesture is a key press, not a tap.
    window.addEventListener('keydown', () => {
      try { const c = audio.context(); if (!c || c.state !== 'running') audio.unlock(); } catch { /* sound is optional */ }
    }, true);
    // Focus is never lost: if it drops to the page (an element went away or was disabled), put it back.
    document.addEventListener('focusout', () => {
      setTimeout(() => {
        const a = document.activeElement;
        if ((!a || a === document.body) && document.hasFocus()) focusDefault();
      }, 0);
    });
  }

  document.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
    const key = keyOf(e);
    const target = e.target instanceof Element ? e.target : null;
    const child = document.body.dataset.mode === 'child';
    const dir = DIR[key];
    if (!TV) {
      // Outside TV mode: only the arrow keys on the child screens.
      if (!dir || !child) return;
      e.preventDefault();
      move(dir);
      return;
    }
    if (BACK.has(key)) {
      if (key === 'Backspace' && isText(target)) return;
      e.preventDefault();
      back(app);
      return;
    }
    if (dir) {
      const el = current();
      if (el && isText(el) && (dir === 'left' || dir === 'right')) {
        // Left/Right move the caret, and leave the field at its ends.
        const atEdge = dir === 'left' ? el.selectionStart === 0 && el.selectionEnd === 0
          : el.selectionStart === el.value.length;
        if (!atEdge) return;
      }
      if (el && el.matches('input[type="range"]') && (dir === 'left' || dir === 'right')) return;
      if (el && el.matches('select') && (dir === 'left' || dir === 'right')) {
        e.preventDefault();
        const n = el.selectedIndex + (dir === 'left' ? -1 : 1);
        if (n >= 0 && n < el.options.length) { el.selectedIndex = n; el.dispatchEvent(new Event('change', { bubbles: true })); }
        return;
      }
      e.preventDefault();
      move(dir);
      return;
    }
    if (key === 'Enter' || key === ' ') {
      const el = current();
      if (!el) { e.preventDefault(); focusDefault(); return; }
      if (el.dataset.hold != null || isText(el) || el.matches('select')) return;
      e.preventDefault(); // one press is one activation: a held OK does not repeat
      if (e.repeat) return;
      activate(el);
    }
  });
  // A button clicks on space keyup natively: on the TV that is done on keydown (and a keyup after the
  // gate opened must not press whatever has focus next).
  document.addEventListener('keyup', (e) => {
    if (TV && keyOf(e) === ' ' && !isText(e.target instanceof Element ? e.target : null)) e.preventDefault();
  });
}
