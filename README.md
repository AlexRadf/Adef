# Slipgate Raid — Chthon, Lord of the Lava Pit

A raid encounter wearing Quake's skin: one wipe-able boss, one character you control, three
bots filling the rest of the trinity. Plain HTML and ES modules — no framework, no bundler,
no build step, and (three.js aside, which is committed to `vendor/`) no dependencies.

```
python3 -m http.server 8080     # or: npm run serve
open http://localhost:8080/3d/  # the 3D build
open http://localhost:8080/     # the 2D build and balance lab
```

## The 3D build — four games, one fight

The same encounter, the same sim, played four ways. Each is a camera plus a control style,
and **all four keep the holy trinity**: a tank holding the boss, a healer keeping four
people alive, and damage racing an enrage timer.

| | After | What changes |
|---|---|---|
| **Azeroth** | World of Warcraft | Orbit camera over your shoulder, tab-target, global cooldown, cast bars you have to stand still for, a threat table the tank manages |
| **Slipgate** | Quake | First person. No target lock, no cast bars, no GCD — only fire rates and ammo. Every job becomes a shooting job, healer included |
| **Overload** | Overwatch | Third person, primary fire **held** rather than tapped, the rest of the kit heavy cooldowns you spend at the right moment |
| **The Pit** | Dark Souls | Camera locked on the boss while you circle it. Rolling costs stamina and grants i-frames; blocking costs stamina and breaks if you run dry |

One sim cell is three metres, so the 5×5 grid the encounter was tuned on becomes a 15-metre
room you can actually run across — and none of the balance work had to be redone.

**On combat feeling spammy:** primary fire is now *held*, not tapped, in the modes where
that fits. That fixes the mashing; it does not reduce the number of *decisions*, which is
an ability-design change rather than a control one, and is the obvious next thing to do.

## Four buttons that feed each other

A hard limit of four buttons per role. The problem with four buttons is that they collapse
into "spam 1, occasionally press 2" unless they are wired to each other, so each role runs
the same four-beat shape with different content:

| | **1 · Builder** | **2 · Spender** | **3 · Payoff** | **4 · Ultimate** |
|---|---|---|---|---|
| **Vanguard** | Shotgun — free, +20 Fury | Super Shotgun — 45 Fury, leaves the boss **Rattled** (hits 15% softer) | Grappling Hook — taunt, and hands back 35 Fury *while Rattled* | **Pentagram** — charges from damage taken; the party takes 35% less for 6s |
| **Slayer** | Nailgun — free, +20 Charge | Rocket Launcher — 45 Charge, leaves the target **Cracked** (takes 18% more) | Thunderbolt — interrupt, **double damage into a Cracked target** | **Quad Damage** — charges from damage dealt; everything doubles for 10s |
| **Field Medic** | Stimpack — free, +20 Bio | Medkit — 45 Bio, leaves them **Regenerating** (a HoT, +25% healing taken) | Biosuit — cleanse, and dumps 95k more *into a Regenerating ally* | **Megahealth** — charges from healing done; a wall of health across the party |

So button 2 is what makes button 3 worth pressing, button 1 is what pays for button 2, and
button 4 arrives because you did your job — the ultimate charges from damage dealt, damage
taken or healing done, depending on which job that is.

**The loop is measured, not asserted.** Over 60 headless pulls:

```
Thunderbolts into a Cracked target : 94%   (38 bolts per pull)
Grapples taken during Rattled      : 100%
Biosuits onto a Regenerating ally  : 95%
builder : spender presses          : 325 : 156     (build, build, spend)
ultimates per pull                 : Quad 2.1 · Pentagram 1.5 · Megahealth 1.5
```

A Thunderbolt is 38,000 on its own and 89,680 inside the window. That number is the whole
design in one line.

The bot priority lists are the rotation written down, which is the fastest way to tell
whether a kit actually interlocks — if it does, the list reads like a sentence:

```json
{ "if": "bossCastingInterruptible", "do": "cast:lightning" },
{ "if": "ultimateReady",            "do": "cast:quad" },
{ "if": "targetHasAura:cracked",    "do": "cast:lightning" },
{ "if": "resourceAbovePct:45",      "do": "cast:rocket" },
{ "else": true,                     "do": "cast:nailgun" }
```

All four 2D play styles were re-measured after the mode rules landed and sit at Raid 37%,
Arena 54%, Souls 50%, Action 41%, killing in 3:26–3:46 against a 4:30 enrage.

