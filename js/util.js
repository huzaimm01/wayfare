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

// Sheets close by swiping down from the top handle, tapping the backdrop, or Esc.
// The Close button is desktop-only (see CSS); on touch the swipe is the way out.
export function attachSheet(dlg) {
  if (dlg.dataset.sheetWired) return;
  dlg.dataset.sheetWired = '1';
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const handle = document.createElement('div');
  handle.className = 'drag'; handle.setAttribute('aria-hidden', 'true');
  dlg.prepend(handle);
  const finish = () => { dlg.style.transform = ''; dlg.style.opacity = ''; dlg.style.transition = ''; dlg.style.animation = ''; };
  dlg.addEventListener('close', finish);
  // Every way out of a sheet uses this: swipe, backdrop, Esc, and any button
  // inside it, so a tap on a menu item slides the sheet away instead of it
  // vanishing. `after` runs once the dialog has actually closed.
  let closing = false;
  const closeSheet = (after) => {
    if (!dlg.open || closing) return;
    if (reduce) { dlg.close(); after && after(); return; }
    closing = true;
    dlg.style.transition = 'transform .18s ease, opacity .18s ease';
    dlg.style.transform = 'translateY(110%)'; dlg.style.opacity = '0';
    setTimeout(() => { closing = false; if (dlg.open) dlg.close(); after && after(); }, 180);
  };
  dlg.closeSheet = closeSheet;
  dlg.addEventListener('click', e => { if (e.target === dlg) closeSheet(); });
  dlg.addEventListener('cancel', e => { e.preventDefault(); closeSheet(); });
  let startY = null, dy = 0, tracking = false;
  handle.addEventListener('pointerdown', e => {
    tracking = true; startY = e.clientY; dy = 0;
    dlg.style.animation = 'none'; dlg.style.transition = 'none';
    try { handle.setPointerCapture(e.pointerId); } catch {}
  });
  handle.addEventListener('pointermove', e => {
    if (!tracking) return;
    dy = Math.max(0, e.clientY - startY);
    dlg.style.transform = `translateY(${dy}px)`;
  });
  const end = () => {
    if (!tracking) return; tracking = false;
    if (dy > 110) { closeSheet(); return; }
    dlg.style.transition = 'transform .25s cubic-bezier(.2,.9,.25,1.2)';
    dlg.style.transform = '';
    setTimeout(() => { dlg.style.transition = ''; }, 260);
  };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
}
