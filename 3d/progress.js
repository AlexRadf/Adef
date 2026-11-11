// The part that makes you come back: a character that outlives a pull.
//
// From the looter-shooter side: POWER, the average item level of what you
// are wearing, and drops that roll their level around your own so every
// clear can move it. From the MMO side: a RANK with an experience bar,
// a quest board, and a raid lockout that only pays out bosses once a week.
//
// None of this reaches the sim except through one door, powerAura(): a
// small, capped damage/healing/health bonus, so the tuned fights stay
// tuned and power is a reason to come back rather than a way to skip.

const KEY = 'slipgate.progress.v1';

export const SLOTS = [
  { id: 'weapon', name: 'Weapon' },
  { id: 'armour', name: 'Armour' },
  { id: 'sigil', name: 'Sigil' },
];

export const RARITY = [
  { id: 'common', name: 'Common', colour: '#c9bda9', bonus: 0 },
  { id: 'rare', name: 'Rare', colour: '#5aa2ff', bonus: 1 },
  { id: 'epic', name: 'Epic', colour: '#b46cff', bonus: 2 },
  { id: 'exotic', name: 'Exotic', colour: '#ffcc33', bonus: 4 },
];

const NAMES = {
  weapon: {
    vanguard: ['Riveted Boomstick', 'Doorbreaker', 'Ogre-Hide Scattergun', 'The Second Barrel'],
    medic: ['Field Injector', 'Coroner\'s Syringe', 'Bio-Lance', 'Stitchgun'],
    slayer: ['Nailspitter', 'Rivet Driver', 'Thunder Coil', 'Rocket Lantern'],
  },
  armour: ['Slipgate Plate', 'Runed Hauberk', 'Rust-Iron Mail', 'Biosuit Mk II', 'Shambler-Hide Coat', 'Templar Cuirass'],
  sigil: ['Rune of Earth', 'Rune of Black Magic', 'Rune of Hell Magic', 'Rune of Elder Magic', 'Sigil of the Pit', 'Ward of Seconds'],
};

const ROLE_KIT = { tank: 'vanguard', healer: 'medic', dps: 'slayer' };

export const BOUNTY_POOL = [
  { id: 'kill', text: 'Defeat {n} raid bosses', n: 3, stat: 'kills', reward: { xp: 600, shards: 30 } },
  { id: 'interrupt', text: 'Interrupt {n} boss casts', n: 6, stat: 'interrupts', reward: { xp: 400, shards: 20 } },
  { id: 'deathless', text: 'Kill a boss without dying', n: 1, stat: 'deathless', reward: { xp: 500, shards: 25 } },
  { id: 'damage', text: 'Deal {n}M damage in raids', n: 25, stat: 'damageM', reward: { xp: 450, shards: 20 } },
  { id: 'heal', text: 'Heal {n}M in raids', n: 15, stat: 'healM', reward: { xp: 450, shards: 20 } },
  { id: 'slipgate', text: 'Kill a boss in Slipgate (first person)', n: 1, stat: 'kill_quake', reward: { xp: 350, shards: 15 } },
  { id: 'azeroth', text: 'Kill a boss in Azeroth (tab target)', n: 1, stat: 'kill_wow', reward: { xp: 350, shards: 15 } },
  { id: 'pit', text: 'Kill a boss in The Pit (lock-on)', n: 1, stat: 'kill_souls', reward: { xp: 350, shards: 15 } },
  { id: 'overload', text: 'Kill a boss in Overload', n: 1, stat: 'kill_overwatch', reward: { xp: 350, shards: 15 } },
  { id: 'heroic', text: 'Kill a boss on Heroic', n: 1, stat: 'heroic', reward: { xp: 700, shards: 35 } },
  { id: 'clear', text: 'Clear a whole raid', n: 1, stat: 'clears', reward: { xp: 800, shards: 40 } },
];

const XP_PER_RANK = (rank) => 1000 + rank * 250;
export const MAX_POWER = 60;

const week = () => Math.floor((Date.now() / 86400000 - 4) / 7); // resets each Tuesday, UTC

