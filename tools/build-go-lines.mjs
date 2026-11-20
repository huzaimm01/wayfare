// Builds data/go-lines.json from the Metrolinx GO GTFS feed.
// Usage: node tools/build-go-lines.mjs /path/to/unzipped-gtfs-folder
// Needs Node 18+. Streams the big files so memory stays small.
// Output: one entry per GO train line with the real track shape (simplified)
// and its stations in order along the line, with the Metrolinx stop codes
// the live API uses (UN, ML, ...). Colours are the app's line colours, not
// the feed's route_color values.
import { createReadStream } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import readline from 'node:readline';
import path from 'node:path';

const dir = process.argv[2];
if (!dir) { console.error('usage: node tools/build-go-lines.mjs <unzipped-gtfs-folder>'); process.exit(1); }

function splitCsv(line) {
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
    else if (c === '"') q = true; else if (c === ',') { out.push(cur); cur = ''; } else cur += c;
  }
  out.push(cur); return out;
}
async function* rows(file) {
  const rl = readline.createInterface({ input: createReadStream(path.join(dir, file)), crlfDelay: Infinity });
  let head = null;
  for await (const line of rl) {
    if (!line.trim()) continue;
    const cells = splitCsv(line);
    if (!head) { head = cells.map(c => c.replace(/^\uFEFF/, '').trim()); continue; }
    yield Object.fromEntries(head.map((k, i) => [k, cells[i]]));
  }
}

// Line colours from the app (and the original concept), not the feed.
const LINES = {
  LW: { name: 'Lakeshore West', color: '#AD1A46' },
  LE: { name: 'Lakeshore East', color: '#DA291C' },
  MI: { name: 'Milton', color: '#FF8200' },
  KI: { name: 'Kitchener', color: '#007A33' },
  RH: { name: 'Richmond Hill', color: '#0096C3' },
  ST: { name: 'Stouffville', color: '#8B5B29' },
  BR: { name: 'Barrie', color: '#0059B3' },
  UP: { name: 'UP Express', color: '#2688C7' },
};

const routeLine = new Map(); // route_id -> short name
for await (const r of rows('routes.txt')) {
  if (r.route_type === '2' && LINES[r.route_short_name]) routeLine.set(r.route_id, r.route_short_name);
}
if (!routeLine.size) { console.error('No GO train routes found in routes.txt. Is this the GO feed?'); process.exit(1); }

const tripRoute = new Map(); // trip_id -> line
const lineShapes = new Map(); // line -> Set(shape_id)
for await (const t of rows('trips.txt')) {
  const line = routeLine.get(t.route_id);
  if (!line || !t.shape_id) continue;
  tripRoute.set(t.trip_id, line);
  if (!lineShapes.has(line)) lineShapes.set(line, new Set());
  lineShapes.get(line).add(t.shape_id);
}
const wantedShapes = new Set([...lineShapes.values()].flatMap(s => [...s]));

// Stream shapes.txt, keeping every rail shape; the best one per line is
// chosen below, after stations are known.
const shapePts = new Map(); // shape_id -> [[lat, lng, seq]]
for await (const s of rows('shapes.txt')) {
  if (!wantedShapes.has(s.shape_id)) continue;
  if (!shapePts.has(s.shape_id)) shapePts.set(s.shape_id, []);
  shapePts.get(s.shape_id).push([Number(s.shape_pt_lat), Number(s.shape_pt_lon), Number(s.shape_pt_sequence)]);
}
for (const pts of shapePts.values()) pts.sort((a, b) => a[2] - b[2]);

// Stations served per line, from stop_times of the line's trips.
const lineStops = new Map(); // line -> Set(stop_id)
for await (const st of rows('stop_times.txt')) {
  const line = tripRoute.get(st.trip_id);
  if (!line) continue;
  if (!lineStops.has(line)) lineStops.set(line, new Set());
  lineStops.get(line).add(st.stop_id);
}

const stops = new Map();
for await (const s of rows('stops.txt')) stops.set(s.stop_id, s);

