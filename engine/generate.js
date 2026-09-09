// Procedural encounters. A seed goes in, a boss script in exactly the
// same shape as content/bosses/chthon.json comes out -- plus the
// abilities and auras it needs, since a generated boss gets generated
// mechanics rather than a reshuffle of Chthon's.
//
// The interesting part is not the randomness, it is the damage budget:
// mechanics are drawn at random but their numbers are *allocated* from a
// fixed incoming-damage-per-second budget, the way an encounter designer
// would. That is what makes a random fight land near playable before the
// tuner in tune.js ever runs.

import { nextFloat, nextInt, pick, pickMany } from './rng.js';

// mulberry32 correlates hard on small consecutive seeds, so scramble
// first and burn a few draws -- otherwise seeds 1 and 2 make near-twins.
function rng(seed) {
  const state = { rngSeed: Math.imul(seed | 0, 2654435761) | 0 };
  for (let i = 0; i < 4; i++) nextFloat(state);
  return state;
}
const range = (r, lo, hi) => lo + nextFloat(r) * (hi - lo);
const irange = (r, lo, hi) => Math.round(range(r, lo, hi));
const round = (n, to) => Number((Math.round(n / to) * to).toFixed(6));

/* ------------------------------------------------------------ flavour */

const NAMES = [
  'Chthon', 'Shub-Niggurath', 'The Vore Queen', 'Shambler Prime', 'The Ogre Lord',
  'Armagon', 'The Makron', 'Dread Sentinel', 'The Fiend Ascendant', 'Sepulchre',
  'The Scrag Choir', 'Gorehound', 'The Iron Zealot', 'Wrathmaw', 'The Pale Enforcer',
];

const TITLES = [
  'Lord of the Lava Pit', 'Herald of the Slipgate', 'Warden of the Dark Rift',
  'The Spine-Weaver', 'Keeper of the Nailworks', 'Whisper of the Elder World',
  'The Unmaker', 'Butcher of the Runic Halls', 'Tyrant of the Sunken Fane',
];

const THEMES = [
  {
    id: 'lava', school: 'lava', melee: 'Lava Swipe', cleave: 'Magma Cleave',
    ground: 'Lava Geyser', mark: 'Cinder Brand', stack: 'Chain of Souls',
    soak: 'Void Well', channel: 'Rune of Black Magic', add: 'scrag', debuff: 'Scorched',
  },
  {
    id: 'void', school: 'void', melee: 'Rift Claw', cleave: 'Entropy Sweep',
    ground: 'Collapsing Space', mark: 'Slipgate Rift', stack: 'Gravity Well',
    soak: 'Singularity', channel: 'Unmaking', add: 'scrag', debuff: 'Unravelled',
  },
  {
    id: 'nail', school: 'nail', melee: 'Rending Nails', cleave: 'Nail Fan',
    ground: 'Nailbed', mark: 'Impaled', stack: 'Barbed Chain', soak: 'Nail Press',
    channel: 'Overclock the Works', add: 'scrag', debuff: 'Punctured',
  },
  {
    id: 'plague', school: 'acid', melee: 'Rotting Bite', cleave: 'Bile Sweep',
    ground: 'Pustule', mark: 'Contagion', stack: 'Mass Grave', soak: 'Fester Pool',
    channel: 'Consume the Fallen', add: 'scrag', debuff: 'Necrosis',
  },
  {
    id: 'shock', school: 'shock', melee: 'Arc Lash', cleave: 'Chain Lightning',
    ground: 'Tesla Bloom', mark: 'Grounding Rod', stack: 'Conduit', soak: 'Capacitor',
    channel: 'Charge the Core', add: 'scrag', debuff: 'Overloaded',
  },
];

/* --------------------------------------------------------- archetypes */

