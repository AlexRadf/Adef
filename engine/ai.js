// Bot AI: a priority list evaluated top to bottom; the first rule that
// both matches AND produces a usable action wins. The lists themselves
// live in /content/ai/*.json -- this file only provides the named
// condition registry and the action verbs.

import { distance, allCells, cellCenter, clampToArena, contains } from './geometry.js';
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

export function hazardUnder(state, pos) {
  return state.hazards.find((h) => contains(h, pos)) || null;
}

// A bot only "sees" a hazard once its reaction delay has elapsed. This is
// the single cheapest thing in the project that makes bots feel human.
function noticedHazard(state, unit) {
  const h = hazardUnder(state, unit.pos);
  if (!h) return null;
  if (h.kind === 'split' || h.kind === 'soak') return null; // those you walk into
  return state.tick >= h.markedAt + unit.reactionTicks ? h : null;
}

function spotIsSafe(state, pos, arrivalTick) {
  for (const h of state.hazards) {
    if (h.kind === 'split' || h.kind === 'soak') continue;
    if (contains(h, pos) && h.detonatesAt >= arrivalTick) return false;
  }
  return true;
}

// Step just far enough to be clear, the way a person does -- not to the
// middle of the next tile. Sampling short offsets first keeps bots from
// spending more uptime running than the hazard would have cost them.
// In 3D this samples the navmesh; everything around it is unchanged.
function safetyCandidates(unit) {
  const spots = [];
  for (let i = 0; i < 8; i++) {
    const angle = (i / 8) * Math.PI * 2;
    for (const reach of [0.75, 1.2, 1.8]) {
      spots.push(clampToArena({
        x: unit.pos.x + Math.cos(angle) * reach,
        y: unit.pos.y + Math.sin(angle) * reach,
      }));
    }
  }
  for (const cell of allCells()) spots.push(cellCenter(cell));
  return spots;
}

export function nearestSafeSpot(state, unit) {
  let best = null;
  let bestScore = Infinity;
  const boss = bossOf(state);
  for (const spot of safetyCandidates(unit)) {
    const steps = distance(unit.pos, spot);
    if (steps < 0.1) continue;
    const arrival = state.tick + Math.ceil((steps / unit.speed) * 10);
    if (!spotIsSafe(state, spot, arrival + 6)) continue;
    let score = steps * 10;
    // Spread-marked units want elbow room; the tank wants to stay in melee.
    if (hasAura(unit, 'riftMark')) {
      score += livingParty(state).filter((u) => u.id !== unit.id && distance(u.pos, spot) <= 1).length * 40;
    }
    if (boss && unit.role === 'tank') score += distance(spot, boss.pos) * 6;
    if (score < bestScore) {
      bestScore = score;
      best = spot;
    }
  }
  return best;
}

// Standing in a soak or a stack marker is a commitment. Without this a
// bot walks in, then wanders back out to get in range of its target and
// the mechanic fails -- and the longer the telegraph, the more time it
// has to make that mistake.
export function committedArea(state, unit) {
  return (
    state.hazards.find((h) => (h.kind === 'soak' || h.kind === 'split') && contains(h, unit.pos)) || null
  );
}

// When a stack marker and a soak are pending at once they demand
// opposite positions. Whichever lands first wins, then deal with the
// other -- otherwise the party abandons a soak it was already standing
// in and dies to it.
export function urgentGather(state) {
  let soonest = null;
  for (const h of state.hazards) {
    if (h.kind !== 'split' && h.kind !== 'soak') continue;
    if (!soonest || h.detonatesAt < soonest.detonatesAt) soonest = h;
  }
  return soonest;
}

function markedAreaOfKind(state, kind) {
  const area = urgentGather(state);
  return area && area.kind === kind ? area : null;
}

function soakersHeadedTo(state, area) {
  return livingParty(state).filter(
    (u) => contains(area, u.pos) || (u.moveTarget && contains(area, u.moveTarget))
  ).length;
}

/* -------------------------------------------------------- conditions */

export const conditions = {
  always: () => true,
  selfCellUnsafe: (state, content, unit) => !!noticedHazard(state, unit),
  selfBelowPct: (state, content, unit, n) => (unit.hp / unit.maxHp) * 100 < Number(n),
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
  stackMarkerActive: (state) => !!markedAreaOfKind(state, 'split'),
  soakNeeded: (state, content, unit) => {
    const area = markedAreaOfKind(state, 'soak');
    if (!area) return false;
    return soakersHeadedTo(state, area) < area.minSoakers || contains(area, unit.pos);
  },
  outOfMelee: (state, content, unit) => {
    const boss = bossOf(state);
    return !!boss && distance(unit.pos, boss.pos) > 1;
  },
  resourceBelowPct: (state, content, unit, n) => (unit.resource / unit.maxResource) * 100 < Number(n),
  enrageSoon: (state, content, unit, seconds) => state.enrageTick - state.tick <= Number(seconds) * 10,
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

// In the arena scheme the player has no target lock: whatever the
// crosshair is nearest to is what the ability hits.
export function nearestTo(units, point) {
  let best = null;
  let bestDist = Infinity;
  for (const u of units) {
    const d = Math.hypot(u.pos.x - point.x, u.pos.y - point.y);
    if (d < bestDist) {
      bestDist = d;
      best = u;
    }
  }
  return best;
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
    if (checkCondition(state, content, unit, rule.else ? 'always' : rule.if)) return rule.do;
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
      // Out of range? Walk in rather than stand there -- unless leaving
      // would break a soak or stack we are already standing in.
      if (
        target !== unit &&
        distance(unit.pos, target.pos) > (ability.range ?? 5) &&
        !committedArea(state, unit)
      ) {
        orderMove(state, unit, target.pos);
        return true;
      }
      return false;
    }
    startAbility(state, content, unit, abilityId, target);
    return true;
  }

  switch (action) {
    case 'moveToSafe': {
      const spot = nearestSafeSpot(state, unit);
      if (!spot) return false;
      orderMove(state, unit, spot);
      unit.moveReason = 'safety'; // so it stops the moment it is clear
      return true;
    }
    case 'moveToStack': {
      const area = markedAreaOfKind(state, 'split');
      if (!area || contains(area, unit.pos)) return false;
      orderMove(state, unit, area);
      return true;
    }
    case 'moveToSoak': {
      const area = markedAreaOfKind(state, 'soak');
      if (!area || contains(area, unit.pos)) return false;
      orderMove(state, unit, area);
      return true;
    }
    case 'moveToBoss': {
      const boss = bossOf(state);
      if (!boss || distance(unit.pos, boss.pos) <= 1) return false;
      if (committedArea(state, unit)) return false;
      orderMove(state, unit, boss.pos);
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

  const script = content.ai[unit.ai];
  if (!script) return;
  for (const rule of script.priority) {
    if (!checkCondition(state, content, unit, rule.else ? 'always' : rule.if)) continue;
    if (!performAction(state, content, unit, rule.do)) continue;
    unit.aiReadyAt = state.tick + Math.max(2, Math.round(unit.reactionTicks / 2));
    return;
  }
}
