// Bot AI: a priority list evaluated top to bottom, first match wins.
// The lists themselves live in /content/ai/*.json -- this file only
// provides the named condition registry and the action verbs.

import { distance, allCells, stepToward } from './grid.js';
import { auraStacks, hasAura, dispellable } from './auras.js';
import {
  livingParty,
  threatLeader,
  canUseAbility,
  startAbility,
  orderMove,
  abilityDef,
  onCooldown,
} from './abilities.js';

const DISPEL_TYPES = ['magic', 'curse', 'poison'];

/* ------------------------------------------------------------ helpers */

export function bossOf(state) {
  return state.units.find((u) => u.role === 'boss') || null;
}

export function adds(state) {
  return state.units.filter((u) => u.alive && u.team === 'enemy' && u.role === 'add');
}

export function hazardAt(state, cell) {
  return state.cells[cell].hazard;
}

// A bot only "sees" a hazard once its reaction delay has elapsed. This is
// the single cheapest thing in the project that makes bots feel human.
function noticedHazard(state, unit, cell) {
  const h = hazardAt(state, cell);
  if (!h) return null;
  if (h.kind === 'split' || h.kind === 'soak') return null; // those you walk into
  return state.tick >= h.markedAt + unit.reactionTicks ? h : null;
}

function cellIsSafe(state, cell, arrivalTick) {
  const h = state.cells[cell].hazard;
  if (!h) return true;
  if (h.kind === 'split' || h.kind === 'soak') return true;
  return h.detonatesAt < arrivalTick;
}

export function nearestSafeCell(state, unit) {
  let best = null;
  let bestScore = Infinity;
  for (const cell of allCells()) {
    const steps = distance(unit.cell, cell);
    if (steps === 0) continue;
    const arrival = state.tick + steps * 4;
    if (!cellIsSafe(state, cell, arrival + 4)) continue;
    let score = steps * 10;
    // Spread-marked units want elbow room; everyone else likes the middle.
    if (hasAura(unit, 'riftMark')) {
      const crowd = livingParty(state).filter((u) => u.id !== unit.id && distance(u.cell, cell) <= 1).length;
      score += crowd * 40;
    }
    const boss = bossOf(state);
    if (boss && unit.role === 'tank') score += distance(cell, boss.cell) * 6;
    if (score < bestScore) {
      bestScore = score;
      best = cell;
    }
  }
  return best;
}

function markedCellOfKind(state, kind) {
  for (const c of allCells()) {
    const h = state.cells[c].hazard;
    if (h && h.kind === kind) return c;
  }
  return null;
}

function soakersHeadedTo(state, cell) {
  return livingParty(state).filter(
    (u) => u.cell === cell || (u.movePath.length && u.movePath[u.movePath.length - 1] === cell)
  ).length;
}

/* -------------------------------------------------------- conditions */

export const conditions = {
  always: () => true,
  selfCellUnsafe: (state, content, unit) => !!noticedHazard(state, unit, unit.cell),
  selfBelowPct: (state, content, unit, n) => unit.hp / unit.maxHp * 100 < Number(n),
  allyBelowPct: (state, content, unit, n) =>
    livingParty(state).some((u) => (u.hp / u.maxHp) * 100 < Number(n)),
  partyAvgBelowPct: (state, content, unit, n) => {
    const party = livingParty(state);
    if (!party.length) return false;
    const avg = party.reduce((s, u) => s + u.hp / u.maxHp, 0) / party.length;
    return avg * 100 < Number(n);
  },
  allyHasDispellable: (state, content, unit) =>
    livingParty(state).some((u) =>
      dispellable(u, DISPEL_TYPES).some((a) => state.tick >= a.appliedAt + unit.reactionTicks)
    ),
  bossCastingInterruptible: (state, content, unit) => {
    const boss = bossOf(state);
    if (!boss || !boss.castAbility) return false;
    const def = content.abilities[boss.castAbility];
    return !!def.interruptible && state.tick >= boss.castStart + unit.reactionTicks;
  },
  bossCasting: (state, content, unit) => {
    const boss = bossOf(state);
    return !!(boss && boss.castAbility && state.tick >= boss.castStart + unit.reactionTicks);
  },
  notThreatLeader: (state, content, unit) => {
    const boss = bossOf(state);
    if (!boss) return false;
    const leader = threatLeader(state, boss);
    return !leader || leader.id !== unit.id;
  },
  hasAuraStacks: (state, content, unit, id, n) => auraStacks(unit, id) >= Number(n),
  selfHasAura: (state, content, unit, id) => hasAura(unit, id),
  cooldownReady: (state, content, unit, id) => !onCooldown(state, unit, id),
  addAlive: (state) => adds(state).length > 0,
  stackMarkerActive: (state) => markedCellOfKind(state, 'split') !== null,
  soakNeeded: (state, content, unit) => {
    const cell = markedCellOfKind(state, 'soak');
    if (cell === null) return false;
    const h = state.cells[cell].hazard;
    return soakersHeadedTo(state, cell) < h.minSoakers || unit.cell === cell;
  },
  outOfMelee: (state, content, unit) => {
    const boss = bossOf(state);
    return !!boss && distance(unit.cell, boss.cell) > 1;
  },
  resourceBelowPct: (state, content, unit, n) => (unit.resource / unit.maxResource) * 100 < Number(n),
  enrageSoon: (state, content, unit, seconds) =>
    state.enrageTick - state.tick <= Number(seconds) * 10,
};