// weight  : how likely this mechanic is to be drawn
// share   : fraction of the raid damage budget it asks for
// payload : how many party members' worth of damage one cast actually
//           delivers. This is the part that stops the numbers being
//           nonsense -- a whole-party nuke and a hit that lands on one
//           person are not the same size just because they cost the same
//           budget, and a split mechanic divides itself by whoever came.
// earliest: the first phase it may appear in
const ARCHETYPES = {
  cleave:  { weight: 3, share: 0.18, payload: 2.0, earliest: 0, cadence: [18, 28] },
  ground:  { weight: 4, share: 0.24, payload: 1.3, earliest: 0, cadence: [14, 24] },
  mark:    { weight: 3, share: 0.18, payload: 2.2, earliest: 0, cadence: [28, 44] },
  stack:   { weight: 3, share: 0.18, payload: 4.0, earliest: 1, cadence: [22, 32] },
  soak:    { weight: 2, share: 0.16, payload: 2.5, earliest: 1, cadence: [26, 38] },
  channel: { weight: 3, share: 0.16, payload: 4.0, earliest: 0, cadence: [30, 42] },
  adds:    { weight: 2, share: 0.10, payload: 2.0, earliest: 1, cadence: [42, 64] },
};

/* ------------------------------------------------------------ builder */

export function generateEncounter(seed, options = {}) {
  const r = rng(seed);
  const theme = pick(r, THEMES);
  const name = pick(r, NAMES);
  const title = pick(r, TITLES);
  const phaseCount = irange(r, 2, 3);

  // The budget, in pre-mitigation damage per second. Everything the boss
  // does is paid for out of these two numbers.
  const tankBudget = range(r, 44000, 58000);
  const raidBudget = range(r, 42000, 62000);

  const abilities = {};
  const auras = {};
  const id = (suffix) => `gen_${suffix}`;

  /* ---- the melee that defines the tank's job --------------------- */

  const meleeInterval = round(range(r, 1.8, 2.6), 0.2);
  const debuffId = id('debuff');
  auras[debuffId] = {
    name: theme.debuff,
    duration: round(range(r, 20, 32), 1),
    harmful: true,
    maxStacks: irange(r, 3, 5),
    modifiers: [{ stat: 'damageTaken', op: 'mult', value: 1.1 + nextFloat(r) * 0.05, perStack: true }],
  };

  abilities[id('melee')] = {
    id: id('melee'), name: theme.melee, icon: '☄',
    cast: 0, gcd: 0, offGcd: true, cooldown: 0, cost: 0,
    targeting: 'enemy', range: 1, requiresTargetInRange: true,
    onNoTargetText: `${name} finds nothing in reach and roars — UNOPPOSED!`,
    onNoTarget: [{ type: 'damage', target: 'party', amount: 28000, school: theme.school, name: 'Unopposed' }],
    effects: [{ type: 'damage', amount: round(tankBudget * meleeInterval, 1000), school: theme.school }],
  };

  /* ---- draw the rest of the kit ---------------------------------- */

  const pool = [];
  for (const [key, def] of Object.entries(ARCHETYPES)) {
    for (let i = 0; i < def.weight; i++) pool.push(key);
  }
  const drawn = ['ground'];
  const wanted = irange(r, 4, 5);
  for (const key of pickMany(r, pool, pool.length)) {
    if (drawn.length >= wanted) break;
    if (!drawn.includes(key)) drawn.push(key);
  }

  const shareTotal = drawn.reduce((sum, k) => sum + ARCHETYPES[k].share, 0);
  const mechanics = drawn.map((key) => {
    const spec = ARCHETYPES[key];
    const cadence = round(range(r, spec.cadence[0], spec.cadence[1]), 1);
    // What this mechanic is allowed to cost the party per cast.
    // Total damage this cast is allowed to do to the party, converted
    // into the per-target number the effect actually carries.
    const total = (spec.share / shareTotal) * raidBudget * cadence;
    const perCast = total / spec.payload;
    return build(key, { r, theme, name, id, abilities, auras, cadence, perCast, debuffId });
  });

  /* ---- lay them out across phases -------------------------------- */

  const phases = [];
  for (let p = 0; p < phaseCount; p++) {
    const speed = 1 - p * 0.16; // later phases come faster
    const timeline = [
      { t: 1, every: meleeInterval, ability: id('melee'), target: 'threatLeader' },
    ];
    let cursor = irange(r, 4, 10);
    for (const mech of mechanics) {
      if (mech.earliest > p) continue;
      timeline.push({
        t: cursor,
        every: round(mech.cadence * speed, 0.5),
        ability: mech.abilityId,
        target: mech.target,
        ...(mech.count ? { count: mech.count } : {}),
        ...(mech.delay ? { delay: mech.delay } : {}),
      });
      cursor += irange(r, 5, 11);
    }
    phases.push({
      name: `Phase ${p + 1} — ${pick(r, ['The Pit Stirs', 'The Brood Wakes', 'Nothing Held Back', 'The Long Dark', 'It Notices You'])}`,
      trigger: p === 0 ? { type: 'start' } : { type: 'hpBelow', pct: Math.round(100 - (p * 100) / phaseCount - 5) },
      timeline,
    });
  }

  const boss = {
    id: `generated_${seed >>> 0}`,
    name,
    title,
    seed: seed >>> 0,
    hp: 20000000, // a placeholder; tune.js fits this to a kill time
    cell: 12,
    speed: 1.8,
    enrageAtSeconds: irange(r, 250, 300),
    theme: theme.id,
    phases,
  };

  return { boss, abilities, auras, damageScale: 1, mechanics: mechanics.map((m) => m.summary) };
}

