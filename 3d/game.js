// The 3D entry point. It owns two clocks: the sim's fixed 10Hz tick, and
// the renderer's frame rate. Everything between them is interpolation.
//
// The sim itself is untouched -- the same engine the 2D build and the
// headless runner use. This file only decides where the camera is and
// turns mouse-look into the inputs the tick already understood.

import { loadContent, applyStyle, overrideAbilities } from '../content/load.js';
import { createState } from '../engine/state.js';
import { step, snapshot } from '../engine/tick.js';
import { spawnPickup } from '../engine/abilities.js';
import { buildLobbyBoss } from '../engine/scenario.js';
import { createScene, toSim } from './scene.js';
import { createRig } from './camera.js';
import { createControls } from './controls.js';
import { createHud } from './hud.js';

const TICK_MS = 100;
const content = await loadContent();
const hud = createHud(content);
const canvas = document.getElementById('view');
const world = createScene(canvas);
const rig = createRig();

let game = 'wow';
let role = 'dps';
let active = null;
let state = null;
let view = null;
let queue = [];
let running = false;
let paused = false;
let scenario = 'lobby';
let lobbyStart = 0;
let accumulator = 0;
let last = performance.now();

/* --------------------------------------------------------- controls */

const controls = createControls(canvas, rig, () => view, {
  onPointerLock: (locked) => {
    document.getElementById('hint').hidden = locked;
    if (!locked && running) paused = true;
    if (locked) paused = false;
  },
  fire: (slot) => fireSlot(slot),
  dash: () => queue.push({ type: 'dash' }),
  setBlocking: (on) => queue.push({ type: 'block', on }),
  togglePause: () => (paused = !paused),
  reset: () => start(),
  cycleTarget: () => {
    if (!view) return;
    const enemies = view.enemies.filter((u) => u.alive);
    if (!enemies.length) return;
    const me = view.party.find((u) => u.id === view.playerId);
    const i = enemies.findIndex((u) => u.id === (me && me.targetId));
    queue.push({ type: 'targetEnemy', unitId: enemies[(i + 1) % enemies.length].id });
  },
});

function fireSlot(slot) {
  const player = view && view.party.find((u) => u.id === view.playerId);
  const id = player && player.abilities[slot];
  if (id) queue.push({ type: 'cast', abilityId: id });
}

/* ------------------------------------------------------- the clocks */

function start(which = 'encounter') {
  scenario = which;
  const def = content.games[game];
  // A game's signature mechanic rides on top of its style.
  active = overrideAbilities(applyStyle(content, def.style), def.abilities);

  let bossId = 'chthon';
  if (scenario === 'lobby') {
    const dummy = buildLobbyBoss(active);
    active = { ...active, bosses: { ...active.bosses, [dummy.id]: dummy } };
    bossId = dummy.id;
  }

  state = createState(active, {
    seed: (Math.random() * 1e9) | 0,
    playerRole: role,
    mode: 'solo',
    boss: bossId,
    hardStopSeconds: scenario === 'lobby' ? 3600 : undefined,
  });
  // Quake's arena is a resource: put the pickups on the floor.
  for (const pickup of def.pickups || []) spawnPickup(state, pickup, pickup.at);
  lobbyStart = 0;
  view = snapshot(state, active);
  queue = [];
  hud.reset();
  world.commit(view);
  running = true;
  paused = false;
  accumulator = 0;
  last = performance.now();
  const me = view.party.find((u) => u.id === view.playerId);
  if (me) rig.aimAtCentre(me, def.camera);
  controls.setSensitivity(def.sensitivity || 1);
  controls.setHoldFire(!!def.holdFire);
  document.getElementById('menu').hidden = true;
  document.getElementById('over').hidden = true;
  document.getElementById('crosshair').hidden = def.camera === 'orbit';
  document.getElementById('lobbyTag').hidden = scenario !== 'lobby';
  document.getElementById('signature').textContent = def.signature || '';
  canvas.requestPointerLock();
}

function tick() {
  const player = view.party.find((u) => u.id === view.playerId);
  if (!player || !player.alive) {
    step(state, active, queue);
    return;
  }

  // Held fire: one press, a stream of shots at the weapon's own rate.
  // This is what stops combat feeling like mashing a key.
  if (controls.isFiring() && controls.state.holdFire) {
    const id = player.abilities[0];
    const ready = (player.cooldowns[id] || 0) <= 0 && player.gcdRemaining <= 0;
    if (ready) queue.push({ type: 'cast', abilityId: id });
  }

  const dir = controls.moveDirection(padStick);
  queue.push({ type: 'moveDir', x: dir.x, y: dir.y });

  const hit = rig.aimPoint(world.camera);
  if (hit) {
    const p = toSim(hit);
    queue.push({ type: 'aim', x: p.x, y: p.y });
  }

  step(state, active, queue);
}

