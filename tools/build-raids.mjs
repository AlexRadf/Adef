#!/usr/bin/env node
// Builds the raids: each one a LibreQuake level and a string of bosses
// fought in the arenas the importer found inside it.
//
//   node tools/build-raids.mjs            # every raid
//   node tools/build-raids.mjs core       # just one
//
// Bosses are rolled by engine/generate.js from a seed, held to the
// theme the level asks for, renamed, and then fitted by engine/tune.js
// against the same headless sim the balance runner uses -- so every
// boss in every raid ships with a measured win rate rather than a guess.
// Output is plain content JSON in content/raids/, read by content/load.js.

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadContent, applyStyle } from '../content/load.js';
import { generateEncounter } from '../engine/generate.js';
import { tuneEncounter } from '../engine/tune.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', 'content', 'raids');

// One sentence of lore each, a level, a portal in the hub, and bosses.
// `band` is the bot win rate an encounter is tuned into: openers are
// gentler than finales, the way a raid's difficulty should climb.
export const RAIDS = [
  {
    id: 'core',
    name: 'The Gloomliths',
    map: 'lq_e1m5',
    portal: 'lq_e1m1',
    tier: 1,
    power: 10,
    tagline: 'Standing stones over a lava wound. Something under them is still awake.',
    encounters: [
      { name: 'Cindermaw', title: 'Furnace Warden', theme: 'lava', arena: 1, band: [0.48, 0.7] },
      { boss: 'chthon', arena: 0 },
    ],
  },
  {
    id: 'pyre',
    name: 'The Pyre of Flesh',
    map: 'lq_e2m3',
    portal: 'lq_e2m1',
    tier: 2,
    power: 20,
    tagline: 'Two levels, one infection. The corpse army marches; the parasites wait at the end of the slipgate.',
    encounters: [
      { name: 'The Rot Choir', title: 'Voices of the Pyre', theme: 'plague', arena: 0, band: [0.45, 0.66] },
      { name: 'Mother Maggot', title: 'She Who Feeds the Fire', theme: 'plague', map: 'lq_e2m5', arena: 0, band: [0.34, 0.55] },
    ],
  },
  {
    id: 'corpse',
    name: 'Holy Bloated Corpse',
    map: 'lq_e3m6',
    portal: 'lq_e3m1',
    tier: 3,
    power: 30,
    tagline: 'A cathedral that sank into the earth and kept praying on the way down.',
    encounters: [
      { name: 'The Drowned Deacon', title: 'Last of the Choir', theme: 'void', arena: 2, band: [0.42, 0.64] },
      { name: 'Saint Bloat', title: 'The Unburied', theme: 'plague', arena: 0, band: [0.32, 0.52] },
    ],
  },
  {
    id: 'citadel',
    name: 'The Copper Citadel',
    map: 'lq_e4m5',
    portal: 'lq_e4m1',
    tier: 4,
    power: 40,
    tagline: 'The machine finished the fortress, then finished the people who ordered it.',
    encounters: [
      { name: 'Foreman Nine', title: 'Keeper of the Nailworks', theme: 'nail', arena: 1, band: [0.4, 0.62] },
      { name: 'The Copper Regent', title: 'Will of the Machine', theme: 'shock', arena: 0, band: [0.3, 0.5] },
    ],
  },
  {
    id: 'end',
    name: 'At the End of Time',
    map: 'lq_end',
    portal: 'lq_end',
    tier: 5,
    power: 50,
    tagline: 'Every slipgate leads here eventually. Nothing leaves.',
    encounters: [
      { name: 'Warden of Seconds', title: 'Who Counts Down', theme: 'shock', arena: 2, band: [0.38, 0.6] },
      { name: 'The Hour Eater', title: 'Hunger Between Moments', theme: 'void', arena: 1, band: [0.32, 0.52] },
      { name: 'The Last Slipgate', title: 'Door Without a Far Side', theme: 'void', arena: 0, band: [0.26, 0.46] },
    ],
  },
];

// Roll seeds until the generator lands on the theme we asked for. The
// search is deterministic, so a rebuild produces the same bosses.
function rollThemed(theme, salt, phases) {
  for (let seed = salt; seed < salt + 5000; seed++) {
    const enc = generateEncounter(seed);
    if (enc.boss.theme === theme && enc.boss.phases.length === phases) return enc;
  }
  throw new Error(`no ${theme} encounter near seed ${salt}`);
}

// Generated ids are all gen_*, so two bosses in one content set would
// overwrite each other's abilities. Give every boss its own namespace.
function namespace(enc, prefix) {
  const rename = (s) => (typeof s === 'string' && s.startsWith('gen_') ? `${prefix}_${s.slice(4)}` : s);
  const walk = (v) => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [rename(k), walk(x)]));
    return rename(v);
  };
  return { ...enc, abilities: walk(enc.abilities), auras: walk(enc.auras), boss: walk(enc.boss) };
}

const base = await loadContent();
const content = applyStyle(base, 'raid');
mkdirSync(OUT, { recursive: true });

const only = process.argv[2];
const index = [];
for (const raid of RAIDS) {
  index.push(raid.id);
  if (only && only !== raid.id) continue;
  const out = { ...raid, encounters: [] };
  delete out.map;
  out.maps = [...new Set(raid.encounters.map((e) => e.map || raid.map))];
  let n = 0;
  for (const spec of raid.encounters) {
    n++;
    if (spec.boss) {
      out.encounters.push({ boss: spec.boss, map: spec.map || raid.map, arena: spec.arena });
      console.log(`${raid.id} #${n}: ${spec.boss} (handcrafted)`);
      continue;
    }
    const phases = n === raid.encounters.length ? 3 : 2;
    const prefix = `${raid.id}${n}`;
    // Some rolls cannot be tuned into the band at all (a kit with no way
    // to kill anybody, or one mechanic that always wipes). Re-roll those
    // rather than ship them; the search is still deterministic.
    let enc;
    let tuned;
    let salt = raid.tier * 1000 + n * 97;
    for (let attempt = 0; attempt < 8; attempt++, salt += 211) {
      enc = namespace(rollThemed(spec.theme, salt, phases), prefix);
      enc.boss.id = `${raid.id}_${n}`;
      enc.boss.name = spec.name;
      enc.boss.title = spec.title;
      tuned = tuneEncounter(content, enc, { seed: salt, band: spec.band, runs: 40 });
      const w = tuned.report.winRate;
      if (w >= spec.band[0] - 0.06 && w <= spec.band[1] + 0.06 && tuned.report.medianKill > 120) break;
    }
    const r = tuned.report;
    console.log(`${raid.id} #${n}: ${spec.name} — ${(enc.boss.hp / 1e6).toFixed(1)}M hp, ` +
      `${(r.winRate * 100).toFixed(0)}% bots survive, ${r.medianKill.toFixed(0)}s kill${tuned.accepted ? '' : '  (outside band)'}`);
    out.encounters.push({
      boss: enc.boss.id,
      map: spec.map || raid.map,
      arena: spec.arena,
      botsWin: Math.round(r.winRate * 100),
      mechanics: enc.mechanics,
      def: enc.boss,
      abilities: enc.abilities,
      auras: enc.auras,
    });
  }
  writeFileSync(join(OUT, `${raid.id}.json`), JSON.stringify(out, null, 1));
}
writeFileSync(join(OUT, 'index.json'), JSON.stringify(index));