### The practice range

Every game starts you in a lobby, and the lobby is now a range you can set up. Press `P`
(or the switches directly) and you get:

| | |
|---|---|
| **Dummy** | A training dummy that does not hit back, or **any one boss mechanic on a loop** — Lava Geyser, Chain of Souls, Void Well, Slipgate Rift, Rune of Black Magic, Magma Cleave. The drills are built out of Chthon's own abilities, so what you practise is exactly what you meet |
| **Switches** | `V` invulnerable · `B` infinite resources · `N` no cooldowns. Learn the movement without the mechanic ending the lesson, or learn the rotation without waiting on the bars |
| **Speed** | `T` cycles 1× / 0.5× / 0.25×. Slow motion scales how fast the sim's clock is *fed*, never the tick itself — same fight, same determinism, four times as long to read a telegraph |
| **Game and role** | Switch mode or role without leaving the game. The range rebuilds around you |
| **Kit card** | `H` shows your four buttons, what each one does, how they feed each other, and everything that makes this mode different |

A live damage- or healing-per-second readout tells you whether the loop is working. Press
`E` (or Start) and the real thing walks in. Nothing you set in the range follows you into
the pull.

### Quality of life

Things that were invisible and are now on screen:

- **Floating combat numbers.** Your own hits are big and gold, other people's are small and
  grey, damage taken is red, healing green, and a flanking hit is marked. They come out of
  the sim as snapshot events, so the renderer cannot invent one.
- **The fight timeline.** The next four boss abilities with countdowns, bottom right.
  Learning a fight is learning that list; there is no reason to hide it.
- **Threat, guard, heat, momentum, item timers** — each mode's own numbers, drawn only in
  the mode that has them (see below).
- **A combat log feed** — the last five lines, bottom left, colour-coded by kind.
- **A wipe/kill report** that says what killed *you*, at what time, your damage and healing
  per second, and the order the party went down in — with **Pull again** and **Back to the
  range** rather than a walk back through the menu.
- **The camera stops climbing over your head.** Backed into a corner, the boom now shortens
  along its own line instead of clamping into the wall and pitching straight down (which
  put the boss off the top of the screen), and your own body fades out when the camera ends
  up against your back.

### What makes each mode different

The camera alone was not enough, and one signature each was not enough either. Each mode
now carries a signature plus two more things its genre actually does — all of it declared
as a `rules` block in `content/games.json` and read in exactly one file, `engine/rules.js`:

| | Signature | And also |
|---|---|---|
| **Azeroth** | **Frontal cleave** — Magma Cleave comes out of the boss's face in a 130° cone, so the tank's job is pointing it away from everyone. The bot tank does exactly that: cleave went from hitting 2.8 people a cast to 1.6 | A **threat meter** — everyone's threat as a share of whoever is holding it, with a warning before you pull. The number a WoW player actually plays against · **cast bars** you have to stand still for |
| **Slipgate** | **Pickups** — Quad Damage, Megahealth and now **Red Armour** spawn on the floor on a timer and you have to go and stand on them | **Momentum** — hold a direction and you wind up to +13% speed; stop and you lose all of it, instantly · **item timers** in the HUD, because timing the items *is* the map knowledge |
| **Overload** | **Barrier** — the Vanguard's ultimate becomes a deployed absorb pool across the party rather than a damage reduction | **Overheat** — the held primary builds heat and redlines, locking the whole kit except the ultimate for 1.6s. Holding the trigger is not a strategy · **ultimate combos** — two ultimates live in the same 7s window and the whole party is Overloaded (+30% damage and healing, −15% taken), with everyone's charge on screen so you can hold yours for theirs |
| **The Pit** | **Parry** — raise your guard in the 0.35s before a blow lands and you turn it aside completely | **Poise** — the boss has a guard bar. Ordinary hits chip it, hits from behind chip it 2.5× harder, a parry takes a chunk out of it, and breaking it opens a 3s window where it cannot act and takes 35% more · **swings cost stamina**, so attacking, rolling and blocking all draw on one bar |

Poise is the clearest example of why this is a trinity game: the tank opens the window by
reading the wind-up, and the damage dealer is the one who spends it.

Measured over 600 headless pulls each — four bots, no human:

```
Azeroth 41%   Slipgate 56%   Overload 59%   The Pit 47%      kills 3:26-3:43 vs a 4:30 enrage
```

