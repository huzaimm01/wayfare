import { h, fmtClock, minsUntil, setText } from './util.js';
import { fetchDepartures } from './data.js';
import { GO_LINES, GO_BUS, SUBWAY, REFRESH_MS } from './config.js';

const DIRWORD = { N: 'northbound', E: 'eastbound', S: 'southbound', W: 'westbound' };

function lineMeta(agency, key, dep) {
  if (agency === 'ttc') { const m = SUBWAY[key]; return { name: m ? m.name : 'TTC Subway', color: m ? m.color : '#E31837' }; }
  if (GO_LINES[key]) return GO_LINES[key];
  return { name: dep?.lineName || GO_BUS.name, color: GO_BUS.color };
}

export function errorText(e) {
  if (!navigator.onLine) return 'You are offline.';
  if (e?.message === 'not-configured') return 'Set WORKER_URL in js/config.js to connect this page to your Worker.';
  return 'Could not reach the data source.';
}

export function mountBoard(ctx) {
  const { state, root, header, save } = ctx;
  let deps = [], err = null, updated = 0, loaded = false, busy = false, lastSr = '', lastTarget = '';
  const timers = [];
  const isGo = () => state.agency === 'go';
  const sec = () => (isGo() ? state.go : state.ttc);
  const station = () => (isGo() ? state.go.stop : state.ttc.station);
  const target = () => {
    const s = station();
    return isGo()
      ? { kind: 'go', code: s.code, name: s.name, lat: s.lat, lng: s.lng }
      : { kind: 'subway', codes: s.codes, name: s.name, lat: s.lat, lng: s.lng, line: state.ttc.line };
  };

  const num = h('span', { class: 'num' });
  const unit = h('span', { class: 'unit' });
  const clock = h('p', { class: 'clock' });
  const next = h('p', { class: 'next' });
  const where = h('p', { class: 'where' });
  const note = h('p', { class: 'note' });
  const sr = h('p', { class: 'sr', 'aria-live': 'polite' });
  const board = h('div', { class: 'board' },
    h('div', { class: 'radar', 'aria-hidden': 'true' }, h('div', { class: 'timebox' }, num, unit)),
    clock, next, where, note, sr);
  const lead = h('p', { class: 'lead' });
  const empty = h('div', { class: 'empty' }, lead,
    h('button', { class: 'btn', type: 'button', onclick: () => ctx.pickStation() }, 'Choose a station'));
  root.className = 'center';
  root.replaceChildren(board, empty);

  function compute() {
    const now = Date.now();
    const live = deps.filter(d => d.ts > now - 45000);
    const lines = [...new Set(live.map(d => d.line))];
    const s = sec();
    const line = isGo() ? (lines.includes(s.line) ? s.line : lines[0]) : state.ttc.line;
    const ofLine = live.filter(d => d.line === line);
    const dirs = [...new Set(ofLine.map(d => d.dir).filter(Boolean))];
    const dir = dirs.includes(s.dir) ? s.dir : dirs[0] || s.dir || null;
    const list = ofLine.filter(d => !d.dir || !dir || d.dir === dir).sort((a, b) => a.ts - b.ts);
    return { now, lines, line, dirs, dir, list };
  }

  function draw() {
    const has = !!station();
    empty.hidden = has; board.hidden = !has;
    if (!has) {
      setText(lead, isGo() ? 'Pick a GO station to see the next departures.' : state.ttc.station === null && !ctx.subwayReady() ? 'Subway station data has not been built yet. See the README.' : 'Pick a subway station to see the next trains.');
      setText(header.title, isGo() ? 'GO Transit' : 'TTC Subway');
      setText(header.dir, '·');
      ctx.setPalette(isGo() ? GO_BUS.color : '#E31837');
      return;
    }
    const c = compute();
    const first = c.list[0], second = c.list[1];
    const meta = lineMeta(state.agency, c.line, first || deps[0]);
    ctx.setPalette(meta.color);
    setText(header.title, meta.name);
    setText(header.dir, c.dir || '·');
    header.dirBtn.setAttribute('aria-label', c.dir ? `Direction ${DIRWORD[c.dir]}. Tap to change.` : 'Direction');
    header.titleBtn.setAttribute('aria-label', isGo() ? `${meta.name}. Tap to switch line.` : `${meta.name}. Tap to choose a station.`);
    setText(where, station().name);

    if (first) {
      const m = minsUntil(first.ts, c.now);
      setText(num, m <= 0 ? 'Now' : String(m));
      setText(unit, m <= 0 ? '' : m === 1 ? 'minute' : 'minutes');
      let line = fmtClock(first.ts);
      if (first.platform) line += ` · Platform ${first.platform}`;
      if (first.schedTs && Math.abs(first.schedTs - first.ts) >= 60000) line += ` · Scheduled ${fmtClock(first.schedTs)}`;
      setText(clock, line);
      setText(next, second ? `Then ${fmtClock(second.ts)} · ${Math.max(0, minsUntil(second.ts, c.now))} min` : 'No later departure listed');
      const srText = `${meta.name}${c.dir ? ' ' + DIRWORD[c.dir] : ''} at ${station().name}, ${m <= 0 ? 'now' : m + ' minutes'}`;
      if (srText !== lastSr) { lastSr = srText; sr.textContent = srText; }
    } else {
      setText(num, '·'); setText(unit, '');
      setText(clock, !loaded ? 'Loading' : err ? '' : 'No departures listed right now');
      setText(next, '');
    }
    setText(note, err ? `${errorText(err)}${updated ? ` Showing the update from ${fmtClock(updated)}.` : ''}` : '');

    const t = { ...target(), line: c.line, dir: c.dir, color: meta.color };
    const sig = JSON.stringify(t);
    if (sig !== lastTarget) { lastTarget = sig; state.target = t; save(); }
  }

  async function load() {
    if (!station() || busy || document.hidden) return;
    busy = true;
    try { deps = await fetchDepartures(target()); err = null; updated = Date.now(); }
    catch (e) { err = e; }
    loaded = true; busy = false; draw();
  }

  header.titleBtn.onclick = () => {
    if (!isGo()) return ctx.pickStation();
    const c = compute();
    if (c.lines.length < 2) return;
    state.go.line = c.lines[(c.lines.indexOf(c.line) + 1) % c.lines.length];
    state.go.dir = null; save(); draw();
  };
  header.dirBtn.onclick = () => {
    const c = compute();
    if (c.dirs.length < 2) return;
    sec().dir = c.dirs[(c.dirs.indexOf(c.dir) + 1) % c.dirs.length]; save(); draw();
  };
  const onVis = () => { if (!document.hidden) { load(); draw(); } };
  document.addEventListener('visibilitychange', onVis);
  timers.push(setInterval(load, REFRESH_MS), setInterval(draw, 1000));
  draw(); load();
  return { unmount() { timers.forEach(clearInterval); document.removeEventListener('visibilitychange', onVis); header.titleBtn.onclick = header.dirBtn.onclick = null; } };
}
