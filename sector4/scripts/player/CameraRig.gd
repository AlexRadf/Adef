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
@export var shoulder_offset: Vector3 = Vector3(0.55, 1.55, 0.0)
@export var transition_speed: float = 9.0

var preset_index: int = 1
var yaw: float = 0.0
var pitch: float = -0.12

var _target_length: float = 2.5
var _owner_meshes: Array[GeometryInstance3D] = []

@onready var spring_arm: SpringArm3D = $SpringArm3D
@onready var camera: Camera3D = $SpringArm3D/Camera3D

func _ready() -> void:
	position = shoulder_offset
	spring_arm.spring_length = PRESETS[preset_index]
	_target_length = PRESETS[preset_index]
	# The boom must not catch on the operative it is following.
	var body := get_parent()
	if body is CollisionObject3D:
		spring_arm.add_excluded_object(body.get_rid())
	_collect_owner_meshes(body)

func set_active(active: bool) -> void:
	camera.current = active
	set_process(active)
	set_process_input(active)
	if active:
		GameEvents.camera_preset_changed.emit(preset_index, PRESETS[preset_index])

func _input(event: InputEvent) -> void:
	if event is InputEventMouseMotion and Input.mouse_mode == Input.MOUSE_MODE_CAPTURED:
		yaw -= event.relative.x * mouse_sensitivity
		pitch = clampf(pitch - event.relative.y * mouse_sensitivity, deg_to_rad(min_pitch_deg), deg_to_rad(max_pitch_deg))

func _process(delta: float) -> void:
	# Right stick. Polled rather than evented so a pad feels the same as
	# the mouse regardless of how often the driver reports.
	var look := Input.get_vector("look_left", "look_right", "look_up", "look_down")
	if look.length_squared() > 0.0:
		yaw -= look.x * stick_sensitivity * delta
		pitch = clampf(pitch - look.y * stick_sensitivity * delta, deg_to_rad(min_pitch_deg), deg_to_rad(max_pitch_deg))

	if Input.is_action_just_pressed("toggle_camera"):
		cycle_preset()

	rotation = Vector3(pitch, yaw, 0.0)
	spring_arm.spring_length = move_toward(spring_arm.spring_length, _target_length, transition_speed * delta)
	_update_owner_visibility()

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
	var visible_body := length > 0.35
	if visible_body and length < 1.2:
		mode = GeometryInstance3D.SHADOW_CASTING_SETTING_SHADOWS_ONLY
	for mesh in _owner_meshes:
		if not is_instance_valid(mesh):
			continue
		mesh.visible = visible_body
		mesh.cast_shadow = mode
