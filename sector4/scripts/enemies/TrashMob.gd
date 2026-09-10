extends Combatant
class_name TrashMob
## A single trash mob, and the tactical layer from section 3.
##
## The three rules that make a pull a decision rather than a sprint:
##
##   * A mob is asleep until something wakes it, and waking one wakes its
##     pack and nobody else.
##   * A ranged mob will not walk into melee. It stands where it is and
##     shoots, and the only way to move it is to break line of sight --
##     which is the tank's job and the reason corridors exist.
##   * Patrols do not care what you pulled. Time the pull badly and they
##     walk into it.

enum State { DORMANT, ALERTED, ENGAGED, CROWD_CONTROLLED }

@export var mob_type: String = "sentry_drone"

var state: State = State.DORMANT
var pack: AggroPack = null
var patrol_route: PackedVector3Array = PackedVector3Array()

var _is_ranged: bool = false
var _holds_ground: bool = false
var _preferred_range: float = 22.0
var _melee_range: float = 3.0
var _abilities: Array = []
var _next_ability_at: Dictionary = {}
var _patrol_index: int = 0
var _cc_until: float = 0.0
var _knockback: Vector3 = Vector3.ZERO
var _home: Vector3 = Vector3.ZERO
var _gravity: float = float(ProjectSettings.get_setting("physics/3d/default_gravity", 24.0))

@onready var cast_component: CastComponent = $CastComponent

func _ready() -> void:
	team = "enemy"
	super._ready()
	add_to_group("trash")
	_configure()
	_home = global_position

func _configure() -> void:
	var def: Dictionary = Content.mob(mob_type)
	if def.is_empty():
		push_error("Sector-4: unknown mob type '%s'" % mob_type)
		return
	display_name = def.get("display_name", "Drone")
	armor = float(def.get("armor", 1.0))
	move_speed = float(def.get("move_speed", 5.0))
	_is_ranged = def.get("ranged", false)
	_holds_ground = def.get("holds_ground", false)
	_preferred_range = float(def.get("preferred_range", 22.0))
	_melee_range = float(def.get("melee_range", 3.0))
	_abilities = def.get("abilities", [])
	health_component.setup(float(def.get("max_health", 500.0)))

# ------------------------------------------------------------- waking up

## Called when this mob is shot, taunted, or walked into. It wakes the pack
## rather than just itself -- "pulling one alerts only its immediate squad"
## is a statement about both directions: the squad comes, and nobody else.
func on_pulled_by(puller: Node) -> void:
	if pack != null:
		pack.alert(puller)
	else:
		alert(puller)

func alert(puller: Node) -> void:
	if state != State.DORMANT:
		return
	state = State.ALERTED
	if puller != null and threat_component != null:
		threat_component.add_threat(puller, 100.0)

func is_awake() -> bool:
	return state != State.DORMANT

# ----------------------------------------------------------------- brain

func _physics_process(delta: float) -> void:
	if not Net.is_server() or is_dead:
		return
	if state == State.CROWD_CONTROLLED:
		if _now() >= _cc_until:
			state = State.ENGAGED
		else:
			_settle(delta)
			return
	if state == State.DORMANT:
		_patrol(delta)
		return
	_fight(delta)

func _fight(delta: float) -> void:
	var target := _current_target()
	if target == null:
		_settle(delta)
		return
	state = State.ENGAGED
	var to_target: Vector3 = target.global_position - global_position
	to_target.y = 0.0
	var distance := to_target.length()

	_face(to_target, delta)
	_step(_desired_velocity(target, to_target, distance), delta)

	if cast_component.is_casting:
		return
	if status_component.has("interrupt_lockout"):
		return
	_try_ability(target, distance)

## The line-of-sight rule, in one function.
##
## A ranged mob that can see its target stands still and shoots. Take that
## sight line away -- step behind a pillar, round a corner -- and it has to
## come to you. That is the whole of LoS pulling.
func _desired_velocity(target: Node3D, to_target: Vector3, distance: float) -> Vector3:
	var direction := to_target.normalized() if distance > 0.01 else Vector3.ZERO
	if _is_ranged and _holds_ground:
		if not _can_see(target):
			return direction * move_speed          # it has to come and look
		if distance > _preferred_range:
			return direction * move_speed          # drifting into its own range
		if distance < _preferred_range * 0.55:
			return -direction * move_speed * 0.7   # backing off, never closing
		return Vector3.ZERO
	if distance > _melee_range * 0.85:
		return direction * move_speed
	return Vector3.ZERO

func _can_see(target: Node3D) -> bool:
	var space := get_world_3d().direct_space_state
	var query := PhysicsRayQueryParameters3D.create(
		aim_point(), target.global_position + Vector3(0, 1.1, 0), 1, [get_rid()]
	)
	var hit := space.intersect_ray(query)
	return hit.is_empty() or hit.get("collider") == target

