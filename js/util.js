export const $ = (s, r = document) => r.querySelector(s);

// Tiny element builder. Text goes through createTextNode, never innerHTML, so feed data cannot inject markup.
export function h(tag, props, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v === true) e.setAttribute(k, '');
    else if (v !== false && v != null) e.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    e.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return e;
}

export const fmtClock = ts => new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
export const minsUntil = (ts, now = Date.now()) => Math.round((ts - now) / 60000);

const lum = hex => {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
export const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const mix = (a, b, t) => '#' + [1, 3, 5].map(i =>
  Math.round(parseInt(a.slice(i, i + 2), 16) * t + parseInt(b.slice(i, i + 2), 16) * (1 - t)).toString(16).padStart(2, '0')).join('');

// White text on yellow or orange fails WCAG contrast, so pick whichever of white or near-black reads better.
export function palette(bg) {
  const fg = contrast(bg, '#ffffff') >= contrast(bg, '#111111') ? '#ffffff' : '#111111';
  let dim = mix(fg, bg, 0.78);
  if (contrast(dim, bg) < 4.5) dim = fg;
  return { bg, fg, dim };
}

export function setText(el, text) { if (el.textContent !== text) el.textContent = text; }
