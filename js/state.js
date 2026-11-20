const KEY = 'wf_v1';
const base = () => ({
  agency: 'go', view: 'board', colour: true, mapTheme: 'dark',
  go: { stop: null, line: null, dir: null },
  ttc: { line: '1', station: null, dir: null },
  surface: { route: null, routeTitle: null, dir: null, stop: null },
  target: null
});

export function loadState() {
  const b = base();
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || '{}');
    for (const k of Object.keys(b)) {
      if (s[k] === undefined) continue;
      b[k] = b[k] && typeof b[k] === 'object' ? { ...b[k], ...s[k] } : s[k];
    }
  } catch { /* corrupted or blocked storage: start fresh */ }
  return b;
}
export function saveState(s) { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* private mode */ } }
