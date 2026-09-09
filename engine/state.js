// Builds a fresh GameState. Pure data in, pure data out -- nothing here
// knows the DOM exists.

import { CELL_COUNT } from './grid.js';
import { makeUnit } from './abilities.js';
import { applyAura } from './auras.js';

export const TICKS_PER_SECOND = 10;

export function createState(content, options = {}) {
  const seed = options.seed ?? 1234;
  const bossDef = content.bosses[options.boss || 'chthon'];
  const partyDef = content.parties[options.party || 'default'];

  const state = {
    tick: 0,
    rngSeed: seed | 0,
    seed,
    units: [],
    cells: Array.from({ length: CELL_COUNT }, (_, index) => ({ index, hazard: null })),
    phaseIndex: -1,
    phaseStartTick: 0,
    schedule: [],
    enrageTick: (bossDef.enrageAtSeconds || 300) * TICKS_PER_SECOND,
    enraged: false,
    hardStopTick: (options.hardStopSeconds ?? 480) * TICKS_PER_SECOND,
    spawnCounter: 0,
    log: [],
    over: false,
    result: null,
    bossId: bossDef.id,
    playerId: null,
    playerTarget: bossDef.id,
    playerAllyTarget: null,
    stats: { damageBy: {}, healBy: {}, deaths: [], interrupts: 0 },
  };

  // The player takes over one party slot; the rest stay bots.
  const playerRole = options.playerRole || 'dps';
  let playerAssigned = options.headless === true;

  for (const member of partyDef.members) {
    const unit = makeUnit(state, content, { ...member, team: 'party' });
    if (!playerAssigned && member.role === playerRole) {
      unit.ai = null;
      state.playerId = unit.id;
      playerAssigned = true;
    }
    state.units.push(unit);
  }

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

  state.playerAllyTarget = state.playerId;
  return state;
}
