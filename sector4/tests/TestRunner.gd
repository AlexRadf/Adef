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
	await _suite("the kit formation", _test_formation)
	await _suite("status effects", _test_status)
	await _suite("combat choke point", _test_combat)
	await _suite("armour and corrosion", _test_armor)
	await _suite("directional shield", _test_guard)
	await _suite("facing", _test_facing)
	await _suite("camera-relative movement", _test_camera_basis)
	await _suite("rocket dash", _test_dash)
	await _suite("medic can treat themselves", _test_self_heal)
	await _suite("barriers", _test_barrier)
	await _suite("the dead do not act", _test_dead_cannot_act)
	await _suite("wipe and reset", _test_wipe)
	await _suite("going down", _test_downed)
	await _suite("threat table", _test_threat)
	await _suite("ability cooldowns", _test_cooldowns)
	await _suite("soft-lock scoring", _test_softlock)
	await _suite("cast and interrupt", _test_cast)
	await _suite("scenes instantiate", _test_scenes)
	await _suite("boss cycle", _test_boss)
	await _suite("boss room leash", _test_leash)
	await _suite("floor director", _test_floor)
	await _suite("a floor, actually running", _test_integration)
	await _suite("loadout modules", _test_loadout)
	await _suite("the hub", _test_hub)
	await _suite("bots hold the line", _test_bot_restraint)
	await _suite("bots fill the empty seats", _test_bots)
	await _suite("bots do their jobs", _test_bot_jobs)

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

## Every seat is built to the same shape. This is the rule the whole kit
## design rests on -- a seat is a different answer to the same six
## questions, not a different set of buttons -- so it is asserted rather
## than left as an intention.
func _test_formation() -> void:
	for role_id in Content.ROLE_ORDER:
		var seen := {}
		for ability_id in Content.role(role_id)["abilities"]:
			var slot: String = Content.slot_of(ability_id)
			check(slot != "", "%s/%s declares a slot" % [role_id, ability_id])
			check(not seen.has(slot), "%s fills '%s' exactly once" % [role_id, slot])
			seen[slot] = ability_id

		# No holes: a missing slot is a seat that cannot answer one of the
		# six questions.
		for slot in Content.SLOTS:
			check(seen.has(slot), "%s has a '%s'" % [role_id, slot])

		# The same job is on the same button on every seat, so muscle
		# memory survives a swap.
		for slot in seen:
			var ability_id: String = seen[slot]
			check(Content.ability(ability_id).get("input", "") == Content.SLOT_INPUT[slot],
				"%s/%s sits on the '%s' binding" % [role_id, slot, Content.SLOT_INPUT[slot]])

		check(Content.slot_ability(role_id, "ultimate") != "", "%s has an ultimate" % role_id)
		check(Content.slot_ability(role_id, "mobility") == "rocket_dash",
			"%s moves with Rocket Dash" % role_id)

	# Each slot must be filled by a *different* ability per role, or the
	# seats are not actually distinct.
	for slot in Content.SLOTS:
		if slot == "mobility" or slot == "mark":
			continue  # deliberately shared
		var fillers := {}
		for role_id in Content.ROLE_ORDER:
			fillers[Content.slot_ability(role_id, slot)] = true
		check(fillers.size() == Content.ROLE_ORDER.size(),
			"every seat answers '%s' differently" % slot)

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

## The sign error that cost the Striker every swing.
##
## Godot's forward is -Z. Facing a target with the intuitive
## atan2(dx, dz) points a body exactly backwards, and nothing complains --
## it just quietly means melee arcs never connect and the boss's frontal
## cone fires into the people standing behind it.
func _test_facing() -> void:
	var body := _combatant()
	for target in [Vector3(0, 0, -10), Vector3(0, 0, 10), Vector3(7, 0, 3), Vector3(-4, 0, -9)]:
		body.global_position = Vector3.ZERO
		body.rotation.y = Combatant.yaw_toward(body.global_position, target)
		var forward := -body.global_transform.basis.z
		forward.y = 0.0
		var to_target: Vector3 = target
		to_target.y = 0.0
		var error := rad_to_deg(forward.normalized().angle_to(to_target.normalized()))
		check(error < 0.5, "facing %v points forward at it (off by %.2f deg)" % [target, error])

	# The consequence, stated directly: a 110 degree swing arc has to
	# contain what the body is facing.
	body.global_position = Vector3.ZERO
	var enemy_at := Vector3(0, 0, -3)
	body.rotation.y = Combatant.yaw_toward(body.global_position, enemy_at)
	var facing := -body.global_transform.basis.z
	facing.y = 0.0
	check(rad_to_deg(facing.normalized().angle_to(enemy_at.normalized())) <= 55.0,
		"a target dead ahead is inside a 110 degree arc")
	body.queue_free()

