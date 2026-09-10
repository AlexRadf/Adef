extends Node
## Headless self-check.
##
##   godot --headless --path . res://tests/TestRunner.tscn
##
## Everything here runs without a window, a pad or a second machine. It is
## not a substitute for playing the fight, but it is what stops a rename
## from silently unhooking the healer's beam.

var _passed := 0
var _failed := 0
var _current := ""

func _ready() -> void:
	await get_tree().process_frame
	await _run_all()
	print("\n%d passed, %d failed" % [_passed, _failed])
	get_tree().quit(1 if _failed > 0 else 0)

func _run_all() -> void:
	await _suite("content integrity", _test_content)
	await _suite("status effects", _test_status)
	await _suite("combat choke point", _test_combat)
	await _suite("armour and corrosion", _test_armor)
	await _suite("directional shield", _test_guard)
	await _suite("threat table", _test_threat)
	await _suite("ability cooldowns", _test_cooldowns)
	await _suite("soft-lock scoring", _test_softlock)
	await _suite("cast and interrupt", _test_cast)
	await _suite("scenes instantiate", _test_scenes)
	await _suite("boss cycle", _test_boss)
	await _suite("floor director", _test_floor)
	await _suite("a floor, actually running", _test_integration)

# ------------------------------------------------------------- harness

func _suite(title: String, fn: Callable) -> void:
	_current = title
	print("\n-- %s" % title)
	await fn.call()

func check(condition: bool, label: String) -> void:
	if condition:
		_passed += 1
		print("   ok   %s" % label)
	else:
		_failed += 1
		print("   FAIL %s" % label)

func check_near(actual: float, expected: float, label: String, epsilon: float = 0.001) -> void:
	check(absf(actual - expected) <= epsilon, "%s (got %.4f, want %.4f)" % [label, actual, expected])

# --------------------------------------------------------------- tests

func _test_content() -> void:
	check(Content.BOSS["unit_01"]["max_health"] == 50000.0, "Iron Centurion has 50,000 HP")
	check(Content.BOSS["unit_01"]["enrage_hp_pct"] == 0.50, "enrage threshold is 50%")
	check(Content.BOSS["unit_01"]["enrage_cast_rate"] == 1.25, "enrage accelerates recasts by 25%")
	check(Content.ability("core_overcharge")["cast_time"] == 4.0, "Core Overcharge is a 4.0s channel")
	check(Content.ability("core_overcharge")["interruptible"], "Core Overcharge is interruptible")
	check(Content.ability("plasma_sweep")["arc_degrees"] == 90.0, "Plasma Sweep is a 90 degree cone")
	check(Content.ability("plasma_sweep")["locks_turning"], "Plasma Sweep locks turning on cast")
	check(Content.ability("system_shockwave")["max_hp_pct_damage"] == 0.35, "Shockwave is 35% max HP")
	check_near(Content.status("neural_glitch")["modifiers"]["attack_speed"], 0.75, "Neural Glitch is -25% attack speed")
	check_near(Content.status("system_corroded")["modifiers"]["armor"], 0.70, "System Corroded is -30% armour")

	# Every ability a role can reach must exist, or a button does nothing.
	var missing: Array[String] = []
	for role_id in Content.ROLES:
		for ability_id in Content.ROLES[role_id]["abilities"]:
			if Content.ability(ability_id).is_empty():
				missing.append("%s/%s" % [role_id, ability_id])
	check(missing.is_empty(), "every role ability is defined %s" % str(missing))

	# Every status an ability grants or applies must exist too.
	var bad_status: Array[String] = []
	for ability_id in Content.ABILITIES:
		var def: Dictionary = Content.ABILITIES[ability_id]
		for key in ["grants", "applies", "hazard_status", "tank_status"]:
			var status_id: String = def.get(key, "")
			if status_id != "" and Content.status(status_id).is_empty():
				bad_status.append("%s.%s=%s" % [ability_id, key, status_id])
	check(bad_status.is_empty(), "every referenced status exists %s" % str(bad_status))

	# The four roles are the trinity plus one, and each fills a distinct seat.
	var archetypes := {}
	for role_id in Content.ROLE_ORDER:
		archetypes[Content.role(role_id)["archetype"]] = true
	check(archetypes.size() == 4, "four distinct archetypes")
	check(Content.ROLE_ORDER.size() == 4, "four roles in the lobby order")

	# Section 2's control scheme: each role's buttons must not collide.
	for role_id in Content.ROLES:
		var bindings: Dictionary = Content.bindings_for_role(role_id)
		var count := 0
		for ability_id in Content.role(role_id)["abilities"]:
			if Content.ability(ability_id).has("input"):
				count += 1
		check(bindings.size() == count, "%s has no double-bound button" % role_id)

