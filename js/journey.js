// Journey planner: Quickest vs Most Comfortable, with a deadline.
// Origin is where you are (or a station), destination is a station.
// The route shape comes from the static graph (router.js); each boarding
// is then matched to a real live departure, so the times are real, not
// estimates. Fares use the One Fare rules (fares.js).
import { h, setText, fmtClock } from './util.js';
import { loadNetwork, plan, comparePlans } from './router.js';
import { fareFor, money } from './fares.js';
import { fetchDepartures, matches } from './data.js';
import { getPosition } from './geo.js';
import { openPicker } from './picker.js';
import { GO_LINES, SUBWAY } from './config.js';

// Inputs persist across view switches within the session.
let from = { type: 'loc', label: 'My location' };
let to = null;
let mode = 'comfortable';
let rider = 'student';
let arriveBy = '';
let tolerance = 5; // 0, 5, 10, Infinity (relax)
let result = null; // {show: [{plan, fare, leaveBy, late, legs}], note, err}
let busy = false;

const stationLabel = (net, id) => net.nodes[id]?.name || id;
const goCode = id => id.replace('go:', '');

function seg(options, value, onChange) {
  const ind = h('span', { class: 'seg-ind' });
  // The stylesheet sizes the indicator for two options; size it per count.
  ind.style.width = `calc(${100 / options.length}% - 3px)`;
  const el = h('div', { class: 'seg' }, ind);
  const btns = options.map(([v, label]) => h('button', {
    type: 'button', 'aria-pressed': String(v === value),
    onclick: () => { onChange(v); btns.forEach((b, i) => b.setAttribute('aria-pressed', String(options[i][0] === v))); ind.style.transform = `translateX(${options.findIndex(([x]) => x === v) * 100}%)`; }
  }, label));
  el.append(...btns);
  ind.style.transform = `translateX(${options.findIndex(([v]) => v === value) * 100}%)`;
  return el;
}

// Compass letter for a ride leg, so live departures match the direction.
function legDir(leg, net) {
  if (leg.mode === 'go') {
    return leg.to === 'go:UN' ? GO_LINES[leg.line].toUnion : GO_LINES[leg.line].fromUnion;
  }
  const line = leg.line.replace('ttc', '');
  const order = net.lines[leg.line]?.stations || [];
  const fi = order.indexOf(stationLabel(net, leg.from)), ti = order.indexOf(stationLabel(net, leg.to));
  const terminus = ti > fi ? order[order.length - 1] : order[0];
  const cfg = SUBWAY[line] || {};
  for (const k of 'NESW') if (cfg[k] && terminus.includes(cfg[k])) return k;
  return null;
}

function targetFor(leg, net) {
  const dir = legDir(leg, net);
  if (leg.mode === 'go') return { kind: 'go', code: goCode(leg.from), line: leg.line, dir };
  const node = net.nodes[leg.from];
  return { kind: 'subway', codes: node?.codes, line: leg.line.replace('ttc', ''), dir };
}

// Fill in real board/alight times from live departures, walking the legs
// in order. Falls back to the scheduled estimate when live data is missing.
async function materialize(legs, net, startTs) {
  let t = startTs, live = 0, total = 0;
  for (const leg of legs) {
    if (leg.kind !== 'ride') {
      leg.boardTs = t; t += leg.mins * 60000; leg.alightTs = t; leg.live = false;
      continue;
    }
    const ready = t + ((leg.waitMins || 0) + (leg.changeMins || 0)) * 60000;
    let boardTs = null;
    try {
      const target = targetFor(leg, net);
      const deps = await fetchDepartures(target);
      const d = deps.find(d => matches(target, d) && d.ts >= ready);
      if (d) { boardTs = d.ts; live++; }
    } catch { /* live data unavailable; use the estimate */ }
    if (!boardTs) boardTs = ready;
    leg.boardTs = boardTs; leg.live = !!boardTs && boardTs !== ready;
    leg.alightTs = boardTs + leg.rideMins * 60000;
    t = leg.alightTs;
  }
  total = legs.length;
  return { live, total };
}

