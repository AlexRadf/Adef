// Ability execution plus the two choke points every point of damage and
// healing in the game must pass through.

import {
  clampToArena,
  distance,
  isBehind,
  withinArc,
  allCells,
  cellCenter,
  cellOf,
  clonePos,
  contains,
  normalize,
  sub,
  vec,
  CELL_COUNT,
  TILE_HALF,
} from './geometry.js';
import { TICKS_PER_SECOND } from './clock.js';
import { applyAura, removeAura, statMult, consumeAbsorb, dispellable } from './auras.js';
import { nextInt, pick, pickMany } from './rng.js';

export const DEFAULT_GCD_TICKS = 15;

// The play style decides the global cooldown, how fast bodies move,
// whether facing matters, and how tanking works.
export const styleOf = (state) => state.style || { gcd: 1.5, moveSpeed: 2.5, aim: 'target' };
export const gcdTicksOf = (state) => Math.round(styleOf(state).gcd * TICKS_PER_SECOND);
export const telegraphScaleOf = (state) =>
  (styleOf(state).telegraphScale ?? 1) * (state.mods?.telegraphScale ?? 1);

export const unitById = (state, id) => state.units.find((u) => u.id === id) || null;
export const living = (state) => state.units.filter((u) => u.alive);
export const livingParty = (state) => state.units.filter((u) => u.alive && u.team === 'party');
export const livingEnemies = (state) => state.units.filter((u) => u.alive && u.team === 'enemy');

// Events worth stopping the world for, when a mode asks for tactical pause.
const PAUSE_WORTHY = new Set(['telegraph', 'death', 'phase', 'enrage', 'spawn', 'mechanic']);

export function log(state, text, kind = 'info') {
  state.logSeq = (state.logSeq || 0) + 1;
  state.log.push({ seq: state.logSeq, tick: state.tick, text, kind });
  if (PAUSE_WORTHY.has(kind)) state.events.push({ kind, text });
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
  // Body-block tanking has no threat table at all: it swings at whoever
  // is standing closest, so holding the boss is a physical job.
  if (styleOf(state).tanking?.mode === 'guard') {
    let best = null;
    let bestDist = Infinity;
    for (const u of livingParty(state)) {
      const d = distance(u.pos, enemy.pos);
      if (d < bestDist) {
        bestDist = d;
        best = u;
      }
    }
    return best;
  }

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
  // Hitting something from behind, when the style says facing exists.
  const flank = styleOf(state).flankBonus || 1;
  if (flank !== 1 && source && source.team === 'party' && isBehind(source.pos, target)) {
    amount *= flank;
    meta = { ...meta, flanked: true };
  }
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
      return foes.filter((u) => distance(u.pos, target.pos) <= 1);
    }
    case 'nearTarget': {
      if (!target) return [];
      const foes = target.team === 'party' ? livingParty(state) : livingEnemies(state);
      return foes.filter((u) => u.id !== target.id && distance(u.pos, target.pos) <= 1);
    }
    case 'inTargetArea': {
      const area = cell || (target ? { x: target.pos.x, y: target.pos.y, half: TILE_HALF } : null);
      if (!area) return [];
      return living(state).filter((u) => contains(area, u.pos));
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
    const taken = new Set(state.hazards.map((h) => cellOf(h)));
    const free = allCells().filter((c) => !taken.has(c));
    const wanted = (spec.count || 1) + (state.mods?.geyserExtra || 0);
    const chosen = pickMany(state, free.length ? free : allCells(), wanted);
    for (const c of chosen) markArea(state, cellCenter(c), ctx.caster.id, spec);
    log(state, `${ctx.caster.name} — ${ctx.abilityName} — ${chosen.length} tiles begin to glow`, 'telegraph');
  },

  markTargetArea(state, content, ctx, e) {
    const targets = resolveEffectTargets(state, ctx, e.target);
    for (const t of targets) markArea(state, t.pos, ctx.caster.id, e);
    if (targets.length) log(state, `${ctx.abilityName} marks the ground under ${targets[0].name}`, 'telegraph');
  },

  markRandomArea(state, content, ctx, e) {
    markArea(state, cellCenter(nextInt(state, CELL_COUNT)), ctx.caster.id, e);
    log(state, `${ctx.caster.name} — ${ctx.abilityName} — the party must gather!`, 'telegraph');
  },

  // A healing field: heals whoever stands in it, for as long as it lasts.
  healField(state, content, ctx, e) {
    const at = ctx.cell || ctx.caster.pos;
    state.fields.push({
      id: ++state.hazardCounter,
      name: e.name || 'Field',
      x: at.x,
      y: at.y,
      half: e.half ?? 0.6,
      sourceId: ctx.caster.id,
      amount: e.amount,
      intervalTicks: Math.max(1, Math.round((e.interval ?? 0.5) * TICKS_PER_SECOND)),
      nextTick: state.tick + Math.max(1, Math.round((e.interval ?? 0.5) * TICKS_PER_SECOND)),
      expiresAt: state.tick + Math.round((e.duration ?? 4) * TICKS_PER_SECOND),
    });
    log(state, `${ctx.caster.name} drops ${e.name || 'a healing field'}`, 'heal');
  },

  summon(state, content, ctx, e) {
    const total = Math.max(1, (e.count || 1) + (state.mods?.addCountDelta || 0));
    for (let i = 0; i < total; i++) {
      const template = content.units[e.unit];
      const id = `${e.unit}${++state.spawnCounter}`;
      const away = allCells().filter((c) => c !== cellOf(ctx.caster.pos));
      const hpScale = state.mods?.addHpScale ?? 1;
      state.units.push(
        makeUnit(state, content, {
          ...template,
          id,
          cell: pick(state, away),
          maxHp: Math.round(template.maxHp * hpScale),
        })
      );
      log(state, `${template.name} joins the fight!`, 'spawn');
    }
  },

};

