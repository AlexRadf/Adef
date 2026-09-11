# Sector-4: Skyscraper Ascent

A 4-player co-op tactical sci-fi boss-rush in Godot 4 (Forward+). Four operatives ascend an
industrial cyberpunk megastructure floor by floor: breach the elevator, take the room apart
one pull at a time, hold a terminal while it unlocks, kill what is behind the door, ride up.

This is an implementation of the Sector-4 technical design document. Section numbers below
refer to it.

```
godot --path sector4                     # play it
GODOT=/path/to/godot ./tools/check.sh    # compile everything, run the tests
```

## The floor loop (§1)

`FloorDirector` is the state machine, and the order is the design — you cannot reach the boss
without clearing the room, and you cannot open the door without holding the terminal.

```
ELEVATOR BREACH -> TACTICAL TRASH -> SECURITY OVERRIDE -> SECTOR BOSS -> ELEVATOR ASCENT
```

## The four seats (§1.1)

Roles are exclusive in the lobby, because a party without a trinity is a party that cannot
finish a floor. Each is four to six buttons, mapped straight to the pad with no modifier
states and no combo strings.

| | Primary | And |
|---|---|---|
| **Enforcer** (tank) | Riot Carbine, 4× threat | **Directional Shield** — only mitigates what it faces · **Dart Pull** — takes one mob out of a pack · Bulwark Slam |
| **Field Medic** (healer) | Disruptor Pistol — crits refund 10% Nano-Energy | **Nano-Injector** soft-locked beam · **System Purge** · **Smart Nano-Pulse** · **Overclock Surge** |
| **Kinetic Striker** (melee) | Mono-Blade, 1.6× from behind | **Servo Kick** — the interrupt · Static Snare · Blur Step |
| **Railgun Specialist** (ranged) | Railgun, charged | Concussion Round — knockback · Seeker Drone · Orbital Lance |

## The staging deck

You join into a **hub**, not a menu. The deck is a room you walk around with the same
character, camera and controls as the fight, so it doubles as somewhere to get used to moving
before anything is shooting at you — and the rest of the squad is standing on it, so you can
see who you are about to deploy with.

Three stations, walked up to and used with `G` / `A`:

| | |
|---|---|
| **Armoury** | Fit modules. Every module and its trade-off spelled out, plus the net effect of the whole loadout |
| **Roster** | Change seat. One of each; bots fill whatever nobody takes |
| **Mission Table** | Pick a floor and deploy. The squad drops together |

A run ends back on the deck rather than at a dead end, and the pause screen can abort to it.

### Equipment that is actually equipment

A module is a **passive status effect** — the same struct the boss's debuffs use. That is the
whole system: equipment goes through the identical modifier walk as a Corrosive Vent, so there
is no second set of arithmetic for gear and a module can never modify something the combat
resolver does not already understand.

Three slots, eight modules, and **most of them cost you something**:

| | |
|---|---|
| **Reinforced Plating** | Plating +35%, Movement −8% |
| **Servo Actuators** | Movement +14%, Plating −12% |
| **Overclocked Coils** | Attack speed +20%, Damage taken +15% |
| **Trauma Protocol** | Healing done +22%, Damage dealt −10% |

Three slots of pure upside is a menu you click through once and never open again. The armoury
shows each module's modifiers and the combined effect of everything fitted, so the trade is
visible as a total rather than as a pile of separate lines. Loadouts are saved to disk per
role, and an old save silently drops modules that no longer exist.

## The HUD

Everything a player needs mid-fight, in a fixed place:

- **Objective panel** (top left) — the current phase, and the specific countable thing in the
  way: *"2 hostiles remaining · pull one pack at a time"*, *"Stand on it. 64% · adds incoming"*.
  Vague objectives are the same as no objective.
- **Party roster** — four rows in a stable order, health, role, who is a bot, and any debuff
  they are carrying. The world-space frames tell you about whoever you are looking at; this
  tells the healer about the person behind them.
- **Ability bar** — your whole kit with pad and keyboard prompts, cooldown eating each slot
  from the bottom, and cost. A new player can read their role off the bottom of the screen.
