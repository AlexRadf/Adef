// The fixed 100ms tick. Phase order below is load-bearing: mechanics are
// written against it. Do not reorder.

import {
  clonePos,
  contains,
  distance,
  moveAlong,
  moveToward,
  normalize,
  stepPerTick,
  sub,
  vec,
} from './geometry.js';
import { applyAura, removeAura } from './auras.js';
import {
  applyDamage,
  applyHeal,
  livingParty,
  livingEnemies,
  unitById,
  threatLeader,
  resolveAbility,
  startAbility,
  canUseAbility,
  cancelCast,
  performDash,
  setBlocking,
  castBlockedReason,
  orderMove,
  orderMoveDirection,
  faceToward,
  runEffects,
  log,
  fmt,
} from './abilities.js';
import { pick } from './rng.js';
import { runBot, resolveTarget, nearestTo, enemyFocus } from './ai.js';
import { TICKS_PER_SECOND } from './clock.js';

// Tactical pause: orders are given while the world is frozen and take
// effect when it resumes. Same phase-7 code path, no tick advance.
export function applyOrders(state, content, inputQueue = []) {
  if (state.over) return state;
  playerPass(state, content, inputQueue);
  return state;
}

export function step(state, content, inputQueue = []) {
  if (state.over) return state;

  state.tick++;                              // 1
  state.events = [];
  regenResources(state, content);
  resolveCastsAndMoves(state, content);      // 2
  auraPass(state, content);                  // 3
  fieldPass(state, content);
  hazardPass(state, content);                // 4
  bossPass(state, content);                  // 5
  aiPass(state, content);                    // 6
  playerPass(state, content, inputQueue);    // 7
  deathPass(state, content);                 // 8
  endPass(state);                            // 9
  return state;
}

/* ------------------------------------------------------------- 1.5 */

function regenResources(state, content) {
  const block = state.style.block;
  for (const u of state.units) {
    if (!u.alive) continue;
    if (u.resourceRegen) u.resource = Math.min(u.maxResource, u.resource + u.resourceRegen);
    if (!u.maxStamina) continue;

    // Blocking spends stamina for as long as you hold it; running dry
    // breaks the guard and leaves you worse off than not blocking.
    if (u.blocking && block) {
      u.stamina -= block.drain / TICKS_PER_SECOND;
      if (u.stamina <= 0) {
        u.stamina = 0;
        u.blocking = false;
        removeAura(state, u, 'blocking');
        applyAura(state, content, u.id, u, 'guardBroken');
        log(state, `${u.name}'s guard breaks!`, 'mechanic');
      } else {
        applyAura(state, content, u.id, u, 'blocking', { durationTicks: 3 });
      }
    } else {
      u.stamina = Math.min(u.maxStamina, u.stamina + u.staminaRegen / TICKS_PER_SECOND);
    }
  }
}

// Healing fields tick on whoever is standing in them.
function fieldPass(state, content) {
  if (!state.fields.length) return;
  for (const field of state.fields) {
    while (field.nextTick <= state.tick && field.nextTick <= field.expiresAt) {
      for (const u of livingParty(state)) {
        if (contains(field, u.pos)) applyHeal(state, field.sourceId, u, field.amount, { name: field.name });
      }
      field.nextTick += field.intervalTicks;
    }
  }
  state.fields = state.fields.filter((f) => f.expiresAt > state.tick);
}

/* --------------------------------------------------------------- 2 */

// With a lock, you are always pointed at what you locked -- which is
// what lets the facing arc mean "that one and nothing else".
function lockPass(state) {
  if (state.style.aim !== 'lock') return;
  for (const unit of state.units) {
    if (unit.team !== 'party' || !unit.alive) continue;
    const locked = unit.ai
      ? enemyFocus(state, unit)
      : unitById(state, unit.playerTarget) || enemyFocus(state, unit);
    if (locked && locked.alive) faceToward(unit, locked.pos);
  }
}

