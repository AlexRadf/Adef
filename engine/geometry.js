// Arena space. Positions are continuous {x, y} coordinates in cells, not
// grid indices -- the 5x5 tiling survives only as a telegraph shape and a
// way to draw the floor.
//
// PORTING NOTE: `distance` is the single function that decides what
// "range 1" means. Swap it (and add a z to the vectors) and every
// mechanic in /content keeps working unchanged.

import { TICKS_PER_SECOND } from './clock.js';

export const ARENA_SIZE = 5; // cells across
export const CELL_COUNT = ARENA_SIZE * ARENA_SIZE;
export const TILE_HALF = 0.5;

export const vec = (x, y) => ({ x, y });
export const clonePos = (p) => ({ x: p.x, y: p.y });

// Chebyshev: a diagonal costs the same as a straight step, so range is a
// square. Euclidean is one line away if a port wants round range.
export function distance(a, b) {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

export function euclidean(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
export const scale = (a, k) => ({ x: a.x * k, y: a.y * k });

export function normalize(v) {
  const len = Math.hypot(v.x, v.y);
  return len < 1e-6 ? { x: 0, y: 0 } : { x: v.x / len, y: v.y / len };
}

export function clampToArena(p) {
  const pad = 0.08;
  return {
    x: Math.min(ARENA_SIZE - pad, Math.max(pad, p.x)),
    y: Math.min(ARENA_SIZE - pad, Math.max(pad, p.y)),
  };
}

/* --------------------------------------------- tiles: telegraphs + floor */

export const cellOf = (p) => {
  const col = Math.min(ARENA_SIZE - 1, Math.max(0, Math.floor(p.x)));
  const row = Math.min(ARENA_SIZE - 1, Math.max(0, Math.floor(p.y)));
  return row * ARENA_SIZE + col;
};

export const cellCenter = (index) => ({
  x: (index % ARENA_SIZE) + 0.5,
  y: Math.floor(index / ARENA_SIZE) + 0.5,
});

export const allCells = () => Array.from({ length: CELL_COUNT }, (_, i) => i);

// An area effect is a position plus a half-extent, not a cell reference.
export function contains(area, pos) {
  return Math.abs(pos.x - area.x) <= area.half && Math.abs(pos.y - area.y) <= area.half;
}

/* ------------------------------------------------------------- movement */

export function stepPerTick(speedCellsPerSecond) {
  return speedCellsPerSecond / TICKS_PER_SECOND;
}

export function moveToward(pos, target, step) {
  const dx = target.x - pos.x;
  const dy = target.y - pos.y;
  const d = Math.hypot(dx, dy);
  if (d <= step || d < 1e-6) return { pos: clonePos(target), arrived: true };
  return { pos: { x: pos.x + (dx / d) * step, y: pos.y + (dy / d) * step }, arrived: false };
}

// Is `point` inside a cone of `arcDegrees` centred on `facing`? This is
// what makes lock-on combat positional: you have to be pointed at it.
export function withinArc(from, facing, point, arcDegrees) {
  if (!arcDegrees) return true;
  const to = normalize(sub(point, from));
  const f = normalize(facing);
  if ((!f.x && !f.y) || (!to.x && !to.y)) return true;
  const dot = Math.max(-1, Math.min(1, f.x * to.x + f.y * to.y));
  return (Math.acos(dot) * 180) / Math.PI <= arcDegrees / 2;
}

// Attacking something from behind: the defender's facing points away.
export function isBehind(attackerPos, defender) {
  const toAttacker = normalize(sub(attackerPos, defender.pos));
  const f = normalize(defender.facing);
  if ((!f.x && !f.y) || (!toAttacker.x && !toAttacker.y)) return false;
  return f.x * toAttacker.x + f.y * toAttacker.y < -0.25;
}

export function moveAlong(pos, dir, step) {
  const n = normalize(dir);
  return clampToArena({ x: pos.x + n.x * step, y: pos.y + n.y * step });
}
