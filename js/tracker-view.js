// The parent's Tracker screen. It only renders: every figure comes from js/tracker.js.
// Charts are small inline SVGs drawn here, with text labels and a table view, so nothing is colour-only.

import { h, notice } from './ui.js';
import { page, storageNotices, MODE_LABEL, notTargetReason } from './parent.js';
import { canPlay, MIN_WORDS_FOR_MODE } from './logic.js';
import { TV } from './tv.js';
import {
  summary, dailySeries, solidOverTime, recentSessions, soundRows, sortRows, SORTS, mixUps,
  recordingStatus, shortDay, relativeDay, lengthText,
} from './tracker.js';

const STATUS_LABEL = { not_started: 'not started', learning: 'learning', solid: 'solid' };
const STAGE_NAME = { 1: 'Hear it', 2: 'See it' };
const pct = (x) => (x == null ? '–' : `${Math.round(x * 100)}%`);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

let sortBy = 'attention'; // kept while the app is open

/* ---------- charts (inline SVG) ---------- */

const W = 600;
const H = 190;
const M = { l: 36, r: 12, t: 16, b: 28 };
const PW = W - M.l - M.r;
const PH = H - M.t - M.b;

function niceMax(v) {
  if (v <= 4) return 4;
  const steps = [5, 10, 20, 25, 50, 100, 200, 500];
  return steps.find((s) => s >= v) || Math.ceil(v / 100) * 100;
}

/** x labels: the first day, every 7th day back from today, and "today". */
function xLabels(days, x) {
  const out = [];
  for (let i = days.length - 1; i >= 0; i -= 7) {
    const label = i === days.length - 1 ? 'today' : shortDay(days[i].d);
    out.push(`<text class="tk-ax" x="${x(i)}" y="${H - 8}" text-anchor="${i === days.length - 1 ? 'end' : 'middle'}">${esc(label)}</text>`);
  }
  return out.join('');
}

function frame(yTicks, y, fmt) {
  return yTicks.map((v) => `<line class="tk-grid" x1="${M.l}" x2="${W - M.r}" y1="${y(v)}" y2="${y(v)}"/>`
    + `<text class="tk-ax" x="${M.l - 6}" y="${y(v) + 4}" text-anchor="end">${esc(fmt(v))}</text>`).join('');
}

function svg(label, body, testid) {
  return h('figure', { class: 'tk-chart', 'data-testid': testid },
    h('div', { class: 'tk-svg', html: `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}">${body}</svg>` }));
}

function roundsChart(series) {
  const max = niceMax(Math.max(...series.map((d) => d.rounds)));
  const band = PW / series.length;
  const x = (i) => M.l + band * i + band / 2;
  const y = (v) => M.t + PH - (v / max) * PH;
  const bw = Math.max(4, band - 5);
  const bars = series.map((d, i) => {
    if (!d.rounds) return `<rect class="tk-hit" x="${x(i) - band / 2}" y="${M.t}" width="${band}" height="${PH}"><title>${esc(`${shortDay(d.d)}: no play`)}</title></rect>`;
    const top = y(d.rounds);
    const hgt = M.t + PH - top;
    const r = Math.min(4, bw / 2, hgt);
    // A bar with rounded top corners, square at the baseline.
    const path = `M${x(i) - bw / 2},${M.t + PH}V${top + r}Q${x(i) - bw / 2},${top} ${x(i) - bw / 2 + r},${top}H${x(i) + bw / 2 - r}Q${x(i) + bw / 2},${top} ${x(i) + bw / 2},${top + r}V${M.t + PH}Z`;
    return `<g><path class="tk-bar" d="${path}"/><rect class="tk-hit" x="${x(i) - band / 2}" y="${M.t}" width="${band}" height="${PH}"><title>${esc(`${shortDay(d.d)}: ${plural(d.rounds, 'round')}, ${d.correct} right first time`)}</title></rect></g>`;
  }).join('');
  return svg('Rounds played per day, last 30 days', frame([0, max / 2, max], y, (v) => String(v)) + bars + xLabels(series, x), 'chart-rounds');
}

