// Browser entry point. Owns the 100ms clock, hands input to the sim and
// snapshots to the renderer. No game rules live here.

import { loadContent, applyScheme } from './content/load.js';
import { createState } from './engine/state.js';
import { step, snapshot, applyOrders } from './engine/tick.js';
import { render, renderEnd, resetRenderer } from './ui/render.js';
import { createLog } from './ui/log.js';
import { createInput } from './ui/input.js';
import { createGambitEditor } from './ui/gambit.js';
import { buildDrillBoss, gauntletStage, applyCarry } from './engine/scenario.js';
import { applyAura } from './engine/auras.js';

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
let drill = 'lavaGeyser';
let drillCount = 0;
const modifiers = new Set();

// A Gauntlet run: three pulls, health carrying over, a modifier rolled
// each stage and a pickup chosen between them.
const run = { stage: 0, modifiers: [], boons: [], carryHealthPct: 100, dead: false };
function resetRun() {
  run.stage = 0;
  run.modifiers = [];
  run.boons = [];
  run.carryHealthPct = 100;
  run.dead = false;
}
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
const visibleModes = Object.values(content.modes)
  .filter((m) => !m.hidden)
  .sort((a, b) => (a.order || 0) - (b.order || 0));
modePicker.innerHTML = visibleModes
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
  document.getElementById('drillHeading').hidden = mode !== 'drill';
  document.getElementById('drillPicker').hidden = mode !== 'drill';
  document.getElementById('modifierHeading').hidden = mode === 'drill';
  document.getElementById('modifierPicker').hidden = mode === 'drill';
  resetRun();
  // The control scheme still matters in gambit -- it sets how fast the
  // bots move and whether they have a global cooldown.
  gambit.setVisible(content.modes[mode].control === 'none');
}

const drillPicker = document.getElementById('drillPicker');
drillPicker.innerHTML = Object.entries(content.drills)
  .map(
    ([id, d]) => `<button class="chip ${id === drill ? 'sel' : ''}" data-drill="${id}">
      <b>${d.name}</b>${d.desc}</button>`
  )
  .join('');
drillPicker.addEventListener('click', (e) => {
  const chip = e.target.closest('[data-drill]');
  if (!chip) return;
  drill = chip.dataset.drill;
  [...drillPicker.children].forEach((c) => c.classList.toggle('sel', c.dataset.drill === drill));
});

const modifierPicker = document.getElementById('modifierPicker');
modifierPicker.innerHTML =
  Object.values(content.modifiers)
    .map(
      (m) => `<button class="chip" data-mod="${m.id}">
      <b>${m.name}</b>${m.desc} <i>bots win ${m.bots}</i></button>`
    )
    .join('') +
  `<button class="chip" data-roulette="1"><b>Roulette</b>Roll one or two of them for me and do not tell me which until the pull screen.</button>`;