func _try_ability(target: Node3D, distance: float) -> void:
	for ability_id in _abilities:
		if _now() < float(_next_ability_at.get(ability_id, 0.0)):
			continue
		var def: Dictionary = Content.ability(ability_id)
		if distance > float(def.get("range", 3.0)):
			continue
		if _is_ranged and not _can_see(target):
			continue
		_next_ability_at[ability_id] = _now() + float(def.get("cooldown", 2.0))
		var cast_time: float = float(def.get("cast_time", 0.0))
		cast_component.begin(
			ability_id, cast_time, def.get("interruptible", false),
			func() -> void: _resolve(ability_id, target)
		)
		return

func _resolve(ability_id: String, target: Node3D) -> void:
	if is_dead or target == null or not is_instance_valid(target) or target.get("is_dead") == true:
		return
	var def: Dictionary = Content.ability(ability_id)
	# A debuff-first mob. Glitch Field costs the party throughput rather
	# than health, which keeps the punishment on the person who stood in it
	# instead of on the healer.
	var applies: String = def.get("applies", "")
	if applies != "":
		var status = target.get("status_component")
		if status is StatusEffectComponent:
			status.apply(applies, 0)
		return
	Combat.apply_damage(self, target, float(def.get("damage", 0.0)), {
		"school": def.get("school", Content.School.KINETIC),
		"from_position": global_position,
	})

func _current_target() -> Node3D:
	if threat_component == null:
		return null
	var leader := threat_component.get_leader()
	if leader != null and is_instance_valid(leader) and leader.get("is_dead") != true:
		return leader as Node3D
	# Nothing on the table yet: take whoever is closest, so a mob that
	# wakes to a patrol link still has something to walk at.
	var best: Node3D = null
	var nearest := 60.0
	for unit in get_tree().get_nodes_in_group("party"):
		if unit.get("is_dead") == true or not (unit is Node3D):
			continue
		var d: float = global_position.distance_to((unit as Node3D).global_position)
		if d < nearest:
			nearest = d
			best = unit as Node3D
	if best != null and threat_component != null:
		threat_component.add_threat(best, 1.0)
	return best

# -------------------------------------------------------------- patrols

## Patrols walk their route whatever else is happening. A pack pulled while
## the patrol is on top of it is a pull with extra adds, and that is the
## player's mistake rather than the game's.
func _patrol(delta: float) -> void:
	if patrol_route.size() < 2:
		_settle(delta)
		return
	var waypoint: Vector3 = patrol_route[_patrol_index]
	var to_waypoint := waypoint - global_position
	to_waypoint.y = 0.0
	if to_waypoint.length() < 1.2:
		_patrol_index = (_patrol_index + 1) % patrol_route.size()
		return
	_face(to_waypoint, delta)
	_step(to_waypoint.normalized() * move_speed * 0.6, delta)
	_check_patrol_link()

## Walking past a fight joins it. This is the cost of pulling on a bad
## timer, and it is deliberately not forgiving.
func _check_patrol_link() -> void:
	for other in get_tree().get_nodes_in_group("trash"):
		if other == self or other.get("is_dead") == true:
			continue
		if not (other is TrashMob) or not (other as TrashMob).is_awake():
			continue
		if global_position.distance_to((other as TrashMob).global_position) <= Content.AGGRO_LINK_RADIUS:
			alert((other as TrashMob)._current_target())
			return

# ------------------------------------------------------------- movement

func _settle(delta: float) -> void:
	_step(Vector3.ZERO, delta)

func _step(desired: Vector3, delta: float) -> void:
	velocity.x = move_toward(velocity.x, desired.x, 40.0 * delta)
	velocity.z = move_toward(velocity.z, desired.z, 40.0 * delta)
	if not _knockback.is_zero_approx():
		velocity += _knockback
		_knockback = _knockback.move_toward(Vector3.ZERO, 55.0 * delta)
	velocity.y = 0.0 if is_on_floor() else velocity.y - _gravity * delta
	move_and_slide()

func _face(direction: Vector3, delta: float) -> void:
	if direction.is_zero_approx():
		return
	var desired := atan2(direction.x, direction.z)
	rotation.y = lerp_angle(rotation.y, desired, clampf(9.0 * delta, 0.0, 1.0))

# ------------------------------------------------------ what can be done

func apply_knockback(impulse: Vector3) -> void:
	_knockback = impulse
	# Being shoved wakes it, or the Railgun could kite a dormant pack apart.
	on_pulled_by(null)

func apply_crowd_control(seconds: float) -> void:
	state = State.CROWD_CONTROLLED
	_cc_until = _now() + seconds
	cast_component.cancel()

func _now() -> float:
	return float(Time.get_ticks_msec()) / 1000.0
