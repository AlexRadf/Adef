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

func _ready() -> void:
	add_to_group("terminals")
	var cylinder := CylinderShape3D.new()
	cylinder.radius = 3.0
	cylinder.height = 3.0
	_shape.shape = cylinder
	body_entered.connect(func(body: Node3D) -> void:
		if body.get("team") == "party":
			_occupants[body] = true)
	body_exited.connect(func(body: Node3D) -> void: _occupants.erase(body))

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

func _tint() -> void:
	var mat := _pillar.material_override as StandardMaterial3D
	if mat == null:
		mat = StandardMaterial3D.new()
		mat.emission_enabled = true
		_pillar.material_override = mat
	var held := _held_count() > 0
	var colour := Color(0.2, 1.0, 0.5) if is_unlocked else (Color(1.0, 0.75, 0.2) if held else Color(0.9, 0.25, 0.25))
	mat.albedo_color = colour
	mat.emission = colour
	mat.emission_energy_multiplier = 1.0 + fraction() * 2.0