function resolveCastsAndMoves(state, content) {
  lockPass(state);
  for (const unit of state.units) {
    if (!unit.alive) continue;

    moveUnit(state, unit);

    if (unit.castAbility && unit.castUntil === state.tick) {
      const abilityId = unit.castAbility;
      const target = unit.castTarget ? unitById(state, unit.castTarget) : null;
      const cell = unit.castCell ?? null;
      const overrides = unit.castOverrides ?? null;
      unit.castAbility = null;
      unit.castUntil = 0;
      unit.castTarget = null;
      unit.castCell = null;
      unit.castOverrides = null;
      resolveAbility(state, content, unit, abilityId, target, cell, overrides);
    }
  }
}

// Continuous movement. Position is a coordinate, so this is the same
// function a 3D port keeps -- only the collision and pathing change.
function moveUnit(state, unit) {
  unit.movedThisTick = false;
  if (!unit.speed) return;

  // A dodge ends the moment you are clear. Walking on to the middle of
  // the next tile just costs uptime you could have spent casting.
  if (unit.moveReason === 'safety' && !state.hazards.some((h) => h.kind === 'blast' && contains(h, unit.pos))) {
    unit.moveTarget = null;
    unit.moveReason = null;
    return;
  }

  const step = stepPerTick(unit.speed);
  const from = clonePos(unit.pos);

  if (unit.moveDir) {
    unit.pos = moveAlong(unit.pos, unit.moveDir, step);
  } else if (unit.moveTarget) {
    const result = moveToward(unit.pos, unit.moveTarget, step);
    unit.pos = result.pos;
    if (result.arrived) unit.moveTarget = null;
  } else {
    return;
  }

  const moved = Math.abs(unit.pos.x - from.x) > 1e-6 || Math.abs(unit.pos.y - from.y) > 1e-6;
  if (!moved) return;
  unit.movedThisTick = true;
  // Lock-on keeps you facing the target while you strafe, so movement
  // does not steer you. Everything else turns to where it is going.
  const heading = normalize(sub(unit.pos, from));
  if ((heading.x || heading.y) && state.style.aim !== 'lock') unit.facing = heading;
  // Moving cancels a cast in progress.
  if (unit.castAbility && !unit.castWhileMoving) cancelCast(state, unit, 'moving');
}

/* --------------------------------------------------------------- 3 */

function auraPass(state, content) {
  for (const unit of state.units) {
    if (!unit.alive) continue;

    for (const aura of unit.auras.slice()) {
      if (!aura.periodic) continue;
      while (aura.periodic.nextTick <= state.tick) {
        const e = aura.periodic.effect;
        const ctx = {
          caster: unitById(state, aura.sourceId) || unit,
          target: unit,
          ability: { name: aura.name },
          abilityName: aura.name,
        };
        if (e.type === 'damage') {
          applyDamage(state, aura.sourceId, unit, e.amount * aura.stacks, e.school || 'magic', {
            name: aura.name,
          });
        } else {
          runEffects(state, content, ctx, [e]);
        }
        aura.periodic.nextTick += aura.periodic.intervalTicks;
        if (!unit.alive) break;
      }
    }

    for (const aura of unit.auras.slice()) {
      if (aura.expiresAt > state.tick) continue;
      removeAura(state, unit, aura.id);
      if (aura.onExpire) {
        const effects = Array.isArray(aura.onExpire) ? aura.onExpire : [aura.onExpire];
        const ctx = {
          caster: unitById(state, aura.sourceId) || unit,
          target: unit,
          ability: { name: aura.name },
          abilityName: aura.name,
        };
        log(state, `${aura.name} detonates on ${unit.name}!`, 'mechanic');
        runEffects(state, content, ctx, effects);
      }
    }
  }
}

/* --------------------------------------------------------------- 4 */