## Movement has to agree with where the camera is actually pointing.
##
## The rig is a child of the body and the body turns to follow the rig, so
## a local rotation on the rig gets applied on top of the body's -- the
## camera ends up at roughly twice the yaw the movement basis was computed
## from, and "forward" drifts further from the screen the more you turn.
func _test_camera_basis() -> void:
	var player: PlayerCharacter = preload("res://scenes/player/PlayerCharacter.tscn").instantiate()
	player.role_id = "field_medic"
	player.peer_id = 1
	add_child(player)
	player.global_position = Vector3.ZERO
	for i in 3:
		await get_tree().process_frame

	for yaw in [0.0, 0.9, -2.2, 3.0]:
		player.camera_rig.yaw = yaw
		player.camera_rig.pitch = -0.2
		# Let the body finish turning to face the camera, so this measures
		# the settled state rather than the lerp.
		await get_tree().create_timer(0.6).timeout

		var cam_forward := -player.camera_rig.camera.global_transform.basis.z
		cam_forward.y = 0.0
		var basis_forward := player.camera_rig.forward_flat()
		var drift := rad_to_deg(cam_forward.normalized().angle_to(basis_forward.normalized()))
		check(drift < 2.0, "yaw %.1f: movement forward matches the camera (off by %.1f deg)" % [yaw, drift])

		var cam_right := player.camera_rig.camera.global_transform.basis.x
		cam_right.y = 0.0
		var basis_right := player.camera_rig.right_flat()
		var right_drift := rad_to_deg(cam_right.normalized().angle_to(basis_right.normalized()))
		check(right_drift < 2.0, "yaw %.1f: strafe matches the camera (off by %.1f deg)" % [yaw, right_drift])

	player.queue_free()
	for i in 3:
		await get_tree().process_frame

## The Medic's dash is a charge to a person, not a shove forwards.
func _test_dash() -> void:
	_ground()
	var medic := _bot("field_medic", Vector3.ZERO)
	medic.is_bot = false          # exercise the human path
	var ally := _bot("enforcer", Vector3(8, 0, 0))
	ally.health_component.reduce(ally.health_component.max_health * 0.5)
	for i in 3:
		await get_tree().process_frame

	var kit: FieldMedicKit = medic.kit
	var target := kit._charge_target()
	check(target == ally, "the Medic charges at the hurt ally")

	var plan: Dictionary = kit._dash_plan(ally)
	var direction: Vector3 = plan["direction"]
	check(direction.normalized().dot(Vector3.RIGHT) > 0.99, "and aims straight at them")

	# Displacement of a decaying impulse is i^2 / (2 * decay). It must land
	# just short of the ally rather than through them or half way.
	var travel: float = plan["impulse"] * plan["impulse"] / (2.0 * float(plan["decay"]))
	check(travel > 5.5 and travel < 7.5, "landing just short of them (%.1fm of 8m)" % travel)

	var def: Dictionary = Content.ability("rocket_dash")
	check(plan["impulse"] <= float(def["max_charge_impulse"]) + 0.01, "never faster than the cap")

	# A healthy party and no reticle target: a plain evasive boost.
	ally.health_component.restore(99999.0)
	medic.ally_targeting.current_target = null
	check(kit._charge_target() == null, "with nobody hurt it is just a dodge")

	# Far away is out of reach, and a charge that falls short is worse than
	# no charge.
	ally.global_position = Vector3(90, 0, 0)
	ally.health_component.reduce(ally.health_component.max_health * 0.5)
	check(kit._charge_target() == null, "and it will not charge at someone out of range")

	medic.queue_free()
	ally.queue_free()
	for i in 3:
		await get_tree().process_frame

