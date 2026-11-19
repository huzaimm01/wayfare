import * as api from './api.js';
import { GO_LINES, SUBWAY } from './config.js';

const COMPASS = /\b(north|south|east|west)/i;
const letterOf = text => { const m = COMPASS.exec(text || ''); return m ? m[1][0].toUpperCase() : null; };

export function goDir(d) {
  const meta = GO_LINES[d.line];
  if (meta) return /union/i.test(d.dest || '') ? meta.toUnion : meta.fromUnion;
  return letterOf(`${d.dest || ''} ${d.dirName || ''}`);
}

export function subwayDir(line, text) {
  const t = (text || '').toLowerCase(), m = SUBWAY[line];
  if (m) for (const k of 'NESW') if (m[k] && t.includes(m[k].toLowerCase())) return k;
  const c = /\b(n|north|e|east|s|south|w|west)(bound|b)?\b/i.exec(text || '');
  return c ? c[1][0].toUpperCase() : null;
}

export const surfaceDir = title => letterOf((title || '').trim());

// One normalized shape for every agency: { ts, line, lineName, dir, dest, platform, schedTs }
export async function fetchDepartures(t) {
  if (t.kind === 'go') {
    const j = await api.goNext(t.code);
    return j.departures.map(d => ({
      ts: d.ts, schedTs: d.schedTs, line: d.line, lineName: d.lineName, dest: d.dirName,
      platform: d.platform, dir: goDir({ line: d.line, dest: d.dirName, dirName: d.dirCode })
    }));
  }
  if (t.kind === 'subway') {
    const j = await api.subway(t.codes);
    return j.items.map(i => ({ ts: i.ts, line: t.line, lineName: SUBWAY[t.line]?.name, dest: i.dirText, dir: subwayDir(t.line, i.dirText) }));
  }
  const j = await api.ttcPredict(t.stopId, t.route);
  return j.departures.map(d => ({ ts: d.ts, line: d.line, lineName: d.lineName, dest: d.dir, dir: surfaceDir(d.dir) }));
}

export const matches = (t, d) => (!t.line || d.line === t.line) && (!t.dir || !d.dir || d.dir === t.dir);
