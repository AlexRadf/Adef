// Plain node test runner: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadContent } from '../content/load.js';
import { createState } from '../engine/state.js';
import { step, snapshot } from '../engine/tick.js';
import { applyDamage, applyHeal, unitById } from '../engine/abilities.js';
import { applyAura } from '../engine/auras.js';
import { distance } from '../engine/grid.js';

const content = await loadContent();
const run = (seed) => {
  const state = createState(content, { seed, headless: true });
  while (!state.over) step(state, content, []);
  return state;
};

test('same seed produces an identical fight', () => {
  const a = run(42);
  const b = run(42);
  assert.equal(a.tick, b.tick);
  assert.equal(a.result, b.result);
  assert.equal(a.log.length, b.log.length);
  assert.deepEqual(a.stats.deaths, b.stats.deaths);
});

test('different seeds diverge', () => {
  const seeds = [1, 2, 3, 4, 5].map((s) => run(s).tick);
  assert.ok(new Set(seeds).size > 1);
});

test('the fight always terminates', () => {
  for (const seed of [11, 222, 3333]) {
    const state = run(seed);
    assert.ok(['kill', 'wipe', 'timeout'].includes(state.result));
    assert.ok(state.tick <= state.hardStopTick);
  }
});

test('damage modifiers stack through the choke point', () => {
  const state = createState(content, { seed: 1, headless: true });
  const tank = unitById(state, 'ranger');
  const before = tank.hp;
  // Vanguard Stance is 0.7 damage taken; the passive is applied at setup.
  applyDamage(state, 'chthon', 'ranger', 100000, 'lava');
  assert.equal(before - tank.hp, 70000);
  applyAura(state, content, 'ranger', tank, 'pentagram'); // x0.35
  const mid = tank.hp;
  applyDamage(state, 'chthon', 'ranger', 100000, 'lava');
  assert.equal(mid - tank.hp, Math.round(100000 * 0.7 * 0.35));
});

test('healing never overflows max hp', () => {
  const state = createState(content, { seed: 1, headless: true });
  const healer = unitById(state, 'crash');
  healer.hp = healer.maxHp - 1000;
  const healed = applyHeal(state, 'crash', 'crash', 500000);
  assert.equal(healed, 1000);
  assert.equal(healer.hp, healer.maxHp);
});

test('moving cancels a cast in progress', async () => {
  const { startAbility, orderMove } = await import('../engine/abilities.js');
  const state = createState(content, { seed: 1, headless: true });
  const dps = unitById(state, 'visor');
  const boss = unitById(state, 'chthon');
  startAbility(state, content, dps, 'rocket', boss);
  assert.equal(dps.castAbility, 'rocket');
  orderMove(state, dps, dps.cell === 0 ? 1 : 0);
  assert.equal(dps.castAbility, null);
});

test('snapshot is renderable and never leaks live units', () => {
  const state = createState(content, { seed: 5, headless: true });
  for (let i = 0; i < 200; i++) step(state, content, []);
  const view = snapshot(state, content);
  assert.equal(view.cells.length, 25);
  assert.equal(view.party.length, 4);
  assert.ok(view.boss.hp <= view.boss.maxHp);
  view.party[0].hp = -1;
  assert.ok(unitById(state, view.party[0].id).hp > -1);
});

test('chebyshev distance treats diagonals as one step', () => {
  assert.equal(distance(0, 6), 1);
  assert.equal(distance(0, 24), 4);
});
