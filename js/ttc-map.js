import { h, fmtClock, minsUntil, setText } from './util.js';
import { fetchDepartures } from './data.js';
import { SUBWAY, REFRESH_MS } from './config.js';
import { errorText } from './board.js';

const SVGNS = 'http://www.w3.org/2000/svg';
function svgEl(tag, attrs = {}, ...kids) {
  const e = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'onclick') e.addEventListener('click', v);
    else e.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid == null) continue;
    e.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return e;
}

// Same dark-cartography themes as the GO map, so the two service maps feel
// like one map. The only difference is the header logo: TTC, not GO.
const MAP_THEMES = {
  dark: {
    canvas: '#0B0F17', grid: 'rgba(255,255,255,0.035)', gridMajor: 'rgba(255,255,255,0.06)',
    water: '#071929', waterStroke: '#123654', text: '#F8FAFC', sub: '#94A3B8', muted: '#64748B',
    stationFill: '#0B0F17', bar: 'rgba(11,15,23,.72)', barFg: '#ffffff',
    sheet: 'rgba(17,24,39,0.88)', sheetFg: '#F8FAFC', logo: 'assets/ttc-white.svg'
  },
  light: {
    canvas: '#F4F5F7', grid: 'rgba(15,23,42,0.045)', gridMajor: 'rgba(15,23,42,0.08)',
    water: '#DCEBF7', waterStroke: '#B8D6EE', text: '#0F172A', sub: '#475569', muted: '#64748B',
    stationFill: '#FFFFFF', bar: 'rgba(255,255,255,.8)', barFg: '#0F172A',
    sheet: 'rgba(255,255,255,0.92)', sheetFg: '#0F172A', logo: 'assets/ttc.svg'
  }
};
const LINE_ORDER = ['1', '2', '4', '5', '6'];
const ease = t => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export function mountTtcMap(ctx, onBus) {
  const { state, root, header, save } = ctx;
  root.className = 'map-view';
  setText(header.title, 'TTC subway'); setText(header.dir, '·');
  header.titleBtn.onclick = header.dirBtn.onclick = null;

  const themeName = () => (state.colour ? state.mapTheme : 'dark');
  let theme = MAP_THEMES[themeName()];
  const canvas = () => (state.colour ? theme.canvas : '#2b2e35');
  // The palette is the canvas colour, so the bottom nav matches the map.
  ctx.setPalette(theme.canvas);
  const docStyle = document.documentElement.style;
  const applyChrome = () => {
    docStyle.setProperty('--bar-bg', theme.bar);
    docStyle.setProperty('--bar-fg', theme.barFg);
    docStyle.setProperty('--sheet-bg', theme.sheet);
    docStyle.setProperty('--sheet-fg', theme.sheetFg);
    const img = header.mark.querySelector('img');
    if (img) img.src = theme.logo;
  };
  applyChrome();

  const full = h('div', { class: 'map-full' });
  full.style.background = canvas();
  root.replaceChildren(full);

  // ---- state kept across re-renders ----
  let lines = null;
  let stations = [], byName = {};
  let latMin = 0, latMax = 0;
  let filter = 'ALL';
  let selected = null;
  let W = 1000, H = 1000;
  let X = () => 0, Y = () => 0;
  let cam = { x: 0, y: 0, w: W };
  let animId = 0, depTimer = 0, depTick = 0;
  let deps = [], depErr = null;
  let svg = null, trackEls = [], stationEls = new Map();
  const pointers = new Map();
  let dragStart = null, pinchStart = null;

  // ---- floating overlays ----
  const searchWrap = h('div', { class: 'map-search-wrap' });
  const input = h('input', { type: 'search', autocomplete: 'off', spellcheck: 'false', placeholder: 'Search a TTC station', 'aria-label': 'Search a TTC station' });
  const clr = h('button', { class: 'clr', type: 'button', 'aria-label': 'Clear search', hidden: true }, '✕');
  const drop = h('div', { class: 'map-drop', hidden: true });
  searchWrap.append(h('div', { class: 'map-search' }, h('span', { class: 'mag', 'aria-hidden': 'true' }, '⌕'), input, clr), drop);
  const pills = h('div', { class: 'map-pills' });
  const busBtn = h('button', { class: 'map-pill', type: 'button', style: 'justify-self:start' }, 'Bus & streetcar');
  busBtn.onclick = () => { if (onBus) onBus(); };
  const top = h('div', { class: 'map-top' }, searchWrap, pills, busBtn);
  const zoomBox = h('div', { class: 'map-zoom' },
    h('button', { type: 'button', 'aria-label': 'Zoom in', onclick: () => zoomAt(0.7, cam.x + cam.w / 2, cam.y + (cam.w * H / W) / 2) }, '+'),
    h('button', { type: 'button', 'aria-label': 'Zoom out', onclick: () => zoomAt(1.4, cam.x + cam.w / 2, cam.y + (cam.w * H / W) / 2) }, '−'),
    h('button', { type: 'button', 'aria-label': 'Reset view', onclick: resetView }, '↺'));
  const themeBtn = h('button', { class: 'map-theme', type: 'button', 'aria-label': 'Switch map theme' }, state.mapTheme === 'dark' ? '☀' : '☾');

  // ---- station drawer (filled per station) ----
  const hubBadge = h('span', { class: 'badge' });
  const drawerName = h('h2', {}, 'Station');
  const linePills = h('div', { class: 'linepills' });
  const clockEl = h('span', { class: 'sub' }, '');
  const depsEl = h('div', {});
  const boardBtn = h('button', { class: 'board-btn', type: 'button' }, 'Board here');
  const prevBtn = h('button', { type: 'button' }, 'Line end');
  const nextBtn = h('button', { type: 'button' }, 'Line end');
  const drawer = h('div', { class: 'map-drawer', hidden: true },
    h('button', { class: 'close', type: 'button', 'aria-label': 'Close station details', onclick: closeDrawer }, '✕'),
    h('div', {}, hubBadge),
    drawerName,
    linePills,
    h('div', { style: 'display:flex;justify-content:space-between;align-items:baseline' }, h('p', { class: 'sec' }, 'Live departures'), clockEl),
    depsEl,
    boardBtn,
    h('div', { class: 'stepper' }, prevBtn, nextBtn));
  full.append(top, zoomBox, themeBtn, drawer);

  // ---- filter pills ----
  function paintPills() {
    for (const b of pills.children) {
      const id = b.dataset.line, on = id === filter;
      b.setAttribute('aria-pressed', String(on));
      if (on && id !== 'ALL') {
        b.style.background = SUBWAY[id].color; b.style.color = '#fff';
        if (b._dot) b._dot.style.background = '#fff';
      } else {
        b.style.background = ''; b.style.color = '';
        if (b._dot) b._dot.style.background = SUBWAY[id].color;
      }
    }
  }
  function buildPills() {
    const mk = id => {
      const color = id === 'ALL' ? null : SUBWAY[id].color;
      const dot = color ? h('span', { class: 'dot', style: `background:${color}` }) : null;
      const b = h('button', { class: 'map-pill', type: 'button' }, dot, id === 'ALL' ? 'All lines' : SUBWAY[id].name);
      b.dataset.line = id; b._dot = dot;
      b.onclick = () => setFilter(id);
      return b;
    };
    pills.replaceChildren(mk('ALL'), ...LINE_ORDER.map(mk));
    paintPills();
  }
  buildPills();

  function setFilter(id) {
    filter = id;
    paintPills();
    applyHighlight();
    updateLabels();
    if (id === 'ALL') animateCameraTo(0, 0, W, 700);
    else fitLine(id);
  }
  function resetView() { closeDrawer(); setFilter('ALL'); }

  themeBtn.onclick = () => {
    state.mapTheme = state.mapTheme === 'dark' ? 'light' : 'dark';
    save();
    theme = MAP_THEMES[themeName()];
    ctx.setPalette(theme.canvas);
    applyChrome();
    full.style.background = canvas();
    themeBtn.textContent = state.mapTheme === 'dark' ? '☀' : '☾';
    renderSvg();
  };

  // ---- search ----
  const drawDrop = () => {
    const q = input.value.trim().toLowerCase();
    clr.hidden = !input.value;
    if (!q || !stations.length) { drop.hidden = true; drop.replaceChildren(); return; }
    // Stations starting with the query come first, so "Bloor" beats "Osgoode".
    const hits = stations.filter(s => s.name.toLowerCase().includes(q))
      .sort((a, b) => (a.name.toLowerCase().startsWith(q) ? 0 : 1) - (b.name.toLowerCase().startsWith(q) ? 0 : 1))
      .slice(0, 8);
    drop.replaceChildren(...hits.map(s => h('button', { type: 'button', onclick: () => {
      input.value = s.name; drop.hidden = true; clr.hidden = false;
      selectStation(s);
    } }, h('span', {}, s.name), h('span', { class: 'codes' }, ...s.lines.map(id => h('span', { class: 'code', style: `background:${SUBWAY[id].color}` }, id))))));
    drop.hidden = !hits.length;
  };
  input.addEventListener('input', drawDrop);
  input.addEventListener('focus', drawDrop);
  clr.onclick = () => { input.value = ''; clr.hidden = true; drop.hidden = true; input.focus(); };
  const closeDrop = e => { if (!searchWrap.contains(e.target)) drop.hidden = true; };
  document.addEventListener('click', closeDrop);

  // ---- camera ----
  function applyVb() { if (svg) svg.setAttribute('viewBox', `${cam.x} ${cam.y} ${cam.w} ${cam.w * H / W}`); }
  function clampCam() {
    cam.w = clamp(cam.w, 140, W);
    cam.x = clamp(cam.x, 0, W - cam.w);
    cam.y = clamp(cam.y, 0, H - (cam.w * H / W));
  }
  function cancelAnim() { if (animId) { cancelAnimationFrame(animId); animId = 0; } }
  function animateCameraTo(tx, ty, tw, dur = 700) {
    cancelAnim();
    const sx = cam.x, sy = cam.y, sw = cam.w, t0 = performance.now();
    const step = now => {
      const t = Math.min((now - t0) / dur, 1), e = ease(t);
      cam.x = sx + (tx - sx) * e; cam.y = sy + (ty - sy) * e; cam.w = sw + (tw - sw) * e;
      applyVb();
      if (t < 1) animId = requestAnimationFrame(step);
      else { animId = 0; updateLabels(); }
    };
    animId = requestAnimationFrame(step);
  }
  function zoomAt(factor, px, py) {
    cancelAnim();
    const nw = clamp(cam.w * factor, 140, W);
    const k = nw / cam.w;
    cam.x = px - (px - cam.x) * k;
    cam.y = py - (py - cam.y) * k;
    cam.w = nw;
    clampCam(); applyVb();
  }
  function clientToSvg(cx, cy) {
    const r = svg.getBoundingClientRect();
    const vh = cam.w * H / W;
    const s = Math.min(r.width / cam.w, r.height / vh);
    const ox = (r.width - cam.w * s) / 2, oy = (r.height - vh * s) / 2;
    return { x: cam.x + (cx - r.left - ox) / s, y: cam.y + (cy - r.top - oy) / s };
  }
  function fitLine(id) {
    if (!lines) return;
    const l = lines[id];
    const pts = [...l.shape, ...l.stations.map(s => [s.lat, s.lng])].map(([la, lo]) => [X(lo), Y(la)]);
    const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    const w = clamp(Math.max(maxX - minX, (maxY - minY) * W / H) * 1.18, 140, W);
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    animateCameraTo(clamp(cx - w / 2, 0, W - w), clamp(cy - (w * H / W) / 2, 0, H - (w * H / W)), w, 760);
  }
  function focusStation(st) {
    const sx = X(st.lng), sy = Y(st.lat);
    const r = full.getBoundingClientRect();
    const tw = Math.min(W, 360);
    const s = Math.min(r.width / tw, r.height / (tw * H / W));
    const desktop = window.matchMedia('(min-width:641px) and (hover:hover) and (pointer:fine)').matches;
    const cx = desktop ? sx + 190 / s : sx;
    const cy = desktop ? sy : sy + (0.18 * r.height) / s;
    animateCameraTo(clamp(cx - tw / 2, 0, W - tw), clamp(cy - (tw * H / W) / 2, 0, H - (tw * H / W)), tw, 820);
  }

  // ---- labels ----
  // The label sits on the side the track leaves clear: outward along the
  // line for a terminus, perpendicular to the track (away from the network
  // centre) for the rest. That works for the U-shaped Line 1 and the
  // east-west lines alike, where a fixed left/right rule would not.
  function labelSide(st) {
    const order = lines[st.lines[0]].stations;
    const i = order.findIndex(s => s.name === st.name);
    const at = j => [X(order[j].lng), Y(order[j].lat)];
    let dx, dy;
    if (i <= 0) { const [x0, y0] = at(0), [x1, y1] = at(1); dx = x0 - x1; dy = y0 - y1; }
    else if (i >= order.length - 1) { const [x0, y0] = at(i), [x1, y1] = at(i - 1); dx = x0 - x1; dy = y0 - y1; }
    else {
      const [x0, y0] = at(i - 1), [x1, y1] = at(i + 1);
      let nx = -(y1 - y0), ny = x1 - x0;
      const len = Math.hypot(nx, ny) || 1; nx /= len; ny /= len;
      const cx = X(st.lng) - W / 2, cy = Y(st.lat) - H / 2;
      if (nx * cx + ny * cy < 0) { nx = -nx; ny = -ny; }
      dx = nx; dy = ny;
    }
    const len = Math.hypot(dx, dy) || 1; dx /= len; dy /= len;
    if (Math.abs(dx) >= Math.abs(dy)) return dx > 0 ? 'right' : 'left';
    return dy > 0 ? 'bottom' : 'top';
  }
  function updateLabels() {
    if (!lines) return;
    for (const st of stations) {
      const el = stationEls.get(st.name);
      if (!el) continue;
      // At the full-network zoom only Union and the termini are labelled, so
      // the downtown cluster stays readable. Hub labels appear when you zoom
      // in, and a filtered line labels all its own stations.
      const show = st.name === 'Union' || st.terminus || (filter !== 'ALL' && st.lines.includes(filter)) || cam.w < 420;
      el.label.style.display = show ? '' : 'none';
    }
  }
  function applyHighlight() {
    if (!lines) return;
    const active = new Set();
    if (filter !== 'ALL') active.add(filter);
    else if (selected) selected.lines.forEach(l => active.add(l));
    const hasFocus = active.size > 0;
    for (const t of trackEls) {
      const on = !hasFocus || active.has(t.id);
      t.casing.style.opacity = on ? '' : '0.1';
      t.main.style.opacity = on ? '' : '0.12';
      t.main.style.filter = hasFocus && on ? 'url(#map-glow)' : '';
    }
    for (const [name, el] of stationEls) {
      const on = !hasFocus || name === selected?.name || el.lines.some(l => active.has(l));
      el.g.style.opacity = on ? '' : '0.22';
    }
  }

  // ---- render ----
  function renderSvg() {
    if (!lines) return;
    const t = theme;
    const old = svg;
    svg = svgEl('svg', { class: 'map-canvas', role: 'img', 'aria-label': 'TTC subway network map' });
    applyVb();
    const defs = svgEl('defs', {},
      svgEl('pattern', { id: 'map-grid', width: 50, height: 50, patternUnits: 'userSpaceOnUse' },
        svgEl('path', { d: 'M 50 0 L 0 0 0 50', fill: 'none', stroke: t.grid, 'stroke-width': 1 })),
      svgEl('pattern', { id: 'map-grid-major', width: 250, height: 250, patternUnits: 'userSpaceOnUse' },
        svgEl('rect', { width: 250, height: 250, fill: 'url(#map-grid)' }),
        svgEl('path', { d: 'M 250 0 L 0 0 0 250', fill: 'none', stroke: t.gridMajor, 'stroke-width': 1 })),
      svgEl('radialGradient', { id: 'map-vig', cx: '50%', cy: '42%', r: '78%' },
        svgEl('stop', { offset: '62%', 'stop-color': '#000000', 'stop-opacity': 0 }),
        svgEl('stop', { offset: '100%', 'stop-color': '#000000', 'stop-opacity': 0.16 })),
      svgEl('filter', { id: 'map-glow', x: '-40%', y: '-40%', width: '180%', height: '180%' },
        svgEl('feGaussianBlur', { stdDeviation: 3.5, result: 'blur' }),
        svgEl('feMerge', {}, svgEl('feMergeNode', { in: 'blur' }), svgEl('feMergeNode', { in: 'SourceGraphic' }))));
    const vp = svgEl('g', {});
    vp.append(svgEl('rect', { x: -1500, y: -1500, width: 5000, height: 4500, fill: 'url(#map-grid-major)' }));
    const tracks = svgEl('g', {});
    trackEls = [];
    for (const id of LINE_ORDER) {
      const l = lines[id];
      const pts = l.shape.map(([la, lo]) => `${X(lo).toFixed(1)},${Y(la).toFixed(1)}`).join(' ');
      const casing = svgEl('polyline', { points: pts, class: 'map-track map-track-casing', stroke: SUBWAY[id].color, 'stroke-width': 9.5 });
      const main = svgEl('polyline', { points: pts, class: 'map-track', stroke: SUBWAY[id].color, 'stroke-width': 5.5 });
      tracks.append(casing, main);
      trackEls.push({ id, casing, main });
    }
    vp.append(tracks);
    const radar = svgEl('g', {});
    vp.append(radar);
    const stns = svgEl('g', {});
    stationEls = new Map();
    for (const st of stations) {
      const x = X(st.lng), y = Y(st.lat);
      const primary = SUBWAY[st.lines[0]];
      const g = svgEl('g', { class: 'map-stn', 'data-station': st.name },
        svgEl('title', {}, st.name),
        svgEl('circle', { cx: x, cy: y, r: 17, fill: 'transparent' }));
      if (st.name === 'Union') {
        g.append(
          svgEl('circle', { cx: x, cy: y, r: 22, fill: '#FBBF24', opacity: 0.24 }),
          svgEl('circle', { class: 'map-node', cx: x, cy: y, r: 13.5, fill: '#F59E0B', stroke: '#FFFFFF', 'stroke-width': 3.5 }),
          svgEl('circle', { cx: x, cy: y, r: 4.5, fill: '#0B0F17', 'pointer-events': 'none' }));
      } else if (st.hub) {
        g.append(
          svgEl('circle', { class: 'map-node', cx: x, cy: y, r: 7.8, fill: t.stationFill, stroke: primary.color, 'stroke-width': 3.6 }),
          svgEl('circle', { cx: x, cy: y, r: 2.4, fill: primary.color, 'pointer-events': 'none' }));
      } else {
        g.append(svgEl('circle', { class: 'map-node', cx: x, cy: y, r: 5.5, fill: t.stationFill, stroke: primary.color, 'stroke-width': 3 }));
      }
      const side = labelSide(st), off = st.name === 'Union' ? 24 : st.hub ? 14 : 11;
      let lx = side === 'left' ? x - off : side === 'right' ? x + off : x;
      const ly = side === 'top' ? y - off : side === 'bottom' ? y + off + 8 : y + 3.5;
      let anchor = side === 'left' ? 'end' : side === 'right' ? 'start' : 'middle';
      // Keep a centred label on the map instead of running off the edge.
      if (anchor === 'middle') {
        if (x < 70) { anchor = 'start'; lx = x + 12; }
        else if (x > W - 70) { anchor = 'end'; lx = x - 12; }
      }
      const label = svgEl('text', { class: 'map-label' + (st.hub ? ' hub' : ''), x: lx, y: ly, 'text-anchor': anchor, 'font-size': st.name === 'Union' ? 14.5 : st.hub ? 11.2 : 9.8, fill: t.text, stroke: t.canvas, 'stroke-width': 3.5 }, st.name);
      g.append(label);
      stns.append(g);
      stationEls.set(st.name, { g, label, lines: st.lines });
    }
    vp.append(stns);
    vp.append(svgEl('rect', { x: 0, y: 0, width: W, height: H, fill: 'url(#map-vig)', 'pointer-events': 'none' }));
    svg.append(defs, vp);
    svg._radar = radar;
    if (old) old.remove();
    full.prepend(svg);
    attachPointerHandlers();
    applyHighlight();
    renderRadar();
    updateLabels();
  }

  function renderRadar() {
    if (!svg || !svg._radar) return;
    svg._radar.replaceChildren();
    if (!selected) return;
    const st = selected;
    const color = st.name === 'Union' ? '#FBBF24' : SUBWAY[st.lines[0]].color;
    const r = st.name === 'Union' ? 18 : 11;
    for (const cls of ['map-radar', 'map-radar d2']) {
      svg._radar.append(svgEl('circle', { cx: X(st.lng), cy: Y(st.lat), r, fill: 'none', stroke: color, 'stroke-width': 2.5, class: cls }));
    }
  }

  // ---- pointer: drag pan, pinch zoom, wheel zoom, tap vs drag ----
  function attachPointerHandlers() {
    svg.addEventListener('pointerdown', e => {
      cancelAnim();
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      try { svg.setPointerCapture(e.pointerId); } catch {}
      if (pointers.size === 1) dragStart = { x: e.clientX, y: e.clientY, cam: { ...cam }, moved: false };
      else if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinchStart = { dist: Math.hypot(b.x - a.x, b.y - a.y), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
        dragStart = null;
      }
    });
    svg.addEventListener('pointermove', e => {
      if (!pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 1 && dragStart) {
        const k = cam.w / svg.getBoundingClientRect().width;
        const dx = (e.clientX - dragStart.x) * k, dy = (e.clientY - dragStart.y) * k;
        if (Math.hypot(e.clientX - dragStart.x, e.clientY - dragStart.y) > 6) dragStart.moved = true;
        cam.x = clamp(dragStart.cam.x - dx, 0, W - cam.w);
        cam.y = clamp(dragStart.cam.y - dy, 0, H - (cam.w * H / W));
        applyVb();
      } else if (pointers.size === 2 && pinchStart) {
        const [a, b] = [...pointers.values()];
        const dist = Math.hypot(b.x - a.x, b.y - a.y);
        const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
        if (dist > 0) {
          const mid = clientToSvg(cx, cy);
          zoomAt(pinchStart.dist / dist, mid.x, mid.y);
          const k = cam.w / svg.getBoundingClientRect().width;
          cam.x = clamp(cam.x - (cx - pinchStart.cx) * k, 0, W - cam.w);
          cam.y = clamp(cam.y - (cy - pinchStart.cy) * k, 0, H - (cam.w * H / W));
          applyVb();
          pinchStart = { dist, cx, cy };
        }
      }
    });
    // Taps are detected here, not on click: pointer capture retargets the
    // click to the svg, so a click handler on the station group never fires.
    const endPointer = e => {
      const wasTap = dragStart && !dragStart.moved && pointers.size === 1;
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinchStart = null;
      if (pointers.size === 0) dragStart = null;
      if (wasTap) {
        const g = document.elementFromPoint(e.clientX, e.clientY)?.closest('g.map-stn');
        if (g) {
          // Downtown stations sit 300-400 m apart, so their hit circles
          // overlap and the topmost group is not always the one the finger
          // meant. Pick the station nearest the tap instead.
          const p = clientToSvg(e.clientX, e.clientY);
          let best = null, bd = Infinity;
          for (const st of stations) {
            const d = Math.hypot(X(st.lng) - p.x, Y(st.lat) - p.y);
            if (d < bd) { bd = d; best = st; }
          }
          if (best && bd < 30) selectStation(best);
        }
      }
    };
    svg.addEventListener('pointerup', endPointer);
    svg.addEventListener('pointercancel', endPointer);
    svg.addEventListener('wheel', e => {
      e.preventDefault();
      cancelAnim();
      const p = clientToSvg(e.clientX, e.clientY);
      zoomAt(e.deltaY < 0 ? 0.86 : 1.16, p.x, p.y);
    }, { passive: false });
  }

  // ---- selection + drawer ----
  function selectStation(st, zoom = true) {
    selected = st;
    applyHighlight();
    renderRadar();
    updateLabels();
    if (zoom) focusStation(st);
    fillDrawer(st);
  }
  async function loadDeps() {
    if (!selected) return;
    const line = activeLine();
    try { deps = await fetchDepartures({ kind: 'subway', codes: selected.codes, line }); depErr = null; }
    catch (e) { deps = []; depErr = e; }
    drawDeps();
  }
  function drawDeps() {
    const now = Date.now();
    clockEl.textContent = fmtClock(now);
    if (!selected) return;
    if (depErr) { depsEl.replaceChildren(h('p', { class: 'note' }, errorText(depErr))); return; }
    const list = deps.filter(d => d.ts > now - 30000).slice(0, 5);
    if (!list.length) { depsEl.replaceChildren(h('p', { class: 'note' }, 'No departures in the next little while.')); return; }
    depsEl.replaceChildren(...list.map(d => {
      const m = minsUntil(d.ts, now);
      return h('div', { class: 'dep' },
        h('span', { class: 'code', style: `background:${SUBWAY[d.line]?.color || '#555555'}` }, d.line || '?'),
        h('div', { class: 'main' },
          h('div', { class: 'dest' }, d.dest || d.lineName || ''),
          h('div', { class: 'meta' }, fmtClock(d.ts))),
        h('span', { class: 'mins' }, m <= 0 ? 'Now' : m + ' min'));
    }));
  }
  function activeLine() {
    if (!selected) return null;
    return filter !== 'ALL' && selected.lines.includes(filter) ? filter : selected.lines[0];
  }
  function fillDrawer(st) {
    const line = activeLine();
    hubBadge.hidden = !(st.name === 'Union' || st.lines.length > 1);
    hubBadge.textContent = st.name === 'Union' ? 'Central hub' : 'Multi-line';
    drawerName.textContent = st.name;
    linePills.replaceChildren(...st.lines.map(id => h('span', { class: 'linepill', style: `background:${SUBWAY[id].color}` }, SUBWAY[id].name)));
    const order = lines[line].stations.map(s => s.name);
    const idx = order.indexOf(st.name);
    prevBtn.disabled = idx <= 0;
    nextBtn.disabled = idx < 0 || idx >= order.length - 1;
    prevBtn.textContent = idx > 0 ? '← ' + order[idx - 1] : 'Line end';
    nextBtn.textContent = idx >= 0 && idx < order.length - 1 ? order[idx + 1] + ' →' : 'Line end';
    prevBtn.onclick = idx > 0 ? () => selectStation(byName[order[idx - 1]]) : null;
    nextBtn.onclick = idx >= 0 && idx < order.length - 1 ? () => selectStation(byName[order[idx + 1]]) : null;
    boardBtn.style.background = SUBWAY[line].color;
    boardBtn.onclick = () => {
      state.ttc = { line, station: { name: st.name, lat: st.lat, lng: st.lng, codes: st.codes }, dir: null };
      save(); ctx.navigate('board');
    };
    drawer.hidden = false;
    deps = []; depErr = null; drawDeps();
    clearInterval(depTimer); clearInterval(depTick);
    depTimer = setInterval(loadDeps, REFRESH_MS);
    depTick = setInterval(drawDeps, 1000);
    loadDeps();
  }
  function closeDrawer() {
    drawer.hidden = true;
    clearInterval(depTimer); clearInterval(depTick);
    // The radar stays on the station the board is set to, if any.
    selected = state.ttc.station?.name ? byName[state.ttc.station.name] || null : null;
    applyHighlight(); renderRadar(); updateLabels();
  }

  // ---- data ----
  async function load() {
    let res;
    try { res = await (await fetch('data/ttc-lines.json')).json(); }
    catch {
      full.replaceChildren(h('p', { class: 'note' }, 'Could not load the TTC map.'));
      return;
    }
    lines = res.lines; // the file wraps the lines object in a top-level "lines" key
    // The GTFS names the Bloor-Yonge interchange "Bloor" on Line 1 and
    // "Yonge" on Line 2. Normalise both to the name everyone uses, so the
    // two dots merge into one hub instead of landing 78 m apart.
    const displayName = (line, name) =>
      (line === '1' && name === 'Bloor') || (line === '2' && name === 'Yonge') ? 'Bloor-Yonge' : name;
    for (const id of LINE_ORDER) {
      for (const s of lines[id].stations) s.name = displayName(id, s.name);
    }
    const seen = new Map();
    for (const id of LINE_ORDER) {
      for (const s of lines[id].stations) {
        const cur = seen.get(s.name);
        if (!cur) seen.set(s.name, { ...s, lines: [id] });
        else {
          if (!cur.lines.includes(id)) cur.lines.push(id);
          // A hub's departures cover every line that serves it, and its
          // dot sits between the two tracks.
          cur.codes = [...new Set([...cur.codes, ...s.codes])];
          cur.lat = (cur.lat + s.lat) / 2; cur.lng = (cur.lng + s.lng) / 2;
        }
      }
    }
    stations = [...seen.values()];
    byName = Object.fromEntries(stations.map(s => [s.name, s]));
    for (const id of LINE_ORDER) {
      const list = lines[id].stations;
      byName[list[0].name].terminus = true;
      byName[list[list.length - 1].name].terminus = true;
    }
    for (const st of stations) st.hub = st.lines.length > 1 || st.name === 'Union';
    const pts = Object.values(lines).flatMap(l => [...l.shape, ...l.stations.map(s => [s.lat, s.lng])]);
    const lats = pts.map(p => p[0]), lngs = pts.map(p => p[1]);
    latMin = Math.min(...lats); latMax = Math.max(...lats);
    const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
    const kx = Math.cos(((latMin + latMax) / 2) * Math.PI / 180);
    const pad = 0.03;
    const x0 = minLng - (maxLng - minLng) * pad, x1 = maxLng + (maxLng - minLng) * pad;
    const y0 = latMin - (latMax - latMin) * pad, y1 = latMax + (latMax - latMin) * pad;
    const xSpan = (x1 - x0) * kx, ySpan = y1 - y0;
    W = 1000; H = Math.round(1000 * ySpan / xSpan);
    X = lng => ((lng - x0) * kx / xSpan) * W;
    Y = lat => (1 - (lat - y0) / ySpan) * H;
    cam = { x: 0, y: 0, w: W };
    if (state.ttc.station?.name && byName[state.ttc.station.name]) selected = byName[state.ttc.station.name];
    renderSvg();
  }
  load();

  return { unmount() {
    cancelAnim();
    clearInterval(depTimer); clearInterval(depTick);
    document.removeEventListener('click', closeDrop);
    docStyle.removeProperty('--bar-bg');
    docStyle.removeProperty('--bar-fg');
    docStyle.removeProperty('--sheet-bg');
    docStyle.removeProperty('--sheet-fg');
    header.titleBtn.onclick = header.dirBtn.onclick = null;
  } };
}