let padStick = null;

function frame(now) {
  requestAnimationFrame(frame);
  world.resize();
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  padStick = controls.pollGamepad(dt);

  if (running && !paused) {
    accumulator += dt * 1000;
    while (accumulator >= TICK_MS) {
      accumulator -= TICK_MS;
      world.commit(view);
      tick();
      view = snapshot(state, active);
          if (state.over && scenario !== 'lobby') finish();
    }
  }

  if (view) {
    const def = content.games[game];
    const player = view.party.find((u) => u.id === view.playerId);
    const locked = view.enemies.find((u) => u.id === (player && player.targetId)) || view.boss;
    world.paint(view, Math.min(1, accumulator / TICK_MS), now / 1000, {
      hideSelf: def.camera === 'first',
      cameraPos: world.camera.position,
    });
    if (player) rig.apply(world.camera, def.camera, player, locked, dt);
    hud.paint(view, {
      targetName: locked ? locked.name : '',
      modeName: def.name,
      lobby: scenario === 'lobby' ? lobbyStats() : null,
      pad: controls.state.pad,
    });
  }
  world.renderer.render(world.scene, world.camera);
}

// What a dummy is for: a number that tells you whether the loop works.
function lobbyStats() {
  const player = view.party.find((u) => u.id === view.playerId);
  if (!player) return null;
  const dealt = state.stats.damageBy[player.id] || 0;
  const healed = state.stats.healBy[player.id] || 0;
  if (!lobbyStart && (dealt || healed)) lobbyStart = state.tick;
  const seconds = Math.max(1, (state.tick - lobbyStart) / 10);
  return { dps: Math.round(dealt / seconds), hps: Math.round(healed / seconds), seconds };
}

function finish() {
  running = false;
  document.exitPointerLock();
  const won = state.result === 'kill';
  document.getElementById('over').hidden = false;
  document.getElementById('overTitle').textContent = won ? 'Chthon Falls' : 'Wipe';
  document.getElementById('overBody').textContent = won
    ? `Killed in ${Math.floor(view.seconds / 60)}:${String(Math.floor(view.seconds % 60)).padStart(2, '0')}.`
    : `The party is dead with Chthon at ${view.boss.hpPct.toFixed(1)}%.`;
}

/* ----------------------------------------------------------- menu */

const menu = document.getElementById('games');
menu.innerHTML = Object.values(content.games)
  .map(
    (g) => `<button class="game ${g.id === game ? 'sel' : ''}" data-game="${g.id}">
      <b>${g.name}</b><em>after ${g.inspiration}</em>
      <span>${g.tagline}</span>
      <i class="sig">${g.signature ? g.signature.split('—')[0].trim() : ''}</i>
      <i class="bots">bots win ${g.bots}</i></button>`
  )
  .join('');
menu.addEventListener('click', (e) => {
  const card = e.target.closest('[data-game]');
  if (!card) return;
  game = card.dataset.game;
  [...menu.children].forEach((c) => c.classList.toggle('sel', c.dataset.game === game));
  const def = content.games[game];
  document.getElementById('gameBlurb').textContent = `${def.blurb}  ${def.signature || ''}`;
});
document.getElementById('gameBlurb').textContent =
  `${content.games[game].blurb}  ${content.games[game].signature || ''}`;

const roles = document.getElementById('roles');
roles.addEventListener('click', (e) => {
  const card = e.target.closest('[data-role]');
  if (!card) return;
  role = card.dataset.role;
  [...roles.children].forEach((c) => c.classList.toggle('sel', c.dataset.role === role));
});
document.getElementById('play').addEventListener('click', () => start('lobby'));
document.getElementById('again').addEventListener('click', () => start('lobby'));
window.addEventListener('keydown', (e) => {
  if (e.key.toLowerCase() === 'e' && scenario === 'lobby' && running) start('encounter');
});
document.getElementById('play').disabled = false;
document.getElementById('play').textContent = 'Enter the pit';

requestAnimationFrame(frame);
window.__raid3d = { state: () => state, view: () => view, world, rig };
