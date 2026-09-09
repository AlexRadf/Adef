// Browser entry point. Owns the 100ms clock, hands input to the sim and
// snapshots to the renderer. No game rules live here.

import { loadContent, applyScheme } from './content/load.js';
import { createState } from './engine/state.js';
import { step, snapshot, applyOrders } from './engine/tick.js';
import { render, renderEnd, resetRenderer } from './ui/render.js';
import { createLog } from './ui/log.js';
import { createInput } from './ui/input.js';
import { createGambitEditor } from './ui/gambit.js';

const TICK_MS = 100;
const ROLES = [
  { role: 'tank', name: 'Ranger', title: 'Vanguard', blurb: 'Hold threat, eat Magma Cleave, pop the Pentagram before Scorched buries you.' },
  { role: 'healer', name: 'Crash', title: 'Field Medic', blurb: 'Keep four people alive, cleanse Slipgate Rift, never let your Bio-Cells hit zero.' },
  { role: 'dps', name: 'Visor', title: 'Slayer', blurb: 'Burn the boss, kill the Scrags, and land the Thunderbolt interrupt every time.' },
];

const content = await loadContent();
const gambit = createGambitEditor(content);
const logView = createLog(document.getElementById('combatLog'));
const inputQueue = [];

let state = null;
let view = null;
let timer = null;
let paused = false;
let role = 'dps';
let scheme = 'raid';
let mode = 'solo';
const modifiers = new Set();
let active = null; // content with this scheme's ability overrides folded in

const input = createInput(inputQueue, () => view, {
  togglePause: () => setPaused(!paused, ''),
  reset: () => start(),
});

function setPaused(value, reason = '') {
  if (!state || state.over) return;
  paused = value;
  const tag = document.getElementById('pausedTag');
  tag.hidden = !paused;
  tag.textContent = reason ? `${reason.replace(/^[\s—-]+|[\s—-]+$/g, '')}  ·  space to resume` : '— PAUSED —';
}

/* ------------------------------------------------------- start screen */

const modePicker = document.getElementById('modePicker');
modePicker.innerHTML = Object.values(content.modes)
  .map(
    (m) => `<div class="role ${m.id === mode ? 'sel' : ''}" data-mode="${m.id}">
      <b>${m.name}</b><em>${m.tagline}</em></div>`
  )
  .join('');
modePicker.addEventListener('click', (e) => {
  const card = e.target.closest('[data-mode]');
  if (!card) return;
  mode = card.dataset.mode;
  [...modePicker.children].forEach((c) => c.classList.toggle('sel', c.dataset.mode === mode));
  describeMode();
});
function describeMode() {
  document.getElementById('modeHelp').textContent = content.modes[mode].blurb;
  const soloOnly = content.modes[mode].control === 'one';
  document.getElementById('roleHeading').hidden = !soloOnly;
  document.getElementById('rolePicker').hidden = !soloOnly;
  // The control scheme still matters in gambit -- it sets how fast the
  // bots move and whether they have a global cooldown.
  gambit.setVisible(content.modes[mode].control === 'none');
}

const modifierPicker = document.getElementById('modifierPicker');
modifierPicker.innerHTML = Object.values(content.modifiers)
  .map(
    (m) => `<button class="chip" data-mod="${m.id}">
      <b>${m.name}</b>${m.desc} <i>bots win ${m.bots}</i></button>`
  )
  .join('');
modifierPicker.addEventListener('click', (e) => {
  const chip = e.target.closest('[data-mod]');
  if (!chip) return;
  const id = chip.dataset.mod;
  if (modifiers.has(id)) modifiers.delete(id);
  else modifiers.add(id);
  chip.classList.toggle('sel', modifiers.has(id));
  gambit.setModifiers([...modifiers]);
});

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
  gambit.setScheme(scheme);
});
function describeScheme() {
  document.getElementById('schemeHelp').textContent = content.schemes[scheme].blurb;
}
describeScheme();
describeMode();
gambit.setScheme(scheme);

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
  input.setScheme(scheme, mode);

  active = { ...applyScheme(content, scheme), ai: gambit.lists() };
  state = createState(active, {
    seed: (Math.random() * 1e9) | 0,
    playerRole: role,
    mode,
    modifiers: [...modifiers],
  });
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
  if (paused) {
    // Frozen, but still listening: this is where commander orders go in.
    applyOrders(state, active, inputQueue);
    view = snapshot(state, active);
    render(view, active, hud());
    return;
  }
  step(state, active, inputQueue);
  view = snapshot(state, active);
  render(view, active, hud());
  logView.push(state.log);

  // Tactical pause: stop the world on anything the mode says you would
  // want to react to. Commanding four characters at ten ticks a second
  // is otherwise not a game, it is a typing test.
  const watch = content.modes[mode].pauseOn;
  if (watch.length && !state.over && state.tick > 20) {
    const hit = view.events.find((e) => watch.includes(e.kind));
    if (hit) setPaused(true, hit.text);
  }
  if (state.over) {
    clearInterval(timer);
    const mine = state.playerIds.length ? state.playerIds : state.units.filter((u) => u.team === 'party').map((u) => u.id);
    renderEnd(view, active, {
      playerDamage: mine.reduce((sum, id) => sum + (state.stats.damageBy[id] || 0), 0),
      playerHealing: mine.reduce((sum, id) => sum + (state.stats.healBy[id] || 0), 0),
      deaths: state.stats.deaths.map((d) => ({
        ...d,
        name: state.units.find((u) => u.id === d.unit).name,
      })),
    });
  }
}