function fresh() {
  return {
    rank: 1,
    xp: 0,
    shards: 0,
    gear: {
      weapon: { name: 'Standard Issue', slot: 'weapon', power: 5, rarity: 'common' },
      armour: { name: 'Recruit Fatigues', slot: 'armour', power: 5, rarity: 'common' },
      sigil: { name: 'Blank Rune', slot: 'sigil', power: 5, rarity: 'common' },
    },
    stash: [],
    bounties: [],
    bountyWeek: -1,
    lockouts: {}, // raidId -> { week, killed: [encounterIndex] }
    clears: {}, // raidId -> total full clears
    lifetime: { kills: 0, wipes: 0 },
    seed: (Math.random() * 1e9) | 0,
  };
}

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...fresh(), ...JSON.parse(raw) };
  } catch {
    /* private window or blocked storage: play without saving */
  }
  return fresh();
}

function rand(p) {
  // A small LCG on the save, so loot is not re-rollable by refreshing.
  p.seed = (Math.imul(p.seed, 1664525) + 1013904223) | 0;
  return (p.seed >>> 0) / 4294967296;
}

export function createProgress() {
  let p = load();

  const save = () => {
    try {
      localStorage.setItem(KEY, JSON.stringify(p));
    } catch {
      /* not fatal */
    }
  };

  function power() {
    const g = p.gear;
    return Math.floor((g.weapon.power + g.armour.power + g.sigil.power) / 3);
  }

  function refreshBounties() {
    if (p.bountyWeek === week() && p.bounties.length) return;
    p.bountyWeek = week();
    const pool = BOUNTY_POOL.slice();
    p.bounties = [];
    while (p.bounties.length < 4 && pool.length) {
      const b = pool.splice(Math.floor(rand(p) * pool.length), 1)[0];
      p.bounties.push({ id: b.id, progress: 0, done: false, claimed: false });
    }
    save();
  }

  function lockout(raidId) {
    const l = p.lockouts[raidId];
    if (!l || l.week !== week()) return { week: week(), killed: [] };
    return l;
  }

  // A drop rolls its level around your current power: mostly a little
  // under, sometimes over, which is what makes the next one worth it.
  function rollItem(raid, role, heroic) {
    const slot = SLOTS[Math.floor(rand(p) * SLOTS.length)].id;
    const r = rand(p);
    const rarity = r > 0.96 ? 'exotic' : r > 0.78 ? 'epic' : r > 0.4 ? 'rare' : 'common';
    const bonus = RARITY.find((x) => x.id === rarity).bonus;
    const floor = Math.max(raid.power - 6, power() - 3);
    const level = Math.min(MAX_POWER, floor + Math.floor(rand(p) * 5) + bonus + (heroic ? 3 : 0));
    const names = slot === 'weapon' ? NAMES.weapon[ROLE_KIT[role]] : NAMES[slot];
    const name = names[Math.floor(rand(p) * names.length)];
    return { name, slot, power: Math.max(1, level), rarity, from: raid.name };
  }

  function gainXp(n) {
    p.xp += n;
    let ups = 0;
    while (p.xp >= XP_PER_RANK(p.rank)) {
      p.xp -= XP_PER_RANK(p.rank);
      p.rank++;
      ups++;
    }
    return ups;
  }

  function bump(stat, by) {
    for (const b of p.bounties) {
      const def = BOUNTY_POOL.find((d) => d.id === b.id);
      if (!def || b.done || def.stat !== stat) continue;
      b.progress = Math.min(def.n, b.progress + by);
      if (b.progress >= def.n) b.done = true;
    }
  }

  refreshBounties();

  return {
    get data() {
      return p;
    },
    power,
    xpNeeded: () => XP_PER_RANK(p.rank),
    lockout,
    refreshBounties,

    // The one door into the sim. Capped at +15%, reached around power 50.
    powerAura() {
      const k = Math.min(0.15, Math.max(0, (power() - 5) * 0.003));
      return {
        name: `Power ${power()}`,
        duration: 0,
        modifiers: [
          { stat: 'damageDealt', op: 'mult', value: 1 + k },
          { stat: 'healingDone', op: 'mult', value: 1 + k },
          { stat: 'damageTaken', op: 'mult', value: 1 - k / 3 },
        ],
      };
    },

    // Called once per encounter result. Returns what to show.
    recordEncounter({ raid, index, won, role, game, heroic, stats }) {
      refreshBounties();
      const out = { loot: [], xp: 0, shards: 0, ranks: 0, firstThisWeek: false, bounties: [] };
      const before = p.bounties.filter((b) => b.done).map((b) => b.id);
      bump('damageM', stats.damage / 1e6);
      bump('healM', stats.healing / 1e6);
      bump('interrupts', stats.interrupts);
      if (!won) {
        p.lifetime.wipes++;
        out.xp = 120;
        out.ranks = gainXp(out.xp);
        save();
        return out;
      }
      p.lifetime.kills++;
      bump('kills', 1);
      bump(`kill_${game}`, 1);
      if (!stats.died) bump('deathless', 1);
      if (heroic) bump('heroic', 1);

      const lock = lockout(raid.id);
      out.firstThisWeek = !lock.killed.includes(index);
      // Loot and the big xp only once a week per boss; you can always
      // come back for practice, shards and bounty progress.
      if (out.firstThisWeek) {
        lock.killed.push(index);
        p.lockouts[raid.id] = lock;
        const drops = index === raid.encounters.length - 1 ? 2 : 1;
        for (let i = 0; i < drops; i++) out.loot.push(rollItem(raid, role, heroic));
        out.xp = 700 + raid.tier * 150;
        if (lock.killed.length === raid.encounters.length) {
          p.clears[raid.id] = (p.clears[raid.id] || 0) + 1;
          bump('clears', 1);
          out.cleared = true;
        }
      } else {
        out.xp = 250;
      }
      out.shards = 10 + raid.tier * 4 + (heroic ? 10 : 0);
      p.shards += out.shards;
      for (const item of out.loot) p.stash.unshift(item);
      p.stash = p.stash.slice(0, 24);
      out.ranks = gainXp(out.xp);
      out.bounties = p.bounties.filter((b) => b.done && !before.includes(b.id)).map((b) => b.id);
      save();
      return out;
    },

    equip(stashIndex) {
      const item = p.stash[stashIndex];
      if (!item) return;
      const old = p.gear[item.slot];
      p.gear[item.slot] = item;
      p.stash.splice(stashIndex, 1);
      if (old) p.stash.unshift(old);
      save();
    },

    // Shards buy a guaranteed piece at your current power -- the vendor
    // that means a bad week of drops is not a wasted week.
    buy(slot) {
      const cost = 60;
      if (p.shards < cost) return null;
      p.shards -= cost;
      const names = NAMES[slot] && !Array.isArray(NAMES[slot]) ? NAMES[slot].slayer : NAMES[slot];
      const item = {
        name: `Quartermaster's ${names[Math.floor(rand(p) * names.length)]}`,
        slot,
        power: Math.min(MAX_POWER, power() + 1),
        rarity: 'rare',
        from: 'Quartermaster',
      };
      p.stash.unshift(item);
      save();
      return item;
    },

    // Scrap a stash item for a few shards.
    scrap(stashIndex) {
      const item = p.stash[stashIndex];
      if (!item) return;
      p.stash.splice(stashIndex, 1);
      p.shards += 3 + RARITY.find((r) => r.id === item.rarity).bonus * 3;
      save();
    },

    claimBounty(id) {
      const b = p.bounties.find((x) => x.id === id);
      if (!b || !b.done || b.claimed) return null;
      b.claimed = true;
      const def = BOUNTY_POOL.find((d) => d.id === id);
      p.shards += def.reward.shards;
      const ranks = gainXp(def.reward.xp);
      save();
      return { ...def.reward, ranks };
    },

    reset() {
      p = fresh();
      refreshBounties();
      save();
    },
  };
}

export function bountyText(b) {
  const def = BOUNTY_POOL.find((d) => d.id === b.id);
  return def ? def.text.replace('{n}', def.n) : b.id;
}
export function bountyGoal(b) {
  const def = BOUNTY_POOL.find((d) => d.id === b.id);
  return def ? def.n : 1;
}
