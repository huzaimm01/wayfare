import { h, fmtClock, minsUntil, setText } from './util.js';
import { fetchDepartures } from './data.js';
import { GO_LINES, REFRESH_MS } from './config.js';
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

// Dark cartography in the reference style, but with the real GTFS track
// shapes, real stations, and real live departures in the drawer. No legend,
// no simulated trains, no attribution microcopy on the map itself: the
// Metrolinx credit lives in the station drawer.
const MAP_THEMES = {
  dark: {
    canvas: '#0B0F17', grid: 'rgba(255,255,255,0.035)', gridMajor: 'rgba(255,255,255,0.06)',
    water: '#071929', waterStroke: '#123654', text: '#F8FAFC', sub: '#94A3B8', muted: '#64748B',
    stationFill: '#0B0F17', bar: 'rgba(11,15,23,.72)', barFg: '#ffffff',
    sheet: 'rgba(17,24,39,0.88)', sheetFg: '#F8FAFC', logo: 'assets/go-white.svg'
  },
  light: {
    canvas: '#F4F5F7', grid: 'rgba(15,23,42,0.045)', gridMajor: 'rgba(15,23,42,0.08)',
    water: '#DCEBF7', waterStroke: '#B8D6EE', text: '#0F172A', sub: '#475569', muted: '#64748B',
    stationFill: '#FFFFFF', bar: 'rgba(255,255,255,.8)', barFg: '#0F172A',
    sheet: 'rgba(255,255,255,0.92)', sheetFg: '#0F172A', logo: 'assets/go.svg'
  }
};
const LINE_ORDER = ['LW', 'LE', 'MI', 'KI', 'BR', 'RH', 'ST', 'UP'];
const ease = t => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export function mountGoMap(ctx) {
  const { state, root, header, save } = ctx;
  root.className = 'map-view';
  setText(header.title, 'GO lines'); setText(header.dir, '·');
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
  let lines = null, zones = {}, transfers = {};
  let stations = [], byCode = {};
  let latMin = 0, latMax = 0;
  let filter = 'ALL';
  let selected = null;
  let W = 1000, H = 1000;
  let X = () => 0, Y = () => 0;
  let cam = { x: 0, y: 0, w: W };
  let animId = 0, depTimer = 0, depTick = 0;
  let flingId = 0, lastHitR = -1;
  let moveHist = [];
  let deps = [], depErr = null;
  let svg = null, trackEls = [], stationEls = new Map();
  const pointers = new Map();
  let dragStart = null, pinchStart = null;

  // ---- floating overlays (pills come from config, so they render now) ----
  const searchWrap = h('div', { class: 'map-search-wrap' });
  const input = h('input', { type: 'search', autocomplete: 'off', spellcheck: 'false', placeholder: 'Search a GO station', 'aria-label': 'Search a GO station' });
  const clr = h('button', { class: 'clr', type: 'button', 'aria-label': 'Clear search', hidden: true }, '✕');
  const drop = h('div', { class: 'map-drop', hidden: true });
  searchWrap.append(h('div', { class: 'map-search' }, h('span', { class: 'mag', 'aria-hidden': 'true' }, '⌕'), input, clr), drop);
  const pills = h('div', { class: 'map-pills' });
  // Fade the right edge so a pill cut off by the scroll reads as intentional
  // scrolling instead of a broken clip.
  pills.style.maskImage = 'linear-gradient(to right, #000 0, #000 calc(100% - 30px), transparent 100%)';
  pills.style.webkitMaskImage = 'linear-gradient(to right, #000 0, #000 calc(100% - 30px), transparent 100%)';
  const top = h('div', { class: 'map-top' }, searchWrap, pills);
  const zoomBox = h('div', { class: 'map-zoom' },
    h('button', { type: 'button', 'aria-label': 'Zoom in', onclick: () => zoomAt(0.7, cam.x + cam.w / 2, cam.y + (cam.w * H / W) / 2) }, '+'),
    h('button', { type: 'button', 'aria-label': 'Zoom out', onclick: () => zoomAt(1.4, cam.x + cam.w / 2, cam.y + (cam.w * H / W) / 2) }, '−'),
    h('button', { type: 'button', 'aria-label': 'Reset view', onclick: resetView }, '↺'));
  const themeBtn = h('button', { class: 'map-theme', type: 'button', 'aria-label': 'Switch map theme' }, state.mapTheme === 'dark' ? '☀' : '☾');

  // ---- station drawer (filled per station) ----
  const zoneBadge = h('span', { class: 'badge' });
  const hubBadge = h('span', { class: 'badge' });
  const drawerName = h('h2', {}, 'Station');
  const linePills = h('div', { class: 'linepills' });
  const transferPills = h('div', { class: 'tpills' });
  const transfersSec = h('div', {}, h('p', { class: 'sec' }, 'Connections'), transferPills);
  const clockEl = h('span', { class: 'sub' }, '');
  const depsEl = h('div', {});
  const boardBtn = h('button', { class: 'board-btn', type: 'button' }, 'Board here');
  const prevBtn = h('button', { type: 'button' }, 'Line end');
  const nextBtn = h('button', { type: 'button' }, 'Line end');
  const drawer = h('div', { class: 'map-drawer', hidden: true },
    h('button', { class: 'close', type: 'button', 'aria-label': 'Close station details', onclick: closeDrawer }, '✕'),
    h('div', {}, zoneBadge, hubBadge),
    drawerName,
    linePills,
    transfersSec,
    h('div', { style: 'display:flex;justify-content:space-between;align-items:baseline' }, h('p', { class: 'sec' }, 'Live departures'), clockEl),
    depsEl,
    boardBtn,
    h('div', { class: 'stepper' }, prevBtn, nextBtn),
    h('p', { class: 'note small credit' }, 'Line shapes: Metrolinx GO GTFS. Data used with the permission of Metrolinx.'));
  full.append(top, zoomBox, themeBtn, drawer);

  // ---- filter pills ----
  function paintPills() {
    let activeBtn = null;
    for (const b of pills.children) {
      const id = b.dataset.line, on = id === filter;
      b.setAttribute('aria-pressed', String(on));
      if (on) activeBtn = b;
      if (on && id !== 'ALL') {
        b.style.background = GO_LINES[id].color; b.style.color = '#fff';
        if (b._dot) b._dot.style.background = '#fff';
      } else {
        b.style.background = ''; b.style.color = '';
        if (b._dot) b._dot.style.background = GO_LINES[id].color;
      }
    }
    // Keep the active pill fully in view instead of clipped off the edge.
    if (activeBtn) activeBtn.scrollIntoView({ behavior: 'smooth', inline: 'nearest', block: 'nearest' });
  }
  function buildPills() {
    const mk = id => {
      const color = id === 'ALL' ? null : GO_LINES[id].color;
      const dot = color ? h('span', { class: 'dot', style: `background:${color}` }) : null;
      const b = h('button', { class: 'map-pill', type: 'button' }, dot, id === 'ALL' ? 'All lines' : GO_LINES[id].name);
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
    if (id === 'ALL') animateCameraTo(0, 0, W, 550);
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
    // Stations starting with the query come first, so "Milton" beats "Hamilton".
    const hits = stations.filter(s => s.name.toLowerCase().includes(q))
      .sort((a, b) => (a.name.toLowerCase().startsWith(q) ? 0 : 1) - (b.name.toLowerCase().startsWith(q) ? 0 : 1))
      .slice(0, 8);
    drop.replaceChildren(...hits.map(s => h('button', { type: 'button', onclick: () => {
      input.value = s.name; drop.hidden = true; clr.hidden = false;
      selectStation(s);
    } }, h('span', {}, s.name), h('span', { class: 'codes' }, ...s.lines.map(id => h('span', { class: 'code', style: `background:${lines[id].color}` }, id))))));
    drop.hidden = !hits.length;
  };
  input.addEventListener('input', drawDrop);
  input.addEventListener('focus', drawDrop);
  clr.onclick = () => { input.value = ''; clr.hidden = true; drop.hidden = true; input.focus(); };
  const closeDrop = e => { if (!searchWrap.contains(e.target)) drop.hidden = true; };
  document.addEventListener('click', closeDrop);

  // ---- camera ----
  // Keep the tap target about 19 CSS px on screen at any zoom; the visible
  // station dot stays the same size. Only rewrites when the radius moved.
  function updateHitRadii() {
    if (!svg) return;
    const w = svg.getBoundingClientRect().width;
    if (!w) return;
    const r = 19 * cam.w / w;
    if (Math.abs(r - lastHitR) < 0.5) return;
    lastHitR = r;
    for (const el of stationEls.values()) el.hit.setAttribute('r', r.toFixed(1));
  }
  function applyVb() {
    if (!svg) return;
    svg.setAttribute('viewBox', `${cam.x} ${cam.y} ${cam.w} ${cam.w * H / W}`);
    updateHitRadii();
  }
  function clampCam() {
    cam.w = clamp(cam.w, 140, W);
    cam.x = clamp(cam.x, 0, W - cam.w);
    cam.y = clamp(cam.y, 0, H - (cam.w * H / W));
  }
  function cancelAnim() {
    if (animId) { cancelAnimationFrame(animId); animId = 0; }
    if (flingId) { cancelAnimationFrame(flingId); flingId = 0; }
  }
  // Momentum after a drag: keep the camera gliding and ease it to a stop.
  // vx/vy are camera velocity in SVG units per ms.
  function startFling(vx, vy) {
    cancelAnim();
    const speed = Math.hypot(vx, vy);
    if (speed < 0.05) return;
    const cap = 4, k = Math.min(1, cap / speed);
    vx *= k; vy *= k;
    let last = performance.now();
    const step = now => {
      const dt = Math.min(now - last, 50);
      last = now;
      cam.x += vx * dt;
      cam.y += vy * dt;
      const f = Math.pow(0.90, dt / 16.7);
      vx *= f; vy *= f;
      clampCam();
      applyVb();
      // Pin the velocity component that is pushing into a bound, so the
      // other axis can keep gliding.
      if (cam.x === 0 && vx < 0) vx = 0;
      if (cam.x === W - cam.w && vx > 0) vx = 0;
      if (cam.y === 0 && vy < 0) vy = 0;
      if (cam.y === H - (cam.w * H / W) && vy > 0) vy = 0;
      if (Math.hypot(vx, vy) < 0.02) { flingId = 0; return; }
      flingId = requestAnimationFrame(step);
    };
    flingId = requestAnimationFrame(step);
  }
  function animateCameraTo(tx, ty, tw, dur = 550) {
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
    animateCameraTo(clamp(cx - w / 2, 0, W - w), clamp(cy - (w * H / W) / 2, 0, H - (w * H / W)), w, 550);
  }
  function focusStation(st) {
    const sx = X(st.lng), sy = Y(st.lat);
    const r = full.getBoundingClientRect();
    const tw = Math.min(W, 360);
    const s = Math.min(r.width / tw, r.height / (tw * H / W));
    const desktop = window.matchMedia('(min-width:641px) and (hover:hover) and (pointer:fine)').matches;
    const cx = desktop ? sx + 190 / s : sx;
    const cy = desktop ? sy : sy + (0.18 * r.height) / s;
    animateCameraTo(clamp(cx - tw / 2, 0, W - tw), clamp(cy - (tw * H / W) / 2, 0, H - (tw * H / W)), tw, 500);
  }

  // ---- labels ----
  function labelPos(st) {
    if (st.lines.includes('BR')) return 'left';
    if (st.lines.includes('RH') || st.lines.includes('ST')) return 'right';
    if (st.lat < latMin + (latMax - latMin) * 0.12) return 'top';
    return 'bottom';
  }
  function updateLabels() {
    if (!lines) return;
    for (const st of stations) {
      const el = stationEls.get(st.code);
      if (!el) continue;
      // At the full-network zoom only Union and the termini are labelled, so
      // the Toronto cluster stays readable. Hub labels appear when you zoom
      // in, and a filtered line labels all its own stations. Pearson is a UP
      // terminus, so it would be labelled at full zoom and collide with
      // Union Station: hide UP-only termini until zoomed in or the UP line
      // is filtered. Union always stays.
      const upTerminus = st.code !== 'UN' && st.terminus && st.lines.length === 1 && st.lines[0] === 'UP';
      const show = st.code === 'UN' || (st.terminus && !upTerminus) || (filter !== 'ALL' && st.lines.includes(filter)) || cam.w < 420;
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
    for (const [code, el] of stationEls) {
      const on = !hasFocus || code === selected?.code || el.lines.some(l => active.has(l));
      el.g.style.opacity = on ? '' : '0.22';
    }
  }

  // ---- lake, from the real Lakeshore stations ----
  function lakePath() {
    if (!lines || !byCode['UN']) return '';
    const un = byCode['UN'];
    // The Lakeshore track shapes jitter and dip inland around Hamilton
    // (Confederation station sits well south of the shore), which made a
    // binned/smoothed shoreline zigzag. The stations sit on the shore, so
    // build the shoreline from them: a median filter drops the inland
    // outlier, a moving average keeps it smooth.
    const pts = [];
    for (const s of lines['LW'].stations) if (s.lng < un.lng - 0.01) pts.push([s.lat, s.lng]);
    for (const s of lines['LE'].stations) if (s.lng > un.lng + 0.01) pts.push([s.lat, s.lng]);
    pts.sort((a, b) => a[1] - b[1]);
    if (pts.length < 2) return '';
    const shore = pts.map(([la, lo]) => [X(lo), Y(la) + 46]);
    const med = shore.map((p, i) => {
      const ys = [];
      for (let j = Math.max(0, i - 2); j <= Math.min(shore.length - 1, i + 2); j++) ys.push(shore[j][1]);
      ys.sort((a, b) => a - b);
      return [p[0], ys[Math.floor(ys.length / 2)]];
    });
    const sm = med.map((p, i) => {
      let sx = 0, sy = 0, n = 0;
      for (let j = Math.max(0, i - 1); j <= Math.min(med.length - 1, i + 1); j++) { sx += med[j][0]; sy += med[j][1]; n++; }
      return [sx / n, sy / n];
    });
    // Smooth curve through the shoreline points (Catmull-Rom to Bezier),
    // then straight down the right edge and along the bottom.
    const d = [`M ${sm[0][0].toFixed(1)},${sm[0][1].toFixed(1)}`];
    for (let i = 0; i < sm.length - 1; i++) {
      const p0 = sm[Math.max(0, i - 1)], p1 = sm[i], p2 = sm[i + 1], p3 = sm[Math.min(sm.length - 1, i + 2)];
      const c1x = p1[0] + (p2[0] - p0[0]) / 6, c1y = p1[1] + (p2[1] - p0[1]) / 6;
      const c2x = p2[0] - (p3[0] - p1[0]) / 6, c2y = p2[1] - (p3[1] - p1[1]) / 6;
      d.push(`C ${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`);
    }
    const last = sm[sm.length - 1], first = sm[0];
    d.push(`L ${W},${last[1].toFixed(1)} L ${W},${H} L ${first[0].toFixed(1)},${H} Z`);
    return d.join(' ');
  }

  // ---- render ----
  function renderSvg() {
    if (!lines) return;
    lastHitR = -1;
    const t = theme;
    const old = svg;
    svg = svgEl('svg', { class: 'map-canvas', role: 'img', 'aria-label': 'GO train network map' });
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
    const lake = lakePath();
    if (lake) vp.append(svgEl('path', { d: lake, fill: t.water, stroke: t.waterStroke, 'stroke-width': 1.5, 'stroke-linejoin': 'round' }));
    const tracks = svgEl('g', {});
    trackEls = [];
    for (const id of LINE_ORDER) {
      const l = lines[id];
      const pts = l.shape.map(([la, lo]) => `${X(lo).toFixed(1)},${Y(la).toFixed(1)}`).join(' ');
      const casing = svgEl('polyline', { points: pts, class: 'map-track map-track-casing', stroke: l.color, 'stroke-width': 9.5 });
      const main = svgEl('polyline', { points: pts, class: 'map-track', stroke: l.color, 'stroke-width': 5.5 });
      if (id === 'UP') main.setAttribute('stroke-dasharray', '7 5');
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
      const primary = lines[st.lines[0]];
      const hit = svgEl('circle', { cx: x, cy: y, r: 17, fill: 'transparent' });
      const g = svgEl('g', { class: 'map-stn', 'data-station': st.code },
        svgEl('title', {}, st.name), hit);
      if (st.code === 'UN') {
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
      const pos = labelPos(st), off = st.code === 'UN' ? 24 : st.hub ? 14 : 11;
      let lx = pos === 'left' ? x - off : pos === 'right' ? x + off : x;
      const ly = pos === 'top' ? y - off : pos === 'bottom' ? y + off + 8 : y + 3.5;
      let anchor = pos === 'left' ? 'end' : pos === 'right' ? 'start' : 'middle';
      // Keep a centred label on the map instead of running off the edge.
      if (anchor === 'middle') {
        if (x < 70) { anchor = 'start'; lx = x + 12; }
        else if (x > W - 70) { anchor = 'end'; lx = x - 12; }
      }
      const label = svgEl('text', { class: 'map-label' + (st.hub ? ' hub' : ''), x: lx, y: ly, 'text-anchor': anchor, 'font-size': st.code === 'UN' ? 14.5 : st.hub ? 11.2 : 9.8, fill: t.text, stroke: t.canvas, 'stroke-width': 3.5 }, st.name);
      g.append(label);
      stns.append(g);
      stationEls.set(st.code, { g, label, lines: st.lines, hit });
    }
    vp.append(stns);
    vp.append(svgEl('rect', { x: 0, y: 0, width: W, height: H, fill: 'url(#map-vig)', 'pointer-events': 'none' }));
    svg.append(defs, vp);
    svg._radar = radar;
    if (old) old.remove();
    full.prepend(svg);
    updateHitRadii();
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
    const color = st.code === 'UN' ? '#FBBF24' : lines[st.lines[0]].color;
    const r = st.code === 'UN' ? 18 : 11;
    for (const cls of ['map-radar', 'map-radar d2']) {
      svg._radar.append(svgEl('circle', { cx: X(st.lng), cy: Y(st.lat), r, fill: 'none', stroke: color, 'stroke-width': 2.5, class: cls }));
    }
  }

  // ---- pointer: drag pan, pinch zoom, wheel zoom, tap vs drag ----
  function attachPointerHandlers() {
    svg.addEventListener('pointerdown', e => {
      cancelAnim();
      moveHist = [{ t: performance.now(), x: e.clientX, y: e.clientY }];
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
        moveHist.push({ t: performance.now(), x: e.clientX, y: e.clientY });
        if (moveHist.length > 8) moveHist.shift();
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
      const wasDrag = dragStart && dragStart.moved;
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinchStart = null;
      if (pointers.size === 0) dragStart = null;
      if (wasTap) {
        const g = document.elementFromPoint(e.clientX, e.clientY)?.closest('g.map-stn');
        if (g) {
          // The hit circles are ~19px on screen, so in the Union cluster
          // they overlap and the topmost group is not always the one the
          // finger meant. Pick the station nearest the tap instead, as
          // long as it is inside the current hit radius.
          const p = clientToSvg(e.clientX, e.clientY);
          let best = null, bd = Infinity;
          for (const st of stations) {
            const d = Math.hypot(X(st.lng) - p.x, Y(st.lat) - p.y);
            if (d < bd) { bd = d; best = st; }
          }
          if (best && bd <= lastHitR) selectStation(best);
        }
      } else if (wasDrag && pointers.size === 0) {
        // Fling from the last ~120ms of pointer movement; the camera moves
        // opposite the pointer, so the velocity is negated.
        const now = performance.now();
        const recent = moveHist.filter(p => now - p.t <= 120);
        if (recent.length >= 2) {
          const a = recent[0], b = recent[recent.length - 1];
          const dt = b.t - a.t;
          if (dt > 0) {
            const k = cam.w / svg.getBoundingClientRect().width;
            startFling(-(b.x - a.x) / dt * k, -(b.y - a.y) / dt * k);
          }
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
    try { deps = await fetchDepartures({ kind: 'go', code: selected.code }); depErr = null; }
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
        h('span', { class: 'code', style: `background:${GO_LINES[d.line]?.color || '#555555'}` }, d.line || '?'),
        h('div', { class: 'main' },
          h('div', { class: 'dest' }, d.dest || d.lineName || ''),
          h('div', { class: 'meta' }, [d.platform ? 'Platform ' + d.platform : null, fmtClock(d.ts)].filter(Boolean).join(' · '))),
        h('span', { class: 'mins' }, m <= 0 ? 'Now' : m + ' min'));
    }));
  }
  function fillDrawer(st) {
    const primary = lines[st.lines[0]];
    zoneBadge.hidden = !zones[st.code];
    if (zones[st.code]) zoneBadge.textContent = 'Fare Zone ' + zones[st.code];
    hubBadge.hidden = !(st.code === 'UN' || st.lines.length > 1);
    hubBadge.textContent = st.code === 'UN' ? 'Central hub' : 'Multi-line';
    drawerName.textContent = st.name;
    linePills.replaceChildren(...st.lines.map(id => h('span', { class: 'linepill', style: `background:${lines[id].color}` }, lines[id].name)));
    const tr = transfers[st.code] || [];
    transfersSec.hidden = !tr.length;
    transferPills.replaceChildren(...tr.map(t => h('span', { class: 'tpill' }, t)));
    const activeLine = filter !== 'ALL' && st.lines.includes(filter) ? filter : st.lines[0];
    const order = lines[activeLine].stations.map(s => s.code);
    const idx = order.indexOf(st.code);
    prevBtn.disabled = idx <= 0;
    nextBtn.disabled = idx < 0 || idx >= order.length - 1;
    prevBtn.textContent = idx > 0 ? '← ' + byCode[order[idx - 1]].name : 'Line end';
    nextBtn.textContent = idx >= 0 && idx < order.length - 1 ? byCode[order[idx + 1]].name + ' →' : 'Line end';
    prevBtn.onclick = idx > 0 ? () => selectStation(byCode[order[idx - 1]]) : null;
    nextBtn.onclick = idx >= 0 && idx < order.length - 1 ? () => selectStation(byCode[order[idx + 1]]) : null;
    boardBtn.style.background = primary.color;
    boardBtn.onclick = () => {
      state.go = { stop: { code: st.code, name: st.name, lat: st.lat, lng: st.lng }, line: null, dir: null };
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
    selected = state.go.stop?.code ? byCode[state.go.stop.code] || null : null;
    applyHighlight(); renderRadar(); updateLabels();
  }

  // ---- data ----
  async function load() {
    let res;
    try {
      const [a, b, c] = await Promise.all([
        fetch('data/go-lines.json'), fetch('data/go-fares.json'), fetch('data/network.json')
      ]);
      res = { lines: await a.json(), fares: await b.json(), net: await c.json() };
    } catch {
      full.replaceChildren(h('p', { class: 'note' }, 'Could not load the GO map.'));
      return;
    }
    lines = res.lines.lines; // the file wraps the lines object in a top-level "lines" key
    zones = res.fares.zoneOf || {};
    for (const e of res.net.edges || []) {
      if (e.mode === 'transfer' && typeof e.a === 'string' && e.a.startsWith('go:')) {
        const m = /^ttc:(\d+):/.exec(e.b || '');
        if (m) (transfers[e.a.slice(3)] ||= []).push('TTC Line ' + m[1]);
      }
    }
    const seen = new Map();
    for (const id of LINE_ORDER) {
      for (const s of lines[id].stations) {
        // The GTFS calls it "Union"; everyone calls it Union Station.
        if (!seen.has(s.code)) seen.set(s.code, { ...s, name: s.code === 'UN' ? 'Union Station' : s.name, lines: [id] });
        else if (!seen.get(s.code).lines.includes(id)) seen.get(s.code).lines.push(id);
      }
    }
    stations = [...seen.values()];
    byCode = Object.fromEntries(stations.map(s => [s.code, s]));
    for (const id of LINE_ORDER) {
      const list = lines[id].stations;
      byCode[list[0].code].terminus = true;
      byCode[list[list.length - 1].code].terminus = true;
    }
    for (const st of stations) st.hub = st.lines.length > 1 || !!transfers[st.code];
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
    if (state.go.stop?.code && byCode[state.go.stop.code]) selected = byCode[state.go.stop.code];
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