function hazardPass(state, content) {
  const due = state.hazards.filter((h) => h.detonatesAt === state.tick);
  if (!due.length) return;
  state.hazards = state.hazards.filter((h) => h.detonatesAt !== state.tick);

  for (const h of due) {
    const occupants = state.units.filter((u) => u.alive && u.team === 'party' && contains(h, u.pos));

    if (h.kind === 'split') {
      if (!occupants.length) {
        log(state, `${h.name} lands on an empty tile — the whole party is flayed!`, 'mechanic');
        for (const u of livingParty(state)) applyDamage(state, h.sourceId, u, h.raidDamage || h.damage, 'void', { name: h.name });
      } else {
        const each = Math.round(h.damage / occupants.length);
        log(state, `${h.name} splits between ${occupants.length} — ${fmt(each)} each`, 'mechanic');
        for (const u of occupants) applyDamage(state, h.sourceId, u, each, 'void', { name: h.name });
      }
      continue;
    }

    if (h.kind === 'soak') {
      if (occupants.length >= h.minSoakers) {
        const each = Math.round(h.damage / occupants.length);
        log(state, `${h.name} is soaked by ${occupants.length}`, 'mechanic');
        for (const u of occupants) applyDamage(state, h.sourceId, u, each, 'void', { name: h.name });
      } else {
        log(state, `${h.name} was not soaked — the arena erupts!`, 'mechanic');
        for (const u of livingParty(state)) applyDamage(state, h.sourceId, u, h.raidDamage || h.damage, 'void', { name: h.name });
      }
      continue;
    }

    for (const u of occupants) {
      applyDamage(state, h.sourceId, u, h.damage, 'lava', { name: h.name });
      if (h.aura) applyAura(state, content, h.sourceId, u, h.aura);
    }
  }
}

/* --------------------------------------------------------------- 5 */

function enterPhase(state, content, index) {
  const bossDef = content.bosses[state.bossId];
  const phase = bossDef.phases[index];
  state.phaseIndex = index;
  state.phaseStartTick = state.tick;
  state.schedule = phase.timeline.map((entry) => ({
    entry,
    nextTick: state.tick + Math.round((entry.t || 0) * TICKS_PER_SECOND),
    every: entry.every ? Math.round(entry.every * TICKS_PER_SECOND) : 0,
  }));
  if (phase.name) log(state, `— ${phase.name} —`, 'phase');
  if (phase.onEnter) {
    const boss = unitById(state, state.bossId);
    runEffects(state, content, { caster: boss, target: boss, ability: { name: phase.name }, abilityName: phase.name }, phase.onEnter);
  }
}

function phaseTriggerMet(state, content, trigger) {
  const boss = unitById(state, state.bossId);
  switch (trigger.type) {
    case 'start':
      return true;
    case 'hpBelow':
      return (boss.hp / boss.maxHp) * 100 <= trigger.pct;
    case 'timeElapsed':
      return state.tick >= trigger.seconds * TICKS_PER_SECOND;
    default:
      return false;
  }
}

function selectTimelineTarget(state, content, boss, entry) {
  const party = livingParty(state);
  switch (entry.target) {
    case 'threatLeader':
      return threatLeader(state, boss);
    case 'randomPlayer':
      return pick(state, party.filter((u) => u.role !== 'tank')) || pick(state, party);
    case 'randomAny':
      return pick(state, party);
    case 'lowestPlayer':
      return party.slice().sort((a, b) => a.hp / a.maxHp - b.hp / b.maxHp)[0] || null;
    case 'self':
      return boss;
    default:
      return null;
  }
}

