// The aura system carries most of the game: buffs, debuffs, DoTs, HoTs,
// stacking tank debuffs, delayed bombs, absorbs and the enrage are all
// this one struct.

export function auraDef(content, id) {
  const def = content.auras[id];
  if (!def) throw new Error(`unknown aura: ${id}`);
  return def;
}

export function findAura(unit, id) {
  return unit.auras.find((a) => a.id === id) || null;
}

export function hasAura(unit, id) {
  return !!findAura(unit, id);
}

export function auraStacks(unit, id) {
  const a = findAura(unit, id);
  return a ? a.stacks : 0;
}

export function applyAura(state, content, sourceId, target, id, overrides = {}) {
  if (!target.alive) return null;
  const def = auraDef(content, id);
  const duration = overrides.durationTicks ?? def.durationTicks ?? 0;
  const existing = findAura(target, id);

  if (existing) {
    existing.expiresAt = duration > 0 ? state.tick + duration : Infinity;
    existing.sourceId = sourceId;
    if (def.maxStacks && def.maxStacks > 1) {
      existing.stacks = Math.min(def.maxStacks, existing.stacks + (overrides.stacks ?? 1));
    }
    if (def.absorb) existing.absorb = overrides.absorb ?? def.absorb;
    return existing;
  }

  const aura = {
    id,
    name: def.name || id,
    sourceId,
    appliedAt: state.tick,
    expiresAt: duration > 0 ? state.tick + duration : Infinity,
    stacks: overrides.stacks ?? 1,
    maxStacks: def.maxStacks || 1,
    harmful: !!def.harmful,
    dispelType: def.dispelType ?? null,
    modifiers: def.modifiers || [],
    absorb: def.absorb ?? 0,
    isShield: !!def.absorb,
    periodic: def.periodic
      ? { ...def.periodic, nextTick: state.tick + def.periodic.intervalTicks }
      : null,
    onExpire: def.onExpire ?? null,
    onDispel: def.onDispel ?? null,
  };
  target.auras.push(aura);
  return aura;
}

export function removeAura(state, unit, id) {
  const i = unit.auras.findIndex((a) => a.id === id);
  if (i === -1) return null;
  return unit.auras.splice(i, 1)[0];
}

// Multiplicative stats: damageDealt, damageTaken, healingDone, healingTaken,
// threatMult. Additive stats go through statAdd.
export function statMult(unit, stat) {
  let value = 1;
  for (const aura of unit.auras) {
    for (const mod of aura.modifiers) {
      if (mod.stat !== stat || mod.op !== 'mult') continue;
      value *= mod.perStack ? Math.pow(mod.value, aura.stacks) : mod.value;
    }
  }
  return value;
}

export function statAdd(unit, stat) {
  let value = 0;
  for (const aura of unit.auras) {
    for (const mod of aura.modifiers) {
      if (mod.stat !== stat || mod.op !== 'add') continue;
      value += mod.perStack ? mod.value * aura.stacks : mod.value;
    }
  }
  return value;
}

// Spend absorb shields; returns the damage left over.
export function consumeAbsorb(state, unit, amount) {
  let remaining = amount;
  for (const aura of unit.auras) {
    if (remaining <= 0) break;
    if (!aura.absorb || aura.absorb <= 0) continue;
    const used = Math.min(aura.absorb, remaining);
    aura.absorb -= used;
    remaining -= used;
  }
  // A fully spent shield falls off immediately, like it should.
  unit.auras = unit.auras.filter((a) => !(a.isShield && a.absorb <= 0));
  return remaining;
}

export function dispellable(unit, types) {
  return unit.auras.filter((a) => a.harmful && a.dispelType && types.includes(a.dispelType));
}
