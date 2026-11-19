import { WORKER_URL } from './config.js';

async function get(path, params = {}) {
  if (!WORKER_URL) throw new Error('not-configured');
  const u = new URL(path.replace(/^\//, ''), WORKER_URL.replace(/\/?$/, '/'));
  for (const [k, v] of Object.entries(params)) if (v != null) u.searchParams.set(k, v);
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 10000);
  try {
    const r = await fetch(u, { signal: ctl.signal });
    if (!r.ok) throw new Error('http-' + r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}

export const goStops = () => get('/go/stops');
export const goNext = code => get('/go/next', { stop: code });
export const ttcRoutes = () => get('/ttc/routes');
export const ttcRoute = r => get('/ttc/route', { r });
export const ttcPredict = (stopId, r) => get('/ttc/predict', { stopId, r });
export const subway = codes => get('/ttc/subway', { codes: codes.join(',') });
