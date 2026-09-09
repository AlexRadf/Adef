// Ability execution plus the two choke points every point of damage and
// healing in the game must pass through.

import { distance, allCells, CELL_COUNT } from './grid.js';
import { applyAura, removeAura, statMult, consumeAbsorb, dispellable } from './auras.js';
import { nextInt, pick, pickMany } from './rng.js';

export const GCD_TICKS = 15;

export const unitById = (state, id) => state.units.find((u) => u.id === id) || null;
export const living = (state) => state.units.filter((u) => u.alive);
export const livingParty = (state) => state.units.filter((u) => u.alive && u.team === 'party');
export const livingEnemies = (state) => state.units.filter((u) => u.alive && u.team === 'enemy');

export function log(state, text, kind = 'info') {
  state.logSeq = (state.logSeq || 0) + 1;
  state.log.push({ seq: state.logSeq, tick: state.tick, text, kind });
  if (state.log.length > 400) state.log.shift();
}

export function abilityDef(content, id) {
  const def = content.abilities[id];
  if (!def) throw new Error(`unknown ability: ${id}`);
  return def;
}

/* ---------------------------------------------------------------- threat */

export function addThreat(enemy, unitId, amount) {
  if (!enemy || enemy.team !== 'enemy') return;
  enemy.threat[unitId] = (enemy.threat[unitId] || 0) + amount;
}

export function threatLeader(state, enemy) {
  const forced = enemy.auras.find((a) => a.id === 'taunted');
  if (forced) {
    const u = unitById(state, forced.sourceId);
    if (u && u.alive) return u;
  }
  let best = null;
  let bestValue = -1;
  for (const u of livingParty(state)) {
    const v = enemy.threat[u.id] || 0;
    if (v > bestValue) {
      bestValue = v;
      best = u;
    }
  }
  return best;
}

/* -------------------------------------------------------- choke points */

export function applyDamage(state, sourceId, targetId, baseAmount, school = 'physical', meta = {}) {
  const target = typeof targetId === 'object' ? targetId : unitById(state, targetId);
  if (!target || !target.alive) return 0;
  const source = sourceId ? unitById(state, sourceId) : null;

  let amount = baseAmount;
  if (source) amount *= statMult(source, 'damageDealt');
  amount *= statMult(target, 'damageTaken');
  amount = Math.max(0, Math.round(amount));

  const afterAbsorb = consumeAbsorb(state, target, amount);
  const absorbed = amount - afterAbsorb;
  target.hp = Math.max(0, target.hp - afterAbsorb);

  if (source && source.team === 'party' && target.team === 'enemy') {
    const mult = (meta.threatMult ?? 1) * statMult(source, 'threatMult');
    addThreat(target, source.id, afterAbsorb * mult);
  }

  state.stats.damageBy[sourceId || 'environment'] =
    (state.stats.damageBy[sourceId || 'environment'] || 0) + afterAbsorb;

  const label = meta.name || 'damage';
  const src = source ? source.name : 'The arena';
  log(
    state,
    `${src} — ${label} — ${target.name} ${fmt(afterAbsorb)}${absorbed ? ` (${fmt(absorbed)} absorbed)` : ''}`,
    target.team === 'party' ? 'damage-taken' : 'damage-done'
  );

  if (target.hp <= 0) target.pendingDeath = { by: label, sourceId };
  return afterAbsorb;
}

export function applyHeal(state, sourceId, targetId, baseAmount, meta = {}) {
  const target = typeof targetId === 'object' ? targetId : unitById(state, targetId);
  if (!target || !target.alive) return 0;
  const source = sourceId ? unitById(state, sourceId) : null;

  let amount = baseAmount;
  if (source) amount *= statMult(source, 'healingDone');
  amount *= statMult(target, 'healingTaken');
  amount = Math.max(0, Math.round(amount));

  const effective = Math.min(amount, target.maxHp - target.hp);
  target.hp += effective;

  // Healing makes enemies notice you, same as the real thing.
  if (source && source.team === 'party') {
    for (const enemy of livingEnemies(state)) addThreat(enemy, source.id, effective * 0.25);
  }

  state.stats.healBy[sourceId || 'environment'] =
    (state.stats.healBy[sourceId || 'environment'] || 0) + effective;

  const overheal = amount - effective;
  log(
    state,
    `${source ? source.name : 'Something'} — ${meta.name || 'heal'} — ${target.name} +${fmt(effective)}${
      overheal ? ` (${fmt(overheal)} overheal)` : ''
    }`,
    'heal'
  );
  return effective;
}