function bossPass(state, content) {
  const bossDef = content.bosses[state.bossId];
  const boss = unitById(state, state.bossId);
  if (!boss || !boss.alive) return;

  // Enrage: a permanent Quad Damage. Nothing subtle about it.
  if (!state.enraged && state.tick >= state.enrageTick) {
    state.enraged = true;
    applyAura(state, content, boss.id, boss, 'quadDamage', { durationTicks: 0 });
    log(state, `${boss.name} SEIZES THE QUAD DAMAGE — the arena is out of time!`, 'enrage');
  }

  // Phase advance: later phases win, and only ever move forward.
  for (let i = bossDef.phases.length - 1; i > state.phaseIndex; i--) {
    if (phaseTriggerMet(state, content, bossDef.phases[i].trigger)) {
      enterPhase(state, content, i);
      break;
    }
  }
  if (state.phaseIndex === -1) enterPhase(state, content, 0);

  // A boss that cannot reach anybody walks. Standing still forever made
  // its anti-kite punishment the leading cause of death, which is not a
  // mechanic so much as a consequence of the tank having to soak.
  const leader = threatLeader(state, boss);
  if (leader) faceToward(boss, leader.pos); // so "behind it" is a real place
  if (leader && distance(boss.pos, leader.pos) > 1) orderMove(state, boss, leader.pos);
  else boss.moveTarget = null;

  if (boss.castAbility) return;

  for (const slot of state.schedule) {
    if (slot.nextTick > state.tick) continue;
    const entry = slot.entry;
    const target = selectTimelineTarget(state, content, boss, entry);
    const overrides = {};
    if (entry.count !== undefined) overrides.count = entry.count;
    if (entry.delay !== undefined) overrides.delayTicks = Math.round(entry.delay * TICKS_PER_SECOND);
    startAbility(state, content, boss, entry.ability, target, null, overrides);
    slot.nextTick = slot.every ? state.tick + slot.every : Infinity;
    break; // one boss action per tick keeps the log readable
  }

  // Adds act on their own simple threat table.
  for (const add of livingEnemies(state)) {
    if (add.id === boss.id || !add.alive || add.castAbility) continue;
    if (add.gcdUntil > state.tick) continue;
    const abilityId = add.abilities[0];
    if (!abilityId) continue;
    const target = threatLeader(state, add) || pick(state, livingParty(state));
    if (target && canUseAbility(state, content, add, abilityId, target)) {
      startAbility(state, content, add, abilityId, target);
    }
  }
}

/* --------------------------------------------------------------- 6 */

function aiPass(state, content) {
  for (const unit of state.units) {
    if (unit.team !== 'party' || !unit.ai) continue;
    runBot(state, content, unit);
  }
}

/* --------------------------------------------------------------- 7 */

function playerPass(state, content, inputQueue) {
  contentRef = content;
  if (!state.playerIds.length) return;

  // Selection is not an action. Target picks, aim, held movement keys and
  // switching who you are commanding never wait behind a queued cast, so
  // the controls always feel live.
  while (inputQueue.length && SELECTION_INPUTS.has(inputQueue[0].type)) {
    applySelection(state, inputQueue.shift());
  }
  if (!inputQueue.length) return;

  // One action per controlled unit per tick. In solo that is the same
  // single action as before; in commander it means four orders can land
  // together instead of trickling out one tick at a time.
  const acted = new Set();
  const deferred = [];

  while (inputQueue.length) {
    const input = inputQueue.shift();
    if (SELECTION_INPUTS.has(input.type)) {
      applySelection(state, input);
      continue;
    }
    const unit = commandedUnit(state, input);
    if (!unit) continue;
    if (acted.has(unit.id)) {
      deferred.push(input);
      continue;
    }
    if (input.expires !== undefined && state.tick > input.expires) continue;
    if (!unit.alive) continue;

    if (input.type === 'move') {
      orderMove(state, unit, input.pos);
      acted.add(unit.id);
      continue;
    }

    if (input.type === 'dash') {
      if (performDash(state, content, unit)) acted.add(unit.id);
      continue;
    }

    if (input.type === 'cast') {
      const ability = content.abilities[input.abilityId];
      if (!ability) continue;
      const target = resolveTarget(state, content, unit, ability, playerPreference(state, unit, ability));
      // Ground-targeted healing lands where you are pointing.
      const cell = ability.targeting === 'cell' ? { ...state.playerAim } : null;
      if (canUseAbility(state, content, unit, input.abilityId, target)) {
        if (target && target !== unit) faceToward(unit, target.pos);
        startAbility(state, content, unit, input.abilityId, target, cell);
        acted.add(unit.id);
        continue;
      }
      // Small input queue window, like every action game you have played.
      if (input.expires === undefined) input.expires = state.tick + 15;
      if (state.tick < input.expires) deferred.push(input);
      else log(state, castBlockedReason(state, content, unit, input.abilityId, target), 'info');
    }
  }

  for (const input of deferred) inputQueue.push(input);
}

