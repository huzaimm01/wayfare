// Builds data/ttc-subway.json from the TTC GTFS feed (City of Toronto Open Data, "TTC Routes and Schedules").
// Usage: node tools/build-subway.mjs /path/to/unzipped-gtfs-folder
// Needs Node 18+. Streams stop_times.txt so memory stays small.
import { createReadStream } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import readline from 'node:readline';
import path from 'node:path';

const dir = process.argv[2];
if (!dir) { console.error('usage: node tools/build-subway.mjs <unzipped-gtfs-folder>'); process.exit(1); }

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

const WANT = new Set(['1', '2', '4', '5', '6']);
const routeLine = new Map();
for await (const r of rows('routes.txt')) {
  const m = /\bLine (\d)\b/.exec(`${r.route_long_name} ${r.route_short_name}`);
  if (m && WANT.has(m[1]) && (r.route_type === '1' || r.route_type === '0')) routeLine.set(r.route_id, m[1]);
}
if (!routeLine.size) { console.error('No subway or LRT routes found in routes.txt. Is this the TTC feed?'); process.exit(1); }

const tripLine = new Map();
for await (const t of rows('trips.txt')) if (routeLine.has(t.route_id)) tripLine.set(t.trip_id, routeLine.get(t.route_id));

const stopsOnLine = new Map(); // line -> Set(stop_id)
for await (const st of rows('stop_times.txt')) {
  const line = tripLine.get(st.trip_id);
  if (!line) continue;
  if (!stopsOnLine.has(line)) stopsOnLine.set(line, new Set());
  stopsOnLine.get(line).add(st.stop_id);
}

const stops = new Map();
for await (const s of rows('stops.txt')) stops.set(s.stop_id, s);

const baseName = n => n.split(' - ')[0].replace(/ (Subway )?Station.*$/i, '').replace(/ Platform.*$/i, '').trim();
const out = { generated: new Date().toISOString(), lines: {} };
let missingCodes = 0;

for (const [line, ids] of stopsOnLine) {
  const byStation = new Map();
  for (const id of ids) {
    let s = stops.get(id); if (!s) continue;
    if (s.parent_station && stops.get(s.parent_station)) s = { ...s, stop_name: stops.get(s.parent_station).stop_name, _parent: s.parent_station };
    const name = baseName(s.stop_name);
    const code = (stops.get(id).stop_code || '').trim();
    if (!code) missingCodes++;
    const e = byStation.get(name) || { name, lat: [], lng: [], codes: new Set() };
    e.lat.push(Number(stops.get(id).stop_lat)); e.lng.push(Number(stops.get(id).stop_lon));
    e.codes.add(code || id);
    byStation.set(name, e);
  }
  const avg = a => Math.round((a.reduce((x, y) => x + y, 0) / a.length) * 1e5) / 1e5;
  out.lines[line] = { stations: [...byStation.values()].map(e => ({ name: e.name, lat: avg(e.lat), lng: avg(e.lng), codes: [...e.codes].slice(0, 6) })).sort((a, b) => a.name.localeCompare(b.name)) };
  console.log(`Line ${line}: ${out.lines[line].stations.length} stations`);
}
if (missingCodes) console.warn(`${missingCodes} platforms had no stop_code, so stop_id was used. Check one against the live endpoint (see README).`);
await writeFile(new URL('../data/ttc-subway.json', import.meta.url), JSON.stringify(out));
console.log('Wrote data/ttc-subway.json');