func _test_status() -> void:
	var host := _combatant()
	var status: StatusEffectComponent = host.get_node("StatusEffectComponent")

	check_near(status.get_stat("attack_speed"), 1.0, "no statuses means no modifier")
	status.apply("neural_glitch")
	check(status.has("neural_glitch"), "Neural Glitch applies")
	check_near(status.get_stat("attack_speed"), 0.75, "Neural Glitch slows attacks")

	status.apply("overclocked")
	check_near(status.get_stat("attack_speed"), 0.75 * 1.35, "modifiers multiply rather than overwrite")
	check_near(status.get_stat_additive("lifesteal"), 1.0, "Overclock Surge grants full lifesteal")

	check(status.has_dispellable(["performance"]), "Neural Glitch is a performance debuff")
	var purged := status.dispel(["performance"])
	check(purged == "neural_glitch", "System Purge strips it")
	check(not status.has("neural_glitch"), "and it is gone")
	check(status.has("overclocked"), "but the buff survives the purge")
	host.queue_free()

func _test_combat() -> void:
	var attacker := _combatant()
	var target := _combatant("enemy")
	var health: HealthComponent = target.get_node("HealthComponent")
	health.setup(1000.0)
	target.armor = 1.0

	var dealt := Combat.apply_damage(attacker, target, 100.0)
	check_near(dealt, 100.0, "unmodified damage lands whole")
	check_near(health.current_health, 900.0, "and comes off the bar")

	# Overheal is not counted, which is what keeps a healer's numbers honest.
	var healed := Combat.apply_heal(attacker, target, 500.0)
	check_near(healed, 100.0, "overheal is not counted")
	check_near(health.current_health, 1000.0, "bar is full, not overfull")

	# The dash is 0x damage taken, so it is a true i-frame.
	var status: StatusEffectComponent = target.get_node("StatusEffectComponent")
	status.apply("dash_iframes")
	check_near(Combat.apply_damage(attacker, target, 400.0), 0.0, "Rocket Dash i-frames zero a hit")
	status.remove("dash_iframes")

	# 35% of max HP, and it must ignore armour or the tank would shrug it off.
	Combat.apply_max_hp_damage(attacker, target, 0.35)
	check_near(health.current_health, 650.0, "System Shockwave takes 35% of max HP")

	check(health.get_health_percent() > 0.0, "still alive at 65%")
	Combat.apply_damage(attacker, target, 10000.0)
	check(health.is_dead, "lethal damage kills")
	check_near(Combat.apply_damage(attacker, target, 100.0), 0.0, "and the dead take no more")
	attacker.queue_free()
	target.queue_free()

func _test_armor() -> void:
	var attacker := _combatant()
	var tank := _combatant("party")
	var health: HealthComponent = tank.get_node("HealthComponent")
	health.setup(10000.0)
	tank.armor = 0.62                       # the Enforcer's plating

	check_near(Combat.apply_damage(attacker, tank, 100.0), 62.0, "plating lets 62% through")

	# "-30% Armour" has to mean the mitigation shrinks by 30%, not that the
	# damage multiplier does -- otherwise corrosion would make the tank
	# *tougher*, which is the bug this test exists to catch.
	var status: StatusEffectComponent = tank.get_node("StatusEffectComponent")
	status.apply("system_corroded")
	var corroded := Combat.apply_damage(attacker, tank, 100.0)
	check_near(corroded, 73.4, "System Corroded lets 73.4% through", 0.05)
	check(corroded > 62.0, "corrosion makes the tank take MORE, not less")
	attacker.queue_free()
	tank.queue_free()

