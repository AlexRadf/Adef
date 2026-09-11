extends Combatant
class_name PlayerCharacter
## One of the four operatives.
##
## Movement and camera run locally on the machine holding the pad, so the
## controls have no input latency. Everything that changes the shared world
## -- damage, healing, dispels, marks -- is a request to the server, which
## is the only thing allowed to answer. A client can mispredict where it is
## standing and get corrected; it can never mispredict a kill.

const GROUND_ACCEL := 60.0
const AIR_ACCEL := 14.0
const FRICTION := 52.0

@export var role_id: String = "field_medic"

var kit: RoleKit = null
var brain: BotBrain = null
var dash_velocity: Vector3 = Vector3.ZERO
var dash_decay: float = 24.0
var is_local: bool = false
## True for a seat nobody is sitting in. A bot is driven by the server and
## has no camera, so it supplies its own movement and facing.
var is_bot: bool = false
var ai_move_intent: Vector3 = Vector3.ZERO
var ai_face_target: Vector3 = Vector3.ZERO

@onready var camera_rig: CameraRig = $CameraRig
@onready var ally_targeting: SoftLockTargeting = $AllyTargeting
@onready var enemy_targeting: SoftLockTargeting = $EnemyTargeting
@onready var body_mesh: MeshInstance3D = $BodyMesh
@onready var synchronizer: MultiplayerSynchronizer = $MultiplayerSynchronizer

var _gravity: float = float(ProjectSettings.get_setting("physics/3d/default_gravity", 24.0))
var _bindings: Dictionary = {}
var _held_actions: Dictionary = {}

func _ready() -> void:
	team = "party"
	super._ready()
	add_to_group("players")
	_configure_role()
	is_local = not is_bot and peer_id == Net.local_id()
	# A bot's authority is the server, because there is nobody else to give
	# it to.
	set_multiplayer_authority(1 if is_bot or peer_id == 0 else peer_id)

	camera_rig.set_active(is_local)
	ally_targeting.bind_camera(camera_rig.camera)
	enemy_targeting.bind_camera(camera_rig.camera)
	# Only the machine driving this body scores targets for it; the others
	# would be scoring against a camera nobody is looking through.
	ally_targeting.set_process(is_local)
	enemy_targeting.set_process(is_local)
	set_process(is_local)

	if is_local:
		health_component.health_changed.connect(_on_local_health_changed)
		if ability_component != null:
			ability_component.energy_changed.connect(_on_local_energy_changed)
		Input.mouse_mode = Input.MOUSE_MODE_CAPTURED

	# A solo run has no peers, and Godot's default offline peer has no
	# unique id -- so a synchronizer left running there polls every physics
	# tick and errors every time. There is nothing to replicate to, so it
	# goes away entirely.
	if not Net.online():
		synchronizer.queue_free()

	if is_bot and Net.is_server():
		brain = BotBrain.new()
		brain.name = "Brain"
		add_child(brain)
		brain.bind(self)

## The operative this machine is driving, or null in a spectator/headless
## run. The HUD asks for this constantly, so it lives in one place.
static func local(tree: SceneTree) -> PlayerCharacter:
	for candidate in tree.get_nodes_in_group("players"):
		if candidate is PlayerCharacter and (candidate as PlayerCharacter).is_local:
			return candidate as PlayerCharacter
	return null

func _configure_role() -> void:
	var def: Dictionary = Content.role(role_id)
	if def.is_empty():
		push_error("Sector-4: unknown role '%s'" % role_id)
		return
	display_name = def.get("display_name", "Operative")
	armor = float(def.get("armor", 1.0))
	move_speed = float(def.get("move_speed", 6.0))
	threat_aura = float(def.get("threat_aura", 1.0))
	health_component.setup(float(def.get("max_health", 900.0)))
	if ability_component != null:
		ability_component.setup(float(def.get("max_energy", 100.0)), float(def.get("energy_regen", 6.0)))
	_bindings = Content.bindings_for_role(role_id)
	# Equipment is fitted before anything else touches the stats, so the
	# health bar the player sees already accounts for their plating.
	Loadout.apply_to(self, role_id)
	kit = RoleKit.make(role_id)
	kit.name = "Kit"
	add_child(kit)
	kit.bind(self)
	body_mesh.material_override = _role_material(def)

func _role_material(def: Dictionary) -> StandardMaterial3D:
	var mat := StandardMaterial3D.new()
	var tint := {
		"tank": Color(0.30, 0.55, 0.95),
		"healer": Color(0.35, 0.90, 0.65),
		"melee_dps": Color(0.95, 0.55, 0.25),
		"ranged_dps": Color(0.85, 0.35, 0.85),
	}
	mat.albedo_color = tint.get(def.get("archetype", ""), Color(0.7, 0.7, 0.7))
	mat.metallic = 0.45
	mat.roughness = 0.4
	return mat

# ------------------------------------------------------------- input

func _process(_delta: float) -> void:
	if is_dead:
		return
	# Mouse-look drives aiming, so abilities stay holstered while the
	# cursor is free rather than firing at wherever the camera was left.
	if Input.mouse_mode != Input.MOUSE_MODE_CAPTURED:
		return
	# Step through the party without looking away from what you are
	# fighting. The soft lock is an aiming aid; this is the override.
	if Input.is_action_just_pressed("cycle_ally"):
		ally_targeting.cycle(true)
	_poll_abilities()