// An area effect: a position and a half-extent. A 3D port swaps the shape
// test in geometry.js and leaves every mechanic that spawns one alone.
export function markArea(state, pos, sourceId, e) {
  state.hazards.push({
    id: ++state.hazardCounter,
    kind: e.kind || 'blast',
    name: e.name || 'Hazard',
    x: pos.x,
    y: pos.y,
    half: e.half ?? TILE_HALF,
    markedAt: state.tick,
    detonatesAt: state.tick + Math.max(3, Math.round((e.delayTicks || 30) * telegraphScaleOf(state))),
    damage: e.damage || 0,
    minSoakers: e.minSoakers || 0,
    raidDamage: e.raidDamage || 0,
    aura: e.aura || null,
    sourceId,
  });
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
    stamina: def.maxStamina ?? 0,
    maxStamina: def.maxStamina ?? 0,
    staminaRegen: def.staminaRegen ?? 0,
    blocking: false,
    resource: def.maxResource ?? 100,
    maxResource: def.maxResource ?? 100,
    resourceName: def.resourceName || 'Ammo',
    resourceRegen: def.resourceRegen ?? 0.4,
    pos: def.pos ? clonePos(def.pos) : cellCenter(def.cell ?? 12),
    facing: vec(0, 1),
    speed: def.speed ?? 2.5,
    // Bosses and adds cast on the move. Players do not -- that asymmetry
    // is the whole point of "moving cancels a cast".
    castWhileMoving: def.castWhileMoving ?? def.team === 'enemy',
    threat: {},
    auras: [],
    gcdUntil: 0,
    castUntil: 0,
    castStart: 0,
    castAbility: null,
    castTarget: null,
    moveTarget: null,
    moveDir: null,
    moveReason: null,
    movedThisTick: false,
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
  // You cannot cast on the move -- so do not start one that movement is
  // about to cancel, paying the cost and the cooldown for nothing.
  if (ability.castTicks > 0 && (unit.moveTarget || unit.moveDir)) return false;
  if ((ability.cost || 0) > unit.resource) return false;
  if (ability.targeting !== 'self' && ability.targeting !== 'cell' && ability.targeting !== 'none') {
    if (!target || !target.alive) return false;
    if (distance(unit.pos, target.pos) > (ability.range ?? 5)) return false;
    // Lock-on combat: it has to be in front of you.
    const arc = styleOf(state).facingArc || 0;
    if (arc && target !== unit && !withinArc(unit.pos, unit.facing, target.pos, arc)) return false;
  }
  return true;
}

/* ------------------------------------------------------------ stamina */

export function spendStamina(unit, cost) {
  if (unit.stamina < cost) return false;
  unit.stamina -= cost;
  return true;
}