export function mountJourney(ctx) {
  const { state, root, header, save } = ctx;
  root.className = 'top';
  ctx.setPalette('#0059B3');
  setText(header.title, 'Journey'); setText(header.dir, '·');
  header.titleBtn.onclick = header.dirBtn.onclick = null;

  const fromBtn = h('button', { class: 'btn wide', type: 'button' });
  const toBtn = h('button', { class: 'btn', type: 'button', style: 'flex:1;min-width:0' });
  const swapBtn = h('button', { class: 'btn', type: 'button', 'aria-label': 'Swap origin and destination' }, 'Swap');
  const timeInput = h('input', { class: 'field', type: 'time', value: arriveBy, 'aria-label': 'Arrive by' });
  const results = h('div', {});
  const err = h('p', { class: 'note', role: 'alert' });
  const planBtn = h('button', { class: 'btn primary wide', type: 'button' }, 'Plan my trip');

  const drawLabels = () => {
    setText(fromBtn, 'From: ' + from.label);
    setText(toBtn, 'To: ' + (to ? to.label : 'Pick a station'));
    swapBtn.disabled = !(from.type === 'station' && to);
  };

  const chooseStation = async (which) => {
    const net = await loadNetwork();
    const items = Object.entries(net.nodes).map(([id, n]) => ({
      id, label: n.name, lat: n.lat, lng: n.lng,
      sub: n.kind === 'go' ? 'GO ' + n.lines.join(', ') : 'Line ' + n.lines.map(l => l.replace('ttc', '')).join(', ')
    }));
    if (which === 'from') items.unshift({ id: '__loc__', label: 'My location', sub: 'Use where I am now' });
    openPicker({
      title: which === 'from' ? 'Start' : 'Destination',
      load: async () => items,
      onPick: i => {
        if (which === 'from') from = i.id === '__loc__' ? { type: 'loc', label: 'My location' } : { type: 'station', id: i.id, label: i.label };
        else to = { type: 'station', id: i.id, label: i.label };
        drawLabels();
        if (from && to) runPlan();
      }
    });
  };
  fromBtn.onclick = () => chooseStation('from');
  toBtn.onclick = () => chooseStation('to');
  swapBtn.onclick = () => {
    if (from.type !== 'station' || !to) return;
    const oldTo = to;
    to = { type: 'station', id: from.id, label: from.label };
    from = { type: 'station', id: oldTo.id, label: oldTo.label };
    drawLabels(); runPlan();
  };

  const modeSeg = seg([['quickest', 'Quickest'], ['comfortable', 'Comfortable']], mode, v => { mode = v; if (result) runPlan(); });
  const riderSeg = seg([['adult', 'Adult'], ['student', 'Student'], ['senior', 'Senior']], rider, v => { rider = v; if (result) runPlan(); });
  const tolSeg = seg([[0, 'Strict'], [5, '+5'], [10, '+10'], [Infinity, 'Relax']], tolerance, v => { tolerance = v; if (result) runPlan(); });
  timeInput.addEventListener('change', () => { arriveBy = timeInput.value; if (result) runPlan(); });

  root.replaceChildren(
    h('p', { class: 'sec' }, 'Where to'),
    h('div', { class: 'row' }, fromBtn),
    h('div', { class: 'row' }, toBtn, swapBtn),
    h('p', { class: 'sec' }, 'How'),
    modeSeg,
    h('p', { class: 'sec' }, 'Be there by'),
    h('div', { class: 'row' }, timeInput),
    tolSeg,
    h('p', { class: 'sec' }, 'Fare'),
    riderSeg,
    h('div', { class: 'row' }, planBtn),
    err,
    results
  );
  drawLabels();

  async function runPlan() {
    if (busy) return;
    if (!to) { err.textContent = 'Pick a destination first.'; return; }
    if (from.type === 'station' && from.id === to.id) { err.textContent = 'From and To are the same station.'; return; }
    busy = true; err.textContent = ''; results.replaceChildren(h('p', { class: 'note' }, 'Planning…'));
    try {
      const net = await loadNetwork();
      let fromVal = from.id;
      if (from.type === 'loc') {
        try { fromVal = await getPosition(); }
        catch { err.textContent = 'Location is off or blocked. Pick a start station instead.'; results.replaceChildren(); busy = false; return; }
      }
      const quick = plan(net, fromVal, to.id, 'quickest');
      const comfort = plan(net, fromVal, to.id, 'comfortable');
      const { show, note } = comparePlans(quick, comfort);
      if (!show.length) { err.textContent = note || 'No route found.'; results.replaceChildren(); busy = false; return; }
      const now = Date.now();
      let deadlineMs = null;
      if (arriveBy && tolerance !== Infinity) {
        const [hh, mm] = arriveBy.split(':').map(Number);
        const d = new Date(); d.setHours(hh, mm, 0, 0);
        if (d.getTime() < now) d.setDate(d.getDate() + 1);
        deadlineMs = d.getTime();
      }
      const cards = [];
      for (const p of show) {
        const legs = JSON.parse(JSON.stringify(p.legs));
        const allowance = deadlineMs == null ? 0 : tolerance * 60000;
        const latestLeave = deadlineMs == null ? now : deadlineMs + allowance - p.totalMins * 60000;
        const late = deadlineMs != null && latestLeave < now;
        const startTs = late ? now : latestLeave;
        const { live } = await materialize(legs, net, startTs);
        const fare = await fareFor(legs, rider);
        cards.push({ plan: p, legs, fare, leaveBy: late ? null : startTs, late, live });
      }
      result = { show: cards, note };
      drawResults(cards, note, net);
    } catch (e) {
      err.textContent = 'Could not plan that trip. Try again in a moment.';
    } finally { busy = false; }
  }

  function legText(leg, net) {
    if (leg.kind === 'walk') return `Walk ${leg.mins} min to ${stationLabel(net, leg.to)}`;
    if (leg.kind === 'transfer') return `Change at ${stationLabel(net, leg.from)} · ${leg.mins} min`;
    const lineName = leg.mode === 'go' ? (GO_LINES[leg.line]?.name || leg.line) : (SUBWAY[leg.line.replace('ttc', '')]?.name || leg.line);
    const stops = leg.stops.length ? ` · ${leg.stops.length + 1} stop${leg.stops.length ? 's' : ''}` : '';
    const board = leg.boardTs ? fmtClock(leg.boardTs) : '', alight = leg.alightTs ? fmtClock(leg.alightTs) : '';
    const when = board ? ` · board ${board}${leg.live ? '' : ' (scheduled)'} · arrive ${alight}` : '';
    return `${lineName} · ${stationLabel(net, leg.from)} → ${stationLabel(net, leg.to)}${stops}${when}`;
  }

  function drawResults(cards, note, net) {
    const els = [];
    if (note) els.push(h('p', { class: 'note' }, note));
    for (const c of cards) {
      // Real duration from the materialized legs (live departures included).
      const first = c.legs[0], last = c.legs[c.legs.length - 1];
      const total = first?.boardTs && last?.alightTs ? Math.round((last.alightTs - first.boardTs) / 60000) : Math.round(c.plan.totalMins);
      const arrival = c.legs.length ? c.legs[c.legs.length - 1].alightTs : null;
      const head = h('div', { class: 'row' },
        h('span', { class: 'big' }, `${total} min`),
        h('span', { class: 'sub' }, c.plan.mode === 'comfortable' ? 'Comfortable' : 'Quickest'),
        h('span', { class: 'sub' }, c.fare.total == null ? 'Fare not listed' : money(c.fare.total)));
      const sub = h('p', { class: 'note' },
        c.late ? `You can't make it by then — earliest arrival ${arrival ? fmtClock(arrival) : ''}.`
          : c.leaveBy ? `Leave by ${fmtClock(c.leaveBy)} · arrive ${arrival ? fmtClock(arrival) : ''}.`
            : `Leave now · arrive ${arrival ? fmtClock(arrival) : ''}.`);
      const list = h('ul', { class: 'list' }, ...c.legs.map(l => h('li', {}, h('span', {}, legText(l, net)))));
      const fareNote = c.fare.note ? h('p', { class: 'note small' }, c.fare.note) : null;
      els.push(h('div', { class: 'panel' }, head, sub, list, fareNote));
    }
    results.replaceChildren(...els);
  }

  planBtn.onclick = runPlan;
  return { unmount() { header.titleBtn.onclick = header.dirBtn.onclick = null; } };
}
