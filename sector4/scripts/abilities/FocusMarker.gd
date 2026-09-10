extends RefCounted
class_name FocusMarker
## The Focus Marker from the controller table: one red icon, one priority.
##
## Exactly one mob carries the mark at a time. The AI DPS read it as focus
## fire and the AI Tank reads it as the next pull, so a single D-pad press
## is the whole of the party's target calling.

const STATUS := "focus_marked"

static func set_mark(tree: SceneTree, target: Node) -> void:
	clear(tree)
	if target == null or not is_instance_valid(target):
		return
	var status = target.get("status_component")
	if status is StatusEffectComponent:
		status.apply(STATUS, 0)
	GameEvents.target_marked.emit(target)

static func clear(tree: SceneTree) -> void:
	for enemy in tree.get_nodes_in_group("enemies"):
		var status = enemy.get("status_component")
		if status is StatusEffectComponent and status.has(STATUS):
			status.remove(STATUS)

static func current(tree: SceneTree) -> Node:
	for enemy in tree.get_nodes_in_group("enemies"):
		var status = enemy.get("status_component")
		if status is StatusEffectComponent and status.has(STATUS):
			return enemy
	return null