## A body that stops upright reads as a freeze rather than a kill.
## A medic who cannot treat themselves is a medic who dies holding a full
## toolkit.
func _test_self_heal() -> void:
	_ground()
	var medic := _bot("field_medic", Vector3.ZERO)
	medic.is_bot = false
	var ally := _bot("enforcer", Vector3(4, 0, 0))
	for i in 3:
		await get_tree().process_frame

	var kit: FieldMedicKit = medic.kit
	medic.health_component.reduce(medic.health_component.max_health * 0.5)
	var before: float = medic.health_component.current_health

	# Aiming at nobody treats you as the patient.
	kit.channel("nano_injector", true, {"ally": NodePath()})
	check(kit._channel_target == medic, "with no target the beam turns on you")
	kit._tick_beam(0.5)
	check(medic.health_component.current_health > before, "and it heals you")

	# Healing someone else feeds a little back, so you are never stranded.
	ally.health_component.reduce(ally.health_component.max_health * 0.6)
	medic.health_component.reduce(medic.health_component.max_health * 0.2)
	var self_before: float = medic.health_component.current_health
	var ally_before: float = ally.health_component.current_health
	kit.channel("nano_injector", true, {"ally": ally.get_path()})
	check(kit._channel_target == ally, "the beam takes an ally when pointed at one")
	kit._tick_beam(0.5)
	check(ally.health_component.current_health > ally_before, "healing them works")
	check(medic.health_component.current_health > self_before, "and some of it comes back to you")

	# Smart Nano-Pulse is a pulse: it catches the whole group, you included.
	medic.health_component.reduce(medic.health_component.max_health * 0.3)
	ally.health_component.reduce(ally.health_component.max_health * 0.3)
	var pulse_self: float = medic.health_component.current_health
	var pulse_ally: float = ally.health_component.current_health
	check(kit.execute("smart_nano_pulse", {}), "the pulse goes off")
	check(medic.health_component.current_health > pulse_self, "it heals you")
	check(ally.health_component.current_health > pulse_ally, "and everyone near you")

	medic.queue_free()
	ally.queue_free()
	for i in 3:
		await get_tree().process_frame

## Overclock Surge is a shield now, so shields have to be real: soaked
## before the health bar, spent down, and gone when empty.
func _test_barrier() -> void:
	var target := _combatant("party")
	target.armor = 1.0
	target.get_node("HealthComponent").setup(1000.0)
	var status: StatusEffectComponent = target.get_node("StatusEffectComponent")
	var health: HealthComponent = target.get_node("HealthComponent")

	status.apply("barrier")
	var pool: float = float(Content.status("barrier")["absorb"])
	check_near(status.absorb_remaining(), pool, "the barrier starts full")

	Combat.apply_damage(null, target, 200.0)
	check_near(health.current_health, 1000.0, "the shield soaks it whole")
	check_near(status.absorb_remaining(), pool - 200.0, "and is spent down by exactly that")

	# A hit bigger than what is left must carry through, not be swallowed.
	Combat.apply_damage(null, target, pool)
	check(health.current_health < 1000.0, "an overflowing hit carries through")
	check_near(status.absorb_remaining(), 0.0, "and the shield is gone")
	check(not status.has("barrier"), "an empty shield does not linger as a buff")

	target.queue_free()