export function checkCondition(state, content, unit, expr) {
  const [name, ...args] = String(expr).split(':');
  const fn = conditions[name];
  if (!fn) throw new Error(`unknown AI condition: ${expr}`);
  return !!fn(state, content, unit, ...args);
}

/* ------------------------------------------------------- target logic */

export function enemyFocus(state, unit) {
  const add = adds(state).sort((a, b) => a.hp - b.hp)[0];
  if (add && unit.role !== 'tank') return add;
  return bossOf(state) || add || null;
}

export function resolveTarget(state, content, unit, ability, preferred = null) {
  switch (ability.targeting) {
    case 'self':
    case 'none':
    case 'cell':
      return unit;
    case 'enemy':
      return preferred && preferred.alive && preferred.team === 'enemy' ? preferred : enemyFocus(state, unit);
    case 'lowestAlly': {
      const party = livingParty(state);
      return party.slice().sort((a, b) => a.hp / a.maxHp - b.hp / b.maxHp)[0] || null;
    }
    case 'dispelTarget': {
      const hit = livingParty(state).find((u) => dispellable(u, DISPEL_TYPES).length);
      return hit || preferred || unit;
    }
    case 'ally': {
      if (preferred && preferred.alive && preferred.team === 'party') return preferred;
      const party = livingParty(state);
      return party.slice().sort((a, b) => a.hp / a.maxHp - b.hp / b.maxHp)[0] || unit;
    }
    default:
      return null;
  }
}

/* ------------------------------------------------------------ actions */

export function decide(state, content, unit) {
  const script = content.ai[unit.ai];
  if (!script) return null;
  for (const rule of script.priority) {
    const test = rule.else ? 'always' : rule.if;
    if (checkCondition(state, content, unit, test)) return rule.do;
  }
  return null;
}

export function performAction(state, content, unit, action) {
  if (!action) return false;
  if (action.startsWith('cast:')) {
    const abilityId = action.slice(5);
    const ability = abilityDef(content, abilityId);
    const target = resolveTarget(state, content, unit, ability);
    if (!target) return false;
    if (!canUseAbility(state, content, unit, abilityId, target)) {
      // Out of range for a melee ability? Walk in instead of standing still.
      if (
        target !== unit &&
        distance(unit.cell, target.cell) > (ability.range ?? 5) &&
        unit.moveUntil <= state.tick
      ) {
        orderMove(state, unit, stepToward(unit.cell, target.cell));
        return true;
      }
      return false;
    }
    startAbility(state, content, unit, abilityId, target);
    return true;
  }

  switch (action) {
    case 'moveToSafe': {
      const cell = nearestSafeCell(state, unit);
      if (cell === null || cell === unit.cell) return false;
      orderMove(state, unit, cell);
      return true;
    }
    case 'moveToStack': {
      const cell = markedCellOfKind(state, 'split');
      if (cell === null || cell === unit.cell) return false;
      orderMove(state, unit, cell);
      return true;
    }
    case 'moveToSoak': {
      const cell = markedCellOfKind(state, 'soak');
      if (cell === null || cell === unit.cell) return false;
      orderMove(state, unit, cell);
      return true;
    }
    case 'moveToBoss': {
      const boss = bossOf(state);
      if (!boss || distance(unit.cell, boss.cell) <= 1) return false;
      orderMove(state, unit, stepToward(unit.cell, boss.cell));
      return true;
    }
    case 'wait':
      return false;
    default:
      throw new Error(`unknown AI action: ${action}`);
  }
}

// First rule that both matches AND produces a usable action wins, so a
// priority list does not stall on an ability that happens to be on cooldown.
export function runBot(state, content, unit) {
  if (!unit.ai || !unit.alive) return;
  if (state.tick < unit.aiReadyAt) return;
  if (unit.castAbility) return;
  if (unit.moveUntil > state.tick && unit.movePath.length) return;

  const script = content.ai[unit.ai];
  if (!script) return;
  for (const rule of script.priority) {
    if (!checkCondition(state, content, unit, rule.else ? 'always' : rule.if)) continue;
    if (!performAction(state, content, unit, rule.do)) continue;
    unit.aiReadyAt = state.tick + Math.max(2, Math.round(unit.reactionTicks / 2));
    return;
  }
}