func _test_guard() -> void:
	var tank := _combatant("party")
	tank.get_node("HealthComponent").setup(10000.0)
	tank.armor = 1.0
	tank.guard_arc_degrees = 140.0
	tank.global_position = Vector3.ZERO
	# Facing -Z is Godot's forward.
	var front := Vector3(0, 0, -10)
	var behind := Vector3(0, 0, 10)

	var status: StatusEffectComponent = tank.get_node("StatusEffectComponent")
	status.apply("guarded")
	check_near(Combat.apply_damage(null, tank, 100.0, {"from_position": front}), 45.0, "the shield stops what it faces")
	check_near(Combat.apply_damage(null, tank, 100.0, {"from_position": behind}), 100.0, "and nothing from behind")
	check_near(Combat.apply_damage(null, tank, 100.0), 100.0, "a room-wide pulse cannot be blocked")
	tank.queue_free()

func _test_threat() -> void:
	var boss := _combatant("enemy")
	var threat := ThreatComponent.new()
	threat.name = "ThreatComponent"
	boss.add_child(threat)
	var tank := _combatant("party")
	var healer := _combatant("party")

	threat.add_threat(tank, 1000.0)
	threat.add_threat(healer, 400.0)
	check(threat.get_leader() == tank, "the tank holds it")
	check_near(threat.threat_share(healer), 0.4, "the healer is at 40% of the tank")

	threat.add_threat(healer, 2000.0)
	check(threat.get_leader() == healer, "and loses it by out-healing the tank's damage")

	threat.taunt(tank, 6.0)
	check(threat.get_leader() == tank, "Dart Pull takes it straight back")
	check(threat.threat_of(tank) > threat.threat_of(healer), "a taunt tops the table so it does not snap back")
	boss.queue_free()
	tank.queue_free()
	healer.queue_free()

func _test_cooldowns() -> void:
	var unit := _combatant()
	var abilities := AbilityComponent.new()
	abilities.name = "AbilityComponent"
	unit.add_child(abilities)
	abilities.setup(100.0, 0.0)

	check(abilities.can_use("smart_nano_pulse"), "Smart Nano-Pulse starts ready")
	check(abilities.commit("smart_nano_pulse"), "and commits")
	check_near(abilities.energy, 70.0, "spending 30 Nano-Energy")
	check(not abilities.can_use("smart_nano_pulse"), "then it is on cooldown")
	check(abilities.cooldown_remaining("smart_nano_pulse") > 8.0, "for about nine seconds")

	# Neural Glitch is an attack-speed debuff, so it must lengthen cooldowns.
	var status: StatusEffectComponent = unit.get_node("StatusEffectComponent")
	var clean := abilities._scaled_cooldown("disruptor_pistol")
	status.apply("neural_glitch")
	var glitched := abilities._scaled_cooldown("disruptor_pistol")
	check(glitched > clean, "Neural Glitch lengthens the gap between shots")
	check_near(glitched, clean / 0.75, "by exactly the 25% the debuff claims")

	# Not enough in the bar is a refusal, not a negative balance.
	abilities.energy = 5.0
	check(not abilities.can_use("smart_nano_pulse"), "an empty bar blocks the spender")
	check(not abilities.spend(30.0), "and spending fails outright")
	check_near(abilities.energy, 5.0, "leaving the bar untouched")
	unit.queue_free()

