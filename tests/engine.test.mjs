// Plain node test runner, no dependencies: node --test tests/*.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadContent, applyStyle, resolveStyle } from '../content/load.js';
import { createState } from '../engine/state.js';
import { step, snapshot } from '../engine/tick.js';
import {
  applyDamage,
  applyHeal,
  unitById,
  startAbility,
  orderMove,
  markArea,
  canUseAbility,
} from '../engine/abilities.js';
import { applyAura } from '../engine/auras.js';
import { distance, cellCenter, contains, vec } from '../engine/geometry.js';
import {
  urgentGather,
  committedArea,
  conditions,
  performAction,
  CONDITION_SPECS,
  ACTION_SPECS,
} from '../engine/ai.js';
import { toTicks, TICKS_PER_SECOND } from '../engine/clock.js';
import { generateEncounter, withEncounter } from '../engine/generate.js';
import { tuneEncounter } from '../engine/tune.js';
import { buildDrillBoss, gauntletStage, applyCarry } from '../engine/scenario.js';

const base = await loadContent();
const content = applyStyle(base, 'raid');

const run = (seed, style = 'raid') => {
  const c = applyStyle(base, style);
  const state = createState(c, { seed, headless: true });
  while (!state.over) step(state, c, []);
  return state;
};
const fresh = (style = 'raid') => {
  const c = applyStyle(base, style);
  return { c, state: createState(c, { seed: 1, headless: true }) };
};

/* ------------------------------------------------------- determinism */

test('same seed produces an identical fight', () => {
  const a = run(42);
  const b = run(42);
  assert.equal(a.tick, b.tick);
  assert.equal(a.result, b.result);
  assert.equal(a.log.length, b.log.length);
  assert.deepEqual(a.stats.deaths, b.stats.deaths);
});

test('every style preset is deterministic and terminates', () => {
  for (const preset of Object.keys(base.styles.presets)) {
    assert.equal(run(7, preset).tick, run(7, preset).tick);
    const state = run(7, preset);
    assert.ok(['kill', 'wipe', 'timeout'].includes(state.result));
    assert.ok(state.tick <= state.hardStopTick);
  }
});

test('different seeds diverge', () => {
  assert.ok(new Set([1, 2, 3, 4, 5].map((s) => run(s).tick)).size > 1);
});

/* -------------------------------------------------- content pipeline */

test('content is authored in seconds and hydrated into ticks', () => {
  assert.equal(content.abilities.rocket.cast, 1.5);
  assert.equal(content.abilities.rocket.castTicks, toTicks(1.5));
  assert.equal(content.auras.pentagram.durationTicks, toTicks(content.auras.pentagram.duration));
  assert.equal(content.auras.riftMark.periodic.intervalTicks, toTicks(content.auras.riftMark.periodic.interval));
  assert.equal(content.abilities.lavaGeyser.effects[0].delayTicks, toTicks(content.abilities.lavaGeyser.effects[0].delay));
});

test('a style overrides abilities without mutating the base content', () => {
  const arena = applyStyle(base, 'arena');
  assert.equal(arena.abilities.rocket.castTicks, 0);
  assert.equal(arena.style.gcd, 0.3);
  assert.equal(base.abilities.rocket.castTicks, toTicks(1.5), 'base content untouched');
  assert.equal(applyStyle(base, 'raid').abilities.rocket.castTicks, toTicks(1.5));
});

/* ------------------------------------------------------- style axes */

test('the four axes compose independently', () => {
  const mixed = applyStyle(base, { movement: 'dodge', combat: 'tab', healing: 'ground', tanking: 'guard' });
  assert.equal(mixed.style.id, 'custom');
  assert.ok(mixed.style.dash, 'dodge brings a dash');
  assert.equal(mixed.style.gcd, 1.5, 'tab keeps the global cooldown');
  assert.equal(mixed.abilities.stimpack.effects[0].type, 'healField', 'ground rewrites the heals');
  assert.equal(mixed.style.tanking.mode, 'guard');
  assert.equal(mixed.style.facingArc, 0, 'tab does not care which way you face');
});

