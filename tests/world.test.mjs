// The hub and the raids: map compiling, collision, raid content and
// progression. No browser needed -- none of this touches the DOM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { parseMap, buildBrush, pointInBrush, textureAxes } from '../tools/mapfile.mjs';
import { createCollider, createMover, HALF } from '../3d/collide.js';
import { loadContent, applyStyle } from '../content/load.js';
import { createState } from '../engine/state.js';
import { step } from '../engine/tick.js';
import { createProgress } from '../3d/progress.js';

const BOX = (x0, y0, z0, x1, y1, z1, tex = 'wall') => `{
( ${x0} ${y0} ${z0} ) ( ${x0} ${y0 + 1} ${z0} ) ( ${x0} ${y0} ${z0 + 1} ) ${tex} 0 0 0 1 1
( ${x0} ${y0} ${z0} ) ( ${x0} ${y0} ${z0 + 1} ) ( ${x0 + 1} ${y0} ${z0} ) ${tex} 0 0 0 1 1
( ${x0} ${y0} ${z0} ) ( ${x0 + 1} ${y0} ${z0} ) ( ${x0} ${y0 + 1} ${z0} ) ${tex} 0 0 0 1 1
( ${x1} ${y1} ${z1} ) ( ${x1} ${y1 + 1} ${z1} ) ( ${x1 + 1} ${y1} ${z1} ) ${tex} 0 0 0 1 1
( ${x1} ${y1} ${z1} ) ( ${x1 + 1} ${y1} ${z1} ) ( ${x1} ${y1} ${z1 + 1} ) ${tex} 0 0 0 1 1
( ${x1} ${y1} ${z1} ) ( ${x1} ${y1} ${z1 + 1} ) ( ${x1} ${y1 + 1} ${z1} ) ${tex} 0 0 0 1 1
}`;

test('a .map brush compiles to a closed box with outward planes', () => {
  const [world] = parseMap(`{ "classname" "worldspawn" ${BOX(0, 0, 0, 64, 32, 16)} }`);
  assert.equal(world.props.classname, 'worldspawn');
  const brush = buildBrush(world.brushes[0]);
  assert.equal(brush.polys.length, 6);
  assert.deepEqual(brush.mins, [0, 0, 0]);
  assert.deepEqual(brush.maxs, [64, 32, 16]);
  assert.ok(pointInBrush(brush, [32, 16, 8]));
  assert.ok(!pointInBrush(brush, [32, 16, 20]), 'planes point inward');
});

test('texture names starting with { are read whole (alpha masks)', () => {
  const ents = parseMap(`{ "classname" "worldspawn" ${BOX(0, 0, 0, 16, 16, 16, '{fence')} }`);
  assert.equal(ents[0].brushes[0][0].tex, '{fence');
});

test('Valve 220 texture axes are taken as written', () => {
  const [w] = parseMap(`{ "classname" "worldspawn"
{
( 0 0 0 ) ( 0 1 0 ) ( 0 0 1 ) t [ 0 1 0 8 ] [ 0 0 -1 4 ] 0 0.5 2
( 0 0 0 ) ( 0 0 1 ) ( 1 0 0 ) t [ 1 0 0 0 ] [ 0 0 -1 0 ] 0 1 1
( 0 0 0 ) ( 1 0 0 ) ( 0 1 0 ) t [ 1 0 0 0 ] [ 0 -1 0 0 ] 0 1 1
( 8 8 8 ) ( 8 9 8 ) ( 9 8 8 ) t [ 1 0 0 0 ] [ 0 -1 0 0 ] 0 1 1
( 8 8 8 ) ( 9 8 8 ) ( 8 8 9 ) t [ 1 0 0 0 ] [ 0 0 -1 0 ] 0 1 1
( 8 8 8 ) ( 8 8 9 ) ( 8 9 8 ) t [ 0 1 0 0 ] [ 0 0 -1 0 ] 0 1 1
}
}`);
  const ax = textureAxes(w.brushes[0][0], [-1, 0, 0]);
  assert.deepEqual(ax.u, [0, 1, 0]);
  assert.equal(ax.offU, 8);
  assert.equal(ax.su, 0.5);
  assert.equal(ax.sv, 2);
});

// A floor slab and a 16-unit step, in collider form (metres, y up).
function room() {
  const planes = [];
  const hulls = [];
  const add = (min, max) => {
    const first = planes.length / 4;
    planes.push(1, 0, 0, max[0], -1, 0, 0, -min[0], 0, 1, 0, max[1], 0, -1, 0, -min[1], 0, 0, 1, max[2], 0, 0, -1, -min[2]);
    hulls.push(first, 6, ...min, ...max);
  };
  add([-20, -1, -20], [20, 0, 20]); // floor
  add([2, 0, -20], [20, 0.5, 20]); // a step, 16 units high
  add([8, 0, -20], [9, 6, 20]); // a wall
  return createCollider(new Float32Array(planes), new Float32Array(hulls));
}

test('a box trace stops at the floor and reports its normal', () => {
  const c = room();
  const tr = c.trace({ x: 0, y: 3, z: 0 }, { x: 0, y: -3, z: 0 }, HALF);
  assert.ok(tr.fraction > 0 && tr.fraction < 1);
  assert.deepEqual(tr.normal, [0, 1, 0]);
  const restY = 3 - 6 * tr.fraction - HALF[1];
  assert.ok(Math.abs(restY) < 0.01, `feet land on y=0, got ${restY}`);
});

