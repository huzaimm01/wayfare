// Builds data/network.json: the routing graph for the journey planner.
// Usage: node tools/build-network.mjs /path/to/ttc-gtfs /path/to/go-gtfs /path/to/up-gtfs
// Inputs: the three GTFS feeds plus data/ttc-subway.json and data/go-lines.json
// (station identity, live-departure codes, GO line order).
// Output nodes: go:<CODE> and ttc:<line>:<Station Name>, with edges carrying
// median scheduled minutes between adjacent stations, per-line daytime
// headways, and transfer edges (subway-subway by shared name, GO-subway
// explicit). Times are medians across all trips, so they are schedule
// truth, not guesses.
import { createReadStream } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import readline from 'node:readline';
import path from 'node:path';

const [ttcDir, goDir, upDir] = process.argv.slice(2);
if (!ttcDir || !goDir || !upDir) { console.error('usage: node tools/build-network.mjs <ttc-gtfs> <go-gtfs> <up-gtfs>'); process.exit(1); }

function splitCsv(line) {
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
    else if (c === '"') q = true; else if (c === ',') { out.push(cur); cur = ''; } else cur += c;
  }
  out.push(cur); return out;
}
async function* rows(dir, file) {
  const rl = readline.createInterface({ input: createReadStream(path.join(dir, file)), crlfDelay: Infinity });
  let head = null;
  for await (const line of rl) {
    if (!line.trim()) continue;
    const cells = splitCsv(line);
    if (!head) { head = cells.map(c => c.replace(/^\uFEFF/, '').trim()); continue; }
    yield Object.fromEntries(head.map((k, i) => [k, cells[i]]));
  }
}
const tsec = s => { const [h, m, x] = s.split(':').map(Number); return h * 3600 + m * 60 + (x || 0); };
const median = a => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
const baseName = n => n.split(' - ')[0].replace(/ (Subway )?Station.*$/i, '').replace(/ Platform.*$/i, '').trim();

const subwayJson = JSON.parse(await readFile(new URL('../data/ttc-subway.json', import.meta.url), 'utf8'));
const goJson = JSON.parse(await readFile(new URL('../data/go-lines.json', import.meta.url), 'utf8'));

const nodes = {}; // id -> {name, lat, lng, kind, lines: [], codes?}
const edges = []; // {a, b, line, mode, mins}
const headways = {}; // lineKey -> median daytime mins between departures
function node(id, name, lat, lng, kind, line, codes) {
  const n = nodes[id] || (nodes[id] = { name, lat, lng, kind, lines: [], codes: codes || undefined });
  if (!n.lines.includes(line)) n.lines.push(line);
  return n;
}
function edge(a, b, line, mode, mins) {
  if (a === b || mins == null || mins <= 0 || mins > 90) return;
  edges.push({ a, b, line, mode, mins: Math.round(mins * 10) / 10 });
}

// ---------- TTC subway ----------
const WANT_TTC = new Set(['1', '2', '4', '5', '6']);
const ttcRouteLine = new Map();
for await (const r of rows(ttcDir, 'routes.txt')) {
  const m = /\bLine (\d)\b/.exec(`${r.route_long_name} ${r.route_short_name}`);
  if (m && WANT_TTC.has(m[1]) && (r.route_type === '1' || r.route_type === '0')) ttcRouteLine.set(r.route_id, m[1]);
}
const ttcTrip = new Map(); // trip_id -> {line, dir, service}
for await (const t of rows(ttcDir, 'trips.txt')) {
  const line = ttcRouteLine.get(t.route_id);
  if (line) ttcTrip.set(t.trip_id, { line, dir: t.direction_id || '0', service: t.service_id });
}
const ttcStops = new Map();
for await (const s of rows(ttcDir, 'stops.txt')) ttcStops.set(s.stop_id, s);

