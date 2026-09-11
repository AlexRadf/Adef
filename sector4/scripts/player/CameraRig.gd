extends Node3D
class_name CameraRig
## Over-the-shoulder boom with three presets, toggled on R3.
##
##   0.0m  first person
##   2.5m  close third person
##   5.0m  wide third person
##
## The boom is a SpringArm3D, so it shortens along its own line when it
## meets geometry rather than clipping through it. At first person the
## operative's own mesh is hidden, and near the body it fades, so backing
## into a corner never puts the camera inside your own head.

const PRESETS: Array[float] = [0.0, 2.5, 5.0]
const PRESET_NAMES: Array[String] = ["First Person", "Close", "Wide"]

@export var mouse_sensitivity: float = 0.0022
@export var stick_sensitivity: float = 2.6
@export var min_pitch_deg: float = -72.0
@export var max_pitch_deg: float = 68.0
@export var shoulder_offset: Vector3 = Vector3(0.85, 1.6, 0.0)
@export var transition_speed: float = 9.0

var preset_index: int = 2
var yaw: float = 0.0
var pitch: float = -0.12

var _target_length: float = 2.5
var _owner_meshes: Array[GeometryInstance3D] = []
var _body: Node3D = null

@onready var spring_arm: SpringArm3D = $SpringArm3D
@onready var camera: Camera3D = $SpringArm3D/Camera3D

func _ready() -> void:
	# The rig lives in world space, not in the operative's.
	#
	# It is parented to the body for convenience, but the body turns to
	# follow the camera -- so a local rotation here would be applied on top
	# of the body's own, putting the camera at roughly double the yaw the
	# movement basis is computed from. Going top_level breaks that feedback
	# loop: the rig owns its orientation outright and simply follows the
	# body's position.
	top_level = true
	var body := get_parent()
	if body is Node3D:
		_body = body as Node3D
	# The over-the-shoulder offset belongs to the boom rather than the
	# pivot, so it swings round with the camera instead of with the body.
	spring_arm.position = Vector3(shoulder_offset.x, 0.0, 0.0)
	spring_arm.spring_length = PRESETS[preset_index]
	_target_length = PRESETS[preset_index]
	# The boom must not catch on the operative it is following.
	if body is CollisionObject3D:
		spring_arm.add_excluded_object(body.get_rid())
	_collect_owner_meshes(body)
	Settings.changed.connect(_apply_settings)
	_apply_settings()
	_follow_body()

## Sensitivity, inversion and field of view are the settings that stop
## someone playing at all if they are wrong, so they apply live rather
## than needing a restart.
func _apply_settings() -> void:
	mouse_sensitivity = float(Settings.get_value("mouse_sensitivity"))
	stick_sensitivity = float(Settings.get_value("stick_sensitivity"))
	if camera != null:
		camera.fov = float(Settings.get_value("field_of_view"))

func set_active(active: bool) -> void:
	camera.current = active
	set_process(active)
	set_process_input(active)
	if active:
		GameEvents.camera_preset_changed.emit(preset_index, PRESETS[preset_index])

func _input(event: InputEvent) -> void:
	if event is InputEventMouseMotion and Input.mouse_mode == Input.MOUSE_MODE_CAPTURED:
		yaw -= event.relative.x * mouse_sensitivity
		var look_y: float = event.relative.y * mouse_sensitivity
		if bool(Settings.get_value("invert_look_y")):
			look_y = -look_y
		pitch = clampf(pitch - look_y, deg_to_rad(min_pitch_deg), deg_to_rad(max_pitch_deg))

func _process(delta: float) -> void:
	# Right stick. Polled rather than evented so a pad feels the same as
	# the mouse regardless of how often the driver reports.
	var look := Input.get_vector("look_left", "look_right", "look_up", "look_down")
	if look.length_squared() > 0.0:
		yaw -= look.x * stick_sensitivity * delta
		var stick_y: float = look.y * stick_sensitivity * delta
		if bool(Settings.get_value("invert_look_y")):
			stick_y = -stick_y
		pitch = clampf(pitch - stick_y, deg_to_rad(min_pitch_deg), deg_to_rad(max_pitch_deg))

	if Input.is_action_just_pressed("toggle_camera"):
		cycle_preset()

	_follow_body()
	spring_arm.spring_length = move_toward(spring_arm.spring_length, _target_length, transition_speed * delta)
	_update_owner_visibility()

## Pivot on the operative's head, oriented in world space. Because the rig
## is top_level both of these are absolute, which is what keeps
## `forward_flat()` honest -- the direction the player walks is the
## direction the camera is actually looking.
func _follow_body() -> void:
	global_rotation = Vector3(pitch, yaw, 0.0)
	if _body != null and is_instance_valid(_body):
		global_position = _body.global_position + Vector3(0.0, shoulder_offset.y, 0.0)

func cycle_preset() -> void:
	preset_index = (preset_index + 1) % PRESETS.size()
	_target_length = PRESETS[preset_index]
	GameEvents.camera_preset_changed.emit(preset_index, _target_length)

func is_first_person() -> bool:
	return preset_index == 0

## Flat forward, for camera-relative movement. The pitch must not make you
## walk into the floor.
func forward_flat() -> Vector3:
	return Vector3(-sin(yaw), 0.0, -cos(yaw)).normalized()

func right_flat() -> Vector3:
	return Vector3(cos(yaw), 0.0, -sin(yaw)).normalized()

## Where the crosshair actually points, which is the camera's own forward
## and not the body's -- the soft-lock scorer is judged against this.
func aim_forward() -> Vector3:
	return -camera.global_transform.basis.z.normalized()

func _collect_owner_meshes(node: Node) -> void:
	if node == null:
		return
	for child in node.get_children():
		if child is GeometryInstance3D:
			_owner_meshes.append(child)
		_collect_owner_meshes(child)

## Fade the body out as the boom closes on it, and hide it outright in
## first person, so the camera never ends up looking at the inside of a
## mesh.
func _update_owner_visibility() -> void:
	var length := spring_arm.spring_length
	var mode := GeometryInstance3D.SHADOW_CASTING_SETTING_ON
	# Hidden in first person, and shadows-only whenever the boom is close
	# enough that the body would be filling the screen rather than framing
	# the shot.
	var visible_body := length > 1.6
	if length > 0.35 and length <= 1.6:
		mode = GeometryInstance3D.SHADOW_CASTING_SETTING_SHADOWS_ONLY
	for mesh in _owner_meshes:
		if not is_instance_valid(mesh):
			continue
		mesh.visible = visible_body
		mesh.cast_shadow = mode