modifierPicker.addEventListener('click', (e) => {
  if (e.target.closest('[data-roulette]')) {
    const ids = Object.keys(content.modifiers);
    modifiers.clear();
    const many = 1 + Math.floor(Math.random() * 2);
    while (modifiers.size < many) modifiers.add(ids[Math.floor(Math.random() * ids.length)]);
    for (const node of modifierPicker.querySelectorAll('[data-mod]')) {
      node.classList.toggle('sel', modifiers.has(node.dataset.mod));
    }
    gambit.setModifiers([...modifiers]);
    return;
  }
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

// The button is disabled in the markup until the content is in, so an
// early click cannot silently do nothing.
const startBtn = document.getElementById('startBtn');
startBtn.disabled = false;
startBtn.textContent = 'Pull';
startBtn.addEventListener('click', () => start());
document.getElementById('endOverlay').addEventListener('click', (e) => {
  const boon = e.target.closest('[data-boon]');
  if (boon) {
    run.boons.push(boon.dataset.boon);
    start();
    return;
  }
  if (e.target.id === 'retryBtn') {
    if (mode === 'gauntlet') resetRun();
    start();
  }
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

  // Drill and Gauntlet rearrange the handcrafted fight rather than
  // replacing it -- what you practise is what you meet.
  let bossId = 'chthon';
  let stageModifiers = [...modifiers];
  if (mode === 'drill') {
    const boss = buildDrillBoss(active, drill);
    active = { ...active, bosses: { ...active.bosses, [boss.id]: boss } };
    bossId = boss.id;
    stageModifiers = [];
  }
  const stage = mode === 'gauntlet' ? gauntletStage(run) : null;
  if (stage) stageModifiers = [...modifiers, ...stage.modifiers];

  state = createState(active, {
    seed: (Math.random() * 1e9) | 0,
    playerRole: role,
    mode,
    modifiers: stageModifiers,
    boss: bossId,
    hardStopSeconds: mode === 'drill' ? 900 : undefined,
  });
  if (stage) applyCarry(state, active, stage, applyAura);
  drillCount = 0;
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
    finish();
  }
}

/* ------------------------------------------------------- the aftermath */

function finish() {
  const mine = state.playerIds.length
    ? state.playerIds
    : state.units.filter((u) => u.team === 'party').map((u) => u.id);
  const stats = {
    playerDamage: mine.reduce((sum, id) => sum + (state.stats.damageBy[id] || 0), 0),
    playerHealing: mine.reduce((sum, id) => sum + (state.stats.healBy[id] || 0), 0),
    deaths: state.stats.deaths.map((d) => ({
      ...d,
      name: state.units.find((u) => u.id === d.unit).name,
    })),
  };

  if (mode === 'drill') return renderDrillEnd(view, stats);
  if (mode === 'gauntlet' && state.result === 'kill') return renderStageCleared(stats);
  if (mode === 'gauntlet') return renderRunOver(stats);
  renderEnd(view, active, stats);
}

// A drill has no kill. The score is how many repetitions you stood
// through, and how many of them actually landed on you.
function renderDrillEnd(v, stats) {
  const def = content.drills[drill];
  const entry = active.bosses[`drill_${drill}`].phases[0].timeline[1];
  const reps = Math.max(0, Math.floor((v.seconds - entry.t) / entry.every) + 1);
  const player = state.units.find((u) => u.id === state.playerIds[0]);
  const hits = state.log.filter(
    (l) => l.text.includes(`— ${def.name} —`) && player && l.text.includes(player.name)
  ).length;
  renderEnd(v, active, {
    ...stats,
    title: 'Drill Over',
    subtitle: `${def.name} came at you ${reps} times. It caught you ${hits}.`,
    scoreboard: [
      [reps, 'Repetitions'],
      [`${Math.max(0, reps - hits)}`, 'Clean'],
      [`${Math.floor(v.seconds / 60)}:${String(Math.floor(v.seconds % 60)).padStart(2, '0')}`, 'Survived'],
    ],
  });
}

function renderStageCleared(stats) {
  run.stage += 1;
  const party = view.party.filter((u) => u.alive);
  run.carryHealthPct = Math.round(party.reduce((sum, u) => sum + u.hpPct, 0) / Math.max(1, party.length));

  const stages = content.modes.gauntlet.stages;
  if (run.stage >= stages) {
    return renderEnd(view, active, {
      ...stats,
      title: 'Gauntlet Cleared',
      subtitle: `Three kills, no rest. You finished on ${run.carryHealthPct}% health with ${run.boons.length} pickups.`,
    });
  }

  // The pit rolls something new, and you choose what you take with you.
  const unused = Object.keys(content.modifiers).filter((id) => !run.modifiers.includes(id));
  const rolled = unused[Math.floor(Math.random() * unused.length)];
  run.modifiers.push(rolled);
  const boonIds = ['boonQuad', 'boonPentagram', 'boonMegahealth', 'boonBiosuit']
    .filter((id) => !run.boons.includes(id))
    .sort(() => Math.random() - 0.5)
    .slice(0, 2);

  document.getElementById('endCard').innerHTML = `
    <h1>Stage ${run.stage} Cleared</h1>
    <p>The party walks on with <b>${run.carryHealthPct}%</b> health. The pit answers with
      <b style="color:var(--ember)">${content.modifiers[rolled].name}</b> —
      ${content.modifiers[rolled].desc}</p>
    <h2>Take one with you</h2>
    <div class="chips">${boonIds
      .map(
        (id) => `<button class="chip" data-boon="${id}">
          <b>${content.auras[id].name}</b>${boonText(id)}</button>`
      )
      .join('')}</div>`;
  document.getElementById('endOverlay').classList.remove('hide');
}

const boonText = (id) =>
  ({
    boonQuad: 'Everything you hit takes 25% more.',
    boonPentagram: 'The party takes 12% less damage for the rest of the run.',
    boonMegahealth: 'Heals landing on the party are 20% stronger.',
    boonBiosuit: 'Your healer heals for 18% more.',
  })[id];

function renderRunOver(stats) {
  renderEnd(view, active, {
    ...stats,
    title: 'The Run Ends',
    subtitle: `You got to stage ${run.stage + 1} of ${content.modes.gauntlet.stages}` +
      `${run.modifiers.length ? `, carrying ${run.modifiers.map((m) => content.modifiers[m].name).join(' and ')}` : ''}.`,
  });
}
