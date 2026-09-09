// Deterministic RNG (mulberry32). The seed lives on GameState so a given
// seed + input sequence always replays identically -- this is what makes
// the headless balance runner in sim.js worth anything.

export function nextFloat(state) {
  state.rngSeed = (state.rngSeed + 0x6d2b79f5) | 0;
  let t = state.rngSeed;
  t = Math.imul(t ^ (t >>> 15), 1 | t);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export function nextInt(state, maxExclusive) {
  return Math.floor(nextFloat(state) * maxExclusive);
}

export function pick(state, arr) {
  if (!arr.length) return null;
  return arr[nextInt(state, arr.length)];
}

// Fisher-Yates on a copy. Used for "pick N distinct cells / players".
export function pickMany(state, arr, count) {
  const copy = arr.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = nextInt(state, i + 1);
    const tmp = copy[i];
    copy[i] = copy[j];
    copy[j] = tmp;
  }
  return copy.slice(0, count);
}