/* ---------------------------------------------- one mechanic at a time */

function build(key, ctx) {
  const { r, theme, name, id, abilities, auras, cadence, perCast, debuffId } = ctx;
  const key_ = id(key);
  const common = { id: key_, cast: 0, gcd: 0, offGcd: true, cooldown: 0, cost: 0 };
  const base = { abilityId: key_, cadence, earliest: ARCHETYPES[key].earliest, target: 'none' };

  switch (key) {
    case 'cleave': {
      abilities[key_] = {
        ...common, name: theme.cleave, icon: '⚔', cast: 1, targeting: 'enemy', range: 2,
        effects: [
          { type: 'damage', target: 'targetAndAdjacent', amount: round(perCast, 1000), school: theme.school },
          { type: 'aura', aura: debuffId, target: 'target' },
        ],
      };
      return { ...base, target: 'threatLeader',
        summary: `${theme.cleave} — hits the tank and anyone next to them every ${cadence}s, stacking ${auras[debuffId].name}` };
    }

    case 'ground': {
      const count = irange(r, 5, 8);
      const delay = round(range(r, 1.3, 2.1), 0.1);
      abilities[key_] = {
        ...common, name: theme.ground, icon: '▲', targeting: 'none', range: 5,
        effects: [{
          type: 'markCells', count, delay,
          damage: round(perCast, 5000),
          kind: 'blast', name: theme.ground,
        }],
      };
      return { ...base, count, delay,
        summary: `${theme.ground} — ${count} tiles erupt ${delay}s after they light up, every ${cadence}s` };
    }

    case 'mark': {
      const auraId = id('mark_aura');
      auras[auraId] = {
        name: theme.mark, duration: round(range(r, 8, 14), 1), harmful: true, dispelType: 'magic',
        periodic: { interval: 1, effect: { type: 'damage', amount: round(perCast / 10, 1000), school: theme.school } },
        modifiers: [],
        onExpire: [
          { type: 'damage', target: 'target', amount: round(perCast * 0.6, 5000), school: theme.school, name: `${theme.mark} Collapse` },
          { type: 'damage', target: 'nearTarget', amount: round(perCast * 1.1, 5000), school: theme.school, name: `${theme.mark} Collapse` },
        ],
        onDispel: [{ type: 'damage', target: 'target', amount: round(perCast / 8, 5000), school: theme.school, name: `${theme.mark} Backlash` }],
      };
      abilities[key_] = {
        ...common, name: theme.mark, icon: '◈', cast: 1.5, targeting: 'enemy', range: 5,
        effects: [{ type: 'aura', aura: auraId, target: 'target' }],
      };
      return { ...base, target: 'randomPlayer',
        summary: `${theme.mark} — a dispellable curse every ${cadence}s that detonates on everyone nearby if it runs out` };
    }

    case 'stack': {
      abilities[key_] = {
        ...common, name: theme.stack, icon: '⛓', cast: 1, targeting: 'none', range: 5,
        effects: [{
          type: 'markRandomArea', delay: round(range(r, 4, 6), 0.5), kind: 'split',
          damage: round(perCast * 4, 10000), raidDamage: round(perCast * 1.4, 10000), name: theme.stack,
        }],
      };
      return { ...base, summary: `${theme.stack} — every ${cadence}s one tile takes a huge hit split between whoever stands in it` };
    }

    case 'soak': {
      abilities[key_] = {
        ...common, name: theme.soak, icon: '◎', cast: 1, targeting: 'none', range: 5,
        effects: [{
          type: 'markRandomArea', delay: round(range(r, 5, 7), 0.5), kind: 'soak', minSoakers: 2,
          damage: round(perCast * 2.5, 10000), raidDamage: round(perCast * 1.6, 10000), name: theme.soak,
        }],
      };
      return { ...base, summary: `${theme.soak} — every ${cadence}s a tile needs two bodies in it or the raid eats the hit` };
    }

    case 'channel': {
      const heal = irange(r, 3, 6);
      abilities[key_] = {
        ...common, name: theme.channel, icon: '☠', cast: round(range(r, 2.5, 3.5), 0.1),
        targeting: 'self', range: 5, interruptible: true,
        effects: [
          { type: 'healPct', pct: heal, target: 'self', name: theme.channel },
          { type: 'damage', target: 'party', amount: round(perCast, 5000), school: theme.school, name: theme.channel },
        ],
      };
      return { ...base, target: 'self',
        summary: `${theme.channel} — interruptible cast every ${cadence}s; heals ${name} for ${heal}% and hits the party if it lands` };
    }

    case 'adds': {
      const count = irange(r, 2, 3);
      abilities[key_] = {
        ...common, name: 'Summon', icon: '☗', cast: 2, targeting: 'none', range: 5,
        effects: [{ type: 'summon', unit: theme.add, count }],
      };
      return { ...base, summary: `Summons ${count} Scrags every ${cadence}s` };
    }

    default:
      throw new Error(`unknown archetype ${key}`);
  }
}