test('every option of every axis produces a runnable fight', () => {
  const RAID = { movement: 'click', combat: 'tab', healing: 'frames', tanking: 'threat' };
  for (const axis of ['movement', 'combat', 'healing', 'tanking']) {
    for (const opt of Object.keys(base.styles[axis])) {
      const c = applyStyle(base, { ...RAID, [axis]: opt });
      const state = createState(c, { seed: 5, headless: true });
      while (!state.over) step(state, c, []);
      assert.ok(['kill', 'wipe', 'timeout'].includes(state.result), `${axis}=${opt} did not resolve`);
      assert.ok(state.tick > 100, `${axis}=${opt} ended suspiciously early`);
    }
  }
});

test('an unknown axis option is refused rather than silently ignored', () => {
  assert.throws(() => resolveStyle(base, { movement: 'moonwalk' }), /unknown movement style/);
  assert.throws(() => resolveStyle(base, 'nonsense'), /unknown style preset/);
});

/* ------------------------------------------------------ choke points */

test('damage modifiers stack through the choke point', () => {
  const { c, state } = fresh();
  const tank = unitById(state, 'ranger');
  const before = tank.hp;
  applyDamage(state, 'chthon', 'ranger', 100000, 'lava'); // Vanguard Stance is x0.7
  assert.equal(before - tank.hp, 70000);
  applyAura(state, c, 'ranger', tank, 'pentagram'); // x0.35
  const mid = tank.hp;
  applyDamage(state, 'chthon', 'ranger', 100000, 'lava');
  assert.equal(mid - tank.hp, Math.round(100000 * 0.7 * 0.35));
});

test('healing never overflows max hp', () => {
  const { state } = fresh();
  const healer = unitById(state, 'crash');
  healer.hp = healer.maxHp - 1000;
  assert.equal(applyHeal(state, 'crash', 'crash', 500000), 1000);
  assert.equal(healer.hp, healer.maxHp);
});

/* ---------------------------------------------------------- geometry */

test('distance is chebyshev over continuous positions', () => {
  assert.equal(distance(vec(0.5, 0.5), vec(1.5, 1.5)), 1);
  assert.equal(distance(vec(0.5, 0.5), vec(4.5, 4.5)), 4);
  assert.ok(Math.abs(distance(vec(1, 1), vec(1.4, 1.9)) - 0.9) < 1e-9);
  assert.deepEqual(cellCenter(12), { x: 2.5, y: 2.5 });
});

test('an area effect catches whoever is standing in it, mid-tile or not', () => {
  const area = { x: 2.5, y: 2.5, half: 0.5 };
  assert.ok(contains(area, vec(2.5, 2.5)));
  assert.ok(contains(area, vec(2.05, 2.95)));
  assert.ok(!contains(area, vec(1.9, 2.5)));
});

/* ---------------------------------------------------------- movement */

test('moving cancels a cast in progress', () => {
  const { c, state } = fresh();
  const dps = unitById(state, 'visor');
  startAbility(state, c, dps, 'rocket', unitById(state, 'chthon'));
  assert.equal(dps.castAbility, 'rocket');
  orderMove(state, dps, vec(0.5, 0.5));
  assert.equal(dps.castAbility, null);
});

test('a cast is never started while a move order is live', () => {
  const { c, state } = fresh();
  const dps = unitById(state, 'visor');
  orderMove(state, dps, vec(4.5, 4.5));
  const before = dps.resource;
  startAbility(state, c, dps, 'nailgun', unitById(state, 'chthon')); // instant: fine
  assert.ok(dps.resource < before);
  assert.equal(canUseAbility(state, c, dps, 'rocket', unitById(state, 'chthon')), false);
});

test('units travel continuously rather than snapping between tiles', () => {
  const { c, state } = fresh();
  const dps = unitById(state, 'visor');
  const from = { ...dps.pos };
  orderMove(state, dps, vec(0.5, 0.5));
  step(state, c, []);
  assert.notDeepEqual(dps.pos, from);
  assert.ok(distance(dps.pos, from) < 0.6, 'one tick is a fraction of a cell');
});

