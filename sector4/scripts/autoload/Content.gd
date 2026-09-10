extends Node
## Every tuning number in the game, in one file.
##
## The engine reads this and nothing else for balance. Abilities, status
## effects, roles, the boss cycle and the trash packs are all data, so
## retuning the ascent never means touching behaviour code.

# ---------------------------------------------------------------- schools

enum School { KINETIC, THERMAL, ELECTRICAL, CORROSIVE, NANO }

# ------------------------------------------------------------ status FX
#
# A status effect is a duration plus a bag of stat multipliers. Everything
# that modifies a number in this game -- the debuffs the boss applies, the
# buffs the ultimates grant, the dash i-frames -- is one of these, so
# damage and healing only ever walk one list.
#
#   dispel_type: what strips it. Only "performance" responds to the Field
#                Medic's System Purge, which is what makes that button a
#                decision rather than a reflex.

const STATUS_EFFECTS := {
	"neural_glitch": {
		"display_name": "Neural Glitch",
		"duration": 8.0,
		"harmful": true,
		"dispel_type": "performance",
		"alert_color": Color(1.0, 0.72, 0.15),
		"modifiers": {"attack_speed": 0.75},
	},
	"system_corroded": {
		"display_name": "System Corroded",
		"duration": 12.0,
		"harmful": true,
		"dispel_type": "performance",
		"alert_color": Color(0.55, 0.95, 0.35),
		"modifiers": {"armor": 0.70},
	},
	"overclocked": {
		"display_name": "Overclock Surge",
		"duration": 8.0,
		"harmful": false,
		"dispel_type": "",
		"alert_color": Color(0.35, 0.9, 1.0),
		"modifiers": {"attack_speed": 1.35, "lifesteal": 1.0},
	},
	# The shield's mitigation is deliberately NOT a modifier: it only
	# applies to blows arriving inside the arc, so Combat has to check the
	# direction. Putting 0.45 in `modifiers` here would quietly make the
	# Enforcer immune from behind, which is the opposite of the point.
	"guarded": {
		"display_name": "Directional Shield",
		"duration": 3.0,
		"harmful": false,
		"dispel_type": "",
		"alert_color": Color(0.6, 0.75, 1.0),
		"modifiers": {},
		"guard_mult": 0.45,
	},
	"dash_iframes": {
		"display_name": "Rocket Dash",
		"duration": 0.35,
		"harmful": false,
		"dispel_type": "",
		"alert_color": Color(1, 1, 1),
		"modifiers": {"damage_taken": 0.0},
	},
	"interrupt_lockout": {
		"display_name": "Locked Out",
		"duration": 5.0,
		"harmful": true,
		"dispel_type": "",
		"alert_color": Color(1.0, 0.4, 0.4),
		"modifiers": {},
	},
	"enraged": {
		"display_name": "Enrage",
		"duration": 0.0,
		"harmful": false,
		"dispel_type": "",
		"alert_color": Color(1.0, 0.25, 0.2),
		"modifiers": {"cast_rate": 1.25},
	},
	"focus_marked": {
		"display_name": "Focus Marker",
		"duration": 20.0,
		"harmful": true,
		"dispel_type": "",
		"alert_color": Color(1.0, 0.2, 0.2),
		"modifiers": {},
	},
}

# ------------------------------------------------------------- abilities
#
# `input` names the action from the controller table in section 2. An
# ability with no `input` is driven by AI or by the boss timeline.