## Dying mid-channel kept the Nano-Injector healing. A corpse must not be
## able to do anything at all.
func _test_dead_cannot_act() -> void:
	_ground()
	var medic := _bot("field_medic", Vector3.ZERO)
	medic.is_bot = false
	var ally := _bot("enforcer", Vector3(4, 0, 0))
	for i in 3:
		await get_tree().process_frame

	var kit: FieldMedicKit = medic.kit
	ally.health_component.reduce(ally.health_component.max_health * 0.6)
	kit.channel("nano_injector", true, {"ally": ally.get_path()})
	check(kit._channel_active, "the beam is running")
	kit._tick_beam(0.4)
	var healed_alive: float = ally.health_component.current_health

	# Now the medic goes down mid-channel.
	medic.health_component.kill()
	await get_tree().process_frame
	check(medic.is_dead, "the medic is down")
	check(not kit._channel_active, "the channel drops with them")

	# Even forced, nothing may land from a corpse.
	kit._channel_active = true
	kit._channel_target = ally
	kit._tick_beam(0.5)
	check_near(ally.health_component.current_health, healed_alive,
		"and a dead medic heals nobody")
	check_near(Combat.apply_heal(medic, ally, 500.0), 0.0, "healing from a corpse is refused")
	check_near(Combat.apply_damage(medic, ally, 500.0), 0.0, "so is damage from a corpse")

	# The server must refuse to start a new channel for a downed operative.
	kit._channel_active = false
	kit._server_channel("nano_injector", true, {"ally": ally.get_path()})
	check(not kit._channel_active, "and they cannot start another")

	# The world is not a combatant: a hazard with no source still works.
	check(Combat.apply_damage(null, ally, 50.0) > 0.0, "but the floor can still hurt you")

	medic.queue_free()
	ally.queue_free()
	for i in 3:
		await get_tree().process_frame

## While anyone is standing you wait. When the last one falls the attempt
## resets rather than the run ending.
func _test_wipe() -> void:
	Net.roster = {1: {"name": "You", "role": "field_medic", "ready": true}}
	var level: FloorLevel = preload("res://scenes/floor/Floor.tscn").instantiate()
	add_child(level)
	for i in 5:
		await get_tree().process_frame
	var director := level.director

	var party := get_tree().get_nodes_in_group("party")
	check(party.size() == 4, "a full squad deployed")
	check(director.standing_count() == 4, "all four standing")

	# One down is not a wipe.
	party[0].health_component.kill()
	await get_tree().process_frame
	check(director.standing_count() == 3, "one down, three up")
	check(not director.wiped, "and that is not a wipe")

	# The last one is.
	for unit in party:
		if unit.get("is_dead") != true:
			unit.health_component.kill()
	await get_tree().process_frame
	check(director.standing_count() == 0, "everyone is down")
	check(director.wiped, "which is a wipe")

	# And the reset puts them back rather than ending the run.
	director.respawn_party()
	await get_tree().process_frame
	check(director.standing_count() == 4, "the squad is back on its feet")
	check(not director.wiped, "and the wipe is cleared")
	for unit in party:
		check_near(unit.health_component.get_health_percent(), 1.0,
			"%s respawns at full" % unit.get("role_id"))
		break
	check(get_tree().get_nodes_in_group("hazards").is_empty(), "the floor is clean again")

	level.queue_free()
	Net.roster = {}
	for i in 3:
		await get_tree().process_frame