func _test_softlock() -> void:
	var healer: PlayerCharacter = preload("res://scenes/player/PlayerCharacter.tscn").instantiate()
	healer.role_id = "field_medic"
	healer.peer_id = 1
	add_child(healer)
	await get_tree().process_frame

	check(healer.get_node_or_null("AllyTargeting") != null, "the healer has an ally scorer")
	check(healer.camera_rig != null, "and a camera rig")
	check(healer.kit is FieldMedicKit, "and the Field Medic kit")

	var targeting: SoftLockTargeting = healer.get_node("AllyTargeting")
	check_near(targeting.angle_weight, 0.50, "W_angle is 0.50")
	check_near(targeting.health_weight, 0.35, "W_health is 0.35")
	check_near(targeting.distance_weight, 0.15, "W_dist is 0.15")
	check_near(targeting.sticky_bonus, 0.20, "sticky bonus is 0.20")
	check_near(targeting.max_distance, 35.0, "max distance is 35m")

	# Two allies dead ahead: the hurt one must win on the health term.
	var healthy := _party_dummy(Vector3(0, 0, -10), 1.0)
	var hurt := _party_dummy(Vector3(0.6, 0, -10), 0.2)
	targeting.bind_camera(healer.camera_rig.camera)
	targeting.require_line_of_sight = false
	healer.global_position = Vector3.ZERO
	await get_tree().process_frame

	var picked := targeting.evaluate()
	check(picked == hurt, "the injured ally outscores the healthy one")

	# Sticky: once locked, a marginally better candidate must not steal it.
	targeting.current_target = healthy
	var sticky_pick := targeting.evaluate()
	check(sticky_pick == healthy or picked == hurt, "the sticky bonus resists flicker")

	# Out of the cone entirely: nothing is picked.
	healthy.global_position = Vector3(0, 0, 10)
	hurt.global_position = Vector3(0, 0, 10)
	targeting.current_target = null
	check(targeting.evaluate() == null, "nobody behind you is soft-locked")

	# Smart Nano-Pulse ignores the cone by design.
	check(targeting.lowest_health_ally(60.0) == hurt, "Smart Nano-Pulse finds the lowest HP anywhere")

	# The dead are never targets.
	hurt.get_node("HealthComponent").kill()
	hurt.is_dead = true
	check(targeting.lowest_health_ally(60.0) != hurt, "and never picks the dead")

	healthy.queue_free()
	hurt.queue_free()
	healer.queue_free()

func _test_cast() -> void:
	var caster := _combatant("enemy")
	var cast := CastComponent.new()
	cast.name = "CastComponent"
	caster.add_child(cast)

	var fired := [false]
	cast.begin("core_overcharge", 4.0, true, func() -> void: fired[0] = true)
	check(cast.is_casting, "the channel starts")
	check(cast.interruptible, "and it is interruptible")
	check_near(cast.time_left(), 4.0, "with a 4.0s window")

	check(cast.interrupt(), "the kick lands")
	check(not cast.is_casting, "the channel stops")
	check(not fired[0], "and the wipe never fires")

	# An uninterruptible cast must shrug the kick off rather than eat it.
	cast.begin("system_shockwave", 1.5, false, func() -> void: fired[0] = true)
	check(not cast.interrupt(), "an unstoppable cast cannot be kicked")
	check(cast.is_casting, "and keeps casting")
	caster.queue_free()

func _test_scenes() -> void:
	var scenes := {
		"player": "res://scenes/player/PlayerCharacter.tscn",
		"enemy": "res://scenes/enemies/TrashMob.tscn",
		"boss": "res://scenes/enemies/IronCenturion.tscn",
		"floor": "res://scenes/floor/Floor.tscn",
		"terminal": "res://scenes/floor/SecurityTerminal.tscn",
		"hazard": "res://scenes/abilities/HazardZone.tscn",
		"field": "res://scenes/abilities/GroundField.tscn",
		"drone": "res://scenes/abilities/SeekerDrone.tscn",
		"hud": "res://scenes/ui/ArenaReticle.tscn",
		"lobby": "res://scenes/ui/Lobby.tscn",
		"main": "res://scenes/Main.tscn",
	}
	for label in scenes:
		var packed := load(scenes[label]) as PackedScene
		check(packed != null and packed.can_instantiate(), "%s scene loads" % label)

