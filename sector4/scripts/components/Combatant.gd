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

var peer_id: int = 0
var is_dead: bool = false
var threat_aura: float = 1.0
var guard_arc_degrees: float = 140.0

@onready var health_component: HealthComponent = $HealthComponent
@onready var status_component: StatusEffectComponent = $StatusEffectComponent
@onready var ability_component: AbilityComponent = get_node_or_null("AbilityComponent")
@onready var threat_component: ThreatComponent = get_node_or_null("ThreatComponent")

func _ready() -> void:
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

func _on_revived() -> void:
	is_dead = false
	set_physics_process(true)