func _test_downed() -> void:
	var mob: TrashMob = preload("res://scenes/enemies/TrashMob.tscn").instantiate()
	mob.mob_type = "sentry_drone"
	mob.corpse_seconds = 0.6
	add_child(mob)
	mob.global_position = Vector3(0, 0, -4)
	for i in 3:
		await get_tree().process_frame

	check(mob.collision_layer != 0, "a live mob collides")
	mob.health_component.kill()
	await get_tree().create_timer(0.35).timeout
	check(mob.is_dead, "it is down")
	check(mob.collision_layer == 0, "a corpse does not block the room")
	check(absf(mob.rotation.x) > 0.3, "and it has toppled (%.2f rad)" % mob.rotation.x)

	await get_tree().create_timer(0.8).timeout
	check(not is_instance_valid(mob), "then clears itself away")

	# A downed operative stays put, because they can still be revived.
	var fallen := _bot("enforcer", Vector3(0, 0, 6))
	for i in 3:
		await get_tree().process_frame
	fallen.health_component.kill()
	await get_tree().create_timer(0.9).timeout
	check(is_instance_valid(fallen), "a downed operative is not swept away")
	fallen.health_component.revive(0.4)
	await get_tree().create_timer(0.6).timeout
	check(not fallen.is_dead, "and can be picked back up")
	check(absf(fallen.rotation.x) < 0.2, "standing upright again (%.2f rad)" % fallen.rotation.x)
	fallen.queue_free()
	for i in 3:
		await get_tree().process_frame

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

	# Facing the boss must not make the healer unable to heal. With the
	# fallback on, an ally outside the cone is still reachable.
	targeting.fallback_to_neediest = true
	healthy.global_position = Vector3(0, 0, 12)
	hurt.global_position = Vector3(2, 0, 12)
	targeting.current_target = null
	check(targeting.evaluate() == null, "nobody is in the cone")
	await get_tree().process_frame
	check(targeting.current_target == hurt, "but the hurt ally is still picked up behind you")

	# And the explicit override steps through the party regardless.
	var stepped := targeting.cycle(true)
	check(stepped != null, "cycle picks somebody")
	var stepped_again := targeting.cycle(true)
	check(stepped_again != stepped, "and stepping again moves on")
	targeting.fallback_to_neediest = false

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

	# The HUD is what tells the player what is going on, so every panel of
	# it is asserted by name rather than assumed present.
	var hud := (load("res://scenes/ui/ArenaReticle.tscn") as PackedScene).instantiate()
	add_child(hud)
	await get_tree().process_frame
	for panel in ["ReticleArcs", "WorldFrames", "EncounterHud", "AbilityBar",
			"ObjectivePanel", "PartyRoster", "FloatingNumbers"]:
		check(hud.get_node_or_null(panel) != null, "the HUD has a %s" % panel)
	hud.queue_free()
	await get_tree().process_frame

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

## Drag the boss out of its room and it has to give up, walk home and come
## back to full -- otherwise the fight can be won with the corridor rather
## than with the encounter.
func _test_leash() -> void:
	_ground()
	var boss: IronCenturion = preload("res://scenes/enemies/IronCenturion.tscn").instantiate()
	add_child(boss)
	boss.global_position = Vector3(0, 0, -30)
	var puller := _bot("enforcer", Vector3(0, 0, -28))
	for i in 4:
		await get_tree().process_frame
	boss.arm()

	check(not boss.active, "the boss starts dormant")
	boss.on_pulled_by(puller)
	check(boss.active, "and a pull starts it")

	boss.health_component.reduce(20000.0)
	check(boss.health_component.get_health_percent() < 0.9, "it takes damage once engaged")

	# Walk the puller far outside the leash and let the boss notice.
	puller.global_position = Vector3(0, 0, 60)
	boss.global_position = Vector3(0, 0, 55)
	boss._check_leash()
	check(not boss.active, "leaving the room drops the fight")
	await get_tree().create_timer(1.6).timeout
	check_near(boss.health_component.get_health_percent(), 1.0, "and it resets to full")
	check(boss.global_position.distance_to(boss.home) < 1.0, "back where it started")
	check(not boss.is_enraged, "and calm again")

	boss.queue_free()
	puller.queue_free()
	for i in 3:
		await get_tree().process_frame

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
	check(director.boss != null, "which is standing in its chamber")
	# The boss waits. Walking into the room is not a pull, which is the
	# same contract every trash pack already has.
	check(not director.boss.active, "and waits to be pulled rather than starting itself")
	director.boss.on_pulled_by(seats["enforcer"])
	check(director.boss.active, "pulling it starts the fight")

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

