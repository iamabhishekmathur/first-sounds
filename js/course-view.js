// The Learning path screen (parent area; read-only on the TV too) and its compact version at the top
// of the Tracker. It only renders: every figure comes from js/course.js.

import { h } from './ui.js';
import { page, storageNotices } from './parent.js';
import { learningPath } from './course.js';
import { TV } from './tv.js';

const STATUS_TEXT = { done: 'done', doing: 'in progress', todo: 'not yet', later: 'coming later' };
const STATUS_MARK = { done: '✓', doing: '●', todo: '○', later: '🔒' };

export function pathFor(app) {
  return learningPath({
    data: app.data, reading: app.reading && app.reading.data, progress: app.progress, recorded: app.recorded(),
    readiness: app.readiness, override: app.blendOverride, tv: TV,
  });
}

function bar(b) {
  const pct = b.total ? Math.round((Math.min(b.value, b.total) / b.total) * 100) : 0;
  const numbers = b.override ? 'turned on by you' : b.total ? `${b.value} of ${b.total}${b.unit ? ` ${b.unit}` : ''}` : 'no words yet';
  return h('div', { class: 'lp-bar', 'data-testid': 'lp-bar' },
    h('div', { class: 'lp-bar-head' }, h('span', {}, b.label), h('strong', { 'data-testid': 'lp-numbers' }, numbers)),
    h('div', {
      class: `lp-track${b.override ? ' override' : ''}`, role: 'progressbar', 'aria-label': b.label,
      'aria-valuemin': '0', 'aria-valuemax': String(b.total || 0), 'aria-valuenow': String(b.override ? b.total : b.value),
    }, h('span', { class: 'lp-fill', style: `width:${b.override ? 100 : pct}%` })),
    b.practised ? h('p', { class: 'lp-note' }, `Also ${b.practised} word${b.practised === 1 ? '' : 's'} without a picture practised (these have no picture check, so they do not become solid).`) : null,
    null);
}

function milestone(m, i) {
  return h('li', { class: `lp-step ${m.status}${m.current ? ' current' : ''}`, 'data-testid': `lp-${m.id}`, 'data-status': m.status },
    h('span', { class: 'lp-marker', 'aria-hidden': 'true' }, m.status === 'later' ? STATUS_MARK.later : m.status === 'done' ? STATUS_MARK.done : String(i + 1)),
    h('div', { class: 'lp-body' },
      h('div', { class: 'lp-title' }, h('h2', {}, m.title), h('span', { class: `lp-chip ${m.status}`, 'data-testid': 'lp-status' }, STATUS_TEXT[m.status]), m.current ? h('span', { class: 'lp-here' }, 'you are here') : null),
      m.bars.map(bar),
      h('p', { class: 'lp-text' }, m.text)));
}

export function pathView(app) {
  const p = pathFor(app);
  const rd = app.reading && app.reading.report;
  page('path', 'Learning path', { back: { label: 'Parent area', go: () => app.go('parentMenu') } },
    ...storageNotices(app),
    h('div', { class: 'lp-now p-card', 'data-testid': 'lp-now' },
      h('p', { class: 'lp-now-where' }, p.now),
      h('p', { class: 'lp-next', 'data-testid': 'lp-next' }, p.next)),
    h('ol', { class: 'lp-path', 'data-testid': 'learning-path' }, p.milestones.map(milestone)),
    rd && !rd.ok ? h('p', { class: 'p-muted', 'data-testid': 'lp-reading-missing' }, `Reading words: ${rd.errors[0]}`) : null,
    h('p', { class: 'p-muted' }, 'The path is a guide, not a race. Short, happy sessions matter more than speed.'));
}

/** The compact path for the top of the Tracker: one row of steps, the next step, and a link. */
export function compactPath(app) {
  const p = pathFor(app);
  const steps = p.milestones.map((m) => {
    const b = m.bars[0];
    const sum = m.bars.reduce((a, x) => ({ value: a.value + x.value, total: a.total + x.total }), { value: 0, total: 0 });
    const nums = m.status === 'later' ? 'later' : b && b.override ? 'on' : sum.total ? `${sum.value}/${sum.total}` : '–';
    return h('li', { class: `lpc-step ${m.status}${m.current ? ' current' : ''}`, 'data-testid': `lpc-${m.id}`, 'data-status': m.status, title: `${m.title}: ${STATUS_TEXT[m.status]}` },
      h('span', { class: 'lpc-mark', 'aria-hidden': 'true' }, STATUS_MARK[m.status]),
      h('span', { class: 'lpc-name' }, m.title),
      h('span', { class: 'lpc-nums' }, nums),
      h('span', { class: 'sr-only' }, `, ${STATUS_TEXT[m.status]}`));
  });
  return h('section', { class: 'p-card lpc', 'data-testid': 'path-compact' },
    h('div', { class: 'tk-head' }, h('h2', {}, 'Learning path'),
      h('button', { class: 'p-btn', type: 'button', 'data-testid': 'open-path', onclick: () => app.go('path') }, 'See the whole path')),
    h('ol', { class: 'lpc-steps' }, steps),
    h('p', { class: 'lpc-next', 'data-testid': 'lpc-next' }, h('strong', {}, p.now), ' ', p.next));
}