test('the mover walks up a step and is stopped by a wall', () => {
  const c = room();
  const m = createMover(c, { x: 0, y: 0, z: 0 });
  for (let i = 0; i < 120; i++) m.move({ x: 6, z: 0 }, 1 / 60, false);
  const p = m.body.pos;
  assert.ok(p.y > 0.45, `climbed the step (y=${p.y.toFixed(2)})`);
  assert.ok(p.x < 8 - HALF[0] + 0.01, `stopped at the wall (x=${p.x.toFixed(2)})`);
  assert.ok(p.x > 7, 'got all the way to it');
});

test('the mover jumps and lands', () => {
  const m = createMover(room(), { x: -5, y: 0, z: 0 });
  m.move({ x: 0, z: 0 }, 1 / 60, false);
  m.move({ x: 0, z: 0 }, 1 / 60, true);
  let top = 0;
  for (let i = 0; i < 120; i++) {
    m.move({ x: 0, z: 0 }, 1 / 60, false);
    top = Math.max(top, m.body.pos.y);
  }
  assert.ok(top > 1, `jumped (${top.toFixed(2)} m)`);
  assert.ok(Math.abs(m.body.pos.y) < 0.02 && m.body.onGround, 'landed');
});

test('a moved level moves its collision with it', () => {
  const c = room();
  c.setOffset({ x: 100, y: 10, z: 0 });
  const tr = c.trace({ x: 100, y: 13, z: 0 }, { x: 100, y: 7, z: 0 }, HALF);
  assert.ok(tr.fraction < 1);
  assert.equal(c.trace({ x: 0, y: 3, z: 0 }, { x: 0, y: -3, z: 0 }, HALF).fraction, 1);
});

const base = await loadContent();

test('every raid encounter names a boss, a baked level and an arena in it', () => {
  const raids = Object.values(base.raids);
  assert.ok(raids.length >= 4);
  for (const raid of raids) {
    for (const enc of raid.encounters) {
      assert.ok(base.bosses[enc.boss], `${raid.id}: boss ${enc.boss}`);
      const meta = new URL(`../assets/librequake/maps/${enc.map}.json`, import.meta.url);
      assert.ok(existsSync(meta), `${raid.id}: level ${enc.map} is imported`);
      const level = JSON.parse(readFileSync(meta, 'utf8'));
      assert.ok(level.arenas[enc.arena], `${raid.id}: ${enc.map} has arena ${enc.arena}`);
      for (const ph of base.bosses[enc.boss].phases) {
        for (const t of ph.timeline) assert.ok(base.abilities[t.ability], `${enc.boss}: ability ${t.ability}`);
      }
    }
  }
});

test('the hub has a slipgate for every raid', () => {
  const hub = JSON.parse(readFileSync(new URL('../assets/librequake/maps/hub.json', import.meta.url), 'utf8'));
  const portals = hub.triggers.filter((t) => t.cls === 'trigger_changelevel').map((t) => t.map);
  for (const raid of Object.values(base.raids)) assert.ok(portals.includes(raid.portal), `${raid.id} via ${raid.portal}`);
});

test('generated raid bosses do not share ability ids', () => {
  const seen = new Map();
  for (const raid of Object.values(base.raids)) {
    for (const enc of raid.encounters) {
      if (enc.boss === 'chthon') continue;
      for (const ph of base.bosses[enc.boss].phases) {
        for (const t of ph.timeline) {
          const owner = seen.get(t.ability);
          assert.ok(!owner || owner === enc.boss, `${t.ability} used by ${owner} and ${enc.boss}`);
          seen.set(t.ability, enc.boss);
        }
      }
    }
  }
});

test('every raid boss can be pulled, killed and wiped to, headlessly', () => {
  const content = applyStyle(base, 'raid');
  for (const raid of Object.values(base.raids)) {
    for (const enc of raid.encounters) {
      const state = createState(content, { seed: 3, headless: true, boss: enc.boss });
      while (!state.over) step(state, content, []);
      assert.ok(['kill', 'wipe'].includes(state.result), `${enc.boss} ended in ${state.result}`);
    }
  }
});

test('progression: loot once a week per boss, power from gear, capped bonus', () => {
  const p = createProgress();
  p.reset();
  const raid = base.raids.core;
  const stats = { damage: 5e6, healing: 0, interrupts: 2, died: false };
  const first = p.recordEncounter({ raid, index: 0, won: true, role: 'dps', game: 'wow', heroic: false, stats });
  assert.equal(first.loot.length, 1);
  assert.ok(first.firstThisWeek);
  const again = p.recordEncounter({ raid, index: 0, won: true, role: 'dps', game: 'wow', heroic: false, stats });
  assert.equal(again.loot.length, 0, 'locked out until the weekly reset');
  assert.ok(again.shards > 0, 'still worth shards');
  const wipe = p.recordEncounter({ raid, index: 1, won: false, role: 'dps', game: 'wow', heroic: false, stats });
  assert.equal(wipe.loot.length, 0);
  p.equip(0);
  assert.ok(p.power() >= 5);
  for (const slot of ['weapon', 'armour', 'sigil']) p.data.gear[slot].power = 999;
  const aura = p.powerAura();
  const dmg = aura.modifiers.find((m) => m.stat === 'damageDealt').value;
  assert.ok(dmg <= 1.15 + 1e-9, 'the power bonus is capped at 15%');
});