export const fmt = (n) => Math.round(n).toLocaleString('en-US');

/* -------------------------------------------------------------- effects */

function resolveEffectTargets(state, ctx, spec) {
  const { caster, target, cell } = ctx;
  switch (spec || 'target') {
    case 'self':
      return [caster];
    case 'target':
      return target ? [target] : [];
    case 'targetAndAdjacent': {
      if (!target) return [];
      const foes = target.team === 'party' ? livingParty(state) : livingEnemies(state);
      return foes.filter((u) => distance(u.cell, target.cell) <= 1);
    }
    case 'nearTarget': {
      if (!target) return [];
      const foes = target.team === 'party' ? livingParty(state) : livingEnemies(state);
      return foes.filter((u) => u.id !== target.id && distance(u.cell, target.cell) <= 1);
    }
    case 'inTargetCell': {
      const c = cell ?? (target ? target.cell : null);
      if (c === null) return [];
      return living(state).filter((u) => u.cell === c);
    }
    case 'party':
      return livingParty(state);
    case 'enemies':
      return livingEnemies(state);
    case 'lowestAlly': {
      const party = livingParty(state);
      return party.length ? [party.slice().sort((a, b) => a.hp / a.maxHp - b.hp / b.maxHp)[0]] : [];
    }
    default:
      return target ? [target] : [];
  }
}