// Per (line|dir): the trip with the most stops (reference order), and
// adjacent-pair times across all trips.
const refTrip = new Map(); // key -> {trip, stops: [stop_id]}
const pairTimes = new Map(); // "line|fromStop|toStop" -> [seconds]
const ttcDeparts = new Map(); // "line|stop_id" -> Map(service -> [departure seconds, daytime])
let curTrip = null, curStops = [];
const finishTrip = () => {
  if (!curTrip || curStops.length < 2) { curTrip = null; curStops = []; return; }
  curStops.sort((a, b) => a.seq - b.seq);
  const { line, dir } = curTrip;
  const key = line + '|' + dir;
  if (!refTrip.has(key) || curStops.length > refTrip.get(key).stops.length) {
    refTrip.set(key, { trip: curTrip.trip, stops: curStops.map(s => s.id) });
  }
  for (let i = 1; i < curStops.length; i++) {
    const secs = curStops[i].arr - curStops[i - 1].dep;
    if (secs > 0 && secs < 1800) {
      const pk = `${line}|${curStops[i - 1].id}|${curStops[i].id}`;
      if (!pairTimes.has(pk)) pairTimes.set(pk, []);
      pairTimes.get(pk).push(secs);
    }
  }
  curTrip = null; curStops = [];
};
for await (const st of rows(ttcDir, 'stop_times.txt')) {
  const t = ttcTrip.get(st.trip_id);
  if (!t) continue;
  if (!curTrip || curTrip.trip !== st.trip_id) { finishTrip(); curTrip = { ...t, trip: st.trip_id }; }
  curStops.push({ id: st.stop_id, arr: tsec(st.arrival_time), dep: tsec(st.departure_time), seq: Number(st.stop_sequence) });
  const dep = tsec(st.departure_time);
  if (dep >= 6 * 3600 && dep <= 22 * 3600) {
    const dk = `${t.line}|${st.stop_id}`;
    if (!ttcDeparts.has(dk)) ttcDeparts.set(dk, new Map());
    const bySvc = ttcDeparts.get(dk);
    if (!bySvc.has(t.service)) bySvc.set(t.service, []);
    bySvc.get(t.service).push(dep);
  }
}
finishTrip();