## A solo run must still be a four-person fight, because every boss
## ability is answered by a specific seat.
## A bot must never be the thing that starts a fight. The player picks the
## moment; the squad forms up and waits.
func _test_bot_restraint() -> void:
	_ground()
	var leader := _bot("field_medic", Vector3.ZERO)
	leader.is_bot = false          # stand in for the human
	var tank := _bot("enforcer", Vector3(0, 0, 3))
	var mob: TrashMob = preload("res://scenes/enemies/TrashMob.tscn").instantiate()
	mob.mob_type = "sentry_drone"
	add_child(mob)
	mob.global_position = Vector3(0, 0, -14)
	for i in 4:
		await get_tree().process_frame

	check(not mob.is_awake(), "the pack is asleep")
	check(tank.brain._primary_enemy() == null, "so the bot has nothing to fight")
	await get_tree().create_timer(1.2).timeout
	check(not mob.is_awake(), "and it does not go and wake it")
	check(mob.health_component.get_health_percent() >= 0.999, "nor shoot it from here")

	# It should be forming up on the leader instead of idling on the spot.
	var spot := tank.brain._formation_spot()
	check(spot.distance_to(leader.global_position) < 6.0, "it forms up near the leader")

	# Once the player pulls, the bot commits.
	mob.on_pulled_by(leader)
	await get_tree().create_timer(0.6).timeout
	check(tank.brain._primary_enemy() == mob, "and once it is pulled, the bot engages")

	leader.queue_free()
	tank.queue_free()
	mob.queue_free()
	for i in 3:
		await get_tree().process_frame

func _test_bots() -> void:
	Net.roster = {1: {"name": "You", "role": "field_medic", "ready": true}}
	var level: FloorLevel = preload("res://scenes/floor/Floor.tscn").instantiate()
	add_child(level)
	for i in 4:
		await get_tree().process_frame

	var players := get_tree().get_nodes_in_group("players")
	check(players.size() == 4, "one human still makes a party of four")
	var humans := 0
	var bots := 0
	var seats := {}
	for player in players:
		seats[player.role_id] = player
		if player.is_bot:
			bots += 1
		else:
			humans += 1
	check(humans == 1, "exactly one seat is the player's")
	check(bots == 3, "and three are bots")
	check(seats.size() == 4, "covering all four roles")
	check(seats["field_medic"].is_bot == false, "the human kept the role they picked")
	check(seats["enforcer"].is_bot, "and a bot took the tank")

	for role_id in ["enforcer", "kinetic_striker", "railgun_specialist"]:
		var bot: PlayerCharacter = seats[role_id]
		check(bot.brain != null, "%s has a brain" % role_id)
		check(bot.get_multiplayer_authority() == 1, "%s is driven by the server" % role_id)
		check(not bot.camera_rig.camera.current, "%s does not steal the camera" % role_id)

	level.queue_free()
	Net.roster = {}
	for i in 3:
		await get_tree().process_frame