// A roll, or a rocket jump: an instant displacement that can carry
// invulnerability with it. Costs stamina and cancels whatever you were
// casting, because of course it does.
export function performDash(state, content, unit) {
  const style = styleOf(state);
  const dash = style.dash;
  if (!dash || !unit.alive) return false;
  if ((unit.cooldowns.__dash || 0) > state.tick) return false;
  if (!spendStamina(unit, dash.stamina)) return false;

  const dir = unit.moveDir && (unit.moveDir.x || unit.moveDir.y) ? unit.moveDir : unit.facing;
  unit.pos = clampToArena({
    x: unit.pos.x + dir.x * dash.distance,
    y: unit.pos.y + dir.y * dash.distance,
  });
  unit.cooldowns.__dash = state.tick + Math.round(dash.cooldown * TICKS_PER_SECOND);
  if (unit.castAbility) cancelCast(state, unit, dash.name.toLowerCase());
  if (dash.iframes) {
    applyAura(state, content, unit.id, unit, 'iframes', {
      durationTicks: Math.round(dash.iframes * TICKS_PER_SECOND),
    });
  }
  log(state, `${unit.name} — ${dash.name}`, 'cast');
  return true;
}

// Active block: held, drains stamina, breaks when you run out.
export function setBlocking(state, content, unit, on) {
  const block = styleOf(state).block;
  if (!block || !unit.alive) return;
  unit.blocking = !!on && unit.stamina > 0 && !hasAuraId(unit, 'guardBroken');
  if (!unit.blocking) return;
  const aura = applyAura(state, content, unit.id, unit, 'blocking', { durationTicks: 3 });
  // How much a block blocks lives in the style, not in the aura file.
  if (aura) aura.modifiers = [{ stat: 'damageTaken', op: 'mult', value: 1 - block.reduction }];
}

const hasAuraId = (unit, id) => unit.auras.some((a) => a.id === id);

// Player-facing feedback: why did that button do nothing?
export function castBlockedReason(state, content, unit, abilityId, target) {
  const ability = abilityDef(content, abilityId);
  if (!unit.alive) return 'you are dead';
  if (ability.castTicks > 0 && (unit.moveTarget || unit.moveDir)) {
    return `${ability.name} cannot be cast while moving`;
  }
  if (onCooldown(state, unit, abilityId)) {
    return `${ability.name} is not ready (${((unit.cooldowns[abilityId] - state.tick) / 10).toFixed(1)}s)`;
  }
  if ((ability.cost || 0) > unit.resource) return `not enough ${unit.resourceName} for ${ability.name}`;
  if (!target || !target.alive) return `${ability.name} has no valid target`;
  if (
    ability.targeting !== 'self' &&
    ability.targeting !== 'none' &&
    distance(unit.pos, target.pos) > (ability.range ?? 5)
  ) {
    return `${target.name} is out of range for ${ability.name}`;
  }
  return `${ability.name} is not ready`;
}

export function startAbility(state, content, unit, abilityId, target, cell = null, overrides = null) {
  const ability = abilityDef(content, abilityId);
  unit.resource = Math.max(0, unit.resource - (ability.cost || 0));
  if (!ability.offGcd) unit.gcdUntil = state.tick + (ability.gcdTicks ?? gcdTicksOf(state));
  if (ability.cooldownTicks) unit.cooldowns[abilityId] = state.tick + ability.cooldownTicks;

  if (ability.castTicks > 0) {
    unit.castAbility = abilityId;
    unit.castStart = state.tick;
    unit.castUntil = state.tick + ability.castTicks;
    unit.castTarget = target ? target.id : null;
    unit.castCell = cell;
    unit.castOverrides = overrides;
    log(state, `${unit.name} begins casting ${ability.name}${target ? ` on ${target.name}` : ''}`, 'cast');
    if (ability.interruptible) state.events.push({ kind: 'interruptible', text: ability.name });
    return;
  }
  resolveAbility(state, content, unit, abilityId, target, cell, overrides);
}

export function resolveAbility(state, content, unit, abilityId, target, cell = null, overrides = null) {
  const ability = abilityDef(content, abilityId);
  const ctx = { caster: unit, target, cell, ability, abilityName: ability.name, overrides };
  if (
    ability.requiresTargetInRange &&
    (!target || !target.alive || distance(unit.pos, target.pos) > (ability.range ?? 5))
  ) {
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
  if (!unit.alive) return;
  if (distance(unit.pos, destination) < 0.05) return;
  unit.moveTarget = clonePos(destination);
  unit.moveDir = null;
  unit.moveReason = null;
  if (unit.castAbility) cancelCast(state, unit, 'moving');
}

// Held-direction movement: WASD.
export function orderMoveDirection(state, unit, dir) {
  if (!unit.alive) return;
  const n = normalize(dir);
  unit.moveTarget = null;
  unit.moveDir = n.x === 0 && n.y === 0 ? null : n;
  if (unit.moveDir && unit.castAbility) cancelCast(state, unit, 'moving');
}

export function faceToward(unit, point) {
  const d = normalize(sub(point, unit.pos));
  if (d.x !== 0 || d.y !== 0) unit.facing = d;
}
