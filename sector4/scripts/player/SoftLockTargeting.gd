extends Node
class_name SoftLockTargeting
## Section 4's target scorer: the crosshair picks for you.
##
## Every frame it scores the candidates in screen space and keeps the best
## one. The healer never navigates a menu or a D-pad to pick a target --
## point roughly at the person who is hurt and the reticle commits.
##
##   score = dot(cam_forward, to_target) * W_angle
##         + (1 - health_pct)           * W_health
##         - (dist / max_dist)          * W_dist
##         + sticky bonus, if this is already the target
##
## The sticky bonus is the whole reason this feels stable: without it the
## reticle flickers between two people standing on top of each other, and
## a heal beam that flickers is a heal beam that misses.
##
## Generalised from the design's HealerTargeting so the Enforcer's Dart
## Pull can use the same scorer against `enemies` -- one soft-lock, two
## jobs, rather than two implementations that drift apart.

signal target_changed(target: Node)

@export_group("Targeting Parameters")
@export var target_group: String = "party"
@export var include_self: bool = false
@export var max_distance: float = 35.0
@export var max_cone_angle: float = 30.0
@export var angle_weight: float = 0.50
@export var health_weight: float = 0.35
@export var distance_weight: float = 0.15
@export var sticky_bonus: float = 0.20
## When nobody is inside the cone, fall back to whoever most needs help.
## Standing nose-to-nose with the boss must not make the healer unable to
## heal -- the cone is an aiming aid, not a requirement.
@export var fallback_to_neediest: bool = false
@export var fallback_health_pct: float = 0.98
@export var marked_bonus: float = 0.30
@export var require_line_of_sight: bool = true
@export var line_of_sight_mask: int = 1

var current_target: Node3D = null

var _camera: Camera3D = null
var _owner_body: CollisionObject3D = null
var _exclude: Array[RID] = []

func _ready() -> void:
	var body := get_parent()
	if body is CollisionObject3D:
		_owner_body = body
		_exclude = [body.get_rid()]

func bind_camera(camera: Camera3D) -> void:
	_camera = camera

func _process(_delta: float) -> void:
	var best := evaluate()
	if best == null and fallback_to_neediest:
		var needy := lowest_health_ally(max_distance)
		if needy != null and _health_pct(needy) < fallback_health_pct:
			best = needy
	if best != current_target:
		current_target = best
		target_changed.emit(current_target)
		if target_group == "party":
			GameEvents.soft_target_changed.emit(current_target)

func evaluate() -> Node3D:
	if _camera == null:
		return null
	var best_node: Node3D = null
	var highest_score := -INF
	var cam_origin := _camera.global_position
	var cam_forward := -_camera.global_transform.basis.z.normalized()

	for candidate in get_tree().get_nodes_in_group(target_group):
		if not _is_eligible(candidate):
			continue
		var target := candidate as Node3D

		var offset: Vector3 = _aim_point(target) - cam_origin
		var dist := offset.length()
		if dist > max_distance or dist < 0.001:
			continue
		var dir_to_target := offset / dist

		var angle_deg := rad_to_deg(cam_forward.angle_to(dir_to_target))
		if angle_deg > max_cone_angle:
			continue

		if require_line_of_sight and not _has_line_of_sight(cam_origin, target):
			continue

		var dot_val := clampf(cam_forward.dot(dir_to_target), 0.0, 1.0)
		var health_pct := _health_pct(target)
		var norm_dist := clampf(dist / max_distance, 0.0, 1.0)

		var score := (dot_val * angle_weight) \
			+ ((1.0 - health_pct) * health_weight) \
			- (norm_dist * distance_weight)

		if target == current_target:
			score += sticky_bonus
		if _is_marked(target):
			score += marked_bonus

		if score > highest_score:
			highest_score = score
			best_node = target

	return best_node

