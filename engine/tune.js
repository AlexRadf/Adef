// Auto-tuning. A generated encounter is playable in shape but arbitrary
// in size, so this fits it against the same headless sim the balance
// runner uses. Roughly 200 pulls, well under a second.
//
// Two knobs, deliberately kept apart, because conflating them is what
// makes naive auto-tuners oscillate:
//
//   boss hp       sets the KILL TIME, and is set exactly once from
//                 measured party dps. Never touched again -- raising hp
//                 to make a fight "harder" just pushes the kill past the
//                 enrage timer and falls off a cliff instead.
//   damage scale  sets the LETHALITY, and is binary-searched, because
//                 win rate falls monotonically as it rises.
//
// Before either, one pass looks for the specific unfairness a random
// fight usually has: a single mechanic doing most of the killing. That
// gets turned down on its own rather than nerfing everything around it.

import { createState } from './state.js';
import { step } from './tick.js';
import { withEncounter } from './generate.js';

const MEASURE_HP = 400000000; // unkillable, so a run just measures dps

export function tuneEncounter(content, encounter, options = {}) {
  const targetKill = options.targetKill ?? 210;
  const band = options.band ?? [0.32, 0.6];
  const runs = options.runs ?? 30;
  const seed = options.seed ?? 1;
  const onProgress = options.onProgress || (() => {});
  const log = [];
  const pristine = structuredClone({ abilities: encounter.abilities, auras: encounter.auras });
  const bossId = encounter.boss.id;
  const target = (band[0] + band[1]) / 2;

  /* 1. how hard does this party actually hit it ------------------- */

  onProgress('measuring the party against it');
  encounter.boss.hp = MEASURE_HP;
  let damage = 0;
  let seconds = 0;
  for (let i = 0; i < 5; i++) {
    const state = run(withEncounter(content, encounter), bossId, seed + i * 7919);
    const boss = state.units.find((u) => u.id === bossId);
    damage += boss.maxHp - boss.hp;
    seconds += state.tick / 10;
  }
  const dps = damage / seconds;
  encounter.boss.hp = Math.round((dps * targetKill) / 100000) * 100000;
  log.push(`party does ${Math.round(dps).toLocaleString('en-US')} dps → ${(encounter.boss.hp / 1e6).toFixed(1)}M hp for a ${targetKill}s kill`);

  /* 2. find the one mechanic doing all the killing ---------------- */

  for (let pass = 0; pass < 2; pass++) {
    onProgress('looking for anything unfair');
    const check = sample(withEncounter(content, encounter), bossId, 20, seed);
    const worst = check.causes[0];
    if (!worst || check.deaths === 0) break;
    const share = worst[1] / check.deaths;
    if (share < 0.55) break;
    if (!softenMechanic(encounter, worst[0], 0.78)) break;
    Object.assign(pristine, structuredClone({ abilities: encounter.abilities, auras: encounter.auras }));
    log.push(`${worst[0]} was ${Math.round(share * 100)}% of all deaths — turned that one down`);
  }

  /* 3. lethality, then kill time, then lethality again ------------ */
  //
  // The two interact: shortening the fight makes it easier, so a single
  // pass at either one leaves the other wrong. Search, correct, then
  // re-search in a narrow band around what the first search found.

  let best = search(0.4, 3, 5, 20, 'balancing');

  if (best.report.medianKill > 0) {
    const correction = Math.min(1.4, Math.max(0.65, targetKill / best.report.medianKill));
    if (Math.abs(correction - 1) > 0.05) {
      encounter.boss.hp = Math.round((encounter.boss.hp * correction) / 100000) * 100000;
      log.push(`ran ${best.report.medianKill.toFixed(0)}s long → ${(encounter.boss.hp / 1e6).toFixed(1)}M hp`);
      best = search(best.scale * 0.62, best.scale * 1.5, 3, runs, 'settling');
    }
  }

  applyScale(encounter, pristine, best.scale);
  encounter.damageScale = Number(best.scale.toFixed(3));
  log.push(
    `damage ×${encounter.damageScale} → ${(best.report.winRate * 100).toFixed(0)}% survive, killing it in ${best.report.medianKill.toFixed(0)}s`
  );

  function search(lo, hi, passes, sampleRuns, label) {
    let found = null;
    for (let pass = 0; pass < passes; pass++) {
      const scale = (lo + hi) / 2;
      onProgress(`${label} (${pass + 1}/${passes})`);
      applyScale(encounter, pristine, scale);
      const report = sample(withEncounter(content, encounter), bossId, sampleRuns, seed);
      if (!found || Math.abs(report.winRate - target) < Math.abs(found.report.winRate - target)) {
        found = { scale, report };
      }
      if (report.winRate > band[1]) lo = scale;
      else if (report.winRate < band[0]) hi = scale;
      else return { scale, report };
    }
    return found;
  }

  return {
    encounter,
    content: withEncounter(content, encounter),
    report: { ...best.report, log, dps: Math.round(dps) },
    accepted: best.report.winRate >= band[0] - 0.1 && best.report.winRate <= band[1] + 0.12,
  };
}

