// Builds data/ttc-lines.json from the TTC GTFS feed (City of Toronto Open Data,
// "TTC Routes and Schedules"): one real track shape per subway line, with the
// line's stations ordered along that shape. This is the data the intertwined
// TTC+GO map picker will draw from.
// Usage: node tools/build-ttc-lines.mjs /path/to/unzipped-gtfs-folder
// Needs Node 18+.
import { createReadStream, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import readline from 'node:readline';
import path from 'node:path';

const dir = process.argv[2];
if (!dir) { console.error('usage: node tools/build-ttc-lines.mjs <unzipped-gtfs-folder>'); process.exit(1); }

function splitCsv(line) {
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
    else if (c === '"') q = true; else if (c === ',') { out.push(cur); cur = ''; } else cur += c;
  }
  out.push(cur); return out;
}
function readCsv(name) {
  const lines = readFileSync(path.join(dir, name), 'utf8').trim().split('\n');
  const head = splitCsv(lines[0]);
  return lines.slice(1).map(l => Object.fromEntries(head.map((h, i) => [h, splitCsv(l)[i] ?? ''])));
}

const LINES = ['1', '2', '4', '5', '6'];
const NAMES = { '1': 'Line 1 Yonge-University', '2': 'Line 2 Bloor-Danforth', '4': 'Line 4 Sheppard', '5': 'Line 5 Eglinton', '6': 'Line 6 Finch West' };
const COLORS = { '1': '#FFC800', '2': '#008741', '4': '#B4006E', '5': '#D24619', '6': '#898D8D' };

const subway = JSON.parse(readFileSync('data/ttc-subway.json', 'utf8')).lines;
const lineCodes = Object.fromEntries(LINES.map(ln => [ln, new Set(subway[ln].stations.flatMap(s => s.codes))]));

const routes = readCsv('routes.txt');
const routeId = Object.fromEntries(routes.filter(r => LINES.includes(r.route_short_name)).map(r => [r.route_short_name, r.route_id]));
const trips = readCsv('trips.txt');
const tripShape = new Map();
for (const t of trips) {
  if (Object.values(routeId).includes(t.route_id)) tripShape.set(t.trip_id, [t.route_id, t.shape_id]);
}

// Stream stop_times.txt (large): which stops each shape serves.
const shapeStops = new Map(); // "routeId|shapeId" -> Set(stop_id)
const rl = readline.createInterface({ input: createReadStream(path.join(dir, 'stop_times.txt')), crlfDelay: Infinity });
let head = null;
for await (const line of rl) {
  const cols = splitCsv(line);
  if (!head) { head = cols; continue; }
  const row = Object.fromEntries(head.map((h, i) => [h, cols[i] ?? '']));
  const ts = tripShape.get(row.trip_id);
  if (!ts) continue;
  const key = ts[0] + '|' + ts[1];
  if (!shapeStops.has(key)) shapeStops.set(key, new Set());
  shapeStops.get(key).add(row.stop_id);
}

// Shapes: shape_id -> ordered [[lat, lng], ...]
const shapePts = new Map();
for (const r of readCsv('shapes.txt')) {
  if (!shapePts.has(r.shape_id)) shapePts.set(r.shape_id, []);
  shapePts.get(r.shape_id).push([+r.shape_pt_sequence, +r.shape_pt_lat, +r.shape_pt_lon]);
}
for (const pts of shapePts.values()) pts.sort((a, b) => a[0] - b[0]);

const out = { generated: new Date().toISOString(), source: 'TTC GTFS (Toronto Open Data)', lines: {} };
for (const ln of LINES) {
  const want = lineCodes[ln];
  let best = null;
  for (const [key, stops] of shapeStops) {
    const [rid, shapeId] = key.split('|');
    if (rid !== routeId[ln]) continue;
    const hit = [...stops].filter(s => want.has(s)).length;
    const pts = shapePts.get(shapeId);
    if (!pts) continue;
    // Pick the shape covering the most stations; ties go to the longest shape.
    if (!best || hit > best.hit || (hit === best.hit && pts.length > best.pts.length)) {
      best = { hit, shapeId, pts: pts.map(([, la, lo]) => [la, lo]) };
    }
  }
  if (!best || best.hit === 0) { console.error(`Line ${ln}: no shape found`); continue; }
  // Order the stations along the shape by nearest shape-point index.
  const shape = best.pts;
  const ordered = subway[ln].stations.map(s => {
    let bi = 0, bd = Infinity;
    for (let i = 0; i < shape.length; i++) {
      const d = (shape[i][0] - s.lat) ** 2 + (shape[i][1] - s.lng) ** 2;
      if (d < bd) { bd = d; bi = i; }
    }
    return { ...s, _i: bi };
  }).sort((a, b) => a._i - b._i).map(({ _i, ...s }) => s);
  out.lines[ln] = { name: NAMES[ln], color: COLORS[ln], shape, stations: ordered };
  console.log(`Line ${ln}: shape ${best.shapeId} covers ${best.hit}/${want.size} stop codes, ${shape.length} points, ${ordered.length} stations`);
}
await writeFile('data/ttc-lines.json', JSON.stringify(out, null, 2) + '\n');
console.log('wrote data/ttc-lines.json');