function accuracyChart(series) {
  const band = PW / series.length;
  const x = (i) => M.l + band * i + band / 2;
  const y = (v) => M.t + PH - v * PH;
  const pts = series.map((d, i) => ({ ...d, i })).filter((d) => d.acc != null);
  const line = pts.length > 1 ? `<polyline class="tk-line" points="${pts.map((p) => `${x(p.i)},${y(p.acc)}`).join(' ')}"/>` : '';
  const dots = pts.map((p) => `<g><circle class="tk-dot" cx="${x(p.i)}" cy="${y(p.acc)}" r="5"/><rect class="tk-hit" x="${x(p.i) - band / 2}" y="${M.t}" width="${band}" height="${PH}"><title>${esc(`${shortDay(p.d)}: ${pct(p.acc)} right first time (${p.correct} of ${p.rounds})`)}</title></rect></g>`).join('');
  const lastP = pts[pts.length - 1];
  const tag = lastP ? `<text class="tk-val" x="${Math.min(x(lastP.i), W - M.r)}" y="${Math.max(M.t + 10, y(lastP.acc) - 10)}" text-anchor="end">${esc(pct(lastP.acc))}</text>` : '';
  return svg('First-try accuracy per day, last 30 days', frame([0, 0.5, 1], y, (v) => `${v * 100}%`) + line + dots + tag + xLabels(series, x), 'chart-accuracy');
}

function solidChart(series, total) {
  const max = Math.max(4, total);
  const GUT = 74; // right gutter for the direct labels
  const band = (PW - GUT) / series.length;
  const x = (i) => M.l + band * i + band / 2;
  const y = (v) => M.t + PH - (v / max) * PH;
  const step = (key) => series.map((d, i) => `${i ? `H${x(i)}V` : `M${x(i)},`}${y(d[key])}`).join('');
  const last = series[series.length - 1];
  const hits = series.map((d, i) => `<rect class="tk-hit" x="${x(i) - band / 2}" y="${M.t}" width="${band}" height="${PH}"><title>${esc(`${shortDay(d.d)}: ${d.s1} solid in Hear it, ${d.s2} solid in See it`)}</title></rect>`).join('');
  // Direct labels right of the line ends; nudged apart when the two lines end close together.
  let y1;
  let y2;
  y1 = y(last.s1) + 4;
  y2 = y(last.s2) + 4;
  if (Math.abs(y1 - y2) < 15) { if (last.s1 >= last.s2) y2 = y1 + 15; else y1 = y2 + 15; }
  const lx = x(series.length - 1) + 8;
  const labels = `<text class="tk-val" x="${lx}" y="${Math.max(M.t + 4, y1)}">Hear it ${last.s1}</text>`
    + `<text class="tk-val" x="${lx}" y="${Math.min(M.t + PH + 10, Math.max(M.t + 4, y2))}">See it ${last.s2}</text>`;
  const ticks = [0, Math.round(max / 2), max];
  return svg(`Solid sounds over the last 30 days, out of ${total} game targets`,
    frame(ticks, y, (v) => String(v))
    + `<path class="tk-step s1" d="${step('s1')}"/><path class="tk-step s2" d="${step('s2')}"/>`
    + labels + hits + xLabels(series, x), 'chart-solid');
}

/* ---------- sections ---------- */

function stat(label, value, sub, testid) {
  return h('div', { class: 'tk-stat', 'data-testid': testid }, h('span', { class: 'tk-stat-label' }, label), h('strong', {}, value), sub ? h('span', { class: 'tk-stat-sub' }, sub) : null);
}

function summarySection(app, sm) {
  const a = sm.acc7.acc;
  const b = sm.accPrev7.acc;
  let compare;
  if (a == null && b == null) compare = 'no play in the last 14 days';
  else if (a == null) compare = `no play this week (${pct(b)} the week before)`;
  else if (b == null) compare = `${plural(sm.acc7.rounds, 'round')}; no play the 7 days before`;
  else {
    const d = Math.round((a - b) * 100);
    compare = d === 0 ? `same as the 7 days before (${pct(b)})` : `${d > 0 ? 'up' : 'down'} from ${pct(b)} the 7 days before`;
  }
  const r = sm.readiness;
  const ready = r.tried === 0 ? 'not tried yet'
    : r.passedDays >= r.needed ? `passed on ${r.passedDays} days: ready for blending` : `passed on ${r.passedDays} of ${r.needed} days`;
  return h('div', { class: 'tk-stats', 'data-testid': 'tracker-summary' },
    stat('Days practised', `${sm.days7} of the last 7`, `${sm.days30} of the last 30`, 'stat-days'),
    stat('Sessions', sm.sessions ? `${plural(sm.sessions, 'session')}` : 'none yet',
      sm.sessions ? `${plural(sm.minutes, 'minute')} in all, since ${shortDay(sm.firstSession)}` : 'recorded from now on', 'stat-sessions'),
    stat('Right first time, last 7 days', pct(a), compare, 'stat-accuracy'),
    stat('Solid in Hear it', `${sm.solid[1].solid} of ${sm.solid[1].total} sounds`, `${sm.solid[1].learning} learning`, 'stat-solid-1'),
    stat('Solid in See it', `${sm.solid[2].solid} of ${sm.solid[2].total} sounds`, `${sm.solid[2].learning} learning`, 'stat-solid-2'),
    stat('Readiness check', ready, `needs a right answer on ${r.needed} separate days`, 'stat-readiness'));
}

