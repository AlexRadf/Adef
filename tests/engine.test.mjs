// Plain node test runner, no dependencies: node --test tests/*.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadContent, applyGame, applyStyle, resolveStyle } from '../content/load.js';
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
  resolveAbility,
  setBlocking,
  spawnPickup,
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
import { addPoise, markUltimate, momentumMult } from '../engine/rules.js';
import { generateEncounter, withEncounter } from '../engine/generate.js';
import { tuneEncounter } from '../engine/tune.js';
import { buildDrillBoss, buildLobbyBoss, gauntletStage, applyCarry } from '../engine/scenario.js';

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

/* --------------------------------------------------- the four buttons */

test('each role builds, spends, and pays off into its own window', () => {
  const kits = {
    ranger: { build: 'shotgun', spend: 'superShotgun', payoff: 'grapple', ult: 'pentagram', window: 'rattled' },
    crash: { build: 'stimpack', spend: 'medkit', payoff: 'biosuit', ult: 'megahealth', window: 'regenerating' },
    visor: { build: 'nailgun', spend: 'rocket', payoff: 'lightning', ult: 'quad', window: 'cracked' },
  };
  for (const [id, kit] of Object.entries(kits)) {
    const member = content.parties.default.members.find((m) => m.id === id);
    assert.deepEqual(member.abilities, [kit.build, kit.spend, kit.payoff, kit.ult], `${id} kit`);
    assert.ok(member.ultimateGain, `${id} needs a way to charge its ultimate`);

    const build = content.abilities[kit.build];
    assert.equal(build.cost, 0, `${kit.build} is the builder: it should be free`);
    assert.ok(build.effects.some((e) => e.type === 'resource' && e.amount > 0), `${kit.build} must build`);

    const spend = content.abilities[kit.spend];
    assert.ok(spend.cost > 0, `${kit.spend} must cost something`);
    assert.ok(
      spend.effects.some((e) => e.type === 'aura' && e.aura === kit.window),
      `${kit.spend} must open the ${kit.window} window`
    );

    const payoff = content.abilities[kit.payoff];
    assert.ok(
      payoff.effects.some((e) => e.ifTargetAura === kit.window || e.requireTargetAura === kit.window),
      `${kit.payoff} must pay off inside ${kit.window}`
    );

    assert.equal(content.abilities[kit.ult].ultimate, true, `${kit.ult} is the ultimate`);
  }
});

test('an ultimate needs a full bar and empties it', () => {
  const { c, state } = fresh();
  const dps = unitById(state, 'visor');
  const boss = unitById(state, 'chthon');
  assert.equal(canUseAbility(state, c, dps, 'quad', dps), false, 'not charged');
  dps.ultimate = 100;
  assert.equal(canUseAbility(state, c, dps, 'quad', dps), true);
  startAbility(state, c, dps, 'quad', dps);
  assert.equal(dps.ultimate, 0, 'spending it empties the bar');
  assert.ok(dps.auras.some((a) => a.id === 'quadPickup'));
});

test('the ultimate charges from doing your own job', () => {
  const { state } = fresh();
  const dps = unitById(state, 'visor');
  const tank = unitById(state, 'ranger');
  applyDamage(state, 'visor', 'chthon', 500000, 'nail');
  assert.ok(dps.ultimate > 0, 'the slayer charges by dealing damage');
  assert.equal(tank.ultimate, 0, 'and not by watching');
  applyDamage(state, 'chthon', 'ranger', 500000, 'lava');
  assert.ok(tank.ultimate > 0, 'the vanguard charges by taking it');
});

test('a payoff is worth more inside its window', () => {
  const { c, state } = fresh();
  const dps = unitById(state, 'visor');
  const boss = unitById(state, 'chthon');
  const plain = boss.hp;
  startAbility(state, c, dps, 'lightning', boss);
  const without = plain - boss.hp;
  applyAura(state, c, 'visor', boss, 'cracked');
  dps.cooldowns.lightning = 0;
  const mid = boss.hp;
  startAbility(state, c, dps, 'lightning', boss);
  const within = mid - boss.hp;
  assert.ok(within > without * 1.8, `${within} should roughly double ${without}`);
});

