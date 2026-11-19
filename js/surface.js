import { h, fmtClock, minsUntil, setText } from './util.js';
import * as api from './api.js';
import { getPosition, haversine, fmtDistance } from './geo.js';
import { REFRESH_MS, TTC_SURFACE_COLOR } from './config.js';
import { errorText } from './board.js';

const DIRWORD = { N: 'northbound', E: 'eastbound', S: 'southbound', W: 'westbound' };
const letter = d => { const m = /^(north|south|east|west)/i.exec(d?.name || ''); return m ? m[1][0].toUpperCase() : null; };

export function mountSurface(ctx) {
  const { state, root, header, save } = ctx;
  const s = state.surface;
  let routes = null, cfg = null, preds = [], err = null, timer = 0, stopButtons = new Map(), panel = null;
  root.className = 'top';
  ctx.setPalette(TTC_SURFACE_COLOR);
  setText(header.title, s.routeTitle || 'Routes'); setText(header.dir, s.dir || '·');
  header.titleBtn.onclick = () => chooseRoute();
  header.dirBtn.onclick = () => {
    if (!cfg) return;
    const ls = dirLetters();
    if (ls.length < 2) return;
    s.dir = ls[(ls.indexOf(s.dir) + 1) % ls.length]; s.stop = null; save();
    renderRoute();
  };

  const dirLetters = () => [...new Set(cfg.directions.map(letter).filter(Boolean))];
  const curDir = () => cfg.directions.find(d => letter(d) === s.dir) || cfg.directions[0];

  function chooseRoute() {
    s.route = null; s.routeTitle = null; s.stop = null; cfg = null; clearInterval(timer);
    setText(header.title, 'Routes'); setText(header.dir, '·');
    renderPicker();
  }

  async function renderPicker() {
    const input = h('input', { class: 'field', type: 'search', inputmode: 'numeric', autocomplete: 'off', placeholder: 'Route number, like 504', 'aria-label': 'Route number' });
    const list = h('ul', { class: 'list' });
    const msg = h('p', { class: 'note' }, 'Loading routes');
    root.replaceChildren(h('h2', { class: 'lead left' }, 'Bus or streetcar'), input, msg, list);
    const draw = () => {
      const q = input.value.trim().toLowerCase();
      const hits = (routes || []).filter(r => !q || r.tag.toLowerCase().startsWith(q) || r.title.toLowerCase().includes(q)).slice(0, 12);
      list.replaceChildren(...hits.map(r => h('li', {}, h('button', { type: 'button', onclick: () => pick(r) }, h('span', {}, r.title)))));
      msg.textContent = routes ? (hits.length ? '' : 'No route matches that.') : msg.textContent;
    };
    input.addEventListener('input', draw);
    try { routes = (await api.ttcRoutes()).routes; draw(); input.focus(); }
    catch (e) { msg.textContent = errorText(e); }
  }

  async function pick(r) {
    s.route = r.tag; s.routeTitle = r.title; s.dir = null; s.stop = null; save();
    await openRoute();
  }

  async function openRoute() {
    root.replaceChildren(h('p', { class: 'note' }, 'Loading stops'));
    setText(header.title, s.routeTitle || s.route);
    try { cfg = await api.ttcRoute(s.route); }
    catch (e) { root.replaceChildren(h('p', { class: 'note' }, errorText(e)), h('button', { class: 'btn', type: 'button', onclick: chooseRoute }, 'Pick another route')); return; }
    if (!cfg.directions.length) { root.replaceChildren(h('p', { class: 'note' }, 'This route has no stops listed in the feed.'), h('button', { class: 'btn', type: 'button', onclick: chooseRoute }, 'Pick another route')); return; }
    if (!s.dir || !dirLetters().includes(s.dir)) s.dir = letter(curDir()) || null;
    renderRoute();
  }

  function renderRoute() {
    const d = curDir();
    setText(header.dir, s.dir || '·');
    header.dirBtn.setAttribute('aria-label', s.dir ? `Direction ${DIRWORD[s.dir]}. Tap to change.` : 'Direction');
    stopButtons = new Map();
    const stops = d.stops.map(t => cfg.stops[t]).filter(Boolean);
    const list = h('ul', { class: 'list' }, stops.map(st => {
      const b = h('button', { type: 'button', onclick: () => selectStop(st) }, h('span', {}, st.title));
      stopButtons.set(st.tag, b);
      return h('li', {}, b);
    }));
    panel = h('div', { class: 'panel', 'aria-live': 'polite' }, h('p', { class: 'note' }, 'Tap a stop to see the next buses.'));
    const near = h('button', { class: 'btn', type: 'button', onclick: findNearest }, 'Find my nearest stop');
    const change = h('button', { class: 'btn', type: 'button', onclick: chooseRoute }, 'Change route');
    root.replaceChildren(panel, h('div', { class: 'row' }, near, change), h('p', { class: 'note small' }, d.title || ''), list);
    if (s.stop && stopButtons.has(s.stop.tag)) selectStop(s.stop, false);
  }

  function drawPanel() {
    if (!panel || !s.stop) return;
    const now = Date.now(), list = preds.filter(p => p.ts > now - 30000);
    const kids = [h('p', { class: 'stopname' }, s.stop.title)];
    if (!list.length) kids.push(h('p', { class: 'note' }, err ? errorText(err) : 'No predictions right now.'));
    else {
      const m = minsUntil(list[0].ts, now);
      kids.push(h('p', { class: 'big' }, m <= 0 ? 'Now' : `${m} min`),
        h('p', { class: 'clock' }, `${fmtClock(list[0].ts)}${list[0].dir ? ' · ' + list[0].dir : ''}`));
      if (list[1]) kids.push(h('p', { class: 'next' }, 'Then ' + list.slice(1, 4).map(p => `${Math.max(0, minsUntil(p.ts, now))} min`).join(', ')));
    }
    panel.replaceChildren(...kids);
  }

  async function loadPreds() {
    if (!s.stop || document.hidden) return;
    if (!s.stop.stopId) { preds = []; err = null; drawPanel(); return; }
    try { preds = (await api.ttcPredict(s.stop.stopId, s.route)).departures; err = null; } catch (e) { err = e; }
    drawPanel();
  }

  function selectStop(st, scroll = true) {
    s.stop = { tag: st.tag, stopId: st.stopId, title: st.title, lat: st.lat, lng: st.lng };
    stopButtons.forEach((b, t) => b.setAttribute('aria-current', String(t === st.tag)));
    if (scroll) stopButtons.get(st.tag)?.scrollIntoView({ block: 'nearest' });
    state.target = { kind: 'surface', route: s.route, stopId: st.stopId, name: `${st.title}`, lat: st.lat, lng: st.lng, line: s.route, dir: s.dir, color: TTC_SURFACE_COLOR };
    save(); preds = []; drawPanel(); loadPreds();
  }

  async function findNearest() {
    try {
      const pos = await getPosition();
      const d = curDir();
      let best = null, bd = Infinity;
      d.stops.map(t => cfg.stops[t]).filter(st => st && st.lat != null).forEach(st => { const m = haversine(pos, st); if (m < bd) { bd = m; best = st; } });
      if (best) { selectStop(best); stopButtons.get(best.tag)?.scrollIntoView({ block: 'center' }); panel.append(h('p', { class: 'note small' }, `Nearest stop on this direction is about ${fmtDistance(bd)} away.`)); }
    } catch { panel.replaceChildren(h('p', { class: 'note' }, 'Location is off or blocked. You can still pick a stop from the list.')); }
  }

  timer = setInterval(() => { loadPreds(); }, REFRESH_MS);
  const tick = setInterval(drawPanel, 1000);
  const onVis = () => { if (!document.hidden) loadPreds(); };
  document.addEventListener('visibilitychange', onVis);
  if (s.route) openRoute(); else renderPicker();
  return { unmount() { clearInterval(timer); clearInterval(tick); document.removeEventListener('visibilitychange', onVis); header.titleBtn.onclick = header.dirBtn.onclick = null; } };
}