const ABILITIES := {
	# -- Field Medic ---------------------------------------------------
	"disruptor_pistol": {
		"display_name": "Disruptor Pistol",
		"input": "fire_primary",
		"kind": "projectile",
		"cooldown": 0.30,
		"cost": 0.0,
		"damage": 13.0,
		"school": School.NANO,
		"range": 30.0,
		"crit_chance": 0.20,
		"crit_mult": 2.0,
		"crit_energy_refund_pct": 0.10,
		"desc": "Primary filler. Critical hits refund 10% Nano-Energy.",
	},
	"nano_injector": {
		"display_name": "Nano-Injector",
		"input": "heal_beam",
		"kind": "channel_beam",
		"cooldown": 0.0,
		"cost_per_second": 9.0,
		"heal_per_second": 58.0,
		"range": 35.0,
		"desc": "Soft-locked channel beam. Steady HP restoration on the reticle target.",
	},
	"system_purge": {
		"display_name": "System Purge",
		"input": "ability_dispel",
		"kind": "dispel_projectile",
		"cooldown": 6.0,
		"cost": 12.0,
		"dispel_types": ["performance"],
		"heal_on_cleanse": 60.0,
		"range": 35.0,
		"desc": "Strips System Corroded and Neural Glitch from an ally.",
	},
	"rocket_dash": {
		"display_name": "Rocket Dash",
		"input": "ability_dash",
		"kind": "dash",
		"cooldown": 5.0,
		"cost": 0.0,
		"impulse": 17.0,
		"grants": "dash_iframes",
		"desc": "Directional impulse. Clears a hazard zone instantly.",
	},
	"smart_nano_pulse": {
		"display_name": "Smart Nano-Pulse",
		"input": "smart_pulse",
		"kind": "smart_heal",
		"cooldown": 9.0,
		"cost": 30.0,
		"heal": 280.0,
		"range": 40.0,
		"desc": "Auto-targets and heals the lowest-percentage HP ally in the room.",
	},
	"overclock_surge": {
		"display_name": "Overclock Surge",
		"input": "ultimate",
		"kind": "ground_field",
		"cooldown": 60.0,
		"cost": 50.0,
		"radius": 7.0,
		"duration": 8.0,
		"grants": "overclocked",
		"desc": "ULTIMATE. Deployed field: team attack speed up, 100% lifesteal on primaries.",
	},
	"focus_marker": {
		"display_name": "Focus Marker",
		"input": "mark_target",
		"kind": "mark",
		"cooldown": 1.0,
		"cost": 0.0,
		"range": 60.0,
		"desc": "Marks a mob. AI DPS focus it; the AI Tank pulls it.",
	},

	# -- Enforcer (tank) -----------------------------------------------
	"riot_carbine": {
		"display_name": "Riot Carbine",
		"input": "fire_primary",
		"kind": "projectile",
		"cooldown": 0.55,
		"cost": 0.0,
		"damage": 34.0,
		"school": School.KINETIC,
		"range": 25.0,
		"threat_mult": 4.0,
	},
	"directional_shield": {
		"display_name": "Directional Shield",
		"input": "heal_beam",
		"kind": "guard",
		"cooldown": 8.0,
		"cost": 20.0,
		"arc_degrees": 140.0,
		"grants": "guarded",
		"desc": "Physical shield. Only mitigates what comes at your face.",
	},
	"dart_pull": {
		"display_name": "Dart Pull",
		"input": "ability_dispel",
		"kind": "taunt_projectile",
		"cooldown": 4.0,
		"cost": 0.0,
		"damage": 20.0,
		"school": School.KINETIC,
		"range": 45.0,
		"threat_mult": 12.0,
		"desc": "Single-target line-of-sight pull. Alerts the target's pack and nothing else.",
	},
	"bulwark_slam": {
		"display_name": "Bulwark Slam",
		"input": "ultimate",
		"kind": "aoe_taunt",
		"cooldown": 45.0,
		"cost": 50.0,
		"radius": 8.0,
		"damage": 60.0,
		"school": School.KINETIC,
		"threat_mult": 8.0,
	},

	# -- Kinetic Striker (melee DPS) -----------------------------------
	"mono_blade": {
		"display_name": "Mono-Blade",
		"input": "fire_primary",
		"kind": "melee",
		"cooldown": 0.45,
		"cost": 0.0,
		"damage": 62.0,
		"school": School.KINETIC,
		"range": 3.2,
		"arc_degrees": 110.0,
		"backstab_mult": 1.6,
	},
	"kick": {
		"display_name": "Servo Kick",
		"input": "ability_dispel",
		"kind": "interrupt",
		"cooldown": 12.0,
		"cost": 0.0,
		"damage": 25.0,
		"school": School.KINETIC,
		"range": 3.5,
		"lockout": 5.0,
		"desc": "Interrupt. The answer to Core Overcharge.",
	},
	"static_snare": {
		"display_name": "Static Snare",
		"input": "smart_pulse",
		"kind": "cc",
		"cooldown": 18.0,
		"cost": 25.0,
		"range": 14.0,
		"duration": 6.0,
		"desc": "Crowd control. Holds one add out of the fight.",
	},
	"blur_step": {
		"display_name": "Blur Step",
		"input": "ultimate",
		"kind": "burst_buff",
		"cooldown": 50.0,
		"cost": 50.0,
		"duration": 6.0,
		"grants": "overclocked",
	},

	# -- Railgun Specialist (ranged DPS) -------------------------------
	"railgun": {
		"display_name": "Railgun",
		"input": "fire_primary",
		"kind": "hitscan_charge",
		"cooldown": 1.20,
		"charge_time": 0.75,
		"cost": 0.0,
		"damage": 185.0,
		"school": School.ELECTRICAL,
		"range": 90.0,
		"headshot_mult": 1.5,
	},
	"concussion_round": {
		"display_name": "Concussion Round",
		"input": "ability_dispel",
		"kind": "knockback",
		"cooldown": 14.0,
		"cost": 20.0,
		"damage": 40.0,
		"school": School.KINETIC,
		"range": 40.0,
		"knockback": 12.0,
		"desc": "Add knockback and hazard management.",
	},
	"seeker_drone": {
		"display_name": "Seeker Drone",
		"input": "smart_pulse",
		"kind": "turret",
		"cooldown": 25.0,
		"cost": 30.0,
		"duration": 12.0,
		"dps": 45.0,
	},
	"orbital_lance": {
		"display_name": "Orbital Lance",
		"input": "ultimate",
		"kind": "beam_line",
		"cooldown": 55.0,
		"cost": 50.0,
		"damage": 900.0,
		"school": School.THERMAL,
		"range": 90.0,
	},

	# -- Boss ----------------------------------------------------------
	"plasma_sweep": {
		"display_name": "Plasma Sweep",
		"kind": "boss_cone",
		"cast_time": 2.0,
		"arc_degrees": 90.0,
		"range": 14.0,
		"damage": 420.0,
		"school": School.THERMAL,
		"locks_turning": true,
		"desc": "90 degree frontal cone. Turning angle locks the moment the cast starts.",
	},
	"corrosive_vent": {
		"display_name": "Corrosive Vent",
		"kind": "boss_hazard",
		"cast_time": 0.0,
		"delay": 1.5,
		"radius": 4.5,
		"damage": 150.0,
		"school": School.CORROSIVE,
		"hazard_duration": 8.0,
		"hazard_tick_damage": 35.0,
		"hazard_status": "neural_glitch",
		"tank_status": "system_corroded",
		"desc": "Green floor grid under a ranged player. Corrodes the tank at the same time.",
	},
	"system_shockwave": {
		"display_name": "System Shockwave",
		"kind": "boss_raidwide",
		"cast_time": 1.5,
		"max_hp_pct_damage": 0.35,
		"school": School.ELECTRICAL,
		"desc": "Unavoidable. 35% of max HP to everyone in the room.",
	},
	"core_overcharge": {
		"display_name": "Core Overcharge",
		"kind": "boss_channel",
		"cast_time": 4.0,
		"interruptible": true,
		"wipe": true,
		"desc": "4 second channel. Lethal to the whole party if it completes.",
	},

	# -- Trash ---------------------------------------------------------
	"servo_strike": {
		"display_name": "Servo Strike",
		"kind": "melee",
		"cooldown": 1.8,
		"damage": 55.0,
		"school": School.KINETIC,
		"range": 3.0,
	},
	"disruptor_bolt": {
		"display_name": "Disruptor Bolt",
		"kind": "projectile",
		"cooldown": 2.4,
		"cast_time": 1.2,
		"damage": 70.0,
		"school": School.ELECTRICAL,
		"range": 28.0,
		"interruptible": true,
	},
	"glitch_field": {
		"display_name": "Glitch Field",
		"kind": "caster_debuff",
		"cooldown": 14.0,
		"cast_time": 1.8,
		"range": 25.0,
		"applies": "neural_glitch",
		"interruptible": true,
		"desc": "The reason the Striker's kick matters on trash, not just on the boss.",
	},
}

