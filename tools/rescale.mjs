#!/usr/bin/env node
// Nudge one raid boss's lethality after the fact, and measure it again.
//
//   node tools/rescale.mjs citadel_1 1.25        # 25% more damage, then 200 pulls
//
// The tuner fits each boss on ~40-pull samples, which is noisy; this is
// the 200-pull correction. Win rate falls monotonically with damage, so
// one or two nudges land a boss in its band.

import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const [bossId, factorArg, runs = '200'] = process.argv.slice(2);
const factor = Number(factorArg);
if (!bossId || !(factor > 0)) {
  console.error('usage: node tools/rescale.mjs <bossId> <factor> [runs]');
  process.exit(1);
}
const raidId = bossId.split('_')[0];
const file = new URL(`../content/raids/${raidId}.json`, import.meta.url);
const raid = JSON.parse(readFileSync(file, 'utf8'));
const enc = raid.encounters.find((e) => e.boss === bossId);
if (!enc || !enc.def) throw new Error(`${bossId} is not a generated boss in ${raidId}`);

const scale = (v) => {
  if (Array.isArray(v)) return v.forEach(scale);
  if (!v || typeof v !== 'object') return;
  for (const key of ['amount', 'damage', 'raidDamage']) {
    // healPct and resource effects carry amounts too; only damage scales.
    if (typeof v[key] === 'number' && (key !== 'amount' || v.type === 'damage')) v[key] = Math.round(v[key] * factor);
  }
  for (const x of Object.values(v)) scale(x);
};
scale(enc.abilities);
scale(enc.auras);
enc.damageScale = Number(((enc.damageScale || 1) * factor).toFixed(3));
writeFileSync(file, JSON.stringify(raid, null, 1));

const sim = fileURLToPath(new URL('../sim.js', import.meta.url));
const out = execFileSync('node', [sim, '--boss', bossId, '--runs', runs, '--seed', '11'], { encoding: 'utf8' });
const win = out.match(/win rate ([\d.]+)%/)[1];
enc.botsWin = Math.round(Number(win));
writeFileSync(file, JSON.stringify(raid, null, 1));
console.log(`${bossId} damage x${factor} -> ${win}% over ${runs} pulls, ${out.match(/median kill (\S+)/)[1]} median kill`);