/* --------------------------------------------------------------- AI */

test('the soonest gather mechanic wins when two demand opposite ground', () => {
  const { state } = fresh();
  markArea(state, vec(0.5, 0.5), 'chthon', { kind: 'soak', delayTicks: 60, minSoakers: 2, name: 'Void Well' });
  markArea(state, vec(4.5, 4.5), 'chthon', { kind: 'split', delayTicks: 20, name: 'Chain of Souls' });
  assert.equal(urgentGather(state).kind, 'split', 'the one landing first');
  state.hazards[1].detonatesAt = state.tick + 200;
  assert.equal(urgentGather(state).kind, 'soak');
});

test('standing in a soak is a commitment', () => {
  const { state } = fresh();
  const healer = unitById(state, 'crash');
  markArea(state, healer.pos, 'chthon', { kind: 'soak', delayTicks: 60, minSoakers: 2, name: 'Void Well' });
  assert.ok(committedArea(state, healer));
});

/* --------------------------------------------------------- snapshot */

test('snapshot is renderable and never leaks live units', () => {
  const c = applyStyle(base, 'raid');
  const state = createState(c, { seed: 5, headless: true });
  for (let i = 0; i < 200; i++) step(state, c, []);
  const view = snapshot(state, c);
  assert.equal(view.party.length, 4);
  assert.ok(view.boss.hp <= view.boss.maxHp);
  assert.ok(Array.isArray(view.hazards));
  assert.equal(typeof view.party[0].pos.x, 'number');
  view.party[0].hp = -1;
  view.party[0].pos.x = 99;
  assert.ok(unitById(state, view.party[0].id).hp > -1);
  assert.notEqual(unitById(state, view.party[0].id).pos.x, 99);
});

/* ------------------------------------------------------------- modes */

test('a play mode decides how much of the party you drive', () => {
  const counts = {};
  for (const mode of ['solo', 'commander', 'gambit']) {
    const state = createState(content, { seed: 1, mode, playerRole: 'healer' });
    counts[mode] = state.playerIds.length;
    for (const u of state.units.filter((x) => x.team === 'party')) {
      assert.equal(!!u.ai, !state.playerIds.includes(u.id), 'a unit is either yours or a bot, never both');
    }
  }
  assert.deepEqual(counts, { solo: 1, commander: 4, gambit: 0 });
});

test('headless runs stay all-bot whatever the mode says', () => {
  const state = createState(content, { seed: 1, mode: 'commander', headless: true });
  assert.equal(state.playerIds.length, 0);
  assert.ok(state.units.filter((u) => u.team === 'party').every((u) => u.ai));
});

test('every AI condition and action the editor offers actually exists', () => {
  for (const spec of CONDITION_SPECS) {
    assert.ok(conditions[spec.id], `editor offers unknown condition ${spec.id}`);
  }
  for (const id of Object.keys(conditions)) {
    assert.ok(CONDITION_SPECS.some((s) => s.id === id), `condition ${id} is missing an editor label`);
  }
  const state = createState(content, { seed: 1, headless: true });
  const unit = unitById(state, 'crash');
  for (const spec of ACTION_SPECS) {
    assert.doesNotThrow(() => performAction(state, content, unit, spec.id), `action ${spec.id} is not implemented`);
  }
});

test('an edited priority list changes the fight', () => {
  const lazy = structuredClone(content.ai);
  lazy.healer.priority = [{ else: true, do: 'wait' }]; // a healer who does nothing
  const c = { ...content, ai: lazy };
  const state = createState(c, { seed: 11, headless: true });
  while (!state.over) step(state, c, []);
  assert.equal(state.result, 'wipe', 'no healing should not be survivable');
});

/* --------------------------------------------------------- modifiers */