const effectHandlers = {
  damage(state, content, ctx, e) {
    for (const t of resolveEffectTargets(state, ctx, e.target)) {
      applyDamage(state, ctx.caster.id, t, e.amount, e.school || 'physical', {
        name: e.name || ctx.abilityName,
        threatMult: e.threatMult ?? ctx.ability.threatMult ?? 1,
      });
    }
  },

  heal(state, content, ctx, e) {
    for (const t of resolveEffectTargets(state, ctx, e.target)) {
      applyHeal(state, ctx.caster.id, t, e.amount, { name: e.name || ctx.abilityName });
    }
  },

  healPct(state, content, ctx, e) {
    for (const t of resolveEffectTargets(state, ctx, e.target || 'self')) {
      applyHeal(state, ctx.caster.id, t, Math.round(t.maxHp * (e.pct / 100)), {
        name: e.name || ctx.abilityName,
      });
    }
  },

  aura(state, content, ctx, e) {
    for (const t of resolveEffectTargets(state, ctx, e.target)) {
      applyAura(state, content, ctx.caster.id, t, e.aura, {
        durationTicks: e.durationTicks,
        stacks: e.stacks,
      });
      const def = content.auras[e.aura];
      log(state, `${t.name} gains ${def.name || e.aura}`, def.harmful ? 'debuff' : 'buff');
    }
  },

  removeAura(state, content, ctx, e) {
    for (const t of resolveEffectTargets(state, ctx, e.target)) removeAura(state, t, e.aura);
  },

  dispel(state, content, ctx, e) {
    const types = e.types || ['magic'];
    for (const t of resolveEffectTargets(state, ctx, e.target)) {
      const found = dispellable(t, types);
      if (!found.length) {
        log(state, `${ctx.caster.name} — ${ctx.abilityName} — nothing to cleanse on ${t.name}`, 'info');
        continue;
      }
      const aura = found[0];
      removeAura(state, t, aura.id);
      log(state, `${ctx.caster.name} cleanses ${aura.name} from ${t.name}`, 'dispel');
      if (aura.onDispel) {
        const effects = Array.isArray(aura.onDispel) ? aura.onDispel : [aura.onDispel];
        runEffects(state, content, { ...ctx, target: t }, effects);
      }
    }
  },

  taunt(state, content, ctx) {
    for (const enemy of resolveEffectTargets(state, ctx, ctx.ability.taunts || 'target')) {
      if (enemy.team !== 'enemy') continue;
      const top = Math.max(0, ...Object.values(enemy.threat));
      enemy.threat[ctx.caster.id] = top * 1.2 + 1000;
      applyAura(state, content, ctx.caster.id, enemy, 'taunted');
      log(state, `${ctx.caster.name} taunts ${enemy.name}`, 'taunt');
    }
  },

  interrupt(state, content, ctx, e) {
    for (const t of resolveEffectTargets(state, ctx, e.target)) {
      if (!t.castAbility) {
        log(state, `${ctx.caster.name} — ${ctx.abilityName} — nothing to interrupt`, 'info');
        continue;
      }
      const def = content.abilities[t.castAbility];
      if (!def.interruptible) {
        log(state, `${ctx.abilityName} cannot interrupt ${def.name}`, 'info');
        continue;
      }
      log(state, `${ctx.caster.name} INTERRUPTS ${t.name}'s ${def.name}!`, 'interrupt');
      t.castAbility = null;
      t.castUntil = 0;
      t.castTarget = null;
      t.cooldowns[def.id] = state.tick + (e.lockoutTicks || 40);
      state.stats.interrupts++;
    }
  },

  threat(state, content, ctx, e) {
    for (const t of resolveEffectTargets(state, ctx, e.target)) addThreat(t, ctx.caster.id, e.amount);
  },

  resource(state, content, ctx, e) {
    for (const t of resolveEffectTargets(state, ctx, e.target || 'self')) {
      t.resource = Math.min(t.maxResource, t.resource + e.amount);
    }
  },

  markCells(state, content, ctx, e) {
    const spec = { ...e, ...(ctx.overrides || {}) };
    const candidates = allCells().filter((c) => !state.cells[c].hazard);
    const chosen = pickMany(state, candidates.length ? candidates : allCells(), spec.count || 1);
    for (const c of chosen) markCell(state, c, ctx.caster.id, spec);
    log(state, `${ctx.caster.name} — ${ctx.abilityName} — ${chosen.length} cells begin to glow`, 'telegraph');
  },

  markTargetCell(state, content, ctx, e) {
    const targets = resolveEffectTargets(state, ctx, e.target);
    for (const t of targets) markCell(state, t.cell, ctx.caster.id, e);
    if (targets.length) log(state, `${ctx.abilityName} marks the ground under ${targets[0].name}`, 'telegraph');
  },

  markRandomCell(state, content, ctx, e) {
    const c = nextInt(state, CELL_COUNT);
    markCell(state, c, ctx.caster.id, e);
    log(state, `${ctx.caster.name} — ${ctx.abilityName} — the party must gather!`, 'telegraph');
  },

  summon(state, content, ctx, e) {
    for (let i = 0; i < (e.count || 1); i++) {
      const template = content.units[e.unit];
      const id = `${e.unit}${++state.spawnCounter}`;
      const free = allCells().filter((c) => c !== ctx.caster.cell);
      state.units.push(makeUnit(state, content, { ...template, id, cell: pick(state, free) }));
      log(state, `${template.name} joins the fight!`, 'spawn');
    }
  },

};

export function markCell(state, index, sourceId, e) {
  state.cells[index].hazard = {
    kind: e.kind || 'blast',
    name: e.name || 'Hazard',
    markedAt: state.tick,
    detonatesAt: state.tick + (e.delayTicks || 30),
    damage: e.damage || 0,
    minSoakers: e.minSoakers || 0,
    raidDamage: e.raidDamage || 0,
    aura: e.aura || null,
    sourceId,
  };
}

export function runEffects(state, content, ctx, effects) {
  for (const e of effects || []) {
    const handler = effectHandlers[e.type];
    if (!handler) throw new Error(`unknown effect type: ${e.type}`);
    handler(state, content, ctx, e);
  }
}

/* ------------------------------------------------------- casting flow */

export function makeUnit(state, content, def) {
  return {
    id: def.id,
    type: def.type || def.id,
    name: def.name,
    role: def.role,
    title: def.title || '',
    team: def.team || 'party',
    hp: def.maxHp,
    maxHp: def.maxHp,
    resource: def.maxResource ?? 100,
    maxResource: def.maxResource ?? 100,
    resourceName: def.resourceName || 'Ammo',
    resourceRegen: def.resourceRegen ?? 0.4,
    cell: def.cell ?? 12,
    threat: {},
    auras: [],
    gcdUntil: 0,
    castUntil: 0,
    castStart: 0,
    castAbility: null,
    castTarget: null,
    movePath: [],
    moveUntil: 0,
    cooldowns: {},
    alive: true,
    ai: def.ai ?? null,
    reactionTicks: def.reactionTicks ?? 9,
    aiReadyAt: 0,
    abilities: def.abilities || [],
    passives: def.passives || [],
    meleeRange: def.meleeRange ?? 1,
  };
}

