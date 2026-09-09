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

## Two control philosophies

The same encounter, the same sim, two ways of playing it — pick one on the pull screen.
They are content, not code: `content/schemes.json`.

| | **Raid** | **Arena** |
|---|---|---|
| Move | Click a tile, 2.5 cells/s | `WASD`, 5.2 cells/s |
| Aim | Tab-target; your target stays picked | Mouse. No target lock — you hit whatever the crosshair is nearest |
| Pacing | 1.5s global cooldown on everything | 0.3s weapon switch, then each weapon's own fire rate |
| Casting | Rocket and Medkit have cast bars, and **moving cancels a cast** | Nothing has a cast time |
| The constraint | *When can I afford to stand still?* | *Am I going to run out of ammo?* |

Both are honest to their genre and both are balanced: raid wins 52% of headless pulls,
arena 59.6%, with a 3:40 median kill either way. Arena is a little more forgiving because
free movement makes dodging cheap — that gap is the finding, not a bug.

| Shared | |
|---|---|
| `1` `2` `3` `4` | Your four abilities |
| Click a raid frame | Target that ally (raid scheme; click again for automatic) |
| `Space` / `R` | Pause / restart |

Pick Vanguard (tank), Field Medic (healer) or Slayer (dps). The three slots you don't take
are run by bots off the same code path you are.

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
/engine   clock.js  geometry.js  rng.js  auras.js  abilities.js  ai.js  state.js  tick.js
/content  abilities.json  auras.json  units.json  parties.json  schemes.json
          bosses/*.json  ai/*.json  load.js
/ui       render.js  input.js  log.js
/tests    engine.test.mjs
sim.js    headless balance runner (node)
main.js   browser entry: owns the 100ms clock, nothing else
index.html
```

**The sim never touches the DOM.** It takes state plus an input queue and returns new
state; the renderer reads a snapshot. That one rule is what lets the identical encounter
run headlessly in Node a thousand times in forty seconds.

**Positions are coordinates, not grid indices.** Units live at continuous `{x, y}` and
move at a speed in cells per second; area effects are a position plus a half-extent. The
5×5 tiling survives only as a telegraph shape and a way to draw the floor.

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

## Porting this to a 3D engine

The layout is deliberately arranged so the expensive half survives a port.

**Ports unchanged.** `auras.js` contains zero geometry — the whole buff/debuff/DoT/shield/
stacking-debuff system is arithmetic. So do the damage and healing choke points, the threat
table, the boss phase machine and every file in `/content`.

**Two seams do the work.** `distance()` in `engine/geometry.js` is the single function that
decides what "range 1" means; add a `z` and swap the metric and every mechanic in `/content`
keeps working. `TICKS_PER_SECOND` in `engine/clock.js` is the only place that knows how fast
the world runs — content is authored in **seconds** and converted once at load, so moving to
a 30Hz or 60Hz sim does not invalidate a single JSON file.

**Expect to retune, not to rewrite.** When this project moved from grid indices to
coordinates, the win rate went from 48% to 88% overnight: continuous movement makes dodging
far cheaper. The tuning *method* survived — `sim.js` found the new numbers in an
afternoon — but the numbers themselves did not. Budget for that in any port.

**What actually gets rewritten:** the renderer (always was disposable), the movement
resolution, and the AI's movement verbs — `nearestSafeSpot` samples tile centres here and
would sample a navmesh there, about eighty lines. The priority lists themselves are data
and survive.

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
$ node sim.js --runs 500 --scheme raid

boss chthon · party default · raid controls · 500 runs · 6800ms
win rate 52.0%
median kill 3:40
median wipe at 12.9% boss hp · timeouts 0
avg deaths/pull 1.95 · avg interrupts 3.8

top death causes
  Void Well              41%
  Chain of Souls         24%
  Lava Swipe             13%
```

That run is four bots, no human — the player slot is played by its own AI. A human who
dodges better than a bot should win more often than the coin flip.

Flags: `--boss chthon --party default --scheme raid|arena --runs N --seed N --verbose`.

**It earns its keep as a bug detector, not just a tuning tool.** Three real AI defects
showed up as a *non-monotonic difficulty curve* — longer telegraphs were making the fight
easier, which is impossible if the bots are playing correctly:

1. Bots walked into a Void Well to soak it, then wandered back out to get in range of their
   target. Standing in a soak is now a commitment.
2. A bot with a move order would start a 1.5s cast that movement cancelled on the next
   tick, burning the resource and the cooldown for nothing.
3. A Chain of Souls marker appearing during a pending Void Well made the whole party
   abandon the soak — two mechanics demanding opposite ground, with no resolution rule.
   Whichever lands first now wins.

None of those were visible while playing. All three were obvious in a 300-pull sweep.

```
npm test        # determinism, choke points, cast cancelling, snapshot isolation
```

## Deliberately not here

3D. Networking. Multiplayer. Loot. Talent trees. Classes past the four archetypes. A
second boss. Animations. Save files. Difficulty modes. Sound. None of them would make a
bad core loop good — so the loop got the time instead.