test('modifiers stack into one set of knobs', () => {
  const plain = createState(content, { seed: 1, headless: true });
  const loaded = createState(content, {
    seed: 1,
    headless: true,
    modifiers: ['volcanic', 'quickening', 'shortFuse', 'fogOfWar'],
  });
  assert.equal(loaded.mods.geyserExtra, content.modifiers.volcanic.geyserExtra);
  assert.equal(loaded.mods.telegraphScale, content.modifiers.quickening.telegraphScale);
  assert.ok(loaded.enrageTick < plain.enrageTick);
  assert.equal(loaded.mods.hideTimers, true);
  assert.throws(() => createState(content, { seed: 1, modifiers: ['nonsense'] }), /unknown modifier/);
});

test('a modifier actually changes the fight it describes', () => {
  const count = (mods) => {
    const state = createState(content, { seed: 9, headless: true, modifiers: mods });
    let most = 0;
    for (let i = 0; i < 400; i++) {
      step(state, content, []);
      most = Math.max(most, state.hazards.filter((h) => h.kind === 'blast').length);
    }
    return most;
  };
  assert.ok(count(['volcanic']) > count([]), 'Volcanic should put more tiles on the floor');
});

/* --------------------------------------------------- generated fights */

test('a seed always makes the same encounter, and different seeds differ', () => {
  assert.deepEqual(generateEncounter(7), generateEncounter(7));
  const names = [1, 2, 3, 4, 5, 6].map((s) => JSON.stringify(generateEncounter(s).boss));
  assert.equal(new Set(names).size, 6);
});

test('generated encounters are structurally valid content', () => {
  for (let seed = 1; seed <= 25; seed++) {
    const e = generateEncounter(seed);
    const c = withEncounter(content, e);
    assert.ok(e.boss.phases.length >= 2, `#${seed} needs phases`);
    assert.ok(e.mechanics.length >= 2, `#${seed} needs mechanics to describe`);

    for (const phase of e.boss.phases) {
      assert.ok(phase.trigger && phase.trigger.type, `#${seed} phase needs a trigger`);
      for (const entry of phase.timeline) {
        const ability = c.abilities[entry.ability];
        assert.ok(ability, `#${seed} timeline references missing ability ${entry.ability}`);
        assert.equal(typeof ability.castTicks, 'number', `#${seed} ${entry.ability} was never hydrated`);
        for (const effect of [...(ability.effects || []), ...(ability.onNoTarget || [])]) {
          if (effect.type === 'aura') assert.ok(c.auras[effect.aura], `#${seed} missing aura ${effect.aura}`);
          if (effect.type === 'summon') assert.ok(c.units[effect.unit], `#${seed} missing unit ${effect.unit}`);
        }
      }
    }
  }
});

test('a generated fight actually runs to a conclusion', () => {
  for (const seed of [3, 19]) {
    const e = generateEncounter(seed);
    const c = withEncounter(content, e);
    const state = createState(c, { seed: 1, headless: true, boss: e.boss.id });
    while (!state.over) step(state, c, []);
    assert.ok(['kill', 'wipe', 'timeout'].includes(state.result));
    assert.ok(state.log.length > 50, 'a real fight leaves a real log');
  }
});

test('the tuner lands a random encounter in a playable band', () => {
  const tuned = tuneEncounter(content, generateEncounter(12), { seed: 12, runs: 24 });
  assert.ok(tuned.report.winRate > 0.1 && tuned.report.winRate < 0.85, `win rate was ${tuned.report.winRate}`);
  assert.ok(tuned.report.medianKill > 120 && tuned.report.medianKill < 320, `kill was ${tuned.report.medianKill}s`);
  assert.ok(tuned.encounter.boss.hp > 1e6);
  assert.ok(tuned.report.log.length >= 2, 'the tuner should say what it did');
});

test('tuning is deterministic', () => {
  const a = tuneEncounter(content, generateEncounter(5), { seed: 5, runs: 12 });
  const b = tuneEncounter(content, generateEncounter(5), { seed: 5, runs: 12 });
  assert.equal(a.encounter.boss.hp, b.encounter.boss.hp);
  assert.equal(a.encounter.damageScale, b.encounter.damageScale);
});