# ----------------------------------------------------------------- roles

const ROLES := {
	"field_medic": {
		"display_name": "Field Medic",
		"archetype": "healer",
		"max_health": 900.0,
		"max_energy": 100.0,
		"energy_regen": 6.0,
		"energy_name": "Nano-Energy",
		"move_speed": 7.0,
		"armor": 0.90,
		"abilities": [
			"disruptor_pistol", "nano_injector", "system_purge", "rocket_dash",
			"smart_nano_pulse", "overclock_surge", "focus_marker",
		],
	},
	"enforcer": {
		"display_name": "Enforcer",
		"archetype": "tank",
		"max_health": 1500.0,
		"max_energy": 100.0,
		"energy_regen": 5.0,
		"energy_name": "Plating",
		"move_speed": 6.4,
		"armor": 0.62,
		"threat_aura": 3.0,
		"abilities": [
			"riot_carbine", "directional_shield", "dart_pull", "rocket_dash",
			"bulwark_slam", "focus_marker",
		],
	},
	"kinetic_striker": {
		"display_name": "Kinetic Striker",
		"archetype": "melee_dps",
		"max_health": 1050.0,
		"max_energy": 100.0,
		"energy_regen": 7.0,
		"energy_name": "Kinetics",
		"move_speed": 7.6,
		"armor": 0.85,
		"abilities": [
			"mono_blade", "kick", "static_snare", "rocket_dash",
			"blur_step", "focus_marker",
		],
	},
	"railgun_specialist": {
		"display_name": "Railgun Specialist",
		"archetype": "ranged_dps",
		"max_health": 880.0,
		"max_energy": 100.0,
		"energy_regen": 6.0,
		"energy_name": "Capacitor",
		"move_speed": 6.8,
		"armor": 0.92,
		"abilities": [
			"railgun", "concussion_round", "seeker_drone", "rocket_dash",
			"orbital_lance", "focus_marker",
		],
	},
}