function overTimeSection(app, series, solid, total) {
  const table = h('table', { class: 'p-table tk-small' },
    h('thead', {}, h('tr', {}, ['Date', 'Rounds', 'Right first time', 'Solid: Hear it', 'Solid: See it'].map((t) => h('th', {}, t)))),
    h('tbody', {}, series.map((d, i) => h('tr', {},
      h('td', {}, shortDay(d.d)), h('td', {}, String(d.rounds)), h('td', {}, d.rounds ? `${d.correct} (${pct(d.acc)})` : '–'),
      h('td', {}, String(solid[i].s1)), h('td', {}, String(solid[i].s2)))).reverse()));
  return h('section', { class: 'p-card', 'data-testid': 'tracker-time' },
    h('h2', {}, 'Over time'),
    h('div', { class: 'tk-charts' },
      h('div', {}, h('h3', {}, 'Rounds played per day'), roundsChart(series)),
      h('div', {}, h('h3', {}, 'Right first time per day'), accuracyChart(series)),
      h('div', {},
        h('h3', {}, `Solid sounds (of ${total} game targets)`),
        h('p', { class: 'tk-legend' },
          h('span', { class: 'tk-key s1' }), ' Hear it  ', h('span', { class: 'tk-key s2' }), ' See it (dashed)'),
        solidChart(solid, total))),
    h('details', { class: 'p-details' }, h('summary', {}, 'Show the numbers for each day'), table));
}

function stageText(stages) {
  return stages.length ? stages.map((s) => STAGE_NAME[s]).join(' + ') : '–';
}

function sessionsSection(app, list) {
  if (!list.length) {
    return h('section', { class: 'p-card', 'data-testid': 'tracker-sessions' },
      h('h2', {}, 'Sessions'),
      h('p', { class: 'p-muted' }, 'No sessions recorded yet. Each time your child taps Play, the session is recorded here (from this version of the app on). Earlier play still counts in the daily figures above.'));
  }
  return h('section', { class: 'p-card', 'data-testid': 'tracker-sessions' },
    h('h2', {}, 'Recent sessions'),
    h('div', { class: 'tk-scroll' }, h('table', { class: 'p-table' },
      h('thead', {}, h('tr', {}, ['Date', 'Time', 'Length', 'Stage', 'Rounds', 'Right first time'].map((t) => h('th', {}, t)))),
      h('tbody', {}, list.map((s) => h('tr', { 'data-session': s.id },
        h('td', {}, relativeDay(s.d, app.today()) || shortDay(s.d)), h('td', {}, `${s.part}, ${s.clock}`), h('td', {}, lengthText(s.minutes)),
        h('td', {}, stageText(s.stages)), h('td', {}, String(s.rounds)), h('td', {}, `${s.correct} of ${s.rounds}`)))))));
}

function trendCell(row) {
  if (!row.recent.length) return h('td', { class: 'p-muted' }, '–');
  const step = 9;
  const dots = row.recent.map((c, i) => `<circle cx="${5 + i * step}" cy="7" r="3.5" class="${c ? 'tk-ok' : 'tk-miss'}"/>`).join('');
  const word = row.trend || '';
  const arrow = { up: '↑ ', down: '↓ ', steady: '→ ' }[row.trend] || '';
  return h('td', {}, h('span', { class: 'tk-trend' },
    h('span', { class: 'tk-dots', html: `<svg viewBox="0 0 ${10 + (row.recent.length - 1) * step} 14" width="${10 + (row.recent.length - 1) * step}" height="14" role="img" aria-label="last ${row.recent.length} rounds in ${STAGE_NAME[row.focus]}: ${row.recent.filter(Boolean).length} right first time"><title>Last ${row.recent.length} rounds in ${STAGE_NAME[row.focus]} (filled: right first time)</title>${dots}</svg>` }),
    word ? h('small', {}, `${arrow}${word}`) : null));
}

