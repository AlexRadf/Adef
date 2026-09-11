extends Area3D
class_name SecurityTerminal
## The Security Override: hold the terminal while the adds come.
##
## The unlock is a timer that only runs while somebody is standing on it,
## and waves arrive part-way through. That splits the party -- one person
## anchored, three people handling what walks in -- which is the point of
## putting a door between the trash and the boss.

signal unlocked()
signal progress_changed(fraction: float)
signal wave_spawned(index: int)

@export var unlock_seconds: float = 12.0
@export var wave_count: int = 2
@export var wave_types: Array = ["sentry_drone"]

var progress: float = 0.0
var is_unlocked: bool = false

var _occupants: Dictionary = {}
var _waves_sent: int = 0

@onready var _shape: CollisionShape3D = $CollisionShape3D
@onready var _pillar: MeshInstance3D = $Pillar

var _beam: MeshInstance3D = null
var _pad: MeshInstance3D = null

func _ready() -> void:
	add_to_group("terminals")
	var cylinder := CylinderShape3D.new()
	cylinder.radius = 3.0
	cylinder.height = 3.0
	_shape.shape = cylinder
	_build_beacon()
	body_entered.connect(func(body: Node3D) -> void:
		if body.get("team") == "party":
			_occupants[body] = true)
	body_exited.connect(func(body: Node3D) -> void: _occupants.erase(body))

## A pad you can see you are standing on, and a column of light you can
## see from the far end of the floor. "Where is the terminal" should never
## be a question.
func _build_beacon() -> void:
	_pad = MeshInstance3D.new()
	var pad_mesh := CylinderMesh.new()
	pad_mesh.top_radius = 3.0
	pad_mesh.bottom_radius = 3.0
	pad_mesh.height = 0.06
	_pad.mesh = pad_mesh
	add_child(_pad)
	_pad.position = Vector3(0.0, 0.03, 0.0)

	_beam = MeshInstance3D.new()
	var beam_mesh := CylinderMesh.new()
	beam_mesh.top_radius = 1.1
	beam_mesh.bottom_radius = 1.7
	beam_mesh.height = 14.0
	_beam.mesh = beam_mesh
	add_child(_beam)
	_beam.position = Vector3(0.0, 7.0, 0.0)

func _process(delta: float) -> void:
	_tint()
	if is_unlocked or not Net.is_server():
		return
	if _held_count() == 0:
		return
	progress = minf(unlock_seconds, progress + delta)
	progress_changed.emit(fraction())
	_maybe_send_wave()
	if progress >= unlock_seconds:
		is_unlocked = true
		unlocked.emit()

func fraction() -> float:
	return clampf(progress / maxf(0.01, unlock_seconds), 0.0, 1.0)

func _held_count() -> int:
	var count := 0
	for body in _occupants.keys():
		if is_instance_valid(body) and body.get("is_dead") != true:
			count += 1
	return count

## Waves are spaced across the unlock rather than dumped at the start, so
## the pressure builds as the bar fills.
func _maybe_send_wave() -> void:
	if wave_count <= 0 or _waves_sent >= wave_count:
		return
	var next_at: float = unlock_seconds * (float(_waves_sent + 1) / float(wave_count + 1))
	if progress < next_at:
		return
	_waves_sent += 1
	_spawn_wave()
	wave_spawned.emit(_waves_sent)

func _spawn_wave() -> void:
	var mob_scene: PackedScene = preload("res://scenes/enemies/TrashMob.tscn")
	var root := get_tree().get_first_node_in_group("spawn_root")
	if root == null:
		root = get_parent()
	var pack := AggroPack.new()
	pack.pack_name = "Override Wave %d" % _waves_sent
	root.add_child(pack)
	for i in wave_types.size():
		var mob: TrashMob = mob_scene.instantiate()
		mob.mob_type = wave_types[i]
		root.add_child(mob, true)
		var angle := TAU * float(i) / float(maxi(1, wave_types.size()))
		mob.global_position = global_position + Vector3(cos(angle) * 12.0, 0.0, sin(angle) * 12.0)
		pack.adopt(mob)
	# A wave that has to be pulled is not a wave. These arrive awake.
	pack.alert(_nearest_occupant())

func _nearest_occupant() -> Node:
	for body in _occupants.keys():
		if is_instance_valid(body):
			return body
	return null

## Red when nobody is on it, amber while it is running, green when it is
## done -- the same three-state read as the hazard telegraphs.
func _tint() -> void:
	var held := _held_count() > 0
	var colour := Color(0.2, 1.0, 0.5) if is_unlocked else (Color(1.0, 0.75, 0.2) if held else Color(0.95, 0.3, 0.25))
	_paint(_pillar, colour, 1.0 + fraction() * 2.0, 1.0)
	if _pad != null:
		# The pad fills up as the override runs, so progress is underfoot
		# as well as on the HUD.
		_paint(_pad, colour, 0.6 + fraction() * 2.4, 0.30 + fraction() * 0.45)
	if _beam != null:
		var pulse := 0.10 + 0.06 * sin(float(Time.get_ticks_msec()) / 260.0)
		_paint(_beam, colour, 1.6, 0.0 if is_unlocked else pulse)

func _paint(mesh: MeshInstance3D, colour: Color, energy: float, alpha: float) -> void:
	var mat := mesh.material_override as StandardMaterial3D
	if mat == null:
		mat = StandardMaterial3D.new()
		mat.emission_enabled = true
		mat.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
		mat.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
		mesh.material_override = mat
	mat.albedo_color = Color(colour, alpha)
	mat.emission = colour
	mat.emission_energy_multiplier = energy
