// The 3D entry point. It owns two clocks: the sim's fixed 10Hz tick, and
// the renderer's frame rate. Everything between them is interpolation.
//
// The sim itself is untouched -- the same engine the 2D build and the
// headless runner use. This file only decides where the camera is, turns
// mouse-look into the inputs the tick already understood, and runs the
// practice range on top of both.

import { loadContent, applyGame } from '../content/load.js';
import { createState } from '../engine/state.js';
import { step, snapshot } from '../engine/tick.js';
import { spawnPickup } from '../engine/abilities.js';
import { buildLobbyBoss, buildDrillBoss } from '../engine/scenario.js';
import { createScene, toSim } from './scene.js';
import { createRig } from './camera.js';
import { createControls } from './controls.js';
import { createHud } from './hud.js';
import { createFloaters } from './floaters.js';
import { applyAura } from '../engine/auras.js';
import { toTicks } from '../engine/clock.js';
import * as THREE from '../vendor/three.module.js';
import { loadLevel } from './level.js';
import { createHub } from './hub.js';
import { createProgress } from './progress.js';
import { createPanels } from './panels.js';

const TICK_MS = 100;
const content = await loadContent();
const hud = createHud(content);
const canvas = document.getElementById('view');
const world = createScene(canvas);
const rig = createRig();
const floaters = createFloaters(document.getElementById('floaters'));

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

// The practice range: what the room is set up as, and what the rules of
// the room are. None of it survives into an encounter pull.
const practice = { invulnerable: false, infiniteResource: false, noCooldowns: false };
let drill = '';        // '' is the plain dummy
let timeScale = 1;     // slow motion is a render-clock thing, never a sim thing
let screen = null;     // 'practice' | 'kit' | null

// The hub and the raids. A raid run is which raid, which encounter, and
// whether it is on Heroic; everything else about a pull is as before.
const progress = createProgress();
let raidRun = null;
let hub = null;
let hubScene = null;
let npcInRange = null;
const levels = new Map();
const levelTitles = {};
const getLevel = async (id) => {
  if (!levels.has(id)) levels.set(id, loadLevel(id));
  const level = await levels.get(id);
  levelTitles[id] = level.meta.title;
  return level;
};
let launch = { heroic: false };

const panelActions = {
  close: () => closePanel(),
  launch: (arg) => launchRaid(launch.raid, Number(arg)),
  raidHeroic: (arg) => ((launch.heroic = arg === '1'), openPanel('raid', launch.raid)),
  raidGame: (arg) => ((game = arg), openPanel('raid', launch.raid)),
  raidRole: (arg) => ((role = arg), hub && hub.setRole(role), openPanel('raid', launch.raid)),
  equip: (arg) => (progress.equip(Number(arg)), openPanel('character')),
  scrap: (arg) => (progress.scrap(Number(arg)), openPanel('character')),
  buy: (arg) => (progress.buy(arg), openPanel('vendor')),
  claim: (arg) => (progress.claimBounty(arg), openPanel('bounties')),
  journal: (arg) => openPanel('journal', content.raids[arg]),
  range: () => {
    panels.hide();
    start('lobby');
  },
  resetSave: (arg, button) => {
    if (button.dataset.armed) {
      progress.reset();
      openPanel('character');
    } else {
      button.dataset.armed = '1';
      button.textContent = 'Click again to wipe your character';
    }
  },
  nextEncounter: () => {
    raidRun.index++;
    enterEncounter();
  },
  retryEncounter: () => enterEncounter(),
  toHub: () => enterHub(),
};
const panels = createPanels(document.getElementById('panel'), panelActions);

/* --------------------------------------------------------- controls */