## Held actions and tapped actions are the same table; the kit decides
## which of the two it wanted. Nano-Injector is a channel, so it needs the
## hold; System Purge is instant, so it needs the tap.
func _poll_abilities() -> void:
	for action in _bindings:
		var ability_id: String = _bindings[action]
		var pressed := Input.is_action_pressed(action)
		var was_held: bool = _held_actions.get(action, false)
		if Input.is_action_just_pressed(action):
			kit.on_pressed(ability_id)
		elif was_held and not pressed:
			kit.on_released(ability_id)
		elif pressed:
			kit.on_held(ability_id)
		_held_actions[action] = pressed

# ---------------------------------------------------------- movement

func _physics_process(delta: float) -> void:
	if not drives_this_body():
		return
	if is_dead:
		velocity = Vector3.ZERO
		move_and_slide()
		return

	var wish := Vector3.ZERO
	if is_local:
		var stick := Input.get_vector("move_left", "move_right", "move_forward", "move_back")
		wish = (camera_rig.right_flat() * stick.x + camera_rig.forward_flat() * -stick.y)
		if wish.length_squared() > 1.0:
			wish = wish.normalized()
	elif is_bot:
		wish = ai_move_intent

	var speed_scale := status_component.get_stat("move_speed")
	var target := wish * move_speed * speed_scale
	var accel := GROUND_ACCEL if is_on_floor() else AIR_ACCEL

	velocity.x = move_toward(velocity.x, target.x, accel * delta)
	velocity.z = move_toward(velocity.z, target.z, accel * delta)
	if wish.is_zero_approx() and is_on_floor():
		velocity.x = move_toward(velocity.x, 0.0, FRICTION * delta)
		velocity.z = move_toward(velocity.z, 0.0, FRICTION * delta)

	# The dash is an impulse that decays, not a speed change, so it carries
	# you out of a Corrosive Vent even if you were standing still.
	if not dash_velocity.is_zero_approx():
		velocity += dash_velocity
		dash_velocity = dash_velocity.move_toward(Vector3.ZERO, dash_decay * delta)

	if is_on_floor():
		velocity.y = 0.0
	else:
		velocity.y -= _gravity * delta

	move_and_slide()
	_face_movement(delta)

## The body turns to face where the camera is pointing, which is what makes
## the frontal cone and the backstab arc readable to everyone else.
func _face_movement(delta: float) -> void:
	if is_local:
		rotation.y = lerp_angle(rotation.y, camera_rig.yaw, clampf(14.0 * delta, 0.0, 1.0))
		return
	if not is_bot:
		return
	# A bot faces what it is fighting, which is what makes the Striker's
	# backstab arc and the Enforcer's shield arc mean anything.
	var offset := ai_face_target - global_position
	offset.y = 0.0
	if offset.is_zero_approx():
		return
	rotation.y = lerp_angle(
		rotation.y, Combatant.yaw_toward(Vector3.ZERO, offset), clampf(9.0 * delta, 0.0, 1.0)
	)

## Whether this machine is the one moving this body.
##
## `is_multiplayer_authority()` asks the peer for its unique id, and a solo
## run has no peer to ask -- so calling it unguarded errors once per
## physics tick, forever. Offline, this body is always ours.
func drives_this_body() -> bool:
	return not Net.online() or is_multiplayer_authority()

func apply_dash(direction: Vector3, impulse: float, decay: float = 24.0) -> void:
	var dir := direction
	if dir.is_zero_approx():
		dir = camera_rig.forward_flat() if is_local else -global_transform.basis.z
	dash_velocity = dir.normalized() * impulse
	dash_decay = maxf(1.0, decay)
	# The travel line, so a dash reads as going somewhere rather than as a
	# stutter. Length matches the distance it will actually cover.
	var travel := impulse * impulse / (2.0 * dash_decay)
	AbilityFx.tracer(
		global_position + Vector3(0, 0.9, 0),
		global_position + Vector3(0, 0.9, 0) + dir.normalized() * travel,
		Color(0.45, 0.85, 1.0, 0.55), 0.12
	)

## The direction the operative is currently asking to move, in world space.
## Rocket Dash uses this so a dash goes where you are already going rather
## than where the camera happens to look.
func move_intent() -> Vector3:
	if is_bot:
		return ai_move_intent
	if not is_local:
		return Vector3.ZERO
	var stick := Input.get_vector("move_left", "move_right", "move_forward", "move_back")
	if stick.is_zero_approx():
		return Vector3.ZERO
	return (camera_rig.right_flat() * stick.x + camera_rig.forward_flat() * -stick.y).normalized()

func aim_origin() -> Vector3:
	return aim_point() if is_bot else camera_rig.camera.global_position

func aim_direction() -> Vector3:
	return -global_transform.basis.z if is_bot else camera_rig.aim_forward()

# ------------------------------------------------------------ signals

func _on_local_health_changed(current: float, maximum: float) -> void:
	GameEvents.local_health_changed.emit(current, maximum)

func _on_local_energy_changed(current: float, maximum: float) -> void:
	GameEvents.energy_changed.emit(current, maximum)
