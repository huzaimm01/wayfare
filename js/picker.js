import { h, $ } from './util.js';
import { getPosition, haversine, fmtDistance } from './geo.js';

export async function openPicker({ title, load, onPick, emptyText }) {
  const dlg = $('#picker'), body = $('#pickerBody');
  const input = h('input', { class: 'field', type: 'search', autocomplete: 'off', spellcheck: 'false', placeholder: 'Type to search', 'aria-label': title });
  const status = h('p', { class: 'note', 'aria-live': 'polite' }, 'Loading');
  const list = h('ul', { class: 'list' });
  const near = h('button', { class: 'btn', type: 'button', hidden: true }, 'Sort by distance');
  const close = h('button', { class: 'btn', type: 'button', onclick: () => dlg.close() }, 'Close');
  body.replaceChildren(h('h2', {}, title), input, h('div', { class: 'row' }, near, close), status, list);
  if (!dlg.open) dlg.showModal();

  let items = [], pos = null;
  const draw = () => {
    const words = input.value.toLowerCase().split(/\s+/).filter(Boolean);
    let hits = items.filter(i => words.every(w => `${i.label} ${i.sub || ''}`.toLowerCase().includes(w)));
    if (pos) hits = hits.filter(i => i.lat != null).map(i => ({ ...i, d: haversine(pos, i) })).sort((a, b) => a.d - b.d);
    hits = hits.slice(0, 60);
    status.textContent = hits.length ? '' : (emptyText || 'Nothing matches that.');
    list.replaceChildren(...hits.map(i => h('li', {}, h('button', { type: 'button', onclick: () => { dlg.close(); onPick(i); } },
      h('span', {}, i.label), h('span', { class: 'sub' }, i.d != null ? fmtDistance(i.d) : i.sub || '')))));
  };
  input.addEventListener('input', draw);
  try { items = await load(); } catch (e) { status.textContent = e?.message === 'not-configured' ? 'Live data is not connected yet. The Worker link is missing, so this list cannot load.' : 'Could not load the list. Try again in a moment.'; return; }
  near.hidden = !items.some(i => i.lat != null);
  near.onclick = async () => {
    try { pos = await getPosition(); near.hidden = true; draw(); }
    catch { status.textContent = 'Location is off or blocked, so the list stays alphabetical.'; }
  };
  items.sort((a, b) => a.label.localeCompare(b.label));
  draw(); input.focus();
}
