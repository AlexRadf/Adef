// 5x5 arena. Chebyshev distance -- diagonals cost 1, melee is range 1.

export const GRID_W = 5;
export const GRID_H = 5;
export const CELL_COUNT = GRID_W * GRID_H;
export const MOVE_TICKS = 4; // 0.4s per cell, adjacent only

export const rowOf = (cell) => Math.floor(cell / GRID_W);
export const colOf = (cell) => cell % GRID_W;
export const cellAt = (row, col) => row * GRID_W + col;

export function distance(a, b) {
  return Math.max(Math.abs(rowOf(a) - rowOf(b)), Math.abs(colOf(a) - colOf(b)));
}

export function inBounds(row, col) {
  return row >= 0 && row < GRID_H && col >= 0 && col < GRID_W;
}

export function neighbours(cell) {
  const out = [];
  const r = rowOf(cell);
  const c = colOf(cell);
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (dr === 0 && dc === 0) continue;
      if (inBounds(r + dr, c + dc)) out.push(cellAt(r + dr, c + dc));
    }
  }
  return out;
}

// No obstacles, so the chebyshev-optimal step is just a sign step on both axes.
export function stepToward(from, to) {
  if (from === to) return from;
  const dr = Math.sign(rowOf(to) - rowOf(from));
  const dc = Math.sign(colOf(to) - colOf(from));
  return cellAt(rowOf(from) + dr, colOf(from) + dc);
}

export function allCells() {
  return Array.from({ length: CELL_COUNT }, (_, i) => i);
}
