// Builds data/go-fares.json: adult GO fares between train stations.
// Usage: node tools/build-go-fares.mjs /path/to/go-gtfs
// GO fares are zone-to-zone (fare_rules.txt) with prices in
// fare_attributes.txt. Only zones containing a GO train station are kept,
// so the file stays small. Station codes come from data/go-lines.json.
import { createReadStream } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import readline from 'node:readline';
import path from 'node:path';

const dir = process.argv[2];
if (!dir) { console.error('usage: node tools/build-go-fares.mjs <go-gtfs-folder>'); process.exit(1); }

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

const goJson = JSON.parse(await readFile(new URL('../data/go-lines.json', import.meta.url), 'utf8'));
const stationCodes = new Set(Object.values(goJson.lines).flatMap(l => l.stations.map(s => s.code)));

const zoneOf = {}; // station code -> zone_id
for await (const s of rows('stops.txt')) {
  if (stationCodes.has(s.stop_id)) zoneOf[s.stop_id] = s.zone_id;
}
const zones = new Set(Object.values(zoneOf));
console.log(`${Object.keys(zoneOf).length} stations in ${zones.size} zones`);

const price = {}; // fare_id -> dollars
for await (const f of rows('fare_attributes.txt')) price[f.fare_id] = Number(f.price);

const fares = {}; // origin zone -> {dest zone: dollars}
let rules = 0;
for await (const r of rows('fare_rules.txt')) {
  if (!zones.has(r.origin_id) || !zones.has(r.destination_id)) continue;
  const p = price[r.fare_id];
  if (p == null) continue;
  (fares[r.origin_id] || (fares[r.origin_id] = {}))[r.destination_id] = p;
  rules++;
}
console.log(`${rules} zone-pair fares kept`);
await writeFile(new URL('../data/go-fares.json', import.meta.url), JSON.stringify({ generated: new Date().toISOString(), source: 'Metrolinx GO GTFS fare_attributes + fare_rules, feed 20261117', zoneOf, fares }));
console.log('Wrote data/go-fares.json');
