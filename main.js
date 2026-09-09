// Browser entry point. Owns the 100ms clock, hands input to the sim and
// snapshots to the renderer. No game rules live here.

import { loadContent, applyScheme } from './content/load.js';
import { createState } from './engine/state.js';
import { step, snapshot } from './engine/tick.js';
import { render, renderEnd, resetRenderer } from './ui/render.js';
import { createLog } from './ui/log.js';
import { createInput } from './ui/input.js';

const TICK_MS = 100;
const ROLES = [
  { role: 'tank', name: 'Ranger', title: 'Vanguard', blurb: 'Hold threat, eat Magma Cleave, pop the Pentagram before Scorched buries you.' },
  { role: 'healer', name: 'Crash', title: 'Field Medic', blurb: 'Keep four people alive, cleanse Slipgate Rift, never let your Bio-Cells hit zero.' },
  { role: 'dps', name: 'Visor', title: 'Slayer', blurb: 'Burn the boss, kill the Scrags, and land the Thunderbolt interrupt every time.' },
];

const content = await loadContent();
const logView = createLog(document.getElementById('combatLog'));
const inputQueue = [];

let state = null;
let view = null;
let timer = null;
let paused = false;
let role = 'dps';
let scheme = 'raid';
let active = null; // content with this scheme's ability overrides folded in

const input = createInput(inputQueue, () => view, {
  togglePause: () => {
    if (!state || state.over) return;
    paused = !paused;
    document.getElementById('pausedTag').hidden = !paused;
  },
  reset: () => start(),
});

/* ------------------------------------------------------- start screen */

const picker = document.getElementById('rolePicker');
picker.innerHTML = ROLES.map(
  (r) => `<div class="role ${r.role === role ? 'sel' : ''}" data-role="${r.role}">
    <b>${r.title}</b><em>${r.name}</em>
    <div style="font-size:11px;color:var(--dim);margin-top:6px">${r.blurb}</div>
  </div>`
).join('');
picker.addEventListener('click', (e) => {
  const card = e.target.closest('[data-role]');
  if (!card) return;
  role = card.dataset.role;
  [...picker.children].forEach((c) => c.classList.toggle('sel', c.dataset.role === role));
});

const schemePicker = document.getElementById('schemePicker');
schemePicker.innerHTML = Object.values(content.schemes)
  .map(
    (s) => `<div class="role ${s.id === scheme ? 'sel' : ''}" data-scheme="${s.id}">
      <b>${s.name}</b><em>${s.tagline}</em>
    </div>`
  )
  .join('');
schemePicker.addEventListener('click', (e) => {
  const card = e.target.closest('[data-scheme]');
  if (!card) return;
  scheme = card.dataset.scheme;
  [...schemePicker.children].forEach((c) => c.classList.toggle('sel', c.dataset.scheme === scheme));
  describeScheme();
});
function describeScheme() {
  document.getElementById('schemeHelp').textContent = content.schemes[scheme].blurb;
}
describeScheme();

document.getElementById('startBtn').addEventListener('click', () => start());
document.getElementById('endOverlay').addEventListener('click', (e) => {
  if (e.target.id === 'retryBtn') start();
});

/* -------------------------------------------------------------- loop */

function start() {
  clearInterval(timer);
  inputQueue.length = 0;
  paused = false;
  document.getElementById('pausedTag').hidden = true;
  document.getElementById('startOverlay').classList.add('hide');
  document.getElementById('endOverlay').classList.add('hide');
  logView.reset();
  resetRenderer();
  input.setScheme(scheme);

  active = applyScheme(content, scheme);
  state = createState(active, { seed: (Math.random() * 1e9) | 0, playerRole: role });
  view = snapshot(state, active);
  render(view, active, hud());
  logView.push(state.log);

  timer = setInterval(frame, TICK_MS);
}

// Things the renderer shows but the sim has no opinion about.
function hud() {
  const queued = inputQueue.find((i) => i.type === 'cast');
  const lowest = view.party
    .filter((u) => u.alive)
    .sort((a, b) => a.hpPct - b.hpPct)[0];
  return { queued: queued && queued.abilityId, autoHealTarget: lowest && lowest.id };
}

// Handy from the devtools console: __raid.state().units, __raid.content, etc.
window.__raid = { state: () => state, view: () => view, content: () => active, queue: inputQueue };

function frame() {
  if (paused) return;
  step(state, active, inputQueue);
  view = snapshot(state, active);
  render(view, active, hud());
  logView.push(state.log);
  if (state.over) {
    clearInterval(timer);
    renderEnd(view, active, {
      playerDamage: state.stats.damageBy[state.playerId] || 0,
      playerHealing: state.stats.healBy[state.playerId] || 0,
      deaths: state.stats.deaths.map((d) => ({
        ...d,
        name: state.units.find((u) => u.id === d.unit).name,
      })),
    });
  }
}