const SELECTION_INPUTS = new Set(['targetEnemy', 'targetAlly', 'aim', 'moveDir', 'select', 'block']);

// Which unit an input speaks for: the one it names, else whoever is
// currently selected.
function commandedUnit(state, input) {
  const id = input.unitId && state.playerIds.includes(input.unitId) ? input.unitId : state.activeId;
  const unit = unitById(state, id);
  return unit && state.playerIds.includes(unit.id) ? unit : null;
}

let contentRef = null;

function applySelection(state, input) {
  if (input.type === 'select') {
    if (state.playerIds.includes(input.unitId)) state.activeId = input.unitId;
    return;
  }
  const unit = commandedUnit(state, input);
  if (!unit) return;
  switch (input.type) {
    case 'targetEnemy':
      unit.playerTarget = input.unitId;
      return;
    case 'targetAlly':
      // Clicking your current ally target again drops back to automatic.
      unit.playerAllyTarget = unit.playerAllyTarget === input.unitId ? null : input.unitId;
      return;
    case 'aim':
      state.playerAim = { x: input.x, y: input.y };
      if (unit.alive) faceToward(unit, state.playerAim);
      return;
    case 'moveDir':
      if (unit.alive) orderMoveDirection(state, unit, vec(input.x, input.y));
      return;
    case 'block':
      setBlocking(state, contentRef, unit, input.on);
      return;
    default:
  }
}

// Tab and lock-on use what that unit selected; the crosshair uses
// whatever it is nearest to, with no target lock at all.
function playerPreference(state, unit, ability) {
  const wantsAlly = ability.targeting === 'ally' || ability.targeting === 'lowestAlly';
  if (state.style.aim === 'crosshair' && unit.id === state.activeId) {
    return nearestTo(wantsAlly ? livingParty(state) : livingEnemies(state), state.playerAim);
  }
  return wantsAlly ? unitById(state, unit.playerAllyTarget) : unitById(state, unit.playerTarget);
}

/* --------------------------------------------------------------- 8 */

function deathPass(state, content) {
  for (const unit of state.units) {
    if (!unit.alive || !unit.pendingDeath) continue;
    if (unit.hp > 0) {
      unit.pendingDeath = null;
      continue;
    }
    unit.alive = false;
    unit.castAbility = null;
    unit.castUntil = 0;
    unit.moveTarget = null;
    unit.moveDir = null;
    unit.auras = [];
    log(state, `${unit.name} dies (${unit.pendingDeath.by}).`, 'death');
    if (unit.team === 'party') {
      state.stats.deaths.push({ tick: state.tick, unit: unit.id, cause: unit.pendingDeath.by });
    }
    unit.pendingDeath = null;
  }
}

/* --------------------------------------------------------------- 9 */

function endPass(state) {
  const boss = unitById(state, state.bossId);
  if (boss && !boss.alive) {
    state.over = true;
    state.result = 'kill';
    log(state, `${boss.name} falls. The slipgate closes.`, 'win');
    return;
  }
  if (!livingParty(state).length) {
    state.over = true;
    state.result = 'wipe';
    log(state, 'The party is dead. Wipe.', 'death');
    return;
  }
  if (state.tick >= state.hardStopTick) {
    state.over = true;
    state.result = 'timeout';
    log(state, 'The encounter times out.', 'death');
  }
}

/* -------------------------------------------------------------- 10 */