/* ------------------------------------------------------ solo scenarios */

test('a drill is the real fight with everything else removed', () => {
  for (const id of Object.keys(content.drills)) {
    const boss = buildDrillBoss(content, id);
    const timeline = boss.phases[0].timeline;
    assert.equal(timeline.length, 2, `${id}: melee plus the one drilled mechanic`);
    assert.equal(timeline[1].ability, content.drills[id].ability);
    assert.ok(content.abilities[timeline[1].ability], `${id} drills a real ability`);
    assert.ok(boss.enrageAtSeconds > 1000, 'a drill has no enrage to beat');

    const c = { ...content, bosses: { ...content.bosses, [boss.id]: boss } };
    const state = createState(c, { seed: 3, headless: true, boss: boss.id, hardStopSeconds: 60 });
    while (!state.over) step(state, c, []);
    assert.ok(state.result !== 'kill', 'a drill boss cannot be killed');
  }
});

test('gauntlet stages carry health and pickups forward', () => {
  const run = { stage: 1, modifiers: ['volcanic'], boons: ['boonQuad'], carryHealthPct: 61 };
  const stage = gauntletStage(run);
  assert.deepEqual(stage.modifiers, ['volcanic']);
  assert.equal(stage.carryHealthPct, 61);

  const state = createState(content, { seed: 1, headless: true, modifiers: stage.modifiers });
  applyCarry(state, content, stage, applyAura);
  for (const unit of state.units.filter((u) => u.team === 'party')) {
    assert.equal(Math.round((unit.hp / unit.maxHp) * 100), 61);
    assert.ok(unit.auras.some((a) => a.id === 'boonQuad'), 'the pickup came with them');
  }
});

test('a first stage starts clean however hurt the run is', () => {
  const stage = gauntletStage({ stage: 0, modifiers: [], boons: [], carryHealthPct: 12 });
  assert.equal(stage.carryHealthPct, 100);
});

test('every mode the menu offers is playable', () => {
  for (const mode of Object.values(content.modes)) {
    const state = createState(content, { seed: 2, mode: mode.id, playerRole: 'healer' });
    assert.equal(state.mode.id, mode.id);
    assert.ok(Array.isArray(mode.pauseOn));
  }
});

/* -------------------------------------------------------------- 3D */

test('sim coordinates and world metres round-trip', async () => {
  const { toWorld, toSim, CELL } = await import('../3d/scene.js');
  for (const p of [{ x: 0.5, y: 0.5 }, { x: 2.5, y: 2.5 }, { x: 4.5, y: 4.5 }, { x: 1.25, y: 3.75 }]) {
    const back = toSim(toWorld(p));
    assert.ok(Math.abs(back.x - p.x) < 1e-9 && Math.abs(back.y - p.y) < 1e-9, `${JSON.stringify(p)}`);
  }
  // The centre of the arena is the origin, and a cell is a few metres.
  const middle = toWorld({ x: 2.5, y: 2.5 });
  assert.equal(middle.x, 0);
  assert.equal(middle.z, 0);
  assert.equal(toWorld({ x: 3.5, y: 2.5 }).x, CELL);
});

test('every 3D game names a camera and a legal style', async () => {
  const { resolveStyle } = await import('../content/load.js');
  for (const game of Object.values(base.games)) {
    assert.ok(['first', 'shoulder', 'orbit', 'lock'].includes(game.camera), `${game.id} camera`);
    const picked = resolveStyle(base, game.style);
    assert.ok(picked.movement && picked.combat && picked.healing && picked.tanking);
    // The trinity is the whole point: no game may drop a role.
    assert.ok(game.blurb.length > 40, `${game.id} needs to say what it is`);
  }
  assert.deepEqual(Object.keys(base.games), ['wow', 'quake', 'overwatch', 'souls']);
});

test('the tick rate lives in exactly one place', () => {
  assert.equal(TICKS_PER_SECOND, 10);
  assert.equal(toTicks(2.5), 25);
});