/* ------------------------------------------------------------ helpers */

function run(c, bossId, seed) {
  const state = createState(c, { seed, headless: true, boss: bossId });
  while (!state.over) step(state, c, []);
  return state;
}

function sample(c, bossId, runs, seed) {
  const kills = [];
  const causes = {};
  let deaths = 0;
  for (let i = 0; i < runs; i++) {
    const state = run(c, bossId, seed + i * 7919);
    if (state.result === 'kill') kills.push(state.tick / 10);
    for (const d of state.stats.deaths) {
      deaths++;
      causes[d.cause] = (causes[d.cause] || 0) + 1;
    }
  }
  const sorted = kills.slice().sort((a, b) => a - b);
  return {
    runs,
    winRate: kills.length / runs,
    medianKill: sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0,
    deaths,
    deathsPerPull: deaths / runs,
    causes: Object.entries(causes).sort((a, b) => b[1] - a[1]),
  };
}

// Every damage number in the encounter, always recomputed from the
// pristine copy so the search cannot compound its own rounding.
function applyScale(encounter, pristine, scale) {
  encounter.abilities = structuredClone(pristine.abilities);
  encounter.auras = structuredClone(pristine.auras);
  for (const ability of Object.values(encounter.abilities)) {
    for (const e of [...(ability.effects || []), ...(ability.onNoTarget || [])]) scaleEffect(e, scale);
  }
  for (const aura of Object.values(encounter.auras)) {
    for (const e of aura.onExpire || []) scaleEffect(e, scale);
    for (const e of aura.onDispel || []) scaleEffect(e, scale);
    if (aura.periodic?.effect) scaleEffect(aura.periodic.effect, scale);
  }
}

function scaleEffect(e, scale) {
  if (e.amount) e.amount = Math.round(e.amount * scale);
  if (e.damage) e.damage = Math.round(e.damage * scale);
  if (e.raidDamage) e.raidDamage = Math.round(e.raidDamage * scale);
}

// Turn down just the mechanic named in the death log.
function softenMechanic(encounter, causeName, factor) {
  let touched = false;
  for (const ability of Object.values(encounter.abilities)) {
    const owns =
      ability.name === causeName ||
      (ability.effects || []).some((e) => e.name === causeName) ||
      (ability.onNoTarget || []).some((e) => e.name === causeName);
    if (!owns) continue;
    for (const e of [...(ability.effects || []), ...(ability.onNoTarget || [])]) scaleEffect(e, factor);
    touched = true;
  }
  for (const aura of Object.values(encounter.auras)) {
    if (!String(causeName).startsWith(aura.name)) continue;
    for (const e of aura.onExpire || []) scaleEffect(e, factor);
    if (aura.periodic?.effect) scaleEffect(aura.periodic.effect, factor);
    touched = true;
  }
  return touched;
}