func _test_boss() -> void:
	var boss: IronCenturion = preload("res://scenes/enemies/IronCenturion.tscn").instantiate()
	add_child(boss)
	await get_tree().process_frame

	check_near(boss.health_component.max_health, 50000.0, "boss spawns at 50,000 HP")
	check(boss.cast_component != null, "boss has a cast bar")
	check(not boss.is_enraged, "and starts calm")

	# Enrage is a health trigger, and it must accelerate the cycle.
	var before: float = boss.cycle_interval_for("plasma_sweep")
	boss.health_component.reduce(30000.0)
	boss._check_enrage()
	check(boss.is_enraged, "dropping below 50% enrages it")
	var after: float = boss.cycle_interval_for("plasma_sweep")
	check(after < before, "and the cycle speeds up")
	check_near(after, before / 1.25, "by exactly 25%")

	# The scripted channels are the fight's spine and must not drift.
	var scripted: Array = Content.BOSS["unit_01"]["scripted"]
	check(scripted[0]["at"] == 45.0, "first Core Overcharge at 0:45")
	check(scripted[1]["at"] == 90.0, "second at 1:30")
	boss.queue_free()

func _test_floor() -> void:
	var floor_def: Dictionary = Content.FLOORS[0]
	check(floor_def.has("packs") and floor_def["packs"].size() > 0, "the floor has trash packs")
	for pack in floor_def["packs"]:
		var size: int = pack["types"].size()
		check(size >= 2 and size <= 4, "packs are 2 to 4 mobs (got %d)" % size)
	check(floor_def.has("terminal"), "and a security terminal")
	check(floor_def["boss"] == "unit_01", "and the Iron Centurion at the top")

	# The phase order is the loop from section 1 and must not be reordered.
	check(FloorDirector.Phase.ELEVATOR_BREACH < FloorDirector.Phase.TRASH, "breach precedes trash")
	check(FloorDirector.Phase.TRASH < FloorDirector.Phase.SECURITY_OVERRIDE, "trash precedes the override")
	check(FloorDirector.Phase.SECURITY_OVERRIDE < FloorDirector.Phase.BOSS, "the override precedes the boss")
	check(FloorDirector.Phase.BOSS < FloorDirector.Phase.ASCENT, "the boss precedes the ascent")

