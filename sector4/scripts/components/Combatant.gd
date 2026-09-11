extends CharacterBody3D
class_name Combatant
## Anything that can be hit: the four operatives, the trash, the boss.
##
## It owns the components and nothing else. Behaviour belongs to the
## subclasses -- this exists so Combat.gd can ask any node in the game for
## its health, its statuses and its team without knowing what it is.

@export var team: String = "party"
@export var display_name: String = "Unit"
@export var armor: float = 1.0
@export var move_speed: float = 6.0
## How long a corpse stays before it is cleared away. 0 leaves it forever,
## which is what a downed player wants -- they can still be revived.
@export var corpse_seconds: float = 3.2

var peer_id: int = 0
var is_dead: bool = false
var threat_aura: float = 1.0
var guard_arc_degrees: float = 140.0

@onready var health_component: HealthComponent = $HealthComponent
@onready var status_component: StatusEffectComponent = $StatusEffectComponent
@onready var ability_component: AbilityComponent = get_node_or_null("AbilityComponent")
@onready var threat_component: ThreatComponent = get_node_or_null("ThreatComponent")

var _original_layer: int = 0

func _ready() -> void:
	_original_layer = collision_layer
	add_to_group("combatants")
	add_to_group("party" if team == "party" else "enemies")
	health_component.died.connect(_on_died)
	health_component.revived.connect(_on_revived)

## The yaw that points this body's forward at `to`.
##
## Godot's forward is -Z, so a body rotated by `y` faces
## (-sin y, 0, -cos y). Facing a target therefore needs atan2(-dx, -dz):
## the intuitive atan2(dx, dz) points the body exactly backwards, which is
## silent until something depends on facing -- a melee arc, a frontal cone,
## a directional shield -- and then it is total.
static func yaw_toward(from: Vector3, to: Vector3) -> float:
	var offset := to - from
	return atan2(-offset.x, -offset.z)

func is_hostile_to(other: Node) -> bool:
	if other == null or not is_instance_valid(other):
		return false
	return other.get("team") != team

func health_percent() -> float:
	return health_component.get_health_percent()

## Where a heal beam or a nameplate should point: chest height, not the
## floor pivot the CharacterBody3D actually sits on.
func aim_point() -> Vector3:
	return global_position + Vector3(0.0, 1.1, 0.0)

func _on_died() -> void:
	is_dead = true
	velocity = Vector3.ZERO
	set_physics_process(false)
	# Stop being a target for anything still holding a threat entry.
	for enemy in get_tree().get_nodes_in_group("enemies"):
		var threat = enemy.get("threat_component")
		if threat is ThreatComponent:
			threat.forget(self)
	GameEvents.unit_died.emit(self)
	play_downed()

## Going down should be visible. A body that simply stops upright reads as
## a freeze -- the player cannot tell a kill from a hitch -- so it topples,
## settles, and for enemies fades out and clears itself away.
func play_downed() -> void:
	# A corpse must not block the room. Deferred because this can arrive
	# mid-physics, when shapes cannot be touched directly.
	set_deferred("collision_layer", 0)
	var shape := get_node_or_null("CollisionShape3D")
	if shape is CollisionShape3D:
		shape.set_deferred("disabled", true)

	var tip := create_tween().set_parallel(true)
	tip.tween_property(self, "rotation:x", deg_to_rad(-84.0), 0.55) 		.set_ease(Tween.EASE_IN).set_trans(Tween.TRANS_QUAD)
	# A little sink, so it settles into the floor rather than hovering at
	# standing height on its side.
	tip.tween_property(self, "position:y", position.y - 0.3, 0.7)

	if team == "party" or corpse_seconds <= 0.0:
		return
	_fade_and_clear()

func _fade_and_clear() -> void:
	var meshes := _own_meshes()
	var fade := create_tween().set_parallel(true)
	for mesh in meshes:
		var material := _fadeable_material(mesh)
		if material == null:
			continue
		fade.tween_property(material, "albedo_color:a", 0.0, 0.9) 			.set_delay(maxf(0.0, corpse_seconds - 0.9))
	await get_tree().create_timer(corpse_seconds + 0.1).timeout
	if is_instance_valid(self):
		queue_free()

func _own_meshes() -> Array[GeometryInstance3D]:
	var out: Array[GeometryInstance3D] = []
	for child in get_children():
		if child is GeometryInstance3D:
			out.append(child as GeometryInstance3D)
	return out

## Fading needs a material this body owns outright -- writing alpha into a
## shared one would dissolve every other mob using it.
func _fadeable_material(mesh: GeometryInstance3D) -> StandardMaterial3D:
	var material := mesh.material_override as StandardMaterial3D
	if material == null:
		material = StandardMaterial3D.new()
		material.albedo_color = Color(0.7, 0.7, 0.72)
		mesh.material_override = material
	else:
		material = material.duplicate() as StandardMaterial3D
		mesh.material_override = material
	material.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
	return material

func _on_revived() -> void:
	is_dead = false
	set_physics_process(true)
	set_deferred("collision_layer", _original_layer)
	var shape := get_node_or_null("CollisionShape3D")
	if shape is CollisionShape3D:
		shape.set_deferred("disabled", false)
	var stand := create_tween().set_parallel(true)
	stand.tween_property(self, "rotation:x", 0.0, 0.4)
	stand.tween_property(self, "position:y", position.y + 0.3, 0.4)
