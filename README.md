# Slipgate Raid — Chthon, Lord of the Lava Pit

A WoW-style raid encounter simulator wearing Quake's skin. One wipe-able boss, one
character you control, three bots filling the other roles. Plain HTML and ES modules —
no framework, no bundler, no server, no dependencies.

A raid fight is a rotation under pressure + telegraphed mechanics + role interdependence
+ an enrage timer. None of that needs 3D, continuous movement, or networking, so none of
those are here.

```
python3 -m http.server 8080     # or: npm run serve
open http://localhost:8080
```

(A static server is needed only because browsers refuse ES modules and `fetch` over
`file://`. There is nothing to build.)

## Controls

| Input | Action |
|---|---|
| `1` `2` `3` `4` | Your four abilities |
| Click a tile | Walk there — 0.4s per cell, and **moving cancels a cast** |
| Click a raid frame | Target that ally |
| `Tab` | Cycle enemy target (boss ⇄ Scrags) |
| `Space` / `R` | Pause / restart |

Pick Vanguard (tank), Field Medic (healer) or Slayer (dps) on the pull screen. The three
slots you don't take are run by bots off the same code path you are.

## The encounter

**Chthon** — 22.5M HP, enrage at 4:30, three phases. Median kill is 3:39, so the enrage
is close enough to feel.

| Mechanic | What it asks of you |
|---|---|
| **Lava Swipe** | Melee on the threat leader every 2s. Nobody in reach and he hits the whole party instead — you cannot kite him. |
| **Magma Cleave** | Hits the tank *and everyone adjacent*, stacking **Scorched** (+12% damage taken each). Spread out; tank pops the Pentagram at 2 stacks. |
| **Lava Geyser** | Six tiles glow, then erupt three seconds later. Telegraph → detonation. |
| **Slipgate Rift** | A dispellable magic DoT that explodes onto everyone within one cell when it falls off. Cleanse it or spread out. |
| **Rune of Black Magic** | 3s interruptible cast: heals Chthon and nukes the party. Thunderbolt it. |
| **Chain of Souls** | Marks one tile; the damage splits between whoever is standing there. Solo it and you die. |
| **Void Well** | Marks one tile that needs **two** bodies in it, or the whole raid eats it. |
| **Scrags** | Adds with their own threat table. Kill them or drown in Acid Spit. |
| **QUAD DAMAGE** | The enrage. ×10 boss damage, permanent. |

Those nine primitives — telegraph, stack, spread, soak, interrupt, dispel, stacking tank
debuff, adds, enrage — cover essentially all of raid design, which is why the engine has
no mechanic-specific code in it.

## Architecture

```
/engine   rng.js  grid.js  auras.js  abilities.js  ai.js  state.js  tick.js
/content  abilities.json  auras.json  units.json  parties.json  bosses/*.json  ai/*.json
/ui       render.js  input.js  log.js
/tests    engine.test.mjs
sim.js    headless balance runner (node)
main.js   browser entry: owns the 100ms clock, nothing else
index.html
```

**The sim never touches the DOM.** It takes state plus an input queue and returns new
state; the renderer reads a snapshot. That one rule is what lets the identical encounter
run headlessly in Node a thousand times in forty seconds.

**Fixed 10Hz tick.** No delta time, no interpolation, all durations in ticks. The phase
order inside a tick is load-bearing — mechanics are written against it:

1. `tick++` 2. resolve casts and movement landing this tick 3. aura pass (periodics, then
expiry, then delayed-bomb `onExpire`) 4. cell hazards detonate 5. boss timeline 6. bot AI
7. one queued player action 8. death checks 9. win/lose 10. snapshot.

**Every point of damage and healing goes through `applyDamage` / `applyHeal`.** They walk
the target's aura modifiers, then the source's, apply absorbs, feed threat, and write the
log line. Shields, damage reduction, vulnerability stacks and the enrage are all just aura
modifiers — no new code in twelve places.

**The aura system carries the game.** Buffs, debuffs, DoTs, HoTs, stacking tank debuffs,
absorb shields, delayed bombs and the enrage are one struct with `modifiers`, `periodic`,
`onExpire`, `onDispel` and `dispelType`.

## Adding content without touching the engine

A new boss is a new JSON file in `content/bosses/` — phases with `start` / `hpBelow` /
`timeElapsed` triggers, each holding a timeline of `{ t, every, ability, target }`.

A new bot is a priority list, evaluated top to bottom, first rule that both matches *and*
produces a usable action wins:

```json
{ "if": "selfCellUnsafe",     "do": "moveToSafe" },
{ "if": "allyHasDispellable", "do": "cast:biosuit" },
{ "if": "allyBelowPct:42",    "do": "cast:stimpack" },
{ "else": true,               "do": "cast:nailgun" }
```

Conditions live in a named registry in `engine/ai.js` (~15 functions). Each bot carries a
**reaction delay** of 0.5–1.5s, varied per unit: it does not see a hazard on the tick it
appears, and it does not react to a boss cast instantly. One line of code, and it is the
single biggest reason the party feels like people rather than a machine.

## Balance testing

Seeded RNG (mulberry32) on the state: a seed plus an input sequence always replays
identically. So tune against a thousand pulls instead of playing two hundred:

```
$ node sim.js --runs 1000

boss chthon · party default · 1000 runs · 39842ms
win rate 46.4%
median kill 3:39
median wipe at 1.7% boss hp · timeouts 0
avg deaths/pull 2.42 · avg interrupts 3.9

top death causes
  Void Well              49%
  Chain of Souls         25%
  Lava Swipe             12%
```

That run is four bots, no human — the player slot is played by its own AI. A human who
dodges better than a bot should win more often than the coin flip.

Flags: `--boss chthon --party default --runs N --seed N --verbose`.

```
npm test        # determinism, choke points, cast cancelling, snapshot isolation
```

## Deliberately not here

3D. Networking. Multiplayer. Loot. Talent trees. Classes past the four archetypes. A
second boss. Animations. Save files. Difficulty modes. Sound. None of them would make a
bad core loop good — so the loop got the time instead.