## The lowest-health ally in the room, cone and all ignored. This is what
## Smart Nano-Pulse fires at -- it is deliberately *not* the soft target,
## because the whole point of the button is that you do not have to look.
func lowest_health_ally(range_limit: float = 40.0) -> Node3D:
	var best: Node3D = null
	var lowest := INF
	var origin := _origin()
	for candidate in get_tree().get_nodes_in_group("party"):
		if not _is_eligible(candidate, true):
			continue
		var target := candidate as Node3D
		if origin.distance_to(target.global_position) > range_limit:
			continue
		var pct := _health_pct(target)
		if pct < lowest:
			lowest = pct
			best = target
	return best

## Step to the next ally, ignoring the cone entirely. The explicit answer
## to "I am looking at the boss and need to heal the tank".
func cycle(forward: bool = true) -> Node3D:
	# Ordered by seat so the sequence is predictable between presses, but
	# anything without a seat still gets included rather than skipped.
	var candidates: Array[Node3D] = []
	for candidate in get_tree().get_nodes_in_group("party"):
		if _is_eligible(candidate, true):
			candidates.append(candidate as Node3D)
	candidates.sort_custom(func(a: Node3D, b: Node3D) -> bool:
		return _seat_index(a) < _seat_index(b))
	if candidates.is_empty():
		return null
	var index := candidates.find(current_target)
	index = (index + (1 if forward else -1)) % candidates.size()
	if index < 0:
		index += candidates.size()
	current_target = candidates[index]
	target_changed.emit(current_target)
	if target_group == "party":
		GameEvents.soft_target_changed.emit(current_target)
	return current_target

## The nearest ally carrying something System Purge can strip. Drives both
## the dispel prompt on the HUD and the AI medic.
func nearest_dispellable(types: Array, range_limit: float = 35.0) -> Node3D:
	var best: Node3D = null
	var nearest := INF
	var origin := _origin()
	for candidate in get_tree().get_nodes_in_group("party"):
		if not _is_eligible(candidate, true):
			continue
		var status = candidate.get("status_component")
		if not (status is StatusEffectComponent) or not status.has_dispellable(types):
			continue
		var dist: float = origin.distance_to((candidate as Node3D).global_position)
		if dist <= range_limit and dist < nearest:
			nearest = dist
			best = candidate as Node3D
	return best

# --------------------------------------------------------------- helpers

## Position in the lobby's seat order; anything unseated sorts last.
func _seat_index(unit: Node) -> int:
	var role_id = unit.get("role_id")
	if typeof(role_id) != TYPE_STRING:
		return 99
	var index := Content.ROLE_ORDER.find(role_id)
	return index if index >= 0 else 99

func _is_eligible(candidate: Node, ignore_cone: bool = false) -> bool:
	if not (candidate is Node3D) or not is_instance_valid(candidate):
		return false
	if candidate == _owner_body and not include_self:
		return false
	if candidate.get("is_dead") == true:
		return false
	if not ignore_cone and _camera == null:
		return false
	return true

func _aim_point(target: Node3D) -> Vector3:
	if target.has_method("aim_point"):
		return target.aim_point()
	return target.global_position + Vector3(0.0, 1.1, 0.0)

func _health_pct(target: Node) -> float:
	var health = target.get("health_component")
	if health is HealthComponent:
		return health.get_health_percent()
	return 1.0

func _is_marked(target: Node) -> bool:
	var status = target.get("status_component")
	return status is StatusEffectComponent and status.has("focus_marked")

func _origin() -> Vector3:
	if _owner_body != null:
		return _owner_body.global_position
	if _camera != null:
		return _camera.global_position
	return Vector3.ZERO

## A pillar between you and an ally should break the lock, or the healer
## could beam through the geometry the tank is using to pull.
##
## Note for anyone comparing this against the design document: the ray's
## exclude list takes RIDs, not nodes, and the ally's own body has to be
## reachable by the ray -- so the hit is compared against the ally rather
## than assumed to be a wall.
func _has_line_of_sight(from: Vector3, target: Node3D) -> bool:
	var space := _camera.get_world_3d().direct_space_state
	var query := PhysicsRayQueryParameters3D.create(from, _aim_point(target), line_of_sight_mask, _exclude)
	query.collide_with_areas = false
	query.collide_with_bodies = true
	var hit := space.intersect_ray(query)
	if hit.is_empty():
		return true
	return hit.get("collider") == target