// Ordered stations per line, from the longest trip in direction 0
// (direction 1 is the same list reversed).
const ttcOrder = {};
for (const line of WANT_TTC) {
  const ref = refTrip.get(line + '|0') || refTrip.get(line + '|1');
  if (!ref) { console.warn('TTC line ' + line + ': no reference trip'); continue; }
  let stops = ref.stops;
  if (refTrip.get(line + '|0') == null) stops = [...stops].reverse();
  const seen = new Set(), order = [];
  for (const id of stops) {
    let s = ttcStops.get(id);
    if (!s) continue;
    if (s.parent_station && ttcStops.get(s.parent_station)) s = ttcStops.get(s.parent_station);
    const name = baseName(s.stop_name);
    if (seen.has(name)) continue;
    seen.add(name);
    order.push({ name, lat: Number(s.stop_lat), lng: Number(s.stop_lon), stopId: id });
  }
  ttcOrder[line] = order;
  console.log(`TTC Line ${line}: ${order.length} stations, ${order[0].name} -> ${order[order.length - 1].name}`);
}
// Subway nodes + edges. Codes come from data/ttc-subway.json so live
// departures can be fetched for a routed station.
const subwayCodes = {};
for (const [line, l] of Object.entries(subwayJson.lines)) {
  for (const s of l.stations) subwayCodes[line + '|' + s.name] = s.codes;
}
for (const [line, order] of Object.entries(ttcOrder)) {
  for (const st of order) {
    node(`ttc:${line}:${st.name}`, st.name, st.lat, st.lng, 'subway', 'ttc' + line, subwayCodes[line + '|' + st.name]);
  }
  for (let i = 1; i < order.length; i++) {
    const a = order[i - 1], b = order[i];
    // Median time in each direction, from the raw stop-id pairs.
    const fwd = median(pairTimes.get(`${line}|${a.stopId}|${b.stopId}`) || []);
    const back = median(pairTimes.get(`${line}|${b.stopId}|${a.stopId}`) || []);
    const m = fwd != null && back != null ? (fwd + back) / 2 : (fwd ?? back);
    if (m == null) continue;
    edge(`ttc:${line}:${a.name}`, `ttc:${line}:${b.name}`, 'ttc' + line, 'subway', m / 60);
    edge(`ttc:${line}:${b.name}`, `ttc:${line}:${a.name}`, 'ttc' + line, 'subway', m / 60);
  }
  // Headway at the terminus, daytime, from the busiest single service
  // (pooling weekday + weekend trips would fake a tighter headway).
  const bySvc = ttcDeparts.get(`${line}|${order[0].stopId}`) || new Map();
  const busiest = [...bySvc.values()].sort((a, b) => b.length - a.length)[0] || [];
  const deps = [...busiest].sort((x, y) => x - y);
  const gaps = [];
  for (let i = 1; i < deps.length; i++) { const g = (deps[i] - deps[i - 1]) / 60; if (g > 0 && g <= 60) gaps.push(g); }
  if (gaps.length) headways['ttc' + line] = Math.round(median(gaps) * 10) / 10;
}
// Subway-subway transfers: same station name on two lines.
const byName = {};
for (const [line, order] of Object.entries(ttcOrder)) {
  for (const st of order) {
    (byName[st.name] || (byName[st.name] = [])).push(line);
  }
}
for (const [name, lines] of Object.entries(byName)) {
  if (lines.length < 2) continue;
  for (let i = 0; i < lines.length; i++) for (let j = i + 1; j < lines.length; j++) {
    edge(`ttc:${lines[i]}:${name}`, `ttc:${lines[j]}:${name}`, 'transfer', 'transfer', 3);
    edge(`ttc:${lines[j]}:${name}`, `ttc:${lines[i]}:${name}`, 'transfer', 'transfer', 3);
  }
  console.log(`Transfer: ${name} (Lines ${lines.join(', ')})`);
}

// ---------- GO + UP ----------
const GO_LINES = { LW: 1, LE: 1, MI: 1, KI: 1, RH: 1, ST: 1, BR: 1, UP: 1 };
async function goFeed(dir, feedName) {
  const routeLine = new Map();
  for await (const r of rows(dir, 'routes.txt')) {
    if (r.route_type === '2' && GO_LINES[r.route_short_name]) routeLine.set(r.route_id, r.route_short_name);
  }
  const tripLine = new Map(); // trip_id -> {line, service}
  for await (const t of rows(dir, 'trips.txt')) {
    const line = routeLine.get(t.route_id);
    if (line) tripLine.set(t.trip_id, { line, service: t.service_id });
  }
  const pairs = new Map(); // "LINE|FROM|TO" -> [seconds]
  const departs = new Map(); // "LINE|stop" -> Map(service -> [seconds daytime])
  let cur = null, stops = [];
  const fin = () => {
    if (!cur || stops.length < 2) { cur = null; stops = []; return; }
    // GO lists each trip's stops in descending sequence order.
    stops.sort((a, b) => a.seq - b.seq);
    for (let i = 1; i < stops.length; i++) {
      const secs = stops[i].arr - stops[i - 1].dep;
      if (secs > 0 && secs < 7200) { // Stratford-Kitchener is 62 min
        const pk = `${cur.line}|${stops[i - 1].id}|${stops[i].id}`;
        if (!pairs.has(pk)) pairs.set(pk, []);
        pairs.get(pk).push(secs);
      }
    }
    cur = null; stops = [];
  };
  for await (const st of rows(dir, 'stop_times.txt')) {
    const tl = tripLine.get(st.trip_id);
    if (!tl) continue;
    if (!cur || cur.trip !== st.trip_id) { fin(); cur = { line: tl.line, trip: st.trip_id }; }
    stops.push({ id: st.stop_id, arr: tsec(st.arrival_time), dep: tsec(st.departure_time), seq: Number(st.stop_sequence) });
    const dep = tsec(st.departure_time);
    if (dep >= 6 * 3600 && dep <= 22 * 3600) {
      const dk = `${tl.line}|${st.stop_id}`;
      if (!departs.has(dk)) departs.set(dk, new Map());
      const bySvc = departs.get(dk);
      if (!bySvc.has(tl.service)) bySvc.set(tl.service, []);
      bySvc.get(tl.service).push(dep);
    }
  }
  fin();
  console.log(`${feedName}: ${tripLine.size} rail trips`);
  return { pairs, departs };
}
const go = await goFeed(goDir, 'GO');
const up = await goFeed(upDir, 'UP');
const pairMed = (pairs, line, a, b) => median(pairs.get(`${line}|${a}|${b}`) || []);

