extends Area3D
class_name GroundField
## A deployed floor field that grants a status to whoever stands in it.
##
## Overclock Surge is one of these. So is anything else that wants to make
## the party argue about where to stand, which is the most reliable way to
## turn a buff into a decision.

@export var ability_id: String = "overclock_surge"
@export var owner_peer: int = 0

var _duration: float = 8.0
var _radius: float = 7.0
var _status_id: String = ""
var _elapsed: float = 0.0
var _inside: Dictionary = {}

@onready var _shape: CollisionShape3D = $CollisionShape3D
@onready var _decal: MeshInstance3D = $Decal

func configure(id: String, peer: int) -> void:
	ability_id = id
	owner_peer = peer

func _ready() -> void:
	var def: Dictionary = Content.ability(ability_id)
	_duration = float(def.get("duration", 8.0))
	_radius = float(def.get("radius", 7.0))
	_status_id = def.get("grants", "")

	var cylinder := CylinderShape3D.new()
	cylinder.radius = _radius
	cylinder.height = 4.0
	_shape.shape = cylinder

	var mesh := CylinderMesh.new()
	mesh.top_radius = _radius
	mesh.bottom_radius = _radius
	mesh.height = 0.06
	_decal.mesh = mesh
	var mat := StandardMaterial3D.new()
	mat.albedo_color = Color(0.25, 0.85, 1.0, 0.28)
	mat.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
	mat.emission_enabled = true
	mat.emission = Color(0.25, 0.85, 1.0)
	mat.emission_energy_multiplier = 1.4
	_decal.material_override = mat

	body_entered.connect(_on_body_entered)
	body_exited.connect(_on_body_exited)

func _process(delta: float) -> void:
	_elapsed += delta
	# The field pulses so it reads as live at a glance rather than as a
	# decal someone left on the floor.
	var pulse := 0.22 + 0.10 * sin(_elapsed * 6.0)
	var mat := _decal.material_override as StandardMaterial3D
	if mat != null:
		mat.albedo_color.a = pulse
	if not Net.is_server():
		return
	# Re-apply rather than apply-once: refreshing the duration is what
	# makes standing in it different from touching it.
	for body in _inside.keys():
		if not is_instance_valid(body) or body.get("is_dead") == true:
			continue
		var status = body.get("status_component")
		if status is StatusEffectComponent:
			status.apply(_status_id, owner_peer)
	if _elapsed >= _duration:
		queue_free()

func _on_body_entered(body: Node3D) -> void:
	if body.get("team") == "party":
		_inside[body] = true

func _on_body_exited(body: Node3D) -> void:
	_inside.erase(body)