- **Arena reticle** — Nano-Energy left, soft-locked target health right, debuffs flashing above.
- **Floating combat numbers** — yours big and gold, other people's small and grey, damage taken
  red, healing green. Without these there is no feedback loop at all.
- **Boss bar and cast bar** — Core Overcharge gets the loudest thing on screen.

`Escape` opens the **pause screen**: resume, a kit card spelling out what every button does and
why you would press it, and leave-to-lobby. A solo run genuinely stops the world; a multiplayer
one deliberately does not, because one client cannot pause a shared simulation — and the menu
says which of the two you are in rather than quietly behaving differently.

Enemies **go down** rather than freezing upright: they topple, settle, fade and clear themselves
away, with collision dropped so a corpse never blocks the room. A downed operative topples too
but stays put and stands back up, because they can still be revived. Trash is tinted by type,
so the thing that casts at you does not look like the thing that punches you.

## Bots fill the empty seats

Every boss ability is answered by a specific seat — the tank turns Plasma Sweep away, the
Striker kicks Core Overcharge, the Medic triages System Shockwave. So a short party is not a
harder game, it is an unfinishable one. Any seat without a human gets a `BotBrain`.

A bot is a **priority list**, read top to bottom, first rule that both matches *and* produces a
usable action. Writing the rotation down like this is the fastest way to tell whether a kit
interlocks — if it does, the list reads like a sentence:

```json
{ "if": "enemy_casting_interruptible", "do": "use:kick" },
{ "if": "self_in_hazard",              "do": "use:rocket_dash" },
{ "if": "caster_add_up",               "do": "use:static_snare" },
{ "else": true,                        "do": "use:mono_blade" }
```

The list decides what to press. **Steering runs underneath it every frame** and decides where
to stand, which is what stops "walk out of the fire" and "heal the tank" from fighting over the
same slot. The tank's steering is the interesting one: it stands on the far side of the boss
from the party's centre of mass, which drags the boss round to face away from everyone — the
doc's Plasma Sweep counter, as a position rather than a scripted reaction.

Bots do not react instantly. Each seat carries a reaction delay of 0.35–0.95s before it acts on
a condition, and the interrupt gets a much shorter fuse because a 4 second window is not
forgiving enough for a human-shaped pause. One number, and it is the single biggest reason a
party of bots reads as people rather than as a machine.

Bots never bypass validation: every press goes through the same `RoleKit.server_fire` a human's
button reaches, so a bot cannot do anything a player could not.

## Controller scheme (§2)

Bound in `project.godot`, so they are real actions rather than hardcoded key checks.

| Input | Action | Field Medic |
|---|---|---|
| RT / R2 | `fire_primary` | Disruptor Pistol |
| RB / R1 | `heal_beam` | Nano-Injector (held channel) |
| LB / L1 | `ability_dispel` | System Purge |
| LT / L2 | `ability_dash` | Rocket Dash |
| X / Square | `smart_pulse` | Smart Nano-Pulse |
| Y / Triangle | `ultimate` | Overclock Surge |
| D-Pad Right | `mark_target` | Focus Marker |
| R3 | `toggle_camera` | 0.0m / 2.5m / 5.0m |

The camera is a `SpringArm3D`, so backing into a wall shortens the boom along its own line
instead of clipping through it, and the body fades out as the camera closes on it.

## Tactical pulling (§3)

The three rules that make a pull a decision rather than a sprint, all in `TrashMob.gd`:

- **Packs of 2–4.** Shooting one brings its squad and nothing beyond it. The squad wakes on a
  small stagger so it reads as people reacting rather than four bodies turning on one frame.
- **Line-of-sight pulling.** A Code-Disruptor that can see you *stands where it is and shoots*.
  The only thing that moves it is breaking line of sight — which is why `Floor.gd` builds
  pillars and a doorway in code: the geometry is gameplay, not decoration.
- **Patrols.** They walk their route regardless of what you pulled. Pull on a bad timer and
  they walk into it.

Failure is debuff-first: standing in a hazard costs you **Neural Glitch** (−25% attack speed)
rather than a chunk of health, so the mistake lands on the person who made it instead of on
the healer.

## Soft-lock targeting (§4)