export function snapshot(state, content) {
  const boss = unitById(state, state.bossId);
  return {
    tick: state.tick,
    seconds: state.tick / TICKS_PER_SECOND,
    over: state.over,
    result: state.result,
    phaseIndex: state.phaseIndex,
    phaseName: content.bosses[state.bossId].phases[Math.max(0, state.phaseIndex)].name || '',
    enraged: state.enraged,
    enrageIn: Math.max(0, (state.enrageTick - state.tick) / TICKS_PER_SECOND),
    playerId: state.activeId,
    playerIds: [...state.playerIds],
    mode: { id: state.mode.id, name: state.mode.name, control: state.mode.control },
    boss: boss ? unitView(state, content, boss) : null,
    party: state.units.filter((u) => u.team === 'party').map((u) => unitView(state, content, u)),
    enemies: state.units.filter((u) => u.team === 'enemy').map((u) => unitView(state, content, u)),
    hazards: state.hazards.map((h) => ({
      id: h.id,
      kind: h.kind,
      name: h.name,
      x: h.x,
      y: h.y,
      half: h.half,
      remaining: (h.detonatesAt - state.tick) / TICKS_PER_SECOND,
      total: (h.detonatesAt - h.markedAt) / TICKS_PER_SECOND,
      minSoakers: h.minSoakers,
    })),
    aim: { ...state.playerAim },
    fields: state.fields.map((f) => ({ x: f.x, y: f.y, half: f.half, name: f.name })),
    events: state.events.slice(),
    style: {
      id: state.style.id,
      name: state.style.name,
      aim: state.style.aim,
      movement: state.style.movement.id,
      healing: state.style.healing.mode,
      tanking: state.style.tanking.mode,
      dash: state.style.dash ? state.style.dash.name : null,
      blocking: !!state.style.block,
    },
    hideTimers: !!state.mods.hideTimers,
    modifiers: state.modifiers.slice(),
    logLength: state.log.length,
  };
}

function unitView(state, content, u) {
  const ability = u.castAbility ? content.abilities[u.castAbility] : null;
  return {
    id: u.id,
    name: u.name,
    role: u.role,
    title: u.title,
    team: u.team,
    hp: u.hp,
    maxHp: u.maxHp,
    hpPct: (u.hp / u.maxHp) * 100,
    resource: Math.floor(u.resource),
    stamina: Math.floor(u.stamina),
    maxStamina: u.maxStamina,
    blocking: !!u.blocking,
    maxResource: u.maxResource,
    resourceName: u.resourceName,
    pos: { x: u.pos.x, y: u.pos.y },
    controlled: state.playerIds.includes(u.id),
    targetId: u.playerTarget ?? null,
    allyTargetId: u.playerAllyTarget ?? null,
    facing: { x: u.facing.x, y: u.facing.y },
    alive: u.alive,
    abilities: u.abilities,
    moving: u.movedThisTick || !!u.moveTarget || !!u.moveDir,
    threat: u.team === 'enemy' ? { ...u.threat } : null,
    gcdRemaining: Math.max(0, u.gcdUntil - state.tick),
    cast: ability
      ? {
          name: ability.name,
          interruptible: !!ability.interruptible,
          progress: (state.tick - u.castStart) / (u.castUntil - u.castStart),
          remaining: (u.castUntil - state.tick) / TICKS_PER_SECOND,
        }
      : null,
    cooldowns: Object.fromEntries(
      Object.entries(u.cooldowns).map(([id, t]) => [id, Math.max(0, (t - state.tick) / TICKS_PER_SECOND)])
    ),
    auras: u.auras.map((a) => ({
      id: a.id,
      name: a.name,
      stacks: a.stacks,
      harmful: a.harmful,
      dispelType: a.dispelType,
      absorb: a.absorb,
      remaining: a.expiresAt === Infinity ? null : (a.expiresAt - state.tick) / TICKS_PER_SECOND,
    })),
  };
}