function stageCell(row, st) {
  const x = row.stages[st];
  return h('td', { 'data-testid': `tk-s${st}-${row.id}` },
    h('span', { class: `chip ${x.status}` }, STATUS_LABEL[x.status]),
    x.last6.total ? h('small', { class: 'tk-last6', title: 'right first time in the last 6 rounds' }, ` ${x.last6.correct}/${x.last6.total}`) : null);
}

function soundsSection(app, rows) {
  const body = h('tbody', {});
  const fill = () => body.replaceChildren(...sortRows(rows, sortBy).map((r) => h('tr', { 'data-sound': r.id, class: r.target ? '' : 'tk-off' },
    h('td', {}, h('span', { class: 'p-g' }, r.grapheme), ' ', h('small', {}, r.say)),
    h('td', {}, String(r.group)),
    r.target
      ? [h('td', { 'data-testid': `tk-mode-${r.id}` }, r.mode === 'anywhere' ? 'anywhere' : MODE_LABEL[r.mode]), stageCell(r, 1), stageCell(r, 2)]
      : h('td', { colspan: '3', class: 'p-muted', 'data-testid': `tk-mode-${r.id}`, title: notTargetReason(r.counts) },
        `not a game target: ${plural(r.counts.anywhere, 'picture word')} with it (needs ${MIN_WORDS_FOR_MODE})`),
    h('td', {}, r.days ? String(r.days) : '–'),
    h('td', {}, r.last ? relativeDay(r.last, app.today()) : '–'),
    trendCell(r))));
  const select = h('select', {
    class: 'p-select', 'data-testid': 'tk-sort', 'aria-label': 'Order the sounds',
    onchange: (e) => { sortBy = e.target.value; fill(); },
  }, Object.entries(SORTS).map(([k, label]) => {
    const o = h('option', { value: k }, label);
    if (k === sortBy) o.selected = true;
    return o;
  }));
  fill();
  return h('section', { class: 'p-card', 'data-testid': 'tracker-sounds' },
    h('div', { class: 'tk-head' }, h('h2', {}, 'Sounds'), h('label', { class: 'p-label' }, 'Order ', select)),
    h('p', { class: 'p-sub' }, `Each stage shows its status and how many of the last 6 rounds were right first time. "Needs attention first" puts learning sounds with the lowest recent score at the top. Mode is where the sound is in the picture word (at least ${MIN_WORDS_FOR_MODE} words are needed).`),
    h('div', { class: 'tk-scroll' }, h('table', { class: 'p-table tk-sounds' },
      h('thead', {}, h('tr', {}, ['Sound', 'Group', 'Mode', 'Hear it', 'See it', 'Days', 'Last practised', 'Trend'].map((t) => h('th', {}, t)))),
      body)));
}

function soundName(app, id) {
  const s = app.data.sounds.find((x) => x.id === id);
  return s ? s.graphemes[0] : id;
}

function mixUpsSection(app, mx) {
  const say = (id) => { const s = app.data.sounds.find((x) => x.id === id); return s ? s.say : ''; };
  const what = (m) => (m.sound
    ? [h('span', { class: 'p-g' }, soundName(app, m.sound)), ' ', h('small', {}, `(${say(m.sound)})`)]
    : m.word ? [h('span', {}, `the ${m.word} picture`)] : [h('span', { class: 'p-g' }, m.grapheme)]);
  return h('section', { class: 'p-card', 'data-testid': 'tracker-mixups' },
    h('h2', {}, 'Mix-ups'),
    mx.list.length
      ? [
        h('p', { class: 'p-sub' }, 'The sound your child was looking for, and what they tapped instead. Practise these pairs out loud: say both sounds, slowly, and talk about how they feel different in your mouth.'),
        h('ol', { class: 'tk-mix' }, mx.list.map((m) => h('li', { 'data-testid': 'mixup' },
          h('span', { class: 'p-g' }, soundName(app, m.target)), ' ', h('small', {}, `(${say(m.target)})`),
          h('span', { class: 'tk-arrow', 'aria-label': 'mixed up with' }, ' → '),
          ...what(m),
          h('strong', { class: 'tk-count' }, ` ${m.count === 1 ? 'once' : `${m.count} times`}`),
          m.sound && m.examples.length ? h('small', { class: 'p-muted' }, ` (tapped ${m.examples.join(', ')})`) : null))),
      ]
      : h('p', { class: 'p-muted' }, 'No mix-ups recorded yet. When your child taps a wrong picture or letter, it is noted here (from this version of the app on), so you can see which sounds to practise together.'));
}

