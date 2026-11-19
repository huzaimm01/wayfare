import { h, fmtClock, minsUntil, setText } from './util.js';
import { fetchDepartures, matches } from './data.js';
import { getPosition, walkMinutes } from './geo.js';
import { REFRESH_MS, TTC_SURFACE_COLOR } from './config.js';
import { errorText } from './board.js';

export function mountLeave(ctx) {
  const { state, root, header } = ctx;
  const t = state.target;
  root.className = 'top';
  setText(header.title, 'Leave by');
  header.titleBtn.onclick = header.dirBtn.onclick = null;
  if (!t) {
    ctx.setPalette(TTC_SURFACE_COLOR); setText(header.dir, '·');
    root.replaceChildren(h('div', { class: 'empty' }, h('p', { class: 'lead' }, 'Pick a station or stop first, then come back here.'),
      h('button', { class: 'btn', type: 'button', onclick: () => ctx.navigate('board') }, 'Go to the board')));
    return { unmount() {} };
  }
  ctx.setPalette(t.color || TTC_SURFACE_COLOR);
  setText(header.dir, t.dir || '·');

  let deps = [], err = null, walk = null, locNote = '', walkAuto = false;
  const walkIn = h('input', { class: 'field small', type: 'number', min: '0', max: '120', inputmode: 'numeric', 'aria-label': 'Walking minutes', oninput: () => { walk = walkIn.value === '' ? null : Math.max(0, Number(walkIn.value)); walkAuto = false; draw(); } });
  const spareIn = h('input', { class: 'field small', type: 'number', min: '0', max: '30', value: '2', inputmode: 'numeric', 'aria-label': 'Spare minutes', oninput: draw });
  const noteEl = h('p', { class: 'note small' });
  const list = h('ul', { class: 'list leave' });
  const locBtn = h('button', { class: 'btn', type: 'button', onclick: useLocation }, 'Use my location');
  root.replaceChildren(
    h('p', { class: 'stopname' }, t.name),
    h('div', { class: 'row' }, h('label', { class: 'lab' }, 'Walk (min)', walkIn), h('label', { class: 'lab' }, 'Spare (min)', spareIn)),
    h('div', { class: 'row' }, locBtn), noteEl, list);

  async function useLocation() {
    if (t.lat == null) { locNote = 'This stop has no coordinates in the feed. Enter your walking time instead.'; return draw(); }
    try { const pos = await getPosition(); walk = walkMinutes(pos, t); walkAuto = true; walkIn.value = String(walk); locNote = 'Estimated from straight-line distance, not a mapped walking route.'; }
    catch { locNote = 'Location is off or blocked. Enter your walking time instead.'; }
    draw();
  }

  function draw() {
    const now = Date.now(), spare = Number(spareIn.value) || 0;
    const rows = deps.filter(d => matches(t, d) && d.ts > now - 30000).sort((a, b) => a.ts - b.ts);
    noteEl.textContent = err ? errorText(err) : locNote || (walk == null ? 'Enter how long it takes you to walk there, or use your location.' : '');
    if (!rows.length) { list.replaceChildren(h('li', {}, h('p', { class: 'note' }, err ? '' : 'No departures listed right now.'))); return; }
    list.replaceChildren(...rows.map(d => {
      const board = fmtClock(d.ts), mins = Math.max(0, minsUntil(d.ts, now));
      if (walk == null) return h('li', {}, h('div', { class: 'leaverow' }, h('span', { class: 'when' }, board), h('span', { class: 'sub' }, `in ${mins} min`)));
      const leaveTs = d.ts - (walk + spare) * 60000, left = minsUntil(leaveTs, now);
      const missed = leaveTs < now - 15000;
      return h('li', { class: missed ? 'missed' : '' }, h('div', { class: 'leaverow' },
        h('span', { class: 'when' }, missed ? 'Too late' : `Leave by ${fmtClock(leaveTs)}`),
        h('span', { class: 'sub' }, missed ? `${board} departs in ${mins} min` : `${left <= 0 ? 'Leave now' : 'in ' + left + ' min'} for the ${board}`)));
    }));
  }

  async function load() {
    if (document.hidden) return;
    try { deps = await fetchDepartures(t); err = null; } catch (e) { err = e; }
    draw();
  }
  const timers = [setInterval(load, REFRESH_MS), setInterval(draw, 1000)];
  const onVis = () => { if (!document.hidden) load(); };
  document.addEventListener('visibilitychange', onVis);
  load(); draw();
  return { unmount() { timers.forEach(clearInterval); document.removeEventListener('visibilitychange', onVis); } };
}
