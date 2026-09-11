extends Area3D
class_name HubStation
## A thing in the hub you can walk up to and use.
##
## Stations are physical rather than menu entries, because walking to the
## armoury and seeing your squad standing around it is the whole point of
## having a hub instead of a list of buttons.

signal used(station_id: String)

@export_enum("armoury", "roster", "mission") var station_id: String = "armoury"
@export var title: String = "Armoury"
@export var subtitle: String = "Fit modules"
@export var tint: Color = Color(0.35, 0.80, 1.00)

var occupied: bool = false

@onready var _pillar: MeshInstance3D = $Pillar
@onready var _pad: MeshInstance3D = $Pad

func _ready() -> void:
	add_to_group("hub_stations")
	var shape := CollisionShape3D.new()
	var cylinder := CylinderShape3D.new()
	cylinder.radius = 2.6
	cylinder.height = 3.0
	shape.shape = cylinder
	add_child(shape)

	_style(_pillar, tint, 1.6)
	_style(_pad, tint, 0.8)

	body_entered.connect(_on_body_entered)
	body_exited.connect(_on_body_exited)

func _process(_delta: float) -> void:
	# A slow bob, so a station reads as live equipment rather than scenery.
	var t := float(Time.get_ticks_msec()) / 1000.0
	_pillar.position.y = 1.25 + sin(t * 1.6) * 0.06
	_pillar.rotate_y(0.004)

func _on_body_entered(body: Node3D) -> void:
	if not _is_local_player(body):
		return
	occupied = true

func _on_body_exited(body: Node3D) -> void:
	if _is_local_player(body):
		occupied = false

## Only the person at the keyboard gets a prompt. Bots walking past the
## armoury should not open it.
func _is_local_player(body: Node) -> bool:
	return body is PlayerCharacter and (body as PlayerCharacter).is_local

func use() -> void:
	used.emit(station_id)

func _style(mesh: MeshInstance3D, colour: Color, energy: float) -> void:
	var material := StandardMaterial3D.new()
	material.albedo_color = colour
	material.emission_enabled = true
	material.emission = colour
	material.emission_energy_multiplier = energy
	material.metallic = 0.5
	material.roughness = 0.3
	mesh.material_override = material
