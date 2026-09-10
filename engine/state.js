// Builds a fresh GameState. Pure data in, pure data out -- nothing here
// knows the DOM exists.

import { makeUnit } from './abilities.js';
import { nextInt } from './rng.js';
import { applyAura } from './auras.js';
import { TICKS_PER_SECOND } from './clock.js';

export { TICKS_PER_SECOND };

// Headless callers may hand us raw content; fall back to the raid preset.
function resolveDefaultStyle(content, choice) {
  const preset = content.styles.presets[choice || 'raid'];
  const picked = {};
  for (const axis of ['movement', 'combat', 'healing', 'tanking']) {
    picked[axis] = content.styles[axis][preset[axis]];
  }
  return {
    id: choice || 'raid',
    name: preset.name,
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
}

export function createState(content, options = {}) {
  const seed = options.seed ?? 1234;
  const bossDef = content.bosses[options.boss || 'chthon'];
  const partyDef = content.parties[options.party || 'default'];
  // applyStyle() folds the ability overrides in and sets content.style;
  // without it we still run, on the default raid rules.
  const style = content.style || resolveDefaultStyle(content, options.style);
  if (!style) throw new Error('no play style resolved');
  const mode = content.modes[options.mode || 'solo'];
  if (!mode) throw new Error(`unknown play mode: ${options.mode}`);

  // Modifiers are stackable encounter tweaks, folded into one object so
  // the engine reads a single set of knobs rather than a list.
  const chosen = (options.modifiers || []).map((id) => {
    const mod = content.modifiers[id];
    if (!mod) throw new Error(`unknown modifier: ${id}`);
    return mod;
  });
  const mods = { telegraphScale: 1, geyserExtra: 0, addCountDelta: 0, addHpScale: 1, enrageDelta: 0, hideTimers: false };
  for (const mod of chosen) {
    mods.telegraphScale *= mod.telegraphScale ?? 1;
    mods.geyserExtra += mod.geyserExtra ?? 0;
    mods.addCountDelta += mod.addCountDelta ?? 0;
    mods.addHpScale *= mod.addHpScale ?? 1;
    mods.enrageDelta += mod.enrageDelta ?? 0;
    mods.hideTimers = mods.hideTimers || !!mod.hideTimers;
  }

  const state = {
    tick: 0,
    rngSeed: seed | 0,
    seed,
    units: [],
    hazards: [],
    fields: [],
    hazardCounter: 0,
    style,
    mode,
    mods,
    modifiers: chosen.map((m) => m.id),
    phaseIndex: -1,
    phaseStartTick: 0,
    schedule: [],
    enrageTick: Math.max(
      600,
      ((bossDef.enrageAtSeconds || 300) + (mods.enrageDelta || 0)) * TICKS_PER_SECOND
    ),
    enraged: false,
    hardStopTick: (options.hardStopSeconds ?? 480) * TICKS_PER_SECOND,
    spawnCounter: 0,
    log: [],
    events: [],
    over: false,
    result: null,
    bossId: bossDef.id,
    playerIds: [],
    activeId: null,
    playerAim: { x: 2.5, y: 2.5 },
    stats: { damageBy: {}, healBy: {}, deaths: [], interrupts: 0 },
  };

  // How much of the party you drive is the play mode's business:
  //   one  -- you take a slot, three bots fill the rest
  //   all  -- every slot is yours, nobody runs a priority list
  //   none -- you drive nobody; you wrote the priority lists instead
  const control = options.headless ? 'none' : mode.control;
  const playerRole = options.playerRole || 'dps';
  let slotTaken = false;

  for (const member of partyDef.members) {
    const unit = makeUnit(state, content, {
      ...member,
      team: 'party',
      speed: style.moveSpeed,
      maxStamina: style.stamina ? style.stamina.max : 0,
      staminaRegen: style.stamina ? style.stamina.regen : 0,
    });
    // Reaction delay varies per pull, seeded like everything else. The
    // same three bots, but never quite the same three people.
    unit.reactionTicks = Math.max(4, member.reactionTicks + nextInt(state, 7) - 3);
    const mine = control === 'all' || (control === 'one' && !slotTaken && member.role === playerRole);
    if (mine) {
      unit.ai = null;
      state.playerIds.push(unit.id);
      slotTaken = true;
    }
    unit.playerTarget = bossDef.id;
    unit.playerAllyTarget = null;
    state.units.push(unit);
  }
  state.activeId = state.playerIds[0] || null;

  state.units.push(
    makeUnit(state, content, {
      id: bossDef.id,
      type: bossDef.id,
      name: bossDef.name,
      title: bossDef.title,
      role: 'boss',
      team: 'enemy',
      maxHp: bossDef.hp,
      cell: bossDef.cell ?? 12,
      maxResource: 100,
      resourceRegen: 0,
      speed: bossDef.speed ?? 0,
      ai: null,
    })
  );

  // Starting threat so the tank holds aggro out of the gate.
  const boss = state.units.find((u) => u.id === bossDef.id);
  for (const u of state.units) {
    if (u.team !== 'party') continue;
    boss.threat[u.id] = u.role === 'tank' ? 5000 : 0;
    for (const p of u.passives) applyAura(state, content, u.id, u, p, { durationTicks: 0 });
  }

  return state;
}