`SoftLockTargeting.gd`. Every frame it scores candidates in screen space:

```
score = dot(cam_forward, to_target) × 0.50      # angle
      + (1 − health_pct)            × 0.35      # triage
      − (dist / 35m)                × 0.15      # distance
      + 0.20 if it is already the target        # sticky
```

The sticky bonus is the whole reason it feels stable — without it the reticle flickers between
two people standing on top of each other, and a heal beam that flickers is a heal beam that
misses.

Two deliberate changes from the document's snippet:

1. It is a **component**, not a `CharacterBody3D`, and it is generalised so the Enforcer's Dart
   Pull scores enemies with the same code. One soft-lock, two jobs, rather than two
   implementations that drift apart.
2. The document's line-of-sight check does `query.exclude = [self]`. In Godot 4 that field takes
   **RIDs**, not nodes, so the exclusion silently does nothing. Fixed here.

## The Arena Reticle (§5)

Nano-Energy arcs down the left of the crosshair, the soft-locked target's health down the
right, debuffs flash above it, and party frames project over people's heads via
`unproject_position`. Nothing that matters mid-fight lives in a corner of the screen.

Core Overcharge gets the loudest thing on the display. It is the one cast that kills everybody,
and a party that misses it should never be able to say they did not see it.

## Unit-01: Iron Centurion (§6)

50,000 HP. Four abilities, each of which is a different person's job.

| Ability | Every | Cast | What it does | Whose problem |
|---|---|---|---|---|
| **Plasma Sweep** | 12s | 2.0s | 90° frontal cone, turning locked on cast start | Tank points it away |
| **Corrosive Vent** | 18s | 1.5s delay | Floor grid under a ranged player (**Neural Glitch**) + **System Corroded** on the tank | Dash out; purge the tank |
| **System Shockwave** | 25s | 1.5s | Unavoidable, 35% of everyone's max HP | Healer triages |
| **Core Overcharge** | 0:45, 1:30 | 4.0s | Wipes the party | Striker kicks it |

Below 50% the **recurring cycle** accelerates by 25% — including timers already counting, so the
enrage is felt immediately. The **scripted** Core Overcharges deliberately do *not* accelerate:
they are the fight's clock, and a clock that moves is a clock nobody can learn.

## Networking (§7)

ENet, server-authoritative. Peer 1 owns boss AI, damage, hazards and floor transitions.
Movement and camera run locally so the controls have no input latency; `MultiplayerSynchronizer`
resyncs position.

The client decides **intent** — which button, pointed where, at whom — and the server decides
**outcome**. The client's soft-lock choice travels as a suggestion, and the server re-checks
range and line of sight before honouring it, so a client that lies about what it can see gets
nothing for it. A client can mispredict where it is standing and be corrected; it can never
mispredict a kill.

Solo is a one-peer server rather than a separate mode, so a lone tester exercises the same code
path as a full party.

## Architecture

```
scripts/autoload   Content.gd (every tuning number)  Combat.gd (the damage choke point)
                   Net.gd (ENet + roster)  GameEvents.gd (signal bus)
scripts/components Health · StatusEffect · Threat · Ability · Cast · Combatant
scripts/player     PlayerCharacter · CameraRig · SoftLockTargeting · roles/*
scripts/enemies    TrashMob · AggroPack · boss/IronCenturion
scripts/floor      FloorDirector · SecurityTerminal · Floor
scripts/ui         ReticleArcs · WorldFrames · EncounterHud · Lobby
tests              TestRunner — 128 headless assertions
```

Two rules carry the codebase:

**Every point of damage and healing goes through `Combat.apply_damage` / `apply_heal`.** They
walk the source's modifiers, then the target's, apply the directional shield and armour, feed
the threat tables and emit the events the HUD draws from. Shields, corrosion, i-frames, lifesteal
and the enrage are all just modifiers — so a new mechanic never means new arithmetic in twelve
places.

**Every number lives in `Content.gd`.** Abilities, statuses, roles, the boss cycle, the trash
packs and the floor layout are data. Retuning the ascent never means touching behaviour code.

