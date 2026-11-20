// Journey routing over data/network.json (built from the TTC + GO/UP GTFS).
// Dijkstra over (station, line) states, so boarding waits and line changes
// are priced. Two costs are tracked: `cost` orders the search (mode
// penalties apply in Comfortable), `time` is the real trip duration.
import { haversine, walkMinutes } from './geo.js';

let net = null;
export async function loadNetwork() {
  if (!net) net = await (await fetch('data/network.json')).json();
  return net;
}

// Comfortable mode: a subway boarding costs extra minutes and GO ride
// minutes count much less, so a train wins when the time is close. The
// preference has to be strong because a GO line's 30-minute headway puts
// a 15-minute expected wait on the train leg; the 5/10-minute rule in
// comparePlans is what keeps the result honest in real time.
// (GO/TTC bus is not in the graph yet; when it is, it sits between them.)
const COMFORT_BOARD = { go: 0, subway: 20 };
const COMFORT_RIDE = { go: 0.6, subway: 1 };
const LINE_CHANGE = 4; // buffer minutes when switching lines
const WALK_MAX_M = 1500; // how far the planner will walk you to a station

// Expected wait when boarding a line. Frequent services you just show up
// for (half the headway); scheduled trains you plan around, so the wait
// is just the buffer you leave to catch one. The live step then replaces
// the estimate with the next real departure.
const waitFor = (net, line) => {
  const h = net.headways[line] || 10;
  return h <= 10 ? h / 2 : 5;
};

function adjacency(n) {
  if (n._adj) return n._adj;
  const adj = {};
  for (const e of n.edges) (adj[e.a] || (adj[e.a] = [])).push(e);
  return (n._adj = adj);
}

export function plan(net, from, to, mode = 'quickest') {
  const adj = adjacency(net);
  const comfortable = mode === 'comfortable';
  const key = (node, line) => node + '|' + (line || '');
  const dist = new Map(), time = new Map(), parent = new Map();
  const pq = []; // [cost, node, line]
  const push = (cost, node, line, t, par) => {
    const k = key(node, line);
    if (dist.has(k) && dist.get(k) <= cost) return;
    dist.set(k, cost); time.set(k, t); parent.set(k, par);
    pq.push([cost, node, line]);
  };

  if (typeof from === 'string') {
    push(0, from, null, 0, null);
  } else {
    // Walk from the given point to every station in range.
    let any = false;
    for (const [id, n] of Object.entries(net.nodes)) {
      const m = haversine(from, n);
      if (m > WALK_MAX_M) continue;
      const mins = walkMinutes(from, n);
      push(mins, id, null, mins, { edge: { kind: 'walk', from, to: id, mins } });
      any = true;
    }
    if (!any) return null;
  }

  let goal = null;
  while (pq.length) {
    let bi = 0;
    for (let i = 1; i < pq.length; i++) if (pq[i][0] < pq[bi][0]) bi = i;
    const [cost, node, line] = pq.splice(bi, 1)[0];
    const k = key(node, line);
    if (dist.get(k) !== cost) continue;
    if (node === to) { goal = k; break; }
    for (const e of adj[node] || []) {
      const t = time.get(k);
      if (e.mode === 'transfer') {
        push(cost + e.mins, e.b, null, t + e.mins, { prev: k, edge: { kind: 'transfer', from: node, to: e.b, mins: e.mins } });
        continue;
      }
      const boarding = line !== e.line;
      const wait = boarding ? waitFor(net, e.line) : 0;
      const change = line && line !== e.line ? LINE_CHANGE : 0;
      const boardPen = boarding && comfortable ? (COMFORT_BOARD[e.mode] ?? 0) : 0;
      const ride = e.mins * (comfortable ? (COMFORT_RIDE[e.mode] ?? 1) : 1);
      push(cost + ride + wait + change + boardPen, e.b, e.line, t + e.mins + wait + change,
        { prev: k, edge: { kind: 'ride', line: e.line, mode: e.mode, from: node, to: e.b, mins: e.mins, wait, change } });
    }
  }
  if (!goal) return null;

  // Reconstruct the edge chain, then collapse rides on one line into legs.
  const chain = [];
  for (let k = goal; parent.get(k); k = parent.get(k).prev || '') {
    chain.push(parent.get(k).edge);
    if (!parent.get(k).prev) break;
  }
  chain.reverse();
  const legs = [];
  for (const e of chain) {
    if (e.kind === 'ride') {
      const last = legs[legs.length - 1];
      if (last && last.kind === 'ride' && last.line === e.line) {
        last.to = e.to; last.stops.push(e.from); last.rideMins += e.mins;
        continue;
      }
      legs.push({ kind: 'ride', line: e.line, mode: e.mode, from: e.from, to: e.to, stops: [], rideMins: e.mins, waitMins: e.wait, changeMins: e.change });
    } else {
      legs.push(e);
    }
  }
  for (const l of legs) if (l.kind === 'ride') l.stops = l.stops.filter(s => s !== l.from);
  return { legs, totalMins: time.get(goal), mode };
}

// The concept's rule: Comfortable is only shown when it is not much slower
// than Quickest — 5 minutes on a short trip, 10 on a long one.
export function comparePlans(quick, comfort) {
  if (!quick) return { show: [], note: 'No route found.' };
  if (!comfort) return { show: [quick], note: null };
  const threshold = quick.totalMins < 30 ? 5 : 10;
  const extra = Math.round(comfort.totalMins - quick.totalMins);
  if (extra > threshold) {
    return { show: [quick], note: `Comfortable would take ${extra} min longer, so only the quickest way is shown.` };
  }
  return { show: [comfort, quick], note: null };
}