const ROLE_ORDER := ["enforcer", "field_medic", "kinetic_striker", "railgun_specialist"]

# ------------------------------------------------------------------ boss

const BOSS := {
	"unit_01": {
		"display_name": "Unit-01",
		"title": "Iron Centurion",
		"max_health": 50000.0,
		"armor": 1.0,
		"enrage_hp_pct": 0.50,
		"enrage_cast_rate": 1.25,
		"move_speed": 4.2,
		"melee": "servo_strike",
		# Recurring cycle: fires every `every` seconds from `first`.
		"cycle": [
			{"ability": "plasma_sweep", "first": 6.0, "every": 12.0, "target": "threat_leader"},
			{"ability": "corrosive_vent", "first": 11.0, "every": 18.0, "target": "random_ranged"},
			{"ability": "system_shockwave", "first": 20.0, "every": 25.0, "target": "room"},
		],
		# Fixed-time events. These do not accelerate with enrage: they are
		# the fight's spine and the party learns them by the clock.
		"scripted": [
			{"ability": "core_overcharge", "at": 45.0},
			{"ability": "core_overcharge", "at": 90.0},
			{"ability": "core_overcharge", "at": 135.0},
			{"ability": "core_overcharge", "at": 180.0},
		],
	},
}

# ------------------------------------------------------------------ mobs

const MOB_TYPES := {
	"sentry_drone": {
		"display_name": "Sentry Drone",
		"max_health": 620.0,
		"armor": 0.95,
		"move_speed": 5.4,
		"melee_range": 3.0,
		"abilities": ["servo_strike"],
		"ranged": false,
	},
	"code_disruptor": {
		"display_name": "Code-Disruptor",
		"max_health": 480.0,
		"armor": 1.0,
		"move_speed": 4.6,
		"melee_range": 3.0,
		"abilities": ["disruptor_bolt", "glitch_field"],
		"ranged": true,
		"preferred_range": 22.0,
		# A ranged mob will not walk into melee. Only breaking line of
		# sight makes it move, which is what turns a pull into a decision.
		"holds_ground": true,
	},
	"patrol_drone": {
		"display_name": "Patrol Drone",
		"max_health": 700.0,
		"armor": 0.95,
		"move_speed": 4.0,
		"melee_range": 3.0,
		"abilities": ["servo_strike"],
		"ranged": false,
		"patrols": true,
	},
}

# ---------------------------------------------------------------- floors

const AGGRO_LINK_RADIUS := 9.0
const PULL_ALERT_DELAY := 0.35

const FLOORS := [
	{
		"index": 4,
		"name": "Sector 4 - Fabrication",
		"packs": [
			{"types": ["sentry_drone", "sentry_drone", "code_disruptor"], "origin": Vector3(0, 0, -18)},
			{"types": ["sentry_drone", "code_disruptor"], "origin": Vector3(14, 0, -30)},
			{"types": ["sentry_drone", "sentry_drone", "code_disruptor", "code_disruptor"], "origin": Vector3(-12, 0, -38)},
		],
		"patrols": [
			{"type": "patrol_drone", "route": [Vector3(-16, 0, -10), Vector3(16, 0, -10), Vector3(16, 0, -34), Vector3(-16, 0, -34)]},
		],
		"terminal": Vector3(0, 0, -46),
		"terminal_unlock_seconds": 12.0,
		"terminal_waves": 2,
		"terminal_wave_types": ["sentry_drone", "sentry_drone"],
		"boss": "unit_01",
		"boss_origin": Vector3(0, 0, -70),
	},
]

# --------------------------------------------------------------- lookups

func ability(id: String) -> Dictionary:
	return ABILITIES.get(id, {})

func status(id: String) -> Dictionary:
	return STATUS_EFFECTS.get(id, {})

func role(id: String) -> Dictionary:
	return ROLES.get(id, {})

func mob(id: String) -> Dictionary:
	return MOB_TYPES.get(id, {})

func boss(id: String) -> Dictionary:
	return BOSS.get(id, {})

## Abilities a role can reach, keyed by the input action that fires them.
## This is the controller table in section 2, resolved per role.
func bindings_for_role(role_id: String) -> Dictionary:
	var out := {}
	var def := role(role_id)
	for ability_id in def.get("abilities", []):
		var a: Dictionary = ability(ability_id)
		var action: String = a.get("input", "")
		if action != "":
			out[action] = ability_id
	return out
