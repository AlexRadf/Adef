// The headless runner, in a worker. Identical sim, identical seeds, same
// numbers as `node sim.js` -- which is only possible because the sim
// never touches the DOM.

import { loadContent, applyStyle } from '../content/load.js';
import { createState } from '../engine/state.js';
import { step } from '../engine/tick.js';
import { generateEncounter } from '../engine/generate.js';
import { tuneEncounter } from '../engine/tune.js';

let content = null;

self.onmessage = async (event) => {
  const { type = 'batch', style = 'raid', modifiers = [], ai, runs = 200, seed = 1 } = event.data;
  if (!content) content = await loadContent();
  const c = { ...applyStyle(content, style), ai: ai || content.ai };

  // Roll a new encounter and tune it against this very sim before
  // anybody has to play it.
  if (type === 'generate') {
    const tuned = tuneEncounter(c, generateEncounter(seed), {
      seed,
      onProgress: (stage) => self.postMessage({ type: 'progress', stage }),
    });
    self.postMessage({
      type: 'encounter',
      encounter: tuned.encounter,
      accepted: tuned.accepted,
      report: {
        winRate: tuned.report.winRate,
        medianKill: tuned.report.medianKill,
        deathsPerPull: tuned.report.deathsPerPull,
        causes: tuned.report.causes.slice(0, 3),
        log: tuned.report.log,
      },
    });
    return;
  }

  const kills = [];
  const causes = {};
  const deathsByUnit = {};
  let deaths = 0;
  let wipes = 0;

  for (let i = 0; i < runs; i++) {
    const state = createState(c, { seed: seed + i * 7919, headless: true, modifiers, boss: event.data.boss });
    while (!state.over) step(state, c, []);
    if (state.result === 'kill') kills.push(state.tick / 10);
    else wipes++;
    for (const d of state.stats.deaths) {
      deaths++;
      causes[d.cause] = (causes[d.cause] || 0) + 1;
      deathsByUnit[d.unit] = (deathsByUnit[d.unit] || 0) + 1;
    }
    if (i % 10 === 9) self.postMessage({ type: 'progress', done: i + 1, runs });
  }

  const sorted = kills.slice().sort((a, b) => a - b);
  self.postMessage({
    type: 'done',
    runs,
    winRate: (kills.length / runs) * 100,
    medianKill: sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0,
    deathsPerPull: deaths / runs,
    wipes,
    causes: Object.entries(causes).sort((a, b) => b[1] - a[1]).slice(0, 5),
    deathsByUnit: Object.entries(deathsByUnit).sort((a, b) => b[1] - a[1]),
  });
};
