extends Area3D
class_name HazardZone
## A patch of floor that hurts, and the shape of every telegraph.
##
## Corrosive Vent is one of these. It arrives after a delay so it can be
## read and left, and its real cost is a debuff rather than a health bar --
## "debuff-first failure penalties" from section 3, so standing in the fire
## costs *you* damage output instead of costing the healer their mana.

@export var ability_id: String = "corrosive_vent"

var _source: Node = null
var _radius: float = 4.5
var _delay: float = 1.5
var _duration: float = 8.0
var _tick_damage: float = 35.0
var _impact_damage: float = 150.0
var _status_id: String = ""
var _elapsed: float = 0.0
var _armed: bool = false
var _tick_accumulator: float = 0.0
var _inside: Dictionary = {}

@onready var _shape: CollisionShape3D = $CollisionShape3D
@onready var _decal: MeshInstance3D = $Decal

func configure(id: String, source: Node) -> void:
	ability_id = id
	_source = source

func _ready() -> void:
	add_to_group("hazards")
	var def: Dictionary = Content.ability(ability_id)
	_radius = float(def.get("radius", 4.5))
	_delay = float(def.get("delay", 1.5))
	_duration = float(def.get("hazard_duration", 8.0))
	_tick_damage = float(def.get("hazard_tick_damage", 35.0))
	_impact_damage = float(def.get("damage", 150.0))
	_status_id = def.get("hazard_status", "")

	var cylinder := CylinderShape3D.new()
	cylinder.radius = _radius
	cylinder.height = 3.0
	_shape.shape = cylinder

	var mesh := CylinderMesh.new()
	mesh.top_radius = _radius
	mesh.bottom_radius = _radius
	mesh.height = 0.05
	_decal.mesh = mesh
	var mat := StandardMaterial3D.new()
	mat.albedo_color = Color(0.45, 0.95, 0.25, 0.30)
	mat.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
	mat.emission_enabled = true
	mat.emission = Color(0.4, 1.0, 0.2)
	mat.emission_energy_multiplier = 1.2
	_decal.material_override = mat

	body_entered.connect(func(body: Node3D) -> void: _inside[body] = true)
	body_exited.connect(func(body: Node3D) -> void: _inside.erase(body))

func _process(delta: float) -> void:
	_elapsed += delta
	_draw_state()
	if not Net.is_server():
		return
	if not _armed:
		if _elapsed >= _delay:
			_armed = true
			_elapsed = 0.0
			_detonate()
		return
	_tick_accumulator += delta
	if _tick_accumulator >= 1.0:
		_tick_accumulator -= 1.0
		_tick()
	if _elapsed >= _duration:
		queue_free()

## The moment it lands. Anyone still standing in it takes the hit and the
## debuff; anyone who dashed out takes nothing, which is the whole lesson.
func _detonate() -> void:
	for body in _inside.keys():
		if not _is_target(body):
			continue
		Combat.apply_damage(_source, body, _impact_damage, {"from_position": global_position})
		_apply_status(body)

func _tick() -> void:
	for body in _inside.keys():
		if not _is_target(body):
			continue
		Combat.apply_damage(_source, body, _tick_damage, {"from_position": global_position})
		_apply_status(body)

func _apply_status(body: Node) -> void:
	if _status_id == "":
		return
	var status = body.get("status_component")
	if status is StatusEffectComponent:
		status.apply(_status_id, 0)

func _is_target(body: Node) -> bool:
	return is_instance_valid(body) and body.get("team") == "party" and body.get("is_dead") != true

## Telegraph then live: it pulses fast while it is arming so it reads as a
## countdown, and settles once it is actually dangerous.
func _draw_state() -> void:
	var mat := _decal.material_override as StandardMaterial3D
	if mat == null:
		return
	if not _armed:
		var progress := clampf(_elapsed / maxf(0.01, _delay), 0.0, 1.0)
		# Warns in red and lands in its own colour, so "about to happen"
		# and "happening" never look the same.
		mat.albedo_color = Color(1.0, 0.25, 0.2).lerp(Color(0.45, 0.95, 0.25), progress)
		mat.emission = mat.albedo_color
		mat.albedo_color.a = 0.18 + 0.38 * progress
		var scale_factor := 0.35 + 0.65 * progress
		_decal.scale = Vector3(scale_factor, 1.0, scale_factor)
	else:
		_decal.scale = Vector3.ONE
		mat.albedo_color.a = 0.30 + 0.08 * sin(_elapsed * 8.0)