const controls = createControls(canvas, rig, () => view, {
  onPointerLock: (locked) => {
    document.getElementById('hint').hidden = locked || !!screen || panels.open;
    if (scenario === 'hub') return;
    if (!locked && running && !screen) paused = true;
    if (locked) paused = false;
  },
  fire: (slot) => {
    if (scenario === 'hub') return slot === 0 ? hub && hub.jump() : slot === 2 ? interact() : null;
    fireSlot(slot);
  },
  dash: () => scenario !== 'hub' && queue.push({ type: 'dash' }),
  setBlocking: (on) => scenario !== 'hub' && queue.push({ type: 'block', on }),
  togglePause: () => (scenario === 'hub' ? hub && hub.jump() : (paused = !paused)),
  reset: () => scenario !== 'hub' && start(scenario),
  cycleTarget: () => {
    if (!view || scenario === 'hub') return;
    const enemies = view.enemies.filter((u) => u.alive);
    if (!enemies.length) return;
    const me = view.party.find((u) => u.id === view.playerId);
    const i = enemies.findIndex((u) => u.id === (me && me.targetId));
    queue.push({ type: 'targetEnemy', unitId: enemies[(i + 1) % enemies.length].id });
  },
});

function fireSlot(slot) {
  if (screen) return;
  const player = view && view.party.find((u) => u.id === view.playerId);
  const id = player && player.abilities[slot];
  if (id) queue.push({ type: 'cast', abilityId: id });
}

/* ------------------------------------------------------- the clocks */

function start(which = 'encounter') {
  scenario = which;
  if (which === 'lobby') {
    raidRun = null;
    world.setLevel(null);
  }
  const def = content.games[game];
  // A game is its style, its signature ability overrides and its rules,
  // assembled exactly the way the headless runner assembles it.
  active = applyGame(content, def);

  let bossId = 'chthon';
  let modifiers = [];
  if (scenario === 'encounter' && raidRun) {
    bossId = raidRun.raid.encounters[raidRun.index].boss;
    if (raidRun.heroic) modifiers = ['quickening'];
  }
  if (scenario === 'lobby') {
    // The range is either a dummy that does nothing, or one boss ability
    // on a loop -- so the thing you drill is the thing you will meet.
    const target = drill ? buildDrillBoss(active, drill) : buildLobbyBoss(active);
    active = { ...active, bosses: { ...active.bosses, [target.id]: target } };
    bossId = target.id;
  }

  state = createState(active, {
    seed: (Math.random() * 1e9) | 0,
    playerRole: role,
    mode: 'solo',
    boss: bossId,
    practice: scenario === 'lobby' ? practice : {},
    hardStopSeconds: scenario === 'lobby' ? 3600 : undefined,
    modifiers,
  });
  // Gear is a small permanent aura on you and nobody else -- the only
  // way progression reaches the sim, and capped so the fights stay tuned.
  if (scenario === 'encounter') {
    const def = progress.powerAura();
    active = { ...active, auras: { ...active.auras, gearPower: { ...def, durationTicks: toTicks(0) } } };
    const me = state.units.find((u) => u.id === state.activeId);
    if (me) applyAura(state, active, me.id, me, 'gearPower', { durationTicks: 0 });
  }
  document.body.dataset.mode = 'combat';
  if (hub) hub.show(false);
  // Quake's arena is a resource: put the pickups on the floor.
  for (const pickup of def.pickups || []) spawnPickup(state, pickup, pickup.at);
  lobbyStart = 0;
  world.clearActors();
  view = snapshot(state, active);
  queue = [];
  hud.reset();
  floaters.reset();
  world.commit(view);
  running = true;
  paused = false;
  accumulator = 0;
  last = performance.now();
  const me = view.party.find((u) => u.id === view.playerId);
  if (me) rig.aimAtCentre(me, def.camera);
  controls.setSensitivity(def.sensitivity || 1);
  controls.setHoldFire(!!def.holdFire);
  showScreen(null);
  document.getElementById('menu').hidden = true;
  document.getElementById('over').hidden = true;
  document.getElementById('crosshair').hidden = def.camera === 'orbit';
  document.getElementById('lobbyTag').hidden = scenario !== 'lobby';
  document.getElementById('signature').textContent = def.signature || '';
  lock();
}