One consequence worth naming: `system_corroded` is `{"armor": 0.70}`, and Combat applies it to
the *mitigation* rather than to the damage multiplier. "−30% armour" has to mean the Enforcer
takes **more**; applying it the obvious way would have made a corroded tank tougher. There is a
test that fails if anyone changes that.

## What is real, and what is not

**Real.** The floor loop end to end, all four kits, the soft-lock scorer, aggro-linked packs
with line-of-sight pulling and patrols, the full boss cycle with enrage and a wipe you can
prevent by kicking it, the reticle HUD, bots in every empty seat, and the ENet layer with
server-authoritative damage. `tools/check.sh` compiles every script and scene and runs 176
assertions — including a suite that boots a real floor with a real party, pulls a real pack,
holds the terminal and kills the boss, and one that proves the Striker bot actually kicks Core
Overcharge before it wipes the party.

`res://tests/Soak.tscn` is the other half of that: a watchable run with no human in it at all,
printing the phase, what is alive, everyone's health and what each seat pressed. A party of
four bots clears the first room in about forty seconds, holds the Security Override, walks into
the boss chamber and fights the Iron Centurion at roughly **385 damage a second** — a ~130
second kill, which is what the Core Overcharge schedule at 0:45 / 1:30 / 2:15 was written for.

### Rocket Dash

Displacement is `impulse² / (2 × decay)`, so those two numbers together decide both how far it
carries and how violent it feels getting there. A high impulse with a hard decay reads as a
teleport; it is tuned as a boost instead.

The Field Medic's version is not a shove forwards at all — it solves the impulse from the
distance to an ally and **charges to them**, stopping just short so it does not push the person
being saved. The healer's emergency is almost always "get to that person", not "get over there".
It picks the reticle target, else whoever is worst off, and refuses if they are out of range,
because a charge that falls short is worse than no charge.

## Seeing it

`res://tests/Shot.tscn` renders a real frame of the running game and saves a PNG:

```
SHOT_DELAY=26 xvfb-run -a godot --path . \
    --rendering-driver opengl3 --resolution 1600x900 res://tests/Shot.tscn
```

This is not optional polish. The assertion suite proves the simulation is right; it cannot tell
you that the camera is inside the player's head, that the operative's own body is filling half
the screen, or that six nameplates have piled into one word. Every one of those was found by
looking at a screenshot, and none of them by a test.

The other one it found: **movement was not camera-relative.** The rig is parented to the body
and the body turns to follow the rig, so setting a *local* rotation on the rig applied it on top
of the body's own — the camera ended up at roughly double the yaw the movement basis was
computed from, and "forward" drifted further from the screen the more you turned (51.6° off at
0.9 rad, near-reversed at 3.0). The rig is now `top_level`: it owns its orientation outright and
follows the body's position. There is a test that compares the camera's real global basis
against the vector movement actually uses.

That number is also how the worst bug in the project so far was found. The press tally showed
`kinetic_striker/mono_blade` firing **zero** times across an entire run: the Striker never
landed a single swing. Godot's forward is `-Z`, so facing a target needs `atan2(-dx, -dz)` —
and the intuitive `atan2(dx, dz)` points a body *exactly backwards*. Every bot, every trash mob
and the boss had it. Nothing errors; melee arcs simply never connect, the Enforcer's shield
guards the wrong side, and Plasma Sweep's frontal cone fires into the people standing behind
the boss. Fixing it took bot damage from ~80 a second to 385. It now lives in one function,
`Combatant.yaw_toward`, with a test that checks the body's actual forward vector.

**Not real yet.** Art beyond primitives, animation, sound, and visible projectiles. Only one
floor is authored (`Content.FLOORS`), so **Elevator Ascent** currently ends the run rather than
building the next floor — `advance_floor()` is written and takes the second entry the moment
one exists.

**Untested by me, and worth saying plainly.** Nobody has played this with a controller, and no
two machines have ever connected to each other — the networking is validated in a single
process, which exercises the RPC paths and the authority checks but not latency, packet loss,
or reconnection. The balance numbers (damage, health, healing throughput) are a coherent first
pass sized against a ~2 minute boss fight; they are not tuned against anyone actually playing.
Expect to retune rather than to rewrite.
