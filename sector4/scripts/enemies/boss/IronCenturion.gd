extends Combatant
class_name IronCenturion
## Unit-01: Iron Centurion. Section 6, in code.
##
## 50,000 HP and four abilities, each of which is a different person's job:
##
##   Plasma Sweep      90 degree frontal cone, turning locked on cast.
##                     The tank points it away from everyone else.
##   Corrosive Vent    a floor grid under a ranged player, and armour
##                     corrosion on the tank. Dash out; purge the tank.
##   System Shockwave  unavoidable, 35% of everyone's max HP. Triage.
##   Core Overcharge   a 4 second channel that wipes the party. Kick it.
##
## Below 50% the recurring cycle accelerates by 25%. The scripted Core
## Overcharges do not accelerate -- they are the fight's clock, and a clock
## that moves is a clock nobody can learn.

const SCRIPTED_TOLERANCE := 0.05

@export var boss_id: String = "unit_01"

var is_enraged: bool = false
var encounter_time: float = 0.0
var active: bool = false

var _def: Dictionary = {}
var _next_at: Dictionary = {}
var _scripted_fired: Array[int] = []
var _turn_locked: bool = false
var _melee_at: float = 0.0
var _gravity: float = float(ProjectSettings.get_setting("physics/3d/default_gravity", 24.0))

@onready var cast_component: CastComponent = $CastComponent

func _ready() -> void:
	team = "enemy"
	super._ready()
	add_to_group("boss")
	corpse_seconds = 9.0
	_def = Content.boss(boss_id)
	display_name = "%s: %s" % [_def.get("display_name", "Unit-01"), _def.get("title", "")]
	armor = float(_def.get("armor", 1.0))
	move_speed = float(_def.get("move_speed", 4.2))
	health_component.setup(float(_def.get("max_health", 50000.0)))
	health_component.health_changed.connect(_on_health_changed)
	cast_component.cast_started.connect(_on_cast_started)
	cast_component.cast_interrupted.connect(_on_cast_interrupted)
	cast_component.cast_finished.connect(_on_cast_finished)
	for entry in _def.get("cycle", []):
		_next_at[entry["ability"]] = float(entry["first"])

func begin_encounter() -> void:
	active = true
	encounter_time = 0.0
	_scripted_fired.clear()

## The interval this ability is currently running at, enrage included. The
## HUD timeline reads this, and so does the test that proves enrage works.
func cycle_interval_for(ability_id: String) -> float:
	for entry in _def.get("cycle", []):
		if entry["ability"] == ability_id:
			var base := float(entry["every"])
			return base / _cast_rate()
	return 0.0

func _cast_rate() -> float:
	return float(_def.get("enrage_cast_rate", 1.25)) if is_enraged else 1.0

# ------------------------------------------------------------------ loop

func _physics_process(delta: float) -> void:
	if not Net.is_server() or is_dead:
		return
	_chase(delta)
	if not active:
		return
	encounter_time += delta
	if cast_component.is_casting:
		return
	# Scripted first: a Core Overcharge must never be crowded out by the
	# recurring cycle landing on the same frame.
	if _try_scripted():
		return
	_try_cycle()

func _try_scripted() -> bool:
	var scripted: Array = _def.get("scripted", [])
	for i in scripted.size():
		if _scripted_fired.has(i):
			continue
		if encounter_time + SCRIPTED_TOLERANCE < float(scripted[i]["at"]):
			continue
		_scripted_fired.append(i)
		_begin(scripted[i]["ability"], "room")
		return true
	return false

func _try_cycle() -> void:
	for entry in _def.get("cycle", []):
		var ability_id: String = entry["ability"]
		if encounter_time < float(_next_at.get(ability_id, INF)):
			continue
		_next_at[ability_id] = encounter_time + cycle_interval_for(ability_id)
		_begin(ability_id, entry.get("target", "threat_leader"))
		return

func _begin(ability_id: String, target_rule: String) -> void:
	var def: Dictionary = Content.ability(ability_id)
	var target := _resolve_target(target_rule)
	# Plasma Sweep commits to a direction the instant the cast starts. That
	# is what gives the tank something to do and everyone else a tell.
	if def.get("locks_turning", false):
		_turn_locked = true
		_face_now(target)
	cast_component.begin(
		ability_id,
		float(def.get("cast_time", 0.0)),
		def.get("interruptible", false),
		func() -> void: _resolve_ability(ability_id, target)
	)

