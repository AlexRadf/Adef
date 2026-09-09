#!/usr/bin/env node
// Headless balance runner. The sim never touches the DOM, so a thousand
// pulls cost a couple of seconds:
//
//   node sim.js --runs 1000
//   node sim.js --runs 200 --seed 7 --verbose

import { loadContent, applyScheme } from './content/load.js';
import { createState } from './engine/state.js';
import { step } from './engine/tick.js';
import { generateEncounter } from './engine/generate.js';
import { tuneEncounter } from './engine/tune.js';

function parseArgs(argv) {
  const args = { boss: 'chthon', party: 'default', scheme: 'raid', modifiers: '', runs: 100, seed: 1, verbose: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--verbose') args.verbose = true;
    else if (a.startsWith('--')) args[a.slice(2)] = argv[++i];
  }
  args.runs = Number(args.runs);
  args.seed = Number(args.seed);
  args.modifiers = args.modifiers ? String(args.modifiers).split(',').filter(Boolean) : [];
  return args;
}

export function runOnce(content, options) {
  const state = createState(content, { ...options, headless: true });
  while (!state.over) step(state, content, []);
  return state;
}

const args = parseArgs(process.argv.slice(2));
let content = applyScheme(await loadContent(), args.scheme);

// --boss random rolls a procedural encounter and tunes it first.
if (args.boss === 'random') {
  const tuned = tuneEncounter(content, generateEncounter(args.seed), { seed: args.seed });
  content = tuned.content;
  args.boss = tuned.encounter.boss.id;
  const b = tuned.encounter.boss;
  console.log(`\ngenerated #${b.seed}: ${b.name}, ${b.title}`);
  console.log(`  ${(b.hp / 1e6).toFixed(1)}M hp · enrage ${b.enrageAtSeconds}s · ${b.phases.length} phases · damage x${tuned.encounter.damageScale}`);
  for (const m of tuned.encounter.mechanics) console.log(`  · ${m}`);
  for (const l of tuned.report.log) console.log(`  [tuner] ${l}`);
}

const results = [];
const started = Date.now();
for (let i = 0; i < args.runs; i++) {
  const state = runOnce(content, {
    boss: args.boss,
    party: args.party,
    modifiers: args.modifiers,
    seed: args.seed + i * 7919,
  });
  const boss = state.units.find((u) => u.id === state.bossId);
  results.push({
    result: state.result,
    seconds: state.tick / 10,
    bossPct: (boss.hp / boss.maxHp) * 100,
    deaths: state.stats.deaths,
    damageBy: state.stats.damageBy,
    healBy: state.stats.healBy,
    interrupts: state.stats.interrupts,
  });
  if (args.verbose && i === 0) {
    for (const line of state.log.slice(-40)) console.log(`  [${(line.tick / 10).toFixed(1)}s] ${line.text}`);
  }
}

const kills = results.filter((r) => r.result === 'kill');
const median = (arr) => {
  if (!arr.length) return 0;
  const s = arr.slice().sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};
const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

const causes = {};
const deathsByUnit = {};
for (const r of results) {
  for (const d of r.deaths) {
    causes[d.cause] = (causes[d.cause] || 0) + 1;
    deathsByUnit[d.unit] = (deathsByUnit[d.unit] || 0) + 1;
  }
}
const totalDeaths = Object.values(causes).reduce((a, b) => a + b, 0) || 1;

const damageTotals = {};
for (const r of results) {
  for (const [id, amount] of Object.entries(r.damageBy)) {
    damageTotals[id] = (damageTotals[id] || 0) + amount;
  }
}

console.log(
  `\nboss ${args.boss} · party ${args.party} · ${content.scheme.name.toLowerCase()} controls` +
    `${args.modifiers.length ? ` · ${args.modifiers.join('+')}` : ''} · ${args.runs} runs · ${Date.now() - started}ms`
);
console.log(`win rate ${((kills.length / results.length) * 100).toFixed(1)}%`);
console.log(`median kill ${mmss(median(kills.map((r) => r.seconds)))}`);
console.log(
  `median wipe at ${median(results.filter((r) => r.result !== 'kill').map((r) => r.bossPct)).toFixed(1)}% boss hp` +
    ` · timeouts ${results.filter((r) => r.result === 'timeout').length}`
);
console.log(`avg deaths/pull ${(totalDeaths / results.length).toFixed(2)} · avg interrupts ${(results.reduce((s, r) => s + r.interrupts, 0) / results.length).toFixed(1)}`);

console.log('\ntop death causes');
for (const [cause, n] of Object.entries(causes).sort((a, b) => b[1] - a[1]).slice(0, 6)) {
  console.log(`  ${cause.padEnd(22)} ${((n / totalDeaths) * 100).toFixed(0)}%`);
}
console.log('\ndeaths by unit');
for (const [unit, n] of Object.entries(deathsByUnit).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${unit.padEnd(22)} ${(n / results.length).toFixed(2)} per pull`);
}
console.log('\naverage hps by source');
const healTotals = {};
for (const r of results) {
  for (const [id, amount] of Object.entries(r.healBy)) healTotals[id] = (healTotals[id] || 0) + amount;
}
for (const [id, total] of Object.entries(healTotals).sort((a, b) => b[1] - a[1]).slice(0, 4)) {
  console.log(`  ${id.padEnd(22)} ${Math.round(total / results.length / (results.reduce((s, r) => s + r.seconds, 0) / results.length)).toLocaleString('en-US')}`);
}

console.log('\naverage dps by source');
const avgSeconds = results.reduce((s, r) => s + r.seconds, 0) / results.length;
for (const [id, total] of Object.entries(damageTotals).sort((a, b) => b[1] - a[1]).slice(0, 8)) {
  console.log(`  ${id.padEnd(22)} ${Math.round(total / results.length / avgSeconds).toLocaleString('en-US')}`);
}
console.log('');