## The three behaviours the encounter cannot be finished without.
func _test_bot_jobs() -> void:
	_ground()

	# 1. The Striker kicks Core Overcharge. This is the whole reason the
	#    seat exists: the channel wipes the party if it completes.
	var boss: IronCenturion = preload("res://scenes/enemies/IronCenturion.tscn").instantiate()
	add_child(boss)
	boss.global_position = Vector3.ZERO
	var striker := _bot("kinetic_striker", Vector3(0, 0.5, 3.0))
	for i in 4:
		await get_tree().process_frame

	# The boss has to be pulled before anyone is fighting it.
	boss.arm()
	boss.on_pulled_by(striker)

	var wiped := [false]
	boss.cast_component.begin("core_overcharge", 4.0, true, func() -> void: wiped[0] = true)
	check(boss.cast_component.is_casting, "the channel starts")
	await get_tree().create_timer(1.6).timeout
	check(not boss.cast_component.is_casting, "the Striker bot kicks it")
	check(not wiped[0], "so the party is not wiped")
	check(boss.status_component.has("interrupt_lockout"), "and the boss is locked out")

	# It must not fire the kick into nothing -- that would waste the one
	# cooldown that matters on a 12 second timer.
	striker.ability_component._ready_at.clear()
	await get_tree().create_timer(0.8).timeout
	check(striker.ability_component.is_ready("kick"), "and holds the kick when nothing is casting")

	# The kick is not the only thing the Striker owes the party. If the
	# swing arc is wrong it lands nothing at all, silently -- which is
	# exactly what happened before facing was fixed.
	var boss_hp_before: float = boss.health_component.current_health
	await get_tree().create_timer(1.5).timeout
	check(boss.health_component.current_health < boss_hp_before,
		"the Striker bot actually connects with the boss (%.0f damage in 1.5s)"
			% (boss_hp_before - boss.health_component.current_health))

	striker.queue_free()
	boss.queue_free()
	for i in 3:
		await get_tree().process_frame

	# 2. The Medic bot heals whoever is lowest.
	var medic := _bot("field_medic", Vector3(0, 0.5, 0))
	var patient := _bot("enforcer", Vector3(3, 0.5, 0))
	patient.health_component.reduce(patient.health_component.max_health * 0.6)
	var before: float = patient.health_component.current_health
	for i in 4:
		await get_tree().process_frame
	await get_tree().create_timer(1.6).timeout
	check(patient.health_component.current_health > before,
		"the Medic bot heals the wounded (%.0f -> %.0f)" % [before, patient.health_component.current_health])

	# 3. And purges what it is allowed to purge.
	patient.status_component.apply("system_corroded")
	await get_tree().create_timer(1.6).timeout
	check(not patient.status_component.has("system_corroded"), "and purges System Corroded off the tank")

	medic.queue_free()
	patient.queue_free()
	for i in 3:
		await get_tree().process_frame

	# 4. The tank bot takes aggro back when it loses it.
	var mob: TrashMob = preload("res://scenes/enemies/TrashMob.tscn").instantiate()
	mob.mob_type = "sentry_drone"
	add_child(mob)
	mob.global_position = Vector3(0, 0.5, -6)
	var tank := _bot("enforcer", Vector3(0, 0.5, 0))
	var squishy := _bot("railgun_specialist", Vector3(4, 0.5, 0))
	for i in 4:
		await get_tree().process_frame
	# A real pull: the sniper wakes it and holds the threat. Bots only
	# commit once something is actually engaged, so the mob has to be awake
	# for the tank to care about it.
	mob.on_pulled_by(squishy)
	mob.threat_component.add_threat(squishy, 5000.0)
	check(mob.is_awake(), "the mob is engaged")
	check(mob.threat_component.get_leader() == squishy, "the sniper pulled aggro")
	await get_tree().create_timer(2.0).timeout
	check(mob.threat_component.get_leader() == tank, "the Enforcer bot pulls it back")

	tank.queue_free()
	squishy.queue_free()
	mob.queue_free()
	for i in 3:
		await get_tree().process_frame

	# 5. Deployables land where the caster is standing, not at the world
	#    origin. Setting global_position before parenting fails silently,
	#    so this is asserted rather than eyeballed.
	var deployer := _bot("field_medic", Vector3(12, 0.5, -7))
	for i in 3:
		await get_tree().process_frame
	check(deployer.kit.server_fire("overclock_surge", deployer.kit.bot_payload(deployer)),
		"Overclock Surge deploys")
	var field: GroundField = null
	for node in get_children():
		if node is GroundField:
			field = node
	check(field != null, "and puts a field in the world")
	if field != null:
		check(field.global_position.distance_to(deployer.global_position) < 0.5,
			"under the Medic rather than at the origin")
		field.queue_free()
	deployer.queue_free()
	for i in 3:
		await get_tree().process_frame