/* ------------------------------------------------------ choke points */

test('damage modifiers stack through the choke point', () => {
  const { c, state } = fresh();
  const tank = unitById(state, 'ranger');
  const before = tank.hp;
  applyDamage(state, 'chthon', 'ranger', 100000, 'lava'); // Vanguard Stance is x0.7
  assert.equal(before - tank.hp, 70000);
  applyAura(state, c, 'ranger', tank, 'pentagram');
  // Read the mitigation out of the content rather than hardcoding it, so
  // rebalancing the ultimate does not "break" the choke point.
  const pent = c.auras.pentagram.modifiers[0].value;
  const mid = tank.hp;
  applyDamage(state, 'chthon', 'ranger', 100000, 'lava');
  assert.equal(mid - tank.hp, Math.round(100000 * 0.7 * pent));
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
  const boss = unitById(state, 'chthon');
  const before = boss.hp;
  startAbility(state, c, dps, 'nailgun', boss); // instant: fine while moving
  assert.ok(boss.hp < before, 'an instant ability still fires on the move');
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

test('the tuner lands encounters in a playable band, or admits it did not', () => {
  // The contract is not "every roll is good" -- some rolls are lopsided
  // and the tuner's job is to say so rather than ship them.
  let accepted = 0;
  for (const seed of [5, 12, 40, 77]) {
    const tuned = tuneEncounter(content, generateEncounter(seed), { seed, runs: 20 });
    assert.ok(tuned.encounter.boss.hp > 1e6, `#${seed} needs a real health pool`);
    assert.ok(tuned.report.log.length >= 2, `#${seed}: the tuner should say what it did`);
    if (tuned.accepted) {
      accepted++;
      assert.ok(tuned.report.winRate > 0.1 && tuned.report.winRate < 0.85, `#${seed} win ${tuned.report.winRate}`);
      assert.ok(tuned.report.medianKill > 120 && tuned.report.medianKill < 340, `#${seed} kill ${tuned.report.medianKill}s`);
    }
  }
  assert.ok(accepted >= 2, `only ${accepted} of 4 rolls were usable`);
});

test('the tuner measures what the party dealt, not what the boss is missing', () => {
  // A generated boss that heals a percentage of its pool used to make the
  // measurement read near zero, and fitted a boss that died in 48s.
  const tuned = tuneEncounter(content, generateEncounter(12), { seed: 12, runs: 12 });
  assert.ok(tuned.report.dps > 60000, `measured only ${tuned.report.dps} dps`);
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

/* ------------------------------------------- 3D controls and modes */

test('movement is camera-relative, and A is not D', async () => {
  const { cameraRelative } = await import('../3d/controls.js');
  const close = (a, b) => Math.abs(a - b) < 1e-9;
  for (const yaw of [0, 0.9, 2.2, -1.4, Math.PI]) {
    const forward = { x: -Math.sin(yaw), y: -Math.cos(yaw) };
    const right = { x: Math.cos(yaw), y: -Math.sin(yaw) };
    const w = cameraRelative({ x: 0, y: -1 }, yaw);
    const s = cameraRelative({ x: 0, y: 1 }, yaw);
    const d = cameraRelative({ x: 1, y: 0 }, yaw);
    const a = cameraRelative({ x: -1, y: 0 }, yaw);
    assert.ok(close(w.x, forward.x) && close(w.y, forward.y), `W at yaw ${yaw}`);
    assert.ok(close(s.x, -forward.x) && close(s.y, -forward.y), `S at yaw ${yaw}`);
    assert.ok(close(d.x, right.x) && close(d.y, right.y), `D at yaw ${yaw}`);
    assert.ok(close(a.x, -right.x) && close(a.y, -right.y), `A at yaw ${yaw}`);
  }
});

test('a cone only catches what is in front of the caster', async () => {
  const { c, state } = fresh();
  const boss = unitById(state, 'chthon');
  boss.pos = { x: 2.5, y: 2.5 };
  boss.facing = { x: 0, y: -1 }; // pointed "north"
  const infront = unitById(state, 'ranger');
  const behind = unitById(state, 'crash');
  infront.pos = { x: 2.5, y: 1.6 };
  behind.pos = { x: 2.5, y: 3.4 };
  const cone = { ...c.abilities.magmaCleave, coneArc: 130, coneRange: 2.6,
    effects: [{ type: 'damage', target: 'cone', amount: 50000, school: 'lava' }] };
  const withCone = { ...c, abilities: { ...c.abilities, magmaCleave: cone } };
  const hpBefore = { front: infront.hp, back: behind.hp };
  resolveAbility(state, withCone, boss, 'magmaCleave', infront);
  assert.ok(infront.hp < hpBefore.front, 'the one in front is hit');
  assert.equal(behind.hp, hpBefore.back, 'the one behind it is not');
});

test('a parry turns the blow aside and staggers what swung', () => {
  const c = applyStyle(base, 'souls');
  const state = createState(c, { seed: 1, mode: 'solo', playerRole: 'tank' });
  const tank = unitById(state, 'ranger');
  const boss = unitById(state, 'chthon');
  setBlocking(state, c, tank, true);
  state.content = c;
  const before = tank.hp;
  const dealt = applyDamage(state, 'chthon', 'ranger', 90000, 'lava');
  assert.equal(dealt, 0, 'a parried blow does nothing');
  assert.equal(tank.hp, before);
  assert.ok(boss.auras.some((a) => a.id === 'staggered'), 'and staggers the boss');

  // The window closes: a later hit in the same block is not a parry.
  state.tick += 40;
  applyDamage(state, 'chthon', 'ranger', 90000, 'lava');
  assert.ok(tank.hp < before, 'the second one lands');
});

test('a pickup is taken by standing on it, and comes back later', () => {
  const c = applyStyle(base, 'raid');
  const state = createState(c, { seed: 1, headless: true });
  const def = base.games.quake.pickups[0];
  spawnPickup(state, { ...def, firstAt: 0 }, def.at);
  const taker = state.units.find((u) => u.team === 'party');
  taker.pos = { x: def.at.x, y: def.at.y };
  step(state, c, []);
  assert.ok(taker.auras.some((a) => a.id === def.aura), 'standing on it takes it');
  assert.ok(state.pickups[0].readyAt > state.tick, 'and it goes away for a while');
});

test('the lobby dummy does nothing at all', () => {
  const dummy = buildLobbyBoss(content);
  assert.equal(dummy.phases[0].timeline.length, 0, 'no timeline means no attacks');
  const c = { ...content, bosses: { ...content.bosses, dummy } };
  const state = createState(c, { seed: 1, headless: true, boss: 'dummy', hardStopSeconds: 40 });
  while (!state.over) step(state, c, []);
  assert.equal(state.stats.deaths.length, 0, 'nobody dies in the lobby');
  assert.equal(state.result, 'timeout', 'and the dummy cannot be killed');
});

test('every game names a signature mechanic', () => {
  for (const game of Object.values(base.games)) {
    assert.ok(game.signature && game.signature.length > 30, `${game.id} needs a signature`);
    assert.ok(game.bots, `${game.id} should carry its measured win rate`);
  }
});

test('the tick rate lives in exactly one place', () => {
  assert.equal(TICKS_PER_SECOND, 10);
  assert.equal(toTicks(2.5), 25);
});

/* ------------------------------------------------------- mode rules */

test('a game assembles into style plus signature plus rules', async () => {
  for (const def of Object.values(base.games)) {
    const c = applyGame(base, def);
    assert.ok(c.style, `${def.id} has no style`);
    assert.deepEqual(c.rules, def.rules || {}, `${def.id} lost its rules`);
    const state = createState(c, { seed: 3, headless: true });
    assert.deepEqual(state.rules, def.rules || {});
    while (!state.over) step(state, c, []);
    assert.ok(state.tick > 100, `${def.id} ended instantly`);
  }
});

test('every game names a signature and at least two more differences', () => {
  for (const def of Object.values(base.games)) {
    assert.ok(def.signature, `${def.id} has no signature`);
    assert.ok((def.extras || []).length >= 2, `${def.id} has fewer than two extras`);
  }
});

test('momentum builds while you move and is gone the moment you stop', () => {
  const c = applyGame(base, base.games.quake);
  const state = createState(c, { seed: 9, playerRole: 'dps' });
  const me = unitById(state, state.activeId);
  // Weave, so the wall never stops us and momentum is what is measured.
  for (let i = 0; i < 40; i++) step(state, c, [{ type: 'moveDir', x: i % 8 < 4 ? 1 : -1, y: 0 }]);
  const wound = me.momentum;
  assert.equal(wound, c.rules.momentum.rampTicks, 'momentum never reached the cap');
  const fast = momentumMult(state, me);
  assert.ok(fast > 1.1, `momentum gave no speed: ${fast}`);
  step(state, c, [{ type: 'moveDir', x: 0, y: 0 }]);
  step(state, c, [{ type: 'moveDir', x: 0, y: 0 }]);
  assert.equal(me.momentum, 0, 'momentum survived standing still');
  assert.equal(momentumMult(state, me), 1);
});

test('a mode without momentum never gets any', () => {
  const c = applyGame(base, base.games.wow);
  const state = createState(c, { seed: 9, playerRole: 'dps' });
  const me = unitById(state, state.activeId);
  for (let i = 0; i < 40; i++) step(state, c, [{ type: 'moveDir', x: i % 8 < 4 ? 1 : -1, y: 0 }]);
  assert.equal(momentumMult(state, me), 1);
});

test('poise breaks the boss guard, and a parry is worth a lot of it', () => {
  const c = applyGame(base, base.games.souls);
  const state = createState(c, { seed: 4, playerRole: 'tank' });
  state.content = c;
  const boss = unitById(state, state.bossId);
  const me = unitById(state, state.activeId);
  const rule = c.rules.poise;

  addPoise(state, boss, rule.max - 1);
  assert.ok(!boss.auras.some((a) => a.id === 'staggered'), 'staggered early');
  addPoise(state, boss, 1);
  assert.ok(boss.auras.some((a) => a.id === 'staggered'), 'the guard never broke');
  assert.equal(boss.poise, 0, 'poise did not reset on the break');

  // A parry pays out several ordinary hits' worth.
  assert.ok(rule.fromParry > rule.fromHit * 5, 'a parry is not worth parrying for');
  assert.ok(rule.flankMult > 1, 'hitting it from behind is worth nothing');
  assert.ok(me.maxStamina > 0);
});

test('poise only exists in the mode that asks for it', () => {
  const c = applyGame(base, base.games.quake);
  const state = createState(c, { seed: 4 });
  const boss = unitById(state, state.bossId);
  addPoise(state, boss, 9999);
  assert.equal(boss.poise || 0, 0);
  assert.ok(!boss.auras.some((a) => a.id === 'staggered'));
});

test('swinging costs stamina where the mode says it does', () => {
  const souls = applyGame(base, base.games.souls);
  const state = createState(souls, { seed: 6, playerRole: 'dps' });
  const me = unitById(state, state.activeId);
  const before = me.stamina;
  startAbility(state, souls, me, me.abilities[0], unitById(state, state.bossId));
  assert.ok(me.stamina < before, 'a swing was free');

  const quake = applyGame(base, base.games.quake);
  const other = createState(quake, { seed: 6, playerRole: 'dps' });
  const them = unitById(other, other.activeId);
  const start = them.stamina;
  startAbility(other, quake, them, them.abilities[0], unitById(other, other.bossId));
  assert.equal(them.stamina, start, 'a mode without the rule charged for a swing');
});

test('a held primary overheats, locks the kit, and vents', () => {
  const c = applyGame(base, base.games.overwatch);
  const state = createState(c, { seed: 2, playerRole: 'dps' });
  const me = unitById(state, state.activeId);
  const boss = unitById(state, state.bossId);
  const primary = me.abilities[0];
  const rule = c.rules.overheat;

  for (let i = 0; i < Math.ceil(rule.max / rule.per); i++) {
    me.cooldowns = {};
    me.gcdUntil = 0;
    startAbility(state, c, me, primary, boss);
  }
  assert.ok(me.heatLockUntil > state.tick, 'the weapon never redlined');
  me.cooldowns = {};
  me.gcdUntil = 0;
  assert.ok(!canUseAbility(state, c, me, primary, boss), 'redlined and still firing');
  // The ultimate is the one thing venting leaves you.
  const ultId = me.abilities[3];
  me.ultimate = 100;
  assert.ok(canUseAbility(state, c, me, ultId, boss), 'venting locked the ultimate too');

  while (state.tick <= me.heatLockUntil) step(state, c, []);
  me.cooldowns = {};
  me.gcdUntil = 0;
  assert.equal(me.heat, 0, 'venting did not empty the heat');
  assert.ok(canUseAbility(state, c, me, primary, boss), 'never came back from venting');
});

test('two ultimates in the same window overload the party', () => {
  const c = applyGame(base, base.games.overwatch);
  const state = createState(c, { seed: 8 });
  state.content = c;
  const party = state.units.filter((u) => u.team === 'party');
  const aura = c.rules.ultCombo.aura;

  markUltimate(state, party[0]);
  step(state, c, []);
  assert.ok(!party[1].auras.some((a) => a.id === aura), 'one ultimate overloaded the party');
  markUltimate(state, party[1]);
  step(state, c, []);
  for (const u of party) {
    assert.ok(u.auras.some((a) => a.id === aura), `${u.name} missed the combo`);
  }
});

/* -------------------------------------------------- practice range */

test('training armour stops the party dying without touching the boss', () => {
  const c = applyGame(base, base.games.wow);
  const state = createState(c, { seed: 11, practice: { invulnerable: true } });
  state.content = c;
  const me = state.units.find((u) => u.team === 'party');
  const boss = unitById(state, state.bossId);
  assert.equal(applyDamage(state, boss.id, me, 5e6, 'lava', { name: 'test' }), 0);
  assert.equal(me.hp, me.maxHp);
  assert.ok(applyDamage(state, me.id, boss, 1000, 'physical', { name: 'test' }) > 0);
});

test('infinite resources and no cooldowns hold themselves open every tick', () => {
  const c = applyGame(base, base.games.souls);
  const state = createState(c, { seed: 12, practice: { infiniteResource: true, noCooldowns: true } });
  const me = unitById(state, state.activeId); // the player: no bot to spend it again
  me.resource = 0;
  me.stamina = 0;
  me.cooldowns = { rocket: 9999 };
  me.gcdUntil = 9999;
  step(state, c, []);
  assert.equal(me.resource, me.maxResource);
  assert.equal(me.stamina, me.maxStamina);
  assert.deepEqual(me.cooldowns, {});
  assert.equal(me.gcdUntil, 0);
});

test('the practice switches are off unless the range turns them on', () => {
  const c = applyGame(base, base.games.wow);
  const state = createState(c, { seed: 13 });
  state.content = c;
  const me = state.units.find((u) => u.team === 'party');
  assert.deepEqual(state.practice, {});
  assert.ok(applyDamage(state, state.bossId, me, 1000, 'lava', { name: 'test' }) > 0);
});

test('every drill the practice range offers builds and runs', () => {
  const c = applyGame(base, base.games.souls);
  for (const id of Object.keys(base.drills)) {
    const boss = buildDrillBoss(c, id);
    const withDrill = { ...c, bosses: { ...c.bosses, [boss.id]: boss } };
    const state = createState(withDrill, { seed: 5, boss: boss.id, hardStopSeconds: 40, headless: true });
    while (!state.over) step(state, withDrill, []);
    assert.ok(state.tick > 50, `drill ${id} ended immediately`);
  }
});

/* ------------------------------------------------------ hud feeds */

test('the snapshot carries what the hud needs to teach a fight', () => {
  const c = applyGame(base, base.games.wow);
  const state = createState(c, { seed: 14 });
  for (let i = 0; i < 60; i++) step(state, c, []);
  const view = snapshot(state, c);
  assert.ok(Array.isArray(view.upcoming));
  assert.ok(view.upcoming.length, 'nothing is ever coming');
  for (const u of view.upcoming) {
    assert.equal(typeof u.name, 'string');
    assert.ok(u.in >= 0);
  }
  assert.ok(Array.isArray(view.feed) && view.feed.length, 'the log feed is empty');
  assert.equal(view.rules.threatMeter, true);
  assert.ok(view.boss.threat, 'no threat table to draw a meter from');
});

test('damage and healing surface as events a renderer can float', () => {
  const c = applyGame(base, base.games.wow);
  const state = createState(c, { seed: 15 });
  state.content = c;
  state.events = [];
  const me = state.units.find((u) => u.team === 'party');
  const boss = unitById(state, state.bossId);
  applyDamage(state, me.id, boss, 5000, 'physical', { name: 'test' });
  me.hp = me.maxHp - 5000;
  applyHeal(state, me.id, me, 3000, { name: 'test' });
  const hit = state.events.find((e) => e.kind === 'hit');
  const heal = state.events.find((e) => e.kind === 'healed');
  assert.equal(hit.unitId, boss.id);
  assert.equal(hit.amount, 5000);
  assert.equal(heal.unitId, me.id);
  assert.equal(heal.amount, 3000);
});

test('every element the 3D build reaches for exists in its page', async () => {
  const { readFileSync, readdirSync } = await import('node:fs');
  const page = readFileSync(new URL('../3d/index.html', import.meta.url), 'utf8');
  const ids = new Set([...page.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  for (const file of readdirSync(new URL('../3d/', import.meta.url))) {
    if (!file.endsWith('.js')) continue;
    const src = readFileSync(new URL(`../3d/${file}`, import.meta.url), 'utf8');
    for (const m of src.matchAll(/getElementById\('([^']+)'\)/g)) {
      assert.ok(ids.has(m[1]), `3d/${file} reaches for #${m[1]}, which the page does not have`);
    }
  }
});

test('the camera boom shortens at a wall rather than climbing over your head', async () => {
  const { fitInside, LIMIT } = await import('../3d/camera.js');
  // Middle of the room: the boom gets everything it asked for.
  assert.equal(fitInside({ x: 0, z: 0 }, { x: 0, z: 1 }, 4), 4);
  // Backed into a corner: it gets only what is left before the wall.
  const corner = { x: LIMIT - 1, z: -(LIMIT - 1) };
  const away = { x: Math.SQRT1_2, z: -Math.SQRT1_2 };
  const fitted = fitInside(corner, away, 8);
  assert.ok(fitted > 0 && fitted < 2, `boom should be short in a corner, got ${fitted}`);
  const landed = { x: corner.x + away.x * fitted, z: corner.z + away.z * fitted };
  assert.ok(Math.abs(landed.x) <= LIMIT + 1e-9 && Math.abs(landed.z) <= LIMIT + 1e-9, 'boom left the room');
  // Never negative, however far outside the caller already is.
  assert.equal(fitInside({ x: LIMIT + 5, z: 0 }, { x: 1, z: 0 }, 4), 0);
});