Overheat is the one mechanic the headless runner cannot see: bots are gated by their
decision loop (one action every ~1.5s), not by fire rate, so they never build enough heat
to redline. It is a player-facing rhythm, and Overload's 59% should be read as the most
forgiving of the four rather than as evidence that heat costs nothing.

### Controller

Sticks move and look, `A B X Y` are the four abilities, `RT` is primary fire, `LT` blocks,
`RB` dodges, `LB` cycles target, `Start` pauses. Polled through the Gamepad API once a
frame, so anything that reports as a pad works. The HUD says "controller" when it sees one.

### What is real and what is not

Real: the arena, the four cameras, mouse-look and camera-relative movement, telegraphs and
healing fields drawn on the floor, nameplates, the full HUD, dodge rolls with i-frames,
held block with stamina, lock-on facing, and the entire encounter running underneath it at
the tuned difficulty.

Also real: the practice range with its drills and switches, floating combat numbers, the
fight timeline, and each mode's own meters.

Not yet: split screen, animations, sound, projectiles you can see, and any art beyond
primitives. The end goal is two people on one couch with pads — controller support is in
now, and the engine already runs on a list of controlled units, so what is left is a second
input source and a second viewport rather than an architectural change.

## The 2D build

The original grid version is still here, and still the place where balance gets decided —
it runs the same engine, and the headless runner (below) is what tuned everything the 3D
build inherits.

### Three ways to play it

All three are solo — you drive one character and three bots fill the rest. They differ in
what a session *is*.

| Mode | What it is |
|---|---|
| **Solo** | One pull. Kill him, or wipe. The default and the point. |
| **Gauntlet** | A run: kill him three times without a rest. Health carries between stages, the pit rolls a new modifier each time, and between rounds you take one Quake pickup — Quad Damage, Pentagram, Megahealth, Biosuit — and keep it for the rest of the run. |
| **Drill** | Practice. Pick one mechanic and it comes at you on a loop with nothing else going on. He cannot be killed and you are not trying to: the score is how many repetitions you stood through, and how many of them landed on you. |

Drill builds its fight out of Chthon's own abilities rather than inventing anything, so
what you practise is exactly what you meet.