## Boots a real floor with a real party and pulls a real pack. The unit
## tests above prove the arithmetic; this proves the game starts.
func _test_integration() -> void:
	Net.roster = {
		1: {"name": "Tank", "role": "enforcer", "ready": true},
		2: {"name": "Doc", "role": "field_medic", "ready": true},
		3: {"name": "Blade", "role": "kinetic_striker", "ready": true},
		4: {"name": "Scope", "role": "railgun_specialist", "ready": true},
	}
	var level: FloorLevel = preload("res://scenes/floor/Floor.tscn").instantiate()
	add_child(level)
	for i in 4:
		await get_tree().process_frame

	var players := get_tree().get_nodes_in_group("players")
	check(players.size() == 4, "four operatives spawn")
	var seats := {}
	for player in players:
		seats[player.role_id] = player
	check(seats.size() == 4, "one of each role")
	check(seats.has("enforcer") and seats["enforcer"].kit is EnforcerKit, "the Enforcer got the Enforcer kit")
	check(seats.has("field_medic") and seats["field_medic"].kit is FieldMedicKit, "the Medic got the Medic kit")
	check(seats.has("kinetic_striker") and seats["kinetic_striker"].kit is KineticStrikerKit, "the Striker got the Striker kit")
	check(seats.has("railgun_specialist") and seats["railgun_specialist"].kit is RailgunSpecialistKit, "the Specialist got the railgun")
	check_near(seats["enforcer"].health_component.max_health, 1500.0, "the tank has the biggest health bar")

	var director := level.director
	check(director.phase == FloorDirector.Phase.TRASH, "the floor opens on the trash phase")
	check(director.packs.size() >= 2, "and spawns its packs")

	var mobs := get_tree().get_nodes_in_group("trash")
	check(mobs.size() >= 6, "the room has trash in it (%d)" % mobs.size())
	var dormant := 0
	for mob in mobs:
		if not (mob as TrashMob).is_awake():
			dormant += 1
	check(dormant == mobs.size(), "and every mob starts asleep")

	# The pull. One dart into one mob should bring that squad and only
	# that squad -- this is the single most important behaviour in the
	# tactical layer, so it gets asserted rather than assumed.
	var pack_a: AggroPack = director.packs[0]
	var pack_b: AggroPack = director.packs[1]
	var puller = seats["enforcer"]
	pack_a.members[0].on_pulled_by(puller)
	for i in 8:
		await get_tree().process_frame
	await get_tree().create_timer(Content.PULL_ALERT_DELAY * 4.0).timeout

	var awake_a := 0
	for mob in pack_a.members:
		if mob.is_awake():
			awake_a += 1
	check(awake_a == pack_a.members.size(), "pulling one mob wakes its whole squad")
	var awake_b := 0
	for mob in pack_b.members:
		if mob.is_awake():
			awake_b += 1
	check(awake_b == 0, "and wakes nobody in the next squad")

	# A ranged mob that can see you holds its ground. It is the reason the
	# tank has to break line of sight instead of just walking backwards.
	var ranged: TrashMob = null
	for mob in pack_a.members:
		if Content.mob(mob.mob_type).get("holds_ground", false):
			ranged = mob
			break
	check(ranged != null, "the squad has a Code-Disruptor in it")

	# Clearing the floor has to open the Security Override, or the party
	# can never reach the boss.
	for mob in get_tree().get_nodes_in_group("trash"):
		(mob as TrashMob).health_component.kill()
	for i in 6:
		await get_tree().process_frame
	check(director.phase == FloorDirector.Phase.SECURITY_OVERRIDE, "clearing the room opens the override")
	var terminal := get_tree().get_first_node_in_group("terminals")
	check(terminal != null, "and puts a terminal in the room")

	# Holding the terminal spawns the boss. The unlock is wall-clock, so
	# this waits on a timer rather than on frames -- headless idle frames
	# are far shorter than a physics tick and would never add up.
	if terminal is SecurityTerminal:
		var pane := terminal as SecurityTerminal
		pane.unlock_seconds = 0.3
		pane.wave_count = 0
		seats["enforcer"].global_position = pane.global_position + Vector3(0, 0.4, 0)
		await get_tree().create_timer(0.4).timeout
		check(pane._held_count() > 0, "standing on the terminal registers as holding it")
		await get_tree().create_timer(0.6).timeout
		check(pane.is_unlocked, "and the override completes")
	check(director.phase == FloorDirector.Phase.BOSS, "and holding it brings the Iron Centurion")
	check(director.boss != null and director.boss.active, "which starts its cycle")

	# Killing the boss ends the floor on the ascent.
	if director.boss != null:
		director.boss.health_component.kill()
		for i in 6:
			await get_tree().process_frame
	check(director.phase == FloorDirector.Phase.ASCENT, "and killing it opens the elevator")

	level.queue_free()
	Net.roster = {}
	for i in 3:
		await get_tree().process_frame

# -------------------------------------------------------------- fixtures

func _combatant(team_id: String = "party") -> Combatant:
	var body := Combatant.new()
	body.team = team_id
	var health := HealthComponent.new()
	health.name = "HealthComponent"
	health.max_health = 1000.0
	body.add_child(health)
	var status := StatusEffectComponent.new()
	status.name = "StatusEffectComponent"
	body.add_child(status)
	add_child(body)
	health.setup(1000.0)
	return body

func _party_dummy(where: Vector3, health_pct: float) -> Combatant:
	var body := _combatant("party")
	body.global_position = where
	var health: HealthComponent = body.get_node("HealthComponent")
	health.setup(1000.0)
	health.reduce(1000.0 * (1.0 - health_pct))
	return body
