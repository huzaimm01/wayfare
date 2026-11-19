// Wayfare proxy. The only backend. No database, no accounts, no logging of visitors.
// It exists for three reasons: keep the Metrolinx key secret, add CORS headers,
// and cache upstream responses so we stay inside each provider's rate limits.

const MX = 'https://api.openmetrolinx.com/OpenDataAPI/api/V1';
const UMO = 'https://retro.umoiq.com/service/publicJSONFeed';
const NTAS = 'https://ntas.ttc.ca/api/ntas/get-next-train-time/';
const UA = { 'user-agent': 'wayfare-proxy/1.0 (static transit board)' };

class BadInput extends Error {}
const arr = v => (v == null ? [] : Array.isArray(v) ? v : [v]);
const pick = (o, ...keys) => { for (const k of keys) if (o && o[k] != null && o[k] !== '') return o[k]; };
const num = v => (v == null || v === '' || isNaN(Number(v)) ? null : Number(v));
const must = (v, re) => { if (typeof v !== 'string' || !re.test(v)) throw new BadInput(); return v; };

async function getJson(url) {
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error('upstream ' + r.status); // never include the URL: it can contain the key
  return r.json();
}

// First array of objects found breadth-first. Metrolinx wraps lists in differently named keys.
function findArray(j) {
  const q = [j];
  while (q.length) {
    const x = q.shift();
    if (Array.isArray(x)) { if (x.length && typeof x[0] === 'object') return x; q.push(...x); }
    else if (x && typeof x === 'object') q.push(...Object.values(x));
  }
  return [];
}
function walk(o, fn) {
  if (Array.isArray(o)) o.forEach(x => walk(x, fn));
  else if (o && typeof o === 'object') { fn(o); Object.values(o).forEach(x => walk(x, fn)); }
}

// Metrolinx times are local Toronto wall-clock strings, e.g. "2026-11-18 15:35:00".
export function torontoToEpoch(s) {
  const [d, t = '0:0:0'] = String(s).trim().split(/[ T]/);
  const [Y, M, D] = d.split('-').map(Number);
  const [hh, mm, ss = 0] = t.split(':').map(Number);
  const guess = Date.UTC(Y, M - 1, D, hh, mm, ss);
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Toronto', hourCycle: 'h23', year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
  const p = Object.fromEntries(f.formatToParts(new Date(guess)).map(x => [x.type, x.value]));
  const asLocal = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return guess - (asLocal - guess);
}

async function goStops(env) {
  const j = await getJson(`${MX}/Stop/All?key=${encodeURIComponent(env.METROLINX_API_KEY)}`);
  const stops = findArray(j).map(s => ({
    code: String(pick(s, 'LocationCode', 'StopCode', 'Code') ?? ''),
    name: String(pick(s, 'LocationName', 'StopName', 'Name') ?? ''),
    type: String(pick(s, 'LocationType', 'StopType', 'Type') ?? ''),
    lat: num(pick(s, 'Latitude', 'Lat')),
    lng: num(pick(s, 'Longitude', 'Lon', 'Lng'))
  })).filter(s => s.code && s.name);
  return { stops };
}

async function goNext(p, env) {
  const code = must(p.get('stop'), /^[A-Za-z0-9]{1,8}$/);
  const j = await getJson(`${MX}/Stop/NextService/${code}?key=${encodeURIComponent(env.METROLINX_API_KEY)}`);
  const lines = j?.NextService ? arr(j.NextService.Lines) : findArray(j);
  const departures = lines.map(l => {
    const sched = pick(l, 'ScheduledDepartureTime');
    const comp = pick(l, 'ComputedDepartureTime') ?? sched;
    return {
      ts: comp ? torontoToEpoch(comp) : null,
      schedTs: sched ? torontoToEpoch(sched) : null,
      line: String(pick(l, 'LineCode') ?? ''),
      lineName: String(pick(l, 'LineName') ?? ''),
      type: String(pick(l, 'ServiceType') ?? ''),
      dirCode: String(pick(l, 'DirectionCode') ?? ''),
      dirName: String(pick(l, 'DirectionName') ?? ''),
      platform: String(pick(l, 'ActualPlatform', 'ScheduledPlatform') ?? ''),
      trip: String(pick(l, 'TripNumber') ?? '')
    };
  }).filter(d => Number.isFinite(d.ts)).sort((a, b) => a.ts - b.ts);
  return { departures };
}

async function ttcRoutes() {
  const j = await getJson(`${UMO}?command=routeList&a=ttc`);
  return { routes: arr(j.route).map(r => ({ tag: String(r.tag), title: String(r.title) })) };
}

async function ttcRoute(p) {
  const r = must(p.get('r'), /^[0-9A-Za-z]{1,5}$/);
  const j = await getJson(`${UMO}?command=routeConfig&a=ttc&r=${r}&terse`);
  const route = j.route || {};
  const stops = {};
  arr(route.stop).forEach(s => {
    stops[s.tag] = { tag: s.tag, title: s.title, lat: num(s.lat), lng: num(s.lon), stopId: s.stopId ? String(s.stopId) : null };
  });
  const directions = arr(route.direction)
    .filter(d => d.useForUI !== 'false')
    .map(d => ({ tag: d.tag, name: d.name, title: d.title, stops: arr(d.stop).map(s => s.tag) }));
  return { route: { tag: route.tag, title: route.title }, stops, directions };
}