function recordingsSection(app) {
  const rs = recordingStatus(app.data, app.recordings);
  const chips = (ids) => h('span', { class: 'tk-chips' }, ids.map((id) => h('span', { class: 'tk-sound', 'data-sound': id }, soundName(app, id))));
  return h('section', { class: 'p-card', 'data-testid': 'tracker-recordings' },
    h('h2', {}, 'Recordings'),
    h('p', {}, `${rs.recorded} of ${rs.total} sounds recorded.`),
    rs.missingTargets.length ? h('p', { 'data-testid': 'tk-missing' }, 'Still to record (game targets): ', chips(rs.missingTargets)) : h('p', { class: 'p-muted' }, 'Every game target is recorded.'),
    rs.missingOther.length ? h('p', { class: 'p-muted' }, 'Not game targets yet, record when you like: ', chips(rs.missingOther)) : null,
    rs.untrimmed.length
      ? h('p', { 'data-testid': 'tk-untrimmed' }, 'Not trimmed (the silence around the sound could not be removed, so it may start late): ', chips(rs.untrimmed), '. Re-record these in the studio.')
      : null,
    TV
      ? h('p', { class: 'p-muted' }, 'Record and re-record on the iPad or laptop: the recordings come to this TV through sync.')
      : h('div', { class: 'p-actions' }, h('button', { class: 'p-btn', type: 'button', onclick: () => app.go('studio') }, 'Open the recording studio')));
}

function emptySection(app) {
  const playable = canPlay(app.data, app.recorded(), app.progress);
  return h('section', { class: 'p-card tk-empty', 'data-testid': 'tracker-empty' },
    h('h2', {}, 'Nothing played yet'),
    h('p', {}, 'Once your child has played, this page shows how often you practise, how many taps are right first time, which sounds are solid or still learning, and which sounds get mixed up.'),
    h('p', { class: 'p-muted' }, playable
      ? `Everything is ready: go back to the child screen and ${TV ? 'press OK on' : 'tap'} the big button together.`
      : TV ? 'First record the group 1 sounds on the iPad or laptop.' : 'First record the group 1 sounds in the recording studio.'),
    h('div', { class: 'p-actions' }, playable || TV
      ? h('button', { class: 'p-btn primary', type: 'button', onclick: () => app.go('home') }, 'Back to the child screen')
      : h('button', { class: 'p-btn primary', type: 'button', onclick: () => app.go('studio') }, 'Open the recording studio')));
}

export function trackerView(app) {
  const today = app.today();
  const sm = summary({ data: app.data, progress: app.progress, sessions: app.sessions, readiness: app.readiness, today });
  const back = { label: 'Parent area', go: () => app.go('parentMenu') };
  if (!sm.hasPlay) {
    page('tracker', 'Tracker', { back }, ...storageNotices(app), emptySection(app), recordingsSection(app));
    return;
  }
  const series = dailySeries(app.progress, app.sessions, today, 30);
  const solid = solidOverTime(app.data, app.progress, today, 30);
  page('tracker', 'Tracker', { back },
    ...storageNotices(app),
    sm.readiness.passedDays >= sm.readiness.needed ? notice('good', `Passed the readiness check on ${sm.readiness.passedDays} different days: your child may be ready for blending (a later version).`) : null,
    summarySection(app, sm),
    overTimeSection(app, series, solid, sm.solid[1].total),
    sessionsSection(app, recentSessions(app.sessions, 10)),
    soundsSection(app, soundRows(app.data, app.progress, app.recorded())),
    mixUpsSection(app, mixUps(app.progress, 8)),
    recordingsSection(app));
}