## Equipment has to be real: the same modifier walk as a boss debuff, with
## slots that actually constrain and downsides that actually bite.
func _test_loadout() -> void:
	for module_id in Content.MODULES:
		var def: Dictionary = Content.MODULES[module_id]
		check(not def.get("modifiers", {}).is_empty(), "%s does something" % module_id)
		# A module synthesised as a status is what lets Combat read it.
		var status: Dictionary = Content.status(Loadout._status_id(module_id))
		check(not status.is_empty(), "%s surfaces as a status" % module_id)
		check(status["duration"] == 0.0, "%s is permanent" % module_id)

	Loadout.clear("enforcer")
	check(Loadout.slots_used("enforcer") == 0, "starts empty after a strip")
	check(Loadout.toggle("enforcer", "reinforced_plating"), "fits a module")
	check(Loadout.has_module("enforcer", "reinforced_plating"), "and it is fitted")
	check(Loadout.toggle("enforcer", "reinforced_plating"), "pressing it again strips it")
	check(not Loadout.has_module("enforcer", "reinforced_plating"), "and it is gone")

	# Slots must be a real constraint, not a suggestion.
	var ids: Array = Content.MODULES.keys()
	for i in Content.MODULE_SLOTS:
		Loadout.toggle("enforcer", ids[i])
	check(Loadout.is_full("enforcer"), "three slots fill up")
	check(not Loadout.toggle("enforcer", ids[Content.MODULE_SLOTS]), "and a fourth is refused")

	# Fitted modules have to reach the combat resolver.
	Loadout.clear("enforcer")
	Loadout.toggle("enforcer", "reinforced_plating")
	var tank := _bot("enforcer", Vector3.ZERO)
	await get_tree().process_frame
	check(tank.status_component.has(Loadout._status_id("reinforced_plating")),
		"the module is fitted to the body on spawn")
	check_near(tank.status_component.get_stat("armor"), 1.35, "and its armour modifier is live")

	var attacker := _combatant("enemy")
	tank.health_component.setup(10000.0)
	var plated := Combat.apply_damage(attacker, tank, 100.0)
	Loadout.clear("enforcer")
	var bare := _bot("enforcer", Vector3(0, 0, 12))
	await get_tree().process_frame
	bare.health_component.setup(10000.0)
	var unplated := Combat.apply_damage(attacker, bare, 100.0)
	check(plated < unplated, "plating actually reduces damage (%.1f vs %.1f)" % [plated, unplated])

	# And the downside has to bite too, or it is not a decision.
	check_near(Content.module("reinforced_plating")["modifiers"]["move_speed"], 0.92,
		"and it costs movement")

	tank.queue_free()
	bare.queue_free()
	attacker.queue_free()
	for i in 3:
		await get_tree().process_frame

func _test_hub() -> void:
	Net.roster = {1: {"name": "You", "role": "field_medic", "ready": true}}
	var hub: Hub = preload("res://scenes/hub/Hub.tscn").instantiate()
	add_child(hub)
	for i in 4:
		await get_tree().process_frame

	var stations := get_tree().get_nodes_in_group("hub_stations")
	check(stations.size() == 3, "the deck has three stations")
	var ids := {}
	for station in stations:
		ids[(station as HubStation).station_id] = true
	check(ids.has("armoury") and ids.has("roster") and ids.has("mission"),
		"armoury, roster and mission table")

	# Only real people stand on the deck. The hub answers "who is actually
	# here", so a bot must not be standing in as a squadmate.
	var bodies := get_tree().get_nodes_in_group("players")
	check(bodies.size() == 1, "only real operatives stand on the deck")
	check(not bodies[0].is_bot, "and that one is you")
	var seats := get_tree().get_nodes_in_group("empty_seats")
	check(seats.size() == 3, "the three unfilled seats are shown as empty")
	var seat_roles := {}
	for pad in seats:
		seat_roles[pad.get_meta("empty_seat_role", "")] = true
	check(not seat_roles.has("field_medic"), "your own seat is not marked empty")

	check(hub.station_in_reach() == null, "no prompt until you walk onto one")

	hub.queue_free()
	Net.roster = {}
	for i in 3:
		await get_tree().process_frame

# -------------------------------------------------------------- fixtures

## Bots fall through an empty test scene and drift out of range, so the
## behavioural tests need something to stand on.
func _ground() -> void:
	var body := StaticBody3D.new()
	body.collision_layer = 1
	body.collision_mask = 0
	var shape := CollisionShape3D.new()
	var box := BoxShape3D.new()
	box.size = Vector3(200, 1, 200)
	shape.shape = box
	body.add_child(shape)
	add_child(body)
	body.global_position = Vector3(0, -0.5, 0)

func _bot(role_id: String, where: Vector3) -> PlayerCharacter:
	var bot: PlayerCharacter = preload("res://scenes/player/PlayerCharacter.tscn").instantiate()
	bot.role_id = role_id
	bot.peer_id = 0
	bot.is_bot = true
	add_child(bot)
	bot.global_position = where
	return bot

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