// Fold a generated encounter into a content view the engine can run.
export function withEncounter(content, encounter) {
  return {
    ...content,
    abilities: { ...content.abilities, ...hydrate(encounter.abilities) },
    auras: { ...content.auras, ...hydrateAuras(encounter.auras) },
    bosses: { ...content.bosses, [encounter.boss.id]: encounter.boss },
  };
}

// Generated content is authored in seconds like every other content file,
// so it goes through the same conversion.
const SECOND_FIELDS = { cast: 'castTicks', gcd: 'gcdTicks', cooldown: 'cooldownTicks', lockout: 'lockoutTicks', delay: 'delayTicks' };
const TICKS_PER_SECOND = 10;

function withTicks(obj) {
  const out = { ...obj };
  for (const [seconds, ticks] of Object.entries(SECOND_FIELDS)) {
    if (out[seconds] !== undefined) out[ticks] = Math.round(out[seconds] * TICKS_PER_SECOND);
  }
  return out;
}

function hydrate(abilities) {
  const out = {};
  for (const [key, def] of Object.entries(abilities)) {
    const ability = withTicks(def);
    if (ability.effects) ability.effects = ability.effects.map(withTicks);
    if (ability.onNoTarget) ability.onNoTarget = ability.onNoTarget.map(withTicks);
    out[key] = ability;
  }
  return out;
}

function hydrateAuras(auras) {
  const out = {};
  for (const [key, def] of Object.entries(auras)) {
    const aura = { ...def, durationTicks: Math.round((def.duration ?? 0) * TICKS_PER_SECOND) };
    if (def.periodic) aura.periodic = { ...def.periodic, intervalTicks: Math.round(def.periodic.interval * TICKS_PER_SECOND) };
    out[key] = aura;
  }
  return out;
}
