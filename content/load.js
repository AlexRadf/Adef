// Content loading that works both in the browser (fetch) and in Node
// (fs), so sim.js and index.html read exactly the same JSON.
//
// Content is authored in SECONDS. This is the one place that turns those
// into engine ticks, so changing the tick rate -- or porting to an engine
// that runs at 30 or 60 -- does not invalidate a single content file.

import { toTicks } from '../engine/clock.js';

const FILES = {
  abilities: 'abilities.json',
  auras: 'auras.json',
  units: 'units.json',
  parties: 'parties.json',
  styles: 'styles.json',
  modes: 'modes.json',
  modifiers: 'modifiers.json',
  drills: 'drills.json',
  games: 'games.json',
};

const BOSSES = ['chthon'];
const AI = ['tank', 'healer', 'dps'];

const isNode = typeof process !== 'undefined' && !!process.versions?.node;

async function readJson(relative) {
  const url = new URL(relative, import.meta.url);
  if (isNode) {
    const { readFileSync } = await import('node:fs');
    return JSON.parse(readFileSync(url, 'utf8'));
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`failed to load ${relative}: ${res.status}`);
  return res.json();
}

export async function loadContent() {
  const content = { bosses: {}, ai: {} };
  await Promise.all([
    ...Object.entries(FILES).map(async ([key, file]) => {
      content[key] = await readJson(file);
    }),
    ...BOSSES.map(async (id) => {
      content.bosses[id] = await readJson(`bosses/${id}.json`);
    }),
    ...AI.map(async (id) => {
      content.ai[id] = await readJson(`ai/${id}.json`);
    }),
  ]);
  content.abilities = hydrateAbilities(content.abilities);
  content.auras = hydrateAuras(content.auras);
  return content;
}

/* ------------------------------------------------- seconds -> ticks */

const SECOND_FIELDS = { cast: 'castTicks', gcd: 'gcdTicks', cooldown: 'cooldownTicks', lockout: 'lockoutTicks', delay: 'delayTicks' };

function withTicks(obj) {
  const out = { ...obj };
  for (const [seconds, ticks] of Object.entries(SECOND_FIELDS)) {
    if (out[seconds] !== undefined) out[ticks] = toTicks(out[seconds]);
  }
  return out;
}

function hydrateAbilities(abilities) {
  const out = {};
  for (const [id, def] of Object.entries(abilities)) {
    const ability = withTicks(def);
    if (ability.effects) ability.effects = ability.effects.map(withTicks);
    if (ability.onNoTarget) ability.onNoTarget = ability.onNoTarget.map(withTicks);
    out[id] = ability;
  }
  return out;
}

function hydrateAuras(auras) {
  const out = {};
  for (const [id, def] of Object.entries(auras)) {
    const aura = { ...def, durationTicks: toTicks(def.duration ?? 0) };
    if (def.periodic) aura.periodic = { ...def.periodic, intervalTicks: toTicks(def.periodic.interval) };
    if (def.onExpire) aura.onExpire = asArray(def.onExpire).map(withTicks);
    if (def.onDispel) aura.onDispel = asArray(def.onDispel).map(withTicks);
    out[id] = aura;
  }
  return out;
}

const asArray = (v) => (Array.isArray(v) ? v : [v]);

/* ----------------------------------------------------- play styles */

// Four independent axes -- how you move, how you attack, how you heal,
// how you tank -- composed into one style. Each axis may override
// abilities; later axes win, so a healing style can rewrite a heal that
// the combat style only re-costed.
export const AXES = ['movement', 'combat', 'healing', 'tanking'];

export function resolveStyle(content, choice = {}) {
  const preset = typeof choice === 'string' ? content.styles.presets[choice] : null;
  if (typeof choice === 'string' && !preset) throw new Error(`unknown style preset: ${choice}`);
  const picked = {};
  for (const axis of AXES) {
    const id = (preset ? preset[axis] : choice[axis]) || Object.keys(content.styles[axis])[0];
    const option = content.styles[axis][id];
    if (!option) throw new Error(`unknown ${axis} style: ${id}`);
    picked[axis] = option;
  }
  return picked;
}

// Returns a content view with the style's ability overrides folded in.
// Nothing is mutated, so several styles can be compared in one process.
export function applyStyle(content, choice = 'raid') {
  const picked = resolveStyle(content, choice);
  const overrides = {};
  for (const axis of AXES) {
    for (const [id, def] of Object.entries(picked[axis].abilities || {})) {
      overrides[id] = { ...(overrides[id] || {}), ...def };
    }
  }

  const abilities = {};
  for (const [id, def] of Object.entries(content.abilities)) {
    abilities[id] = overrides[id] ? hydrateAbilities({ [id]: { ...def, ...overrides[id] } })[id] : def;
  }

  // The flat fields the engine reads every tick, composed from the axes.
  const style = {
    id: typeof choice === 'string' ? choice : 'custom',
    name: typeof choice === 'string' ? content.styles.presets[choice].name : 'Custom',
    ...picked,
    moveSpeed: picked.movement.moveSpeed,
    gcd: picked.combat.gcd,
    aim: picked.combat.aim,
    facingArc: picked.combat.facingArc || 0,
    flankBonus: picked.combat.flankBonus || 1,
    telegraphScale: 1,
    stamina: picked.movement.stamina || picked.tanking.stamina || null,
    dash: picked.movement.dash || null,
    block: picked.tanking.mode === 'block' ? picked.tanking.block : null,
  };
  return { ...content, abilities, style };
}
