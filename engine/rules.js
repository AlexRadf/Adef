// Mode rules: the handful of switches that make Slipgate feel like Quake
// and The Pit feel like Dark Souls, past what a style axis can say.
//
// A style axis answers "how do you aim / move / heal / hold aggro". A
// rule answers "what is this mode ABOUT" -- speed, ultimate overlap,
// stagger, threat. The data lives in content/games.json; this file is
// the only place that reads it, so adding a mode is a JSON edit and one
// function here, and the headless runner can measure the result.

import { applyAura } from './auras.js';
import { livingParty, log } from './abilities.js';
import { TICKS_PER_SECOND } from './clock.js';

export const rulesOf = (state) => state.rules || {};

/* ------------------------------------------------------------ momentum */

// Quake's real subject is speed. Hold a direction and you wind up; stop
// and you are back to a walk. Nothing about the trinity changes -- the
// tank still tanks -- but the floor becomes something you use.
export function momentumMult(state, unit) {
  const rule = rulesOf(state).momentum;
  if (!rule || unit.team !== 'party') return 1;
  const t = Math.min(1, (unit.momentum || 0) / rule.rampTicks);
  return 1 + t * rule.bonus;
}

export function momentumPass(state) {
  const rule = rulesOf(state).momentum;
  if (!rule) return;
  for (const unit of state.units) {
    if (unit.team !== 'party') continue;
    unit.momentum = unit.movedThisTick ? Math.min(rule.rampTicks, (unit.momentum || 0) + 1) : 0;
  }
}

/* -------------------------------------------------------- ultimate combo */

// Overwatch is a game about two ultimates landing in the same second.
// Overlap them and both get better, which turns four separate buttons
// into something the party has to talk about.
export function comboPass(state, content) {
  const rule = rulesOf(state).ultCombo;
  if (!rule) return;
  const live = livingParty(state).filter((u) => (u.ultActiveUntil || 0) > state.tick);
  state.comboCount = live.length;
  if (live.length < (rule.need || 2)) return;
  for (const unit of livingParty(state)) {
    applyAura(state, content, unit.id, unit, rule.aura, { durationTicks: 2 });
  }
  if (!state.comboAnnouncedUntil || state.tick > state.comboAnnouncedUntil) {
    state.comboAnnouncedUntil = state.tick + 30;
    log(state, `ULTIMATE COMBO — ${live.length} ultimates in the air!`, 'enrage');
  }
}

// Called from startAbility: an ultimate leaves a window behind it, and
// the window is what another ultimate can overlap with.
export function markUltimate(state, unit) {
  const rule = rulesOf(state).ultCombo;
  if (!rule) return;
  unit.ultActiveUntil = state.tick + Math.round((rule.windowSeconds || 6) * TICKS_PER_SECOND);
}

/* ------------------------------------------------------------- heat */

// Overwatch's primaries are held, and a held primary needs a reason to
// stop. Heat is that reason: fire long enough and the weapon locks out,
// which is what turns "hold the button" into a rhythm and gives the
// cooldowns somewhere to fit.
export function heatOf(state, unit) {
  const rule = rulesOf(state).overheat;
  if (!rule || unit.team !== 'party') return null;
  return { heat: unit.heat || 0, max: rule.max, locked: (unit.heatLockUntil || 0) > state.tick };
}

export function addHeat(state, unit, abilityId, ability) {
  const rule = rulesOf(state).overheat;
  if (!rule || unit.team !== 'party' || ability.ultimate) return;
  const primary = abilityId === unit.abilities[0];
  unit.heat = (unit.heat || 0) + (primary ? rule.per : rule.perAbility ?? rule.per);
  unit.heatFiredAt = state.tick;
  if (unit.heat < rule.max) return;
  unit.heat = rule.max;
  unit.heatLockUntil = state.tick + Math.round((rule.lockSeconds || 2) * TICKS_PER_SECOND);
  log(state, `${unit.name} REDLINES — venting`, 'mechanic');
}

// Venting locks the whole kit, not just the trigger: the ultimate is the
// one thing you can still spend, which is exactly where Overload wants
// your attention.
export function heatLocked(state, unit, abilityId, ability) {
  const rule = rulesOf(state).overheat;
  if (!rule || unit.team !== 'party' || (ability && ability.ultimate)) return false;
  return (unit.heatLockUntil || 0) > state.tick;
}

export function heatPass(state) {
  const rule = rulesOf(state).overheat;
  if (!rule) return;
  for (const unit of state.units) {
    if (unit.team !== 'party') continue;
    if ((unit.heatLockUntil || 0) === state.tick) unit.heat = 0; // vent finished
    if (!unit.heat) continue;
    if ((unit.heatLockUntil || 0) > state.tick) continue; // venting empties it
    if (state.tick - (unit.heatFiredAt || 0) < (rule.graceTicks ?? 4)) continue;
    unit.heat = Math.max(0, unit.heat - (rule.vent || 4));
  }
}

/* ------------------------------------------------------------- poise */

// Dark Souls does not measure a boss in health alone. It has a guard,
// you break it, and the reward is a window rather than a number. Poise
// fills from hitting it, faster from behind, and a parry all but breaks
// it outright -- so the trinity's tank is the one who opens the window
// and the damage dealer is the one who spends it.
export function poiseMax(state) {
  return rulesOf(state).poise ? rulesOf(state).poise.max : 0;
}

export function addPoise(state, target, amount) {
  const rule = rulesOf(state).poise;
  if (!rule || !target || target.team !== 'enemy' || !target.alive) return;
  if (target.auras.some((a) => a.id === 'staggered')) return; // already open
  target.poise = (target.poise || 0) + amount;
  if (target.poise < rule.max) return;

  target.poise = 0;
  applyAura(state, state.content, target.id, target, 'staggered', {
    durationTicks: Math.round((rule.staggerSeconds || 3) * TICKS_PER_SECOND),
  });
  log(state, `${target.name}'s guard BREAKS — hit it now!`, 'enrage');
  state.stats.staggers = (state.stats.staggers || 0) + 1;
}

export function poisePass(state) {
  const rule = rulesOf(state).poise;
  if (!rule) return;
  for (const unit of state.units) {
    if (unit.team !== 'enemy' || !unit.alive) continue;
    if (unit.auras.some((a) => a.id === 'staggered')) continue;
    unit.poise = Math.max(0, (unit.poise || 0) - (rule.decay || 0));
  }
}

/* ------------------------------------------------------ practice range */

// Practice switches are state, not content: they belong to the pull you
// are doing right now. They read as no-ops when unset, so the headless
// runner and the real encounter are untouched.
export function practiceOf(state) {
  return state.practice || {};
}

export function practicePass(state) {
  const p = practiceOf(state);
  if (!p.infiniteResource && !p.noCooldowns) return;
  for (const unit of state.units) {
    if (unit.team !== 'party' || !unit.alive) continue;
    if (p.infiniteResource) {
      unit.resource = unit.maxResource;
      unit.stamina = unit.maxStamina;
      unit.ultimate = 100;
    }
    if (p.noCooldowns) {
      unit.cooldowns = {};
      unit.gcdUntil = 0;
    }
  }
}