for (const [line, l] of Object.entries(goJson.lines)) {
  const pairs = line === 'UP' ? up.pairs : go.pairs;
  const departs = line === 'UP' ? up.departs : go.departs;
  for (const s of l.stations) node(`go:${s.code}`, s.name, s.lat, s.lng, 'go', line);
  // Edges come from the pairs that actually occur in trips, not from the
  // station list order: branches (West Harbour vs Hamilton) and skipped
  // stops mean the list order is not the trip order.
  for (const [key, secs] of pairs) {
    const [ln, from, to] = key.split('|');
    if (ln !== line) continue;
    edge(`go:${from}`, `go:${to}`, line, 'go', median(secs) / 60);
  }
  const bySvc = departs.get(`${line}|UN`) || new Map();
  const busiest = [...bySvc.values()].sort((a, b) => b.length - a.length)[0] || [];
  const deps = [...busiest].sort((x, y) => x - y);
  const gaps = [];
  for (let i = 1; i < deps.length; i++) { const g = (deps[i] - deps[i - 1]) / 60; if (g > 0 && g <= 120) gaps.push(g); }
  if (gaps.length) headways[line] = Math.round(median(gaps) * 10) / 10;
}

// GO-subway transfers, explicit (station names differ across agencies).
const GO_SUBWAY = [
  ['UN', '1', 'Union', 5],
  ['BL', '2', 'Dundas West', 4],
  ['MD', '5', 'Mount Dennis', 4],
  ['KE', '2', 'Kennedy', 4],
  ['DA', '2', 'Main Street', 4],
  ['KP', '2', 'Kipling', 4],
  ['DW', '1', 'Downsview Park', 4],
  ['OR', '4', 'Leslie', 4],
];
for (const [code, line, name, mins] of GO_SUBWAY) {
  const goId = `go:${code}`, ttcId = `ttc:${line}:${name}`;
  if (!nodes[goId]) { console.warn(`Transfer ${goId} missing`); continue; }
  if (!nodes[ttcId]) { console.warn(`Transfer ${ttcId} missing`); continue; }
  edge(goId, ttcId, 'transfer', 'transfer', mins);
  edge(ttcId, goId, 'transfer', 'transfer', mins);
  console.log(`Transfer: ${nodes[goId].name} GO <-> ${name} (Line ${line}), ${mins} min`);
}

// Line order (for "toward X" directions and the map): TTC from the
// reference trips, GO from data/go-lines.json.
const lines = {};
for (const [line, order] of Object.entries(ttcOrder)) {
  lines['ttc' + line] = { name: 'Line ' + line, stations: order.map(s => s.name) };
}
for (const [line, l] of Object.entries(goJson.lines)) {
  lines[line] = { name: l.name, color: l.color, stations: l.stations.map(s => s.name) };
}

const out = {
  generated: new Date().toISOString(),
  source: 'TTC GTFS + Metrolinx GO/UP GTFS, feed 20261117; medians across all trips',
  nodes, edges, headways, lines,
};
await writeFile(new URL('../data/network.json', import.meta.url), JSON.stringify(out));
console.log(`Wrote data/network.json: ${Object.keys(nodes).length} nodes, ${edges.length} edges`);
console.log('Headways (min):', JSON.stringify(headways));
