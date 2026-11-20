import { $, h, palette, attachSheet } from './util.js';
import { loadState, saveState } from './state.js';
import { AGENCIES, LOGOS } from './config.js';
import { mountBoard } from './board.js';
import { mountSurface } from './surface.js';
import { mountLeave } from './leave.js';
import { mountJourney } from './journey.js';
import { openPicker } from './picker.js';
import * as api from './api.js';

const state = loadState();
const root = $('#view');
const header = { mark: $('#mark'), title: $('#lineName'), dir: $('#dirLetter'), dirBtn: $('#dirBtn'), titleBtn: $('#titleBtn') };
const save = () => saveState(state);
let subway = null; // station data built by tools/build-subway.mjs
const views = { board: mountBoard, surface: mountSurface, leave: mountLeave, journey: mountJourney };
let current = null;

// The bars use Apple's neutral glass, so the logo reverses with the OS appearance:
// white logo in dark mode, colour logo in light mode.
const barDark = () => window.matchMedia('(prefers-color-scheme: dark)').matches;
const logoSrc = () => {
  const l = LOGOS[state.agency];
  if (!l) return '';
  return barDark() ? (l.white || l.color) : l.color;
};

function setPalette(bg) {
  const p = palette(state.colour ? bg : '#2b2e35');
  const s = document.documentElement.style;
  s.setProperty('--bg', p.bg); s.setProperty('--fg', p.fg); s.setProperty('--dim', p.dim);
  s.setProperty('--accent', p.bg);
  $('meta[name=theme-color]').setAttribute('content', p.bg);
  const img = header.mark.querySelector('img');
  if (img) img.src = logoSrc();
}

function drawMark() {
  const a = AGENCIES[state.agency], src = logoSrc();
  header.mark.replaceChildren(src ? h('img', { src, alt: '', height: '28' }) : a.mark);
  $('#agencyBtn').setAttribute('aria-label', `Menu. Current agency: ${a.name}.`);
}

function navigate(view) {
  if (current) current.unmount();
  state.view = view; save();
  document.querySelectorAll('nav button').forEach(b => (b.dataset.view === view ? b.setAttribute('aria-current', 'page') : b.removeAttribute('aria-current')));
  drawMark();
  current = views[view](ctx);
}

async function loadSubway() {
  if (subway) return subway;
  try { subway = await (await fetch('data/ttc-subway.json')).json(); } catch { subway = { lines: {} }; }
  return subway;
}

async function pickStation() {
  // GO stations are picked on the service map, not from a list.
  if (state.agency === 'go') { navigate('surface'); return; }
  const data = await loadSubway();
  openPicker({
    title: 'Subway station',
    emptyText: 'Subway station data has not been built yet. See the README.',
    load: async () => Object.entries(data.lines).flatMap(([line, l]) =>
      l.stations.map(s => ({ id: `${line}:${s.name}`, label: s.name, sub: `Line ${line}`, lat: s.lat, lng: s.lng, line, station: s }))),
    onPick: i => { state.ttc = { line: i.line, station: { name: i.station.name, lat: i.station.lat, lng: i.station.lng, codes: i.station.codes }, dir: null }; save(); navigate('board'); }
  });
}

function openMenu() {
  const dlg = $('#menu'), body = $('#menuBody');
  const segInd = h('span', { class: 'seg-ind' });
  const segBtn = (key, label) => h('button', { type: 'button', 'aria-pressed': String(state.agency === key), onclick: () => { state.agency = key; save(); dlg.closeSheet(); navigate('board'); } }, label);
  const seg = h('div', { class: 'seg' }, segInd, segBtn('go', 'GO Transit'), segBtn('ttc', 'TTC'));
  segInd.style.transform = state.agency === 'ttc' ? 'translateX(100%)' : 'translateX(0)';
  const sw = h('button', { class: 'switch', type: 'button', role: 'switch', 'aria-checked': String(state.colour), 'aria-label': 'Colour', onclick: e => { state.colour = !state.colour; save(); e.currentTarget.setAttribute('aria-checked', String(state.colour)); current && navigate(state.view); } }, h('span', { class: 'knob' }));
  body.replaceChildren(
    h('h2', {}, 'Menu'),
    h('p', { class: 'sec' }, 'Agency'),
    seg,
    h('button', { class: 'btn wide ghost', type: 'button', disabled: true }, 'Local transit (not connected yet)'),
    h('p', { class: 'sec' }, 'Display'),
    h('div', { class: 'switch-row' }, h('span', {}, 'Colour'), sw),
    h('div', { class: 'row' },
      h('button', { class: 'btn', type: 'button', onclick: () => dlg.closeSheet(() => pickStation()) }, 'Choose station'),
      h('a', { class: 'btn', href: 'privacy.html' }, 'Privacy')),
    h('button', { class: 'btn primary wide close-btn', type: 'button', onclick: () => dlg.closeSheet() }, 'Close'),
    h('p', { class: 'note small' }, 'Unofficial. Not affiliated with the TTC, GO Transit or Metrolinx. Contains information licensed under the Open Government Licence – Ontario.'));
  dlg.showModal();
}

const ctx = { state, root, header, save, setPalette, navigate, pickStation, subwayReady: () => !subway || Object.keys(subway.lines).length > 0 };
attachSheet($('#menu')); attachSheet($('#picker'));
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => drawMark());
$('#agencyBtn').addEventListener('click', openMenu);
document.querySelectorAll('nav button').forEach(b => b.addEventListener('click', () => navigate(b.dataset.view)));
loadSubway().finally(() => navigate(state.view));