// Asking for a lock we already hold logs a warning and does nothing
// useful, and asking outside a gesture fails silently -- so ask once.
function lock() {
  if (!controls.state.locked && !screen) canvas.requestPointerLock();
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
  const real = Math.min(0.1, (now - last) / 1000);
  last = now;
  padStick = controls.pollGamepad(real);
  // Slow motion scales how fast the sim's clock is fed, never the tick
  // itself: at 0.25x you get the same fight, four times as much time to
  // read it, and the same deterministic result.
  const dt = real * timeScale;

  if (scenario === 'hub') {
    if (hub) {
      const near = hub.update(panels.open ? 0 : real, now / 1000, panels.open ? null : padStick);
      if (near !== npcInRange) {
        npcInRange = near;
        const prompt = document.getElementById('hubPrompt');
        prompt.hidden = !near;
        if (near) prompt.innerHTML = `<kbd>E</kbd> ${near.name} — ${near.title}`;
      }
      paintHubHud();
      world.renderer.render(hubScene, world.camera);
    }
    return;
  }

  if (running && !paused && !screen) {
    accumulator += dt * 1000;
    while (accumulator >= TICK_MS) {
      accumulator -= TICK_MS;
      world.commit(view);
      tick();
      view = snapshot(state, active);
      floaters.ingest(view);
      if (state.over) {
        if (scenario === 'lobby') start('lobby'); // the range never ends
        else finish();
        break;
      }
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
    if (player) rig.apply(world.camera, def.camera, player, locked, real);
    hud.paint(view, {
      targetName: locked ? locked.name : '',
      modeName: def.name,
      lobby: scenario === 'lobby' ? lobbyStats() : null,
      pad: controls.state.pad,
      practiceLabel: scenario === 'lobby' ? practiceLabel() : '',
    });
    floaters.paint(world.camera, real, { w: canvas.clientWidth, h: canvas.clientHeight });
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

function practiceLabel() {
  const on = [];
  if (practice.invulnerable) on.push('invulnerable');
  if (practice.infiniteResource) on.push('infinite');
  if (practice.noCooldowns) on.push('no cooldowns');
  if (timeScale !== 1) on.push(`${timeScale}× speed`);
  if (drill) on.push(content.drills[drill].name);
  return on.join(' · ');
}

function finish() {
  running = false;
  document.exitPointerLock();
  if (raidRun) return finishRaidEncounter();
  const won = state.result === 'kill';
  const player = state.units.find((u) => u.id === state.activeId);
  const seconds = Math.max(1, state.tick / 10);
  const dealt = Math.round((state.stats.damageBy[state.activeId] || 0) / seconds);
  const healed = Math.round((state.stats.healBy[state.activeId] || 0) / seconds);
  const mine = state.stats.deaths.find((d) => d.unit === state.activeId);
  const nameOf = (id) => (state.units.find((u) => u.id === id) || {}).name || id;
  document.getElementById('over').hidden = false;
  document.getElementById('overTitle').textContent = won ? 'Chthon Falls' : 'Wipe';
  document.getElementById('overBody').textContent = won
    ? `Killed in ${clock(view.seconds)}.`
    : `The party is dead with Chthon at ${view.boss.hpPct.toFixed(1)}%.`;
  // What actually happened to you, not just whether it happened.
  const lines = [
    `<b>${dealt.toLocaleString('en-US')}</b> damage per second · <b>${healed.toLocaleString('en-US')}</b> healing per second`,
    mine
      ? `You died at ${clock(mine.tick / 10)} to <b>${mine.cause}</b>.`
      : player && player.alive
        ? 'You survived.'
        : 'You died.',
  ];
  const order = state.stats.deaths
    .slice(0, 4)
    .map((d) => `${clock(d.tick / 10)} ${nameOf(d.unit)} — ${d.cause}`);
  if (order.length) lines.push(`Deaths: ${order.join(' · ')}`);
  document.getElementById('overStats').innerHTML = lines.map((l) => `<div>${l}</div>`).join('');
}

const clock = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

/* ------------------------------------------------- practice screens */

function showScreen(which) {
  screen = which;
  document.getElementById('practice').hidden = which !== 'practice';
  document.getElementById('kit').hidden = which !== 'kit';
  document.getElementById('hint').hidden = which ? true : controls.state.locked;
  if (which) {
    document.exitPointerLock();
    renderPractice();
    if (which === 'kit') renderKit();
  } else if (running) {
    lock();
  }
}

const chip = (on, label, key) =>
  `<button class="chip ${on ? 'on' : ''}" data-v="${label.value}">${label.text}${
    key ? `<kbd>${key}</kbd>` : ''
  }</button>`;

function renderPractice() {
  const box = (id, html) => (document.getElementById(id).innerHTML = html);
  box(
    'pGames',
    Object.values(content.games)
      .map((g) => chip(g.id === game, { value: g.id, text: g.name }))
      .join('')
  );
  box(
    'pRoles',
    [
      { value: 'tank', text: 'Vanguard' },
      { value: 'healer', text: 'Field Medic' },
      { value: 'dps', text: 'Slayer' },
    ]
      .map((r) => chip(r.value === role, r))
      .join('')
  );
  box(
    'pDrills',
    [{ value: '', text: 'Training dummy' }]
      .concat(Object.entries(content.drills).map(([id, d]) => ({ value: id, text: d.name })))
      .map((d) => chip(d.value === drill, d))
      .join('')
  );
  box(
    'pToggles',
    [
      { value: 'invulnerable', text: 'Invulnerable', key: 'V' },
      { value: 'infiniteResource', text: 'Infinite resources', key: 'B' },
      { value: 'noCooldowns', text: 'No cooldowns', key: 'N' },
    ]
      .map((t) => chip(practice[t.value], t, t.key))
      .join('')
  );
  box(
    'pSpeeds',
    [0.25, 0.5, 1].map((s) => chip(timeScale === s, { value: String(s), text: `${s}×` }, s === 1 ? '' : '')).join('')
  );
}

// What the four buttons are and how they feed each other -- the thing
// that is otherwise only discoverable by pressing them for ten minutes.
function renderKit() {
  const def = content.games[game];
  const player = view && view.party.find((u) => u.id === view.playerId);
  const ids = player ? player.abilities : [];
  document.getElementById('kitTitle').textContent = `${def.name} — ${role === 'dps' ? 'Slayer' : role === 'tank' ? 'Vanguard' : 'Field Medic'}`;
  document.getElementById('kitLoop').textContent =
    'Builder feeds spender, spender opens a window, payoff is worth more inside it, ultimate charges from doing your job.';
  const roles = ['Builder', 'Spender', 'Payoff', 'Ultimate'];
  document.getElementById('kitList').innerHTML = ids
    .map((id, i) => {
      const a = active.abilities[id] || content.abilities[id];
      return `<div class="kitab"><em>${i + 1} — ${roles[i] || ''}</em><b>${a.name}</b>
        <span>${a.desc || ''}</span></div>`;
    })
    .join('');
  document.getElementById('kitExtras').innerHTML = [def.signature, ...(def.extras || [])]
    .filter(Boolean)
    .map((line) => {
      const [head, ...rest] = line.split('—');
      return `<div>· <b>${head.trim()}</b>${rest.length ? ` — ${rest.join('—').trim()}` : ''}</div>`;
    })
    .join('');
}

function onPracticeClick(id, handler) {
  document.getElementById(id).addEventListener('click', (e) => {
    const target = e.target.closest('[data-v]');
    if (!target) return;
    handler(target.dataset.v);
    renderPractice();
  });
}

onPracticeClick('pGames', (v) => {
  game = v;
  start('lobby');
  showScreen('practice');
});
onPracticeClick('pRoles', (v) => {
  role = v;
  start('lobby');
  showScreen('practice');
});
onPracticeClick('pDrills', (v) => {
  drill = v;
  start('lobby');
  showScreen('practice');
});
onPracticeClick('pToggles', (v) => {
  practice[v] = !practice[v];
  if (state && scenario === 'lobby') state.practice = { ...practice };
});
onPracticeClick('pSpeeds', (v) => (timeScale = Number(v)));

document.getElementById('pResume').addEventListener('click', () => showScreen(null));
document.getElementById('pPull').addEventListener('click', () => start('encounter'));
document.getElementById('kitClose').addEventListener('click', () => showScreen(null));

/* ------------------------------------------------------------ the hub */

async function enterHub() {
  running = false;
  raidRun = null;
  scenario = 'hub';
  showScreen(null);
  panels.hide();
  for (const id of ['menu', 'over', 'practice', 'kit']) document.getElementById(id).hidden = true;
  document.body.dataset.mode = 'hub';
  document.getElementById('crosshair').hidden = true;
  if (!hub) {
    document.getElementById('loading').hidden = false;
    const level = await getLevel('hub');
    hubScene = new THREE.Scene();
    hubScene.background = new THREE.Color(0x000000);
    hubScene.fog = new THREE.Fog(0x05040a, 40, 140);
    hub = createHub({
      scene: hubScene,
      camera: world.camera,
      rig,
      controls,
      level,
      progress,
      raids: content.raids,
      getRole: () => role,
      onPortal: (portal) => {
        if (portal.kind === 'raid') openPanel('raid', portal.raid);
        else if (portal.kind === 'range') openPanel('range');
        else toast('This slipgate is sealed.');
      },
    });
    document.getElementById('loading').hidden = true;
    // Warm the raid levels up behind the scenes so a launch is instant.
    for (const r of Object.values(content.raids)) for (const m of r.maps) getLevel(m).catch(() => {});
  } else {
    hub.respawn();
  }
  hub.setRole(role);
  hub.show(true);
  world.camera.fov = 75;
  world.camera.updateProjectionMatrix();
  lock();
}

function interact() {
  if (scenario !== 'hub' || !npcInRange || panels.open) return;
  openPanel(npcInRange.panel);
}

function openPanel(which, arg) {
  document.exitPointerLock();
  const ctx = { progress, content, role, game, levels: levelTitles };
  if (which === 'raid') {
    launch.raid = arg;
    panels.raid({ ...ctx, raid: arg, heroic: launch.heroic });
  } else if (which === 'journal') panels.journal({ ...ctx, raid: arg });
  else panels[which](ctx);
}

function closePanel() {
  panels.hide();
  if (scenario === 'hub') {
    if (hub) hub.stepBack();
    lock();
  }
}

let toastTimer = 0;
function toast(text) {
  const el = document.getElementById('toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 2600);
}

function paintHubHud() {
  const p = progress.data;
  const set = (id, v) => {
    const el = document.getElementById(id);
    if (el.textContent !== String(v)) el.textContent = v;
  };
  set('hubRank', `Rank ${p.rank}`);
  set('hubPower', progress.power());
  set('hubShards', p.shards);
  set('hubRole', { tank: 'Vanguard', healer: 'Field Medic', dps: 'Slayer' }[role]);
  document.getElementById('hubXp').style.width = `${Math.min(100, (p.xp / progress.xpNeeded()) * 100)}%`;
  const ready = p.bounties.filter((b) => b.done && !b.claimed).length;
  set('hubBounties', `${p.bounties.filter((b) => b.claimed).length}/${p.bounties.length} bounties${ready ? ` · ${ready} to turn in` : ''}`);
}

/* -------------------------------------------------------------- raids */

async function launchRaid(raid, index = 0) {
  raidRun = { raid, index, heroic: launch.heroic };
  panels.hide();
  await enterEncounter();
}

async function enterEncounter() {
  const enc = raidRun.raid.encounters[raidRun.index];
  panels.hide();
  document.getElementById('over').hidden = true;
  document.getElementById('loading').hidden = false;
  const level = await getLevel(enc.map);
  document.getElementById('loading').hidden = true;
  world.setLevel(level, level.meta.arenas[enc.arena] || level.meta.arenas[0]);
  start('encounter');
  const boss = content.bosses[enc.boss];
  toast(`${raidRun.raid.name} — ${boss.name}, ${boss.title}${raidRun.heroic ? ' (Heroic)' : ''}`);
}

function finishRaidEncounter() {
  const won = state.result === 'kill';
  const me = state.units.find((u) => u.id === state.activeId);
  const seconds = Math.max(1, state.tick / 10);
  const damage = state.stats.damageBy[state.activeId] || 0;
  const healing = state.stats.healBy[state.activeId] || 0;
  const died = state.stats.deaths.some((d) => d.unit === state.activeId);
  const outcome = progress.recordEncounter({
    raid: raidRun.raid,
    index: raidRun.index,
    won,
    role,
    game,
    heroic: raidRun.heroic,
    stats: { damage, healing, interrupts: state.stats.interrupts, died },
  });
  const boss = content.bosses[raidRun.raid.encounters[raidRun.index].boss];
  const mine = state.stats.deaths.find((d) => d.unit === state.activeId);
  const stats = [
    won ? `Killed in ${clock(view.seconds)}.` : `The party is dead with ${boss.name} at ${view.boss.hpPct.toFixed(1)}%.`,
    `<b>${Math.round(damage / seconds).toLocaleString('en-US')}</b> damage per second · <b>${Math.round(healing / seconds).toLocaleString('en-US')}</b> healing per second`,
    mine ? `You died at ${clock(mine.tick / 10)} to <b>${mine.cause}</b>.` : me && me.alive ? 'You survived.' : 'You died.',
  ]
    .map((l) => `<div>${l}</div>`)
    .join('');
  panels.result({
    raid: raidRun.raid,
    index: raidRun.index,
    won,
    outcome,
    boss,
    stats,
    hasNext: raidRun.index + 1 < raidRun.raid.encounters.length,
  });
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
  blurb();
});
function blurb() {
  const def = content.games[game];
  document.getElementById('gameBlurb').innerHTML = [def.blurb, def.signature, ...(def.extras || [])]
    .filter(Boolean)
    .join('<br>');
}
blurb();

const roles = document.getElementById('roles');
roles.addEventListener('click', (e) => {
  const card = e.target.closest('[data-role]');
  if (!card) return;
  role = card.dataset.role;
  [...roles.children].forEach((c) => c.classList.toggle('sel', c.dataset.role === role));
});
document.getElementById('play').addEventListener('click', () => enterHub());
document.getElementById('again').addEventListener('click', () => enterHub());
document.getElementById('pHub').addEventListener('click', () => enterHub());
document.getElementById('retry').addEventListener('click', () => start('encounter'));

const SPEEDS = [1, 0.5, 0.25];
window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  const key = e.key.toLowerCase();
  if (key === 'escape' && panels.open) return closePanel();
  if (scenario === 'hub') {
    if (panels.open) return;
    if (key === 'e' || key === 'f') return interact();
    if (key === 'i' || key === 'c') return openPanel('character');
    if (key === 'j') return openPanel('journal');
    if (key === 'v') return hub && hub.toggleView();
    return;
  }
  if (key === 'escape' && screen) return showScreen(null);
  if (key === 'p' && running) return showScreen(screen === 'practice' ? null : 'practice');
  if (key === 'h' && running) return showScreen(screen === 'kit' ? null : 'kit');
  if (key === 'e' && scenario === 'lobby' && running) return start('encounter');
  if (key === 'g' && scenario === 'lobby' && running) return enterHub();
  if (!running || scenario !== 'lobby') return;
  // Range switches, reachable without opening anything.
  if (key === 'v' || key === 'b' || key === 'n') {
    const field = key === 'v' ? 'invulnerable' : key === 'b' ? 'infiniteResource' : 'noCooldowns';
    practice[field] = !practice[field];
    state.practice = { ...practice };
    if (screen) renderPractice();
  }
  if (key === 't') {
    timeScale = SPEEDS[(SPEEDS.indexOf(timeScale) + 1) % SPEEDS.length];
    if (screen) renderPractice();
  }
});

document.getElementById('play').disabled = false;
document.getElementById('play').textContent = 'Enter the hub';

requestAnimationFrame(frame);
window.__raid3d = { state: () => state, view: () => view, world, rig, progress, content, hub: () => hub, levels, enterHub, launchRaid, scenario: () => scenario };