const cleanName = n => n.replace(/^UP Express /i, '').replace(/ GO\/UP$/i, '').replace(/ GO$/i, '').replace(/ Station$/i, '').trim();

// Douglas-Peucker on [lat, lng] pairs. Tolerance in degrees (~0.0006 = ~65 m).
function perpDist(p, a, b) {
  const dx = b[1] - a[1], dy = b[0] - a[0];
  const len2 = dx * dx + dy * dy;
  if (!len2) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  let t = ((p[1] - a[1]) * dx + (p[0] - a[0]) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * dy), p[1] - (a[1] + t * dx));
}
function simplify(pts, tol) {
  if (pts.length <= 2) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [i, j] = stack.pop();
    let dmax = 0, idx = -1;
    for (let k = i + 1; k < j; k++) {
      const d = perpDist(pts[k], pts[i], pts[j]);
      if (d > dmax) { dmax = d; idx = k; }
    }
    if (dmax > tol) { keep[idx] = 1; stack.push([i, idx], [idx, j]); }
  }
  return pts.filter((_, i) => keep[i]);
}

const out = { generated: new Date().toISOString(), source: 'Metrolinx GO GTFS, feed 20261117', lines: {} };
for (const line of lineShapes.keys()) {
  // Stations served by this line (train stations have 2-letter codes).
  const rawStations = [];
  for (const id of lineStops.get(line) || []) {
    if (!/^[A-Z]+$/.test(id)) continue; // train stations have letter codes (Pickering is PIN); buses are numeric
    const s = stops.get(id);
    if (!s) continue;
    rawStations.push({ code: id, name: cleanName(s.stop_name), lat: Number(s.stop_lat), lng: Number(s.stop_lon) });
  }
  // Best shape = the one that passes closest to the most stations
  // (a short-turn pattern only covers part of the line, so most-used is wrong).
  // Tie-break: the longer shape.
  let bestShape = null, bestCover = -1, bestLen = -1;
  for (const shapeId of lineShapes.get(line)) {
    const raw = (shapePts.get(shapeId) || []).map(([lat, lng]) => [lat, lng]);
    if (raw.length < 2) continue;
    let cover = 0;
    for (const st of rawStations) {
      let dmin = Infinity;
      for (const [la, lo] of raw) {
        const d = (la - st.lat) ** 2 + (lo - st.lng) ** 2;
        if (d < dmin) dmin = d;
      }
      if (Math.sqrt(dmin) < 0.005) cover++; // within ~500 m of the track
    }
    let len = 0;
    for (let i = 1; i < raw.length; i++) len += Math.hypot(raw[i][0] - raw[i - 1][0], raw[i][1] - raw[i - 1][1]);
    if (cover > bestCover || (cover === bestCover && len > bestLen)) {
      bestShape = raw; bestCover = cover; bestLen = len;
    }
  }
  if (!bestShape) { console.warn(`${line}: no usable shape`); continue; }
  const shape = simplify(bestShape, 0.0006).map(([lat, lng]) => [Math.round(lat * 1e5) / 1e5, Math.round(lng * 1e5) / 1e5]);
  // Order stations by nearest point on the shape, so they run along the line.
  const stations = rawStations.map(st => {
    let best = Infinity, bi = 0;
    shape.forEach(([la, lo], i) => {
      const d = (la - st.lat) ** 2 + (lo - st.lng) ** 2;
      if (d < best) { best = d; bi = i; }
    });
    return { ...st, _i: bi };
  }).sort((a, b) => a._i - b._i);
  stations.forEach(s => delete s._i);
  out.lines[line] = { name: LINES[line].name, color: LINES[line].color, stations, shape };
  console.log(`${line} ${LINES[line].name}: ${stations.length} stations, ${bestCover}/${rawStations.length} on shape, ${bestShape.length} shape pts -> ${shape.length}`);
}
await writeFile(new URL('../data/go-lines.json', import.meta.url), JSON.stringify(out));
console.log('Wrote data/go-lines.json');
