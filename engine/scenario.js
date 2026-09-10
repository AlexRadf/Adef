// Scenario assembly: the handcrafted fight, rearranged. Nothing here
// invents content -- it takes Chthon's own abilities and builds a
// practice loop or a gauntlet stage out of them, so what you drill is
// exactly what you will meet in the real thing.

const DRILL_HP = 900000000; // unkillable: a drill ends when you do

// The lobby: a room, your kit, and something that does not hit back.
// Everything else about the fight is identical, so what you learn here
// is true when the real thing walks in.
export function buildLobbyBoss(content) {
  const source = content.bosses.chthon;
  return {
    id: 'dummy',
    name: 'Training Dummy',
    title: 'It does not hit back',
    hp: 999000000,
    cell: source.cell,
    speed: 0,
    enrageAtSeconds: 100000,
    phases: [{ name: 'Training', trigger: { type: 'start' }, timeline: [] }],
  };
}

export function buildDrillBoss(content, drillId) {
  const drill = content.drills[drillId];
  if (!drill) throw new Error(`unknown drill: ${drillId}`);
  const source = content.bosses.chthon;

  const timeline = [{ t: 1, every: 2, ability: 'lavaSwipe', target: 'threatLeader' }];
  timeline.push({
    t: drill.opening ?? 6,
    every: drill.every,
    ability: drill.ability,
    target: drill.target || 'none',
    ...(drill.count ? { count: drill.count } : {}),
    ...(drill.delay ? { delay: drill.delay } : {}),
  });

  return {
    id: `drill_${drillId}`,
    name: source.name,
    title: `The Drill — ${drill.name}`,
    hp: DRILL_HP,
    cell: source.cell,
    speed: source.speed,
    enrageAtSeconds: 100000,
    drilling: drill.ability,
    phases: [{ name: `Drill — ${drill.name}`, trigger: { type: 'start' }, timeline }],
  };
}

// One stage of a gauntlet: the same boss, plus whatever the run has
// accumulated. Health carries over, which is what makes it a run rather
// than three separate pulls.
export function gauntletStage(run) {
  const stage = run.stage;
  return {
    modifiers: run.modifiers.slice(),
    carryHealthPct: stage === 0 ? 100 : Math.max(45, run.carryHealthPct),
    boons: run.boons.slice(),
  };
}

export function applyCarry(state, content, stage, applyAura) {
  for (const unit of state.units) {
    if (unit.team !== 'party') continue;
    if (stage.carryHealthPct < 100) {
      unit.hp = Math.max(1, Math.round((unit.maxHp * stage.carryHealthPct) / 100));
    }
    for (const boon of stage.boons) applyAura(state, content, unit.id, unit, boon, { durationTicks: 0 });
  }
}
