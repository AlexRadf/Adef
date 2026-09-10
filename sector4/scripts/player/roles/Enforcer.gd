extends RoleKit
class_name EnforcerKit
## The Enforcer: aggro anchor and frontline space controller.
##
## The tank's job in Sector-4 is geometry, not survival. Dart Pull takes one
## mob out of a pack; the shield only works in the direction it is pointed;
## and on the boss the whole job is turning Plasma Sweep away from the
## people standing behind you.

func on_pressed(ability_id: String) -> void:
	if ability_id == "rocket_dash":
		var def: Dictionary = Content.ability("rocket_dash")
		if player.ability_component != null and player.ability_component.can_use("rocket_dash"):
			player.apply_dash(player.move_intent(), float(def.get("impulse", 17.0)))
	fire(ability_id)

func execute(ability_id: String, payload: Dictionary) -> bool:
	match ability_id:
		"riot_carbine":
			return _carbine(payload)
		"directional_shield":
			return _shield()
		"dart_pull":
			return _dart_pull(payload)
		"rocket_dash":
			return _dash(payload)
		"bulwark_slam":
			return _slam()
		"focus_marker":
			return _mark(payload)
	return false

func _carbine(payload: Dictionary) -> bool:
	var def: Dictionary = Content.ability("riot_carbine")
	var target := pick_enemy(payload, float(def.get("range", 25.0)))
	if target == null:
		return false
	return Combat.apply_damage(player, target, float(def.get("damage", 34.0)), {
		"school": def.get("school", Content.School.KINETIC),
		"threat_mult": def.get("threat_mult", 4.0),
		"from_position": player.global_position,
	}) > 0.0

func _shield() -> bool:
	var def: Dictionary = Content.ability("directional_shield")
	player.guard_arc_degrees = float(def.get("arc_degrees", 140.0))
	player.status_component.apply(def.get("grants", "guarded"), player.peer_id)
	return true

## A single-target pull. It alerts the target's own pack and nothing else,
## which is the entire tactical layer in section 3: what you pull is what
## you fight.
func _dart_pull(payload: Dictionary) -> bool:
	var def: Dictionary = Content.ability("dart_pull")
	var target := pick_enemy(payload, float(def.get("range", 45.0)))
	if target == null:
		return false
	var threat = target.get("threat_component")
	if threat is ThreatComponent:
		threat.taunt(player, 6.0)
	if target.has_method("on_pulled_by"):
		target.on_pulled_by(player)
	Combat.apply_damage(player, target, float(def.get("damage", 20.0)), {
		"school": def.get("school", Content.School.KINETIC),
		"threat_mult": def.get("threat_mult", 12.0),
		"from_position": player.global_position,
	})
	return true

func _dash(payload: Dictionary) -> bool:
	var def: Dictionary = Content.ability("rocket_dash")
	player.status_component.apply(def.get("grants", "dash_iframes"), player.peer_id)
	if not player.is_local:
		player.apply_dash(payload.get("move", Vector3.ZERO), float(def.get("impulse", 17.0)))
	return true

## The recovery button: everything nearby, taunted at once. This is what
## picks the adds back up when a Security Override wave lands on the healer.
func _slam() -> bool:
	var def: Dictionary = Content.ability("bulwark_slam")
	var radius: float = float(def.get("radius", 8.0))
	var hit_any := false
	for enemy in player.get_tree().get_nodes_in_group("enemies"):
		if not alive(enemy) or not (enemy is Node3D):
			continue
		if player.global_position.distance_to((enemy as Node3D).global_position) > radius:
			continue
		var threat = enemy.get("threat_component")
		if threat is ThreatComponent:
			threat.taunt(player, 8.0)
		Combat.apply_damage(player, enemy, float(def.get("damage", 60.0)), {
			"school": def.get("school", Content.School.KINETIC),
			"threat_mult": def.get("threat_mult", 8.0),
			"from_position": player.global_position,
		})
		hit_any = true
	return hit_any

func _mark(payload: Dictionary) -> bool:
	var target := pick_enemy(payload, float(Content.ability("focus_marker").get("range", 60.0)))
	if target == null:
		return false
	FocusMarker.set_mark(player.get_tree(), target)
	return true