func _resolve_ability(ability_id: String, target: Node3D) -> void:
	_turn_locked = false
	match ability_id:
		"plasma_sweep":
			_plasma_sweep()
		"corrosive_vent":
			_corrosive_vent(target)
		"system_shockwave":
			_system_shockwave()
		"core_overcharge":
			_core_overcharge()

# ------------------------------------------------------------- abilities

## Everything inside a 90 degree wedge in front of the boss. Standing
## behind it is free; standing in front of it is the tank's problem.
func _plasma_sweep() -> void:
	var def: Dictionary = Content.ability("plasma_sweep")
	var arc: float = float(def.get("arc_degrees", 90.0))
	var reach: float = float(def.get("range", 14.0))
	var facing := -global_transform.basis.z
	facing.y = 0.0
	if facing.is_zero_approx():
		return
	for unit in get_tree().get_nodes_in_group("party"):
		if unit.get("is_dead") == true or not (unit is Node3D):
			continue
		var offset: Vector3 = (unit as Node3D).global_position - global_position
		offset.y = 0.0
		if offset.length() > reach or offset.is_zero_approx():
			continue
		if rad_to_deg(facing.normalized().angle_to(offset.normalized())) > arc * 0.5:
			continue
		Combat.apply_damage(self, unit, float(def.get("damage", 420.0)), {
			"school": def.get("school", Content.School.THERMAL),
			"from_position": global_position,
		})

## Two things at once, aimed at two different people: a hazard under a
## ranged player, and armour corrosion on whoever is tanking. One is a
## movement problem and the other is a dispel, which is why this ability
## needs the Field Medic and the Railgun Specialist to both be paying
## attention.
func _corrosive_vent(target: Node3D) -> void:
	var def: Dictionary = Content.ability("corrosive_vent")
	if target != null and is_instance_valid(target):
		var hazard: HazardZone = preload("res://scenes/abilities/HazardZone.tscn").instantiate()
		hazard.configure("corrosive_vent", self)
		var spot := target.global_position
		spot.y = global_position.y
		_spawn_root().add_child(hazard, true)
		hazard.global_position = spot
	var tank := _threat_leader()
	if tank != null:
		var status = tank.get("status_component")
		if status is StatusEffectComponent:
			status.apply(def.get("tank_status", "system_corroded"), 0)

## Unavoidable by design. There is no dodge and no cone -- the answer is
## the healer's Smart Nano-Pulse, which is the point of the button.
func _system_shockwave() -> void:
	var def: Dictionary = Content.ability("system_shockwave")
	var pct: float = float(def.get("max_hp_pct_damage", 0.35))
	for unit in get_tree().get_nodes_in_group("party"):
		if unit.get("is_dead") == true:
			continue
		Combat.apply_max_hp_damage(self, unit, pct)

## If this resolves, the party is dead. It resolves only if nobody kicked
## it, which is the Kinetic Striker's entire reason for being in the room.
func _core_overcharge() -> void:
	for unit in get_tree().get_nodes_in_group("party"):
		var health = unit.get("health_component")
		if health is HealthComponent and not health.is_dead:
			health.kill()
	GameEvents.encounter_ended.emit(false, "Core Overcharge completed")

# -------------------------------------------------------------- movement

func _chase(delta: float) -> void:
	var target := _threat_leader()
	if target == null or _turn_locked:
		velocity.x = move_toward(velocity.x, 0.0, 30.0 * delta)
		velocity.z = move_toward(velocity.z, 0.0, 30.0 * delta)
	else:
		var to_target: Vector3 = target.global_position - global_position
		to_target.y = 0.0
		var distance := to_target.length()
		var desired := Vector3.ZERO
		if distance > 4.0:
			desired = to_target.normalized() * move_speed
		velocity.x = move_toward(velocity.x, desired.x, 30.0 * delta)
		velocity.z = move_toward(velocity.z, desired.z, 30.0 * delta)
		_face_toward(to_target, delta)
		if distance <= 4.5:
			_melee(target)
	velocity.y = 0.0 if is_on_floor() else velocity.y - _gravity * delta
	move_and_slide()