async function ttcPredict(p) {
  const stopId = must(p.get('stopId'), /^\d{1,8}$/);
  const q = new URLSearchParams({ command: 'predictions', a: 'ttc', stopId });
  const r = p.get('r');
  if (r) q.set('routeTag', must(r, /^[0-9A-Za-z]{1,5}$/));
  const j = await getJson(`${UMO}?${q}`);
  const out = [];
  for (const pr of arr(j.predictions))
    for (const d of arr(pr.direction))
      for (const x of arr(d.prediction))
        out.push({ ts: Number(x.epochTime), line: pr.routeTag, lineName: pr.routeTitle, dir: d.title, vehicle: x.vehicle });
  return { stop: arr(j.predictions)[0]?.stopTitle || '', departures: out.filter(x => Number.isFinite(x.ts)).sort((a, b) => a.ts - b.ts) };
}

// TTC's own station screens use this undocumented endpoint. Its response shape is not published,
// so we collect anything that looks like "minutes until arrival" and pass the raw shape on request
// (?debug=1) so you can adjust this after one real call.
async function subway(p) {
  const codes = must(p.get('codes'), /^\d{4,6}(,\d{4,6}){0,5}$/).split(',');
  const settled = await Promise.allSettled(codes.map(c => getJson(NTAS + c)));
  const ok = settled.filter(s => s.status === 'fulfilled').map(s => s.value);
  if (!ok.length) throw new Error('upstream');
  const now = Date.now(), seen = new Set(), items = [];
  ok.forEach(v => walk(v, o => {
    const m = parseFloat(pick(o, 'timint', 'timeInt', 'minutes', 'mins', 'arrivalMinutes'));
    if (!Number.isFinite(m)) return;
    const dirText = String(pick(o, 'traindirection', 'direction', 'directionText', 'destination', 'towards', 'dest') ?? '');
    const id = String(pick(o, 'trainid', 'trainId', 'vehicleId') ?? '');
    const k = `${id}|${dirText}|${m}`;
    if (seen.has(k)) return;
    seen.add(k);
    items.push({ ts: now + m * 60000, dirText, trainId: id, message: String(pick(o, 'train_message', 'message', 'status') ?? '') });
  }));
  items.sort((a, b) => a.ts - b.ts);
  return p.get('debug') ? { items, raw: ok } : { items };
}

const routes = {
  '/go/stops':    { ttl: 86400, run: (p, env) => goStops(env) },
  '/go/next':     { ttl: 15,    run: (p, env) => goNext(p, env) },
  '/ttc/routes':  { ttl: 86400, run: () => ttcRoutes() },
  '/ttc/route':   { ttl: 86400, run: p => ttcRoute(p) },
  '/ttc/predict': { ttl: 10,    run: p => ttcPredict(p) },   // Umo IQ asks for at most one poll per 10 s
  '/ttc/subway':  { ttl: 10,    run: p => subway(p) }
};

// Per-isolate memory cache. Cloudflare's Cache API does not work on *.workers.dev, so this is the portable option.
const mem = new Map();
const trim = () => { while (mem.size > 400) mem.delete(mem.keys().next().value); };

function cors(req, env) {
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  const o = req.headers.get('Origin');
  const h = { Vary: 'Origin' };
  if (o && allowed.includes(o)) h['access-control-allow-origin'] = o;
  return h;
}
const reply = (body, status, c, ttl = 0, extra = {}) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json', 'cache-control': ttl ? `public, max-age=${ttl}` : 'no-store', ...c, ...extra }
});

export default {
  async fetch(req, env) {
    const c = cors(req, env);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...c, 'access-control-allow-methods': 'GET', 'access-control-max-age': '86400' } });
    if (req.method !== 'GET') return reply({ error: 'method not allowed' }, 405, c);
    const url = new URL(req.url);
    const r = routes[url.pathname];
    if (!r) return reply({ error: 'not found' }, 404, c);
    if (req.headers.get('Origin') && !c['access-control-allow-origin']) return reply({ error: 'origin not allowed' }, 403, c);

    const key = url.pathname + url.search;
    const hit = mem.get(key);
    if (hit && hit.exp > Date.now()) return reply(hit.body, 200, c, r.ttl);
    try {
      const body = await r.run(url.searchParams, env);
      mem.set(key, { exp: Date.now() + r.ttl * 1000, body });
      trim();
      return reply(body, 200, c, r.ttl);
    } catch (e) {
      if (e instanceof BadInput) return reply({ error: 'bad request' }, 400, c);
      if (hit) return reply(hit.body, 200, c, 0, { 'x-stale': '1' }); // serve stale rather than fail
      return reply({ error: 'upstream unavailable' }, 502, c);
    }
  }
};