export function onCooldown(state, unit, abilityId) {
  return (unit.cooldowns[abilityId] || 0) > state.tick;
}

export function canUseAbility(state, content, unit, abilityId, target) {
  const ability = abilityDef(content, abilityId);
  if (!unit.alive) return false;
  if (unit.castAbility) return false;
  if (!ability.offGcd && unit.gcdUntil > state.tick) return false;
  if (onCooldown(state, unit, abilityId)) return false;
  if ((ability.cost || 0) > unit.resource) return false;
  if (ability.targeting !== 'self' && ability.targeting !== 'cell' && ability.targeting !== 'none') {
    if (!target || !target.alive) return false;
    if (distance(unit.cell, target.cell) > (ability.range ?? 5)) return false;
  }
  return true;
}

// Player-facing feedback: why did that button do nothing?
export function castBlockedReason(state, content, unit, abilityId, target) {
  const ability = abilityDef(content, abilityId);
  if (!unit.alive) return 'you are dead';
  if (onCooldown(state, unit, abilityId)) {
    return `${ability.name} is not ready (${((unit.cooldowns[abilityId] - state.tick) / 10).toFixed(1)}s)`;
  }
  if ((ability.cost || 0) > unit.resource) return `not enough ${unit.resourceName} for ${ability.name}`;
  if (!target || !target.alive) return `${ability.name} has no valid target`;
  if (
    ability.targeting !== 'self' &&
    ability.targeting !== 'none' &&
    distance(unit.cell, target.cell) > (ability.range ?? 5)
  ) {
    return `${target.name} is out of range for ${ability.name}`;
  }
  return `${ability.name} is not ready`;
}

export function startAbility(state, content, unit, abilityId, target, cell = null, overrides = null) {
  const ability = abilityDef(content, abilityId);
  unit.resource = Math.max(0, unit.resource - (ability.cost || 0));
  if (!ability.offGcd) unit.gcdUntil = state.tick + (ability.gcdTicks ?? GCD_TICKS);
  if (ability.cooldownTicks) unit.cooldowns[abilityId] = state.tick + ability.cooldownTicks;

  if (ability.castTicks > 0) {
    unit.castAbility = abilityId;
    unit.castStart = state.tick;
    unit.castUntil = state.tick + ability.castTicks;
    unit.castTarget = target ? target.id : null;
    unit.castCell = cell;
    unit.castOverrides = overrides;
    log(state, `${unit.name} begins casting ${ability.name}${target ? ` on ${target.name}` : ''}`, 'cast');
    return;
  }
  resolveAbility(state, content, unit, abilityId, target, cell, overrides);
}

export function resolveAbility(state, content, unit, abilityId, target, cell = null, overrides = null) {
  const ability = abilityDef(content, abilityId);
  const ctx = { caster: unit, target, cell, ability, abilityName: ability.name, overrides };
  if (ability.requiresTargetInRange && (!target || !target.alive || distance(unit.cell, target.cell) > (ability.range ?? 5))) {
    if (ability.onNoTarget) {
      log(state, ability.onNoTargetText || `${ability.name} finds no target!`, 'mechanic');
      runEffects(state, content, ctx, ability.onNoTarget);
    } else {
      log(state, `${unit.name}'s ${ability.name} finds no target`, 'info');
    }
    return;
  }
  runEffects(state, content, ctx, ability.effects);
}

export function cancelCast(state, unit, reason) {
  if (!unit.castAbility) return;
  log(state, `${unit.name}'s cast is cancelled (${reason})`, 'cast');
  unit.castAbility = null;
  unit.castUntil = 0;
  unit.castTarget = null;
}

// Moving cancels a cast in progress. Those seven words are the whole
// movement-versus-DPS tension.
export function orderMove(state, unit, destination) {
  if (!unit.alive || destination === unit.cell) return;
  unit.movePath = [destination];
  if (unit.castAbility) cancelCast(state, unit, 'moving');
  if (unit.moveUntil <= state.tick) unit.moveUntil = state.tick + 4;
}
