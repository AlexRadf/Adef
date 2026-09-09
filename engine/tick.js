// The fixed 100ms tick. Phase order below is load-bearing: mechanics are
// written against it. Do not reorder.

import { stepToward } from './grid.js';
import { applyAura, removeAura } from './auras.js';
import {
  applyDamage,
  livingParty,
  livingEnemies,
  unitById,
  threatLeader,
  resolveAbility,
  startAbility,
  canUseAbility,
  castBlockedReason,
  orderMove,
  runEffects,
  log,
  fmt,
} from './abilities.js';
import { pick } from './rng.js';
import { runBot, resolveTarget } from './ai.js';
import { TICKS_PER_SECOND } from './state.js';

export function step(state, content, inputQueue = []) {
  if (state.over) return state;

  state.tick++;                              // 1
  regenResources(state);
  resolveCastsAndMoves(state, content);      // 2
  auraPass(state, content);                  // 3
  hazardPass(state, content);                // 4
  bossPass(state, content);                  // 5
  aiPass(state, content);                    // 6
  playerPass(state, content, inputQueue);    // 7
  deathPass(state, content);                 // 8
  endPass(state);                            // 9
  return state;
}

/* ------------------------------------------------------------- 1.5 */

function regenResources(state) {
  for (const u of state.units) {
    if (!u.alive || !u.resourceRegen) continue;
    u.resource = Math.min(u.maxResource, u.resource + u.resourceRegen);
  }
}

/* --------------------------------------------------------------- 2 */

function resolveCastsAndMoves(state, content) {
  for (const unit of state.units) {
    if (!unit.alive) continue;

    if (unit.movePath.length && unit.moveUntil === state.tick) {
      const dest = unit.movePath[unit.movePath.length - 1];
      unit.cell = stepToward(unit.cell, dest);
      if (unit.cell === dest) unit.movePath = [];
      else unit.moveUntil = state.tick + 4;
    }

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
  for (const cell of state.cells) {
    const h = cell.hazard;
    if (!h || h.detonatesAt !== state.tick) continue;
    cell.hazard = null;

    const occupants = state.units.filter((u) => u.alive && u.team === 'party' && u.cell === cell.index);

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
  const player = state.playerId ? unitById(state, state.playerId) : null;
  if (!player) return;
  // Target changes are selection, not actions -- they never wait behind a
  // queued cast, so clicking a frame always feels instant.
  while (inputQueue.length && inputQueue[0].type.startsWith('target')) {
    const pick = inputQueue.shift();
    if (pick.type === 'targetEnemy') state.playerTarget = pick.unitId;
    // Clicking your current ally target again drops back to automatic targeting.
    else state.playerAllyTarget = state.playerAllyTarget === pick.unitId ? null : pick.unitId;
  }
  if (!inputQueue.length) return;

  const input = inputQueue.shift();
  if (input.expires !== undefined && state.tick > input.expires) return;
  if (!player.alive) return;

  if (input.type === 'move') {
    orderMove(state, player, input.cell);
    return;
  }

  if (input.type === 'cast') {
    const ability = content.abilities[input.abilityId];
    if (!ability) return;
    const preferred =
      ability.targeting === 'enemy'
        ? unitById(state, state.playerTarget)
        : unitById(state, state.playerAllyTarget);
    const target = resolveTarget(state, content, player, ability, preferred);
    if (canUseAbility(state, content, player, input.abilityId, target)) {
      startAbility(state, content, player, input.abilityId, target);
      return;
    }
    // Small input queue window, like every action game you have played.
    if (input.expires === undefined) input.expires = state.tick + 15;
    if (state.tick < input.expires) inputQueue.unshift(input);
    else log(state, castBlockedReason(state, content, player, input.abilityId, target), 'info');
  }
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
    unit.movePath = [];
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
    playerId: state.playerId,
    playerTarget: state.playerTarget,
    playerAllyTarget: state.playerAllyTarget,
    boss: boss ? unitView(state, content, boss) : null,
    party: state.units.filter((u) => u.team === 'party').map((u) => unitView(state, content, u)),
    enemies: state.units.filter((u) => u.team === 'enemy').map((u) => unitView(state, content, u)),
    cells: state.cells.map((c) => ({
      index: c.index,
      hazard: c.hazard
        ? {
            kind: c.hazard.kind,
            name: c.hazard.name,
            remaining: (c.hazard.detonatesAt - state.tick) / TICKS_PER_SECOND,
            total: (c.hazard.detonatesAt - c.hazard.markedAt) / TICKS_PER_SECOND,
            minSoakers: c.hazard.minSoakers,
          }
        : null,
    })),
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
    maxResource: u.maxResource,
    resourceName: u.resourceName,
    cell: u.cell,
    alive: u.alive,
    abilities: u.abilities,
    moving: u.movePath.length > 0,
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