Two further modes — **Commander** (drive all four with tactical pause) and **Gambit**
(write the bots' priority lists, then watch) — are built and tested but marked
`"hidden": true` in `content/modes.json`, because neither is what this game is about.
Delete that line to get them back.

### Modifiers

Stackable encounter tweaks, toggled on the pull screen (and rolled for you in Gauntlet). Each is a few numbers in
`content/modifiers.json`, and each was calibrated against the headless runner rather than
guessed — the bot win rate is on the chip:

| Modifier | Effect | Bots win |
|---|---|---|
| — | the encounter as tuned | 45% |
| **Volcanic** | Lava Geyser marks two extra tiles | 18% |
| **Quickening** | every telegraph resolves 45% sooner | 24% |
| **Short Fuse** | Quad Damage 55s early — your kill has to beat it | 16% |
| **Swarm** | twice as many Scrags, at under half health each | 27% |
| **Fog of War** | no countdowns on the ground | 45%* |

Modifiers apply to generated encounters too. \* Fog of War costs the bots nothing — they were never reading the numbers. It is aimed
squarely at you, which is the honest way to describe it. Modifiers stack: Volcanic + Swarm
is 8.7%.

### Procedural encounters (command line)

There is also a generator: `engine/generate.js` rolls a whole boss from a seed —
theme, name, four or five mechanics, two or three phases — allocating their numbers out of
a damage budget, and `engine/tune.js` fits it against the headless sim until it lands in a
playable band. Over 40 seeds, 95% land there, median win 50%, ~3.4s each.

```
node sim.js --boss random --seed 4417 --runs 100
```

It is deliberately **not** in the game's UI: the handcrafted fight is the one worth
playing, and a menu full of procedural options was getting in the way of that. The code is
kept because the tuner is genuinely useful for balancing anything you add by hand.

### Four axes of play style

How you move, how you attack, how you heal and how you tank are four **independent**
choices, not one setting. Any combination is legal — dodge rolls with party frames,
click-to-move with body-block tanking — and the engine has no idea which is driving it.
It all lives in `content/styles.json`.

| Axis | Options |
|---|---|
| **Movement** | *Click to move* · *Free run* (WASD) · *Dodge roll* (WASD + an i-frame roll on Shift, costs stamina) · *Rocket jump* (WASD + a long leap, no invulnerability) |
| **Combat** | *Tab target* (target sticks, 1.5s GCD, cast bars) · *Crosshair* (no lock at all, weapon fire rates, no GCD) · *Lock on* (locked target, you strafe while facing it, hits only land in a 100° arc, +20% from behind) |
| **Healing** | *Party frames* (click a portrait) · *Aimed* (heal who you point at) · *Smart* (always the lowest) · *Ground fields* (heals are dropped on the floor and tick on whoever stands in them) |
| **Tanking** | *Threat table* (aggro and taunts) · *Active block* (hold Ctrl or right mouse, drains stamina, breaks if you run dry) · *Body block* (no threat table at all — it swings at whoever is nearest) |

The trinity survives all of it, which was the point of the exercise. Ground healing turns
the healer into someone arguing with the party about where to stand; body-block tanking
turns holding aggro into a physical job; lock-on makes "get behind it" worth 20% and gives
the tank a reason to care which way the boss is facing.

**Every option is measured, not guessed.** Holding the other three axes at the raid
baseline (47% of pulls survived) and varying one:

| | | | |
|---|---|---|---|
| movement | click 47% · free 47% | dodge 57% | blink 53% |
| combat | tab 47% · crosshair 45% | lockon 42% | |
| healing | frames / aimed / smart 47% | ground 33% | |
| tanking | threat 47% | block 53% | guard 35% |

Everything sits inside 33–57%, so feel dominates over difficulty when you compare them.
The presets stack their axes though, and the numbers on the buttons say so: Raid 37%,
Arena 54%, Souls 50%, Action 41% (400 pulls each).

Tuning that took three real fixes the sim caught: lock-on **deadlocked** (you must face a
target to cast, and facing only changed when casting — so nobody ever attacked), bot tanks
**never blocked**, making active mitigation a tank with no mitigation, and the block
strength lived hardcoded in the aura file so the number in `styles.json` was decorative.

```
node sim.js --style souls --runs 150
```

## Architecture

```
/engine   clock.js  geometry.js  rng.js  auras.js  abilities.js  ai.js  state.js  tick.js
/content  abilities.json  auras.json  units.json  parties.json  schemes.json  modes.json
          modifiers.json  bosses/*.json  ai/*.json  load.js
/engine   generate.js  tune.js          procedural encounters and their auto-tuning
/ui       render.js  input.js  log.js  gambit.js  styles.js  simworker.js
/engine   rules.js                         per-mode rules: momentum, poise, heat, ult combos
/3d       game.js  scene.js  camera.js  controls.js  hud.js  floaters.js
/vendor   three.module.js                three.js r160, committed rather than installed
/tests    engine.test.mjs
sim.js    headless balance runner (node)
main.js   browser entry: owns the 100ms clock, nothing else
index.html
```

Every one of those axes — mode, control scheme, modifier, boss, party, ability, aura, bot
priority list — is a JSON file. The engine gained four small hooks for all of it: who is in
`state.playerIds`, a global-cooldown lookup, a telegraph multiplier, and an add-count knob.

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

## Porting this to a 3D engine — how it actually went

The layout was arranged so the expensive half would survive a port, and then it was ported,
so this section is a record rather than a prediction. It took one session, the sim was not
touched, and the only real work was a renderer and four camera rigs.

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

Going to actual 3D afterwards cost nothing further, because the coordinate work had already
happened: one sim cell was declared to be three metres and the encounter came along
unchanged. The bugs were all in the new code, and all of the same kind — sign errors in the
camera basis. The camera sat *in front* of the player instead of behind, W ran backwards,
and the Souls rig looked away from the thing it was locked onto.

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

Flags: `--boss chthon --party default --scheme raid|arena --modifiers a,b --runs N --seed N
--verbose`. The same runner is in the browser behind Gambit mode's *run N pulls*.

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

## Two players

The engine already runs on `state.playerIds` — a list, not a single player — and every
input carries the unit it speaks for, so two people driving two characters with two bots
filling in is not an architectural change. What is missing is only the transport: some way
for a second machine's input queue to reach this one, and a snapshot going back. The sim
being deterministic and tick-based is the hard part of that problem, and it is already
done.

## Deliberately not here

3D. Networking. Loot. Talent trees. Classes past the four archetypes. A
second boss. Animations. Save files. Difficulty modes. Sound. None of them would make a
bad core loop good — so the loop got the time instead.
