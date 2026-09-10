extends Node3D
class_name SeekerDrone
## A deployed turret that fires at whatever the party is focused on.
##
## It reads the Focus Marker first, so the D-pad press that calls a target
## also redirects every drone in the room.

var _owner: Node = null
var _elapsed: float = 0.0
var _duration: float = 12.0
var _dps: float = 45.0
var _accumulator: float = 0.0

func configure(deployer: Node) -> void:
	_owner = deployer
	var def: Dictionary = Content.ability("seeker_drone")
	_duration = float(def.get("duration", 12.0))
	_dps = float(def.get("dps", 45.0))

func _process(delta: float) -> void:
	_elapsed += delta
	rotate_y(delta * 2.0)
	if not Net.is_server():
		return
	if _elapsed >= _duration or not is_instance_valid(_owner):
		queue_free()
		return
	# Damage is accumulated and paid out once a second rather than every
	# frame, so the combat log stays readable and the numbers stay whole.
	_accumulator += delta
	if _accumulator < 1.0:
		return
	_accumulator -= 1.0
	var target := _pick_target()
	if target != null:
		Combat.apply_damage(_owner, target, _dps, {"school": Content.School.ELECTRICAL})

func _pick_target() -> Node:
	var marked := FocusMarker.current(get_tree())
	if marked != null and marked.get("is_dead") != true:
		return marked
	var best: Node = null
	var nearest := 45.0
	for enemy in get_tree().get_nodes_in_group("enemies"):
		if enemy.get("is_dead") == true or not (enemy is Node3D):
			continue
		var d: float = global_position.distance_to((enemy as Node3D).global_position)
		if d < nearest:
			nearest = d
			best = enemy
	return best