func _melee(target: Node3D) -> void:
	var def: Dictionary = Content.ability(_def.get("melee", "servo_strike"))
	if _now() < _melee_at:
		return
	_melee_at = _now() + float(def.get("cooldown", 1.8))
	Combat.apply_damage(self, target, float(def.get("damage", 55.0)), {
		"school": def.get("school", Content.School.KINETIC),
		"from_position": global_position,
	})

func _face_toward(direction: Vector3, delta: float) -> void:
	if direction.is_zero_approx():
		return
	rotation.y = lerp_angle(
		rotation.y, Combatant.yaw_toward(Vector3.ZERO, direction), clampf(4.5 * delta, 0.0, 1.0)
	)

func _face_now(target: Node3D) -> void:
	if target == null or not is_instance_valid(target):
		return
	var to_target: Vector3 = target.global_position - global_position
	to_target.y = 0.0
	if not to_target.is_zero_approx():
		rotation.y = Combatant.yaw_toward(Vector3.ZERO, to_target)

# --------------------------------------------------------------- targets

func _resolve_target(rule: String) -> Node3D:
	match rule:
		"threat_leader":
			return _threat_leader()
		"random_ranged":
			return _random_ranged()
		_:
			return _threat_leader()

func _threat_leader() -> Node3D:
	if threat_component == null:
		return null
	var leader := threat_component.get_leader()
	if leader != null and is_instance_valid(leader) and leader.get("is_dead") != true:
		return leader as Node3D
	return _nearest_party()

## Corrosive Vent goes under someone standing away from the boss, so the
## hazard lands where the ranged players live rather than on top of the
## melee pile.
func _random_ranged() -> Node3D:
	var candidates: Array[Node3D] = []
	for unit in get_tree().get_nodes_in_group("party"):
		if unit.get("is_dead") == true or not (unit is Node3D):
			continue
		if unit == _threat_leader():
			continue
		if global_position.distance_to((unit as Node3D).global_position) > 8.0:
			candidates.append(unit as Node3D)
	if candidates.is_empty():
		return _nearest_party()
	return candidates[randi() % candidates.size()]

func _nearest_party() -> Node3D:
	var best: Node3D = null
	var nearest := INF
	for unit in get_tree().get_nodes_in_group("party"):
		if unit.get("is_dead") == true or not (unit is Node3D):
			continue
		var d: float = global_position.distance_to((unit as Node3D).global_position)
		if d < nearest:
			nearest = d
			best = unit as Node3D
	return best

# ---------------------------------------------------------------- enrage

func _on_health_changed(current: float, maximum: float) -> void:
	GameEvents.boss_health_changed.emit(current, maximum)
	_check_enrage()

func _check_enrage() -> void:
	if is_enraged:
		return
	if health_component.get_health_percent() > float(_def.get("enrage_hp_pct", 0.5)):
		return
	is_enraged = true
	status_component.apply("enraged", 0)
	# Pull every pending recast in by the same 25%, so the acceleration is
	# felt immediately rather than after the current timers run out.
	for ability_id in _next_at:
		var remaining: float = maxf(0.0, float(_next_at[ability_id]) - encounter_time)
		_next_at[ability_id] = encounter_time + remaining / _cast_rate()
	GameEvents.boss_enraged.emit()

# --------------------------------------------------------------- signals

func _on_cast_started(ability_id: String, duration: float, interruptible: bool) -> void:
	GameEvents.boss_cast_started.emit(
		ability_id, Content.ability(ability_id).get("display_name", ability_id), duration, interruptible
	)

func _on_cast_interrupted(ability_id: String) -> void:
	_turn_locked = false
	GameEvents.boss_cast_finished.emit(ability_id, true)

func _on_cast_finished(ability_id: String) -> void:
	GameEvents.boss_cast_finished.emit(ability_id, false)

func _spawn_root() -> Node:
	var root := get_tree().get_first_node_in_group("spawn_root")
	return root if root != null else get_tree().current_scene

func _now() -> float:
	return float(Time.get_ticks_msec()) / 1000.0
