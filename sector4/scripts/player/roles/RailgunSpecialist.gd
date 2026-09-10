extends RoleKit
class_name RailgunSpecialistKit
## The Railgun Specialist: long-range focus fire and hazard management.
##
## The railgun charges, so the sniper's rhythm is "hold, breathe, release"
## rather than a trigger to mash -- and holding it while a Corrosive Vent
## opens under you is exactly the tension the role is for.

var _charging: bool = false
var _charge: float = 0.0

func _process(delta: float) -> void:
	if _charging:
		_charge += delta

func on_pressed(ability_id: String) -> void:
	match ability_id:
		"railgun":
			_charging = true
			_charge = 0.0
		"rocket_dash":
			var def: Dictionary = Content.ability("rocket_dash")
			if player.ability_component != null and player.ability_component.can_use("rocket_dash"):
				player.apply_dash(player.move_intent(), float(def.get("impulse", 17.0)))
			fire(ability_id)
		_:
			fire(ability_id)

func on_released(ability_id: String) -> void:
	if ability_id != "railgun":
		return
	_charging = false
	var def: Dictionary = Content.ability("railgun")
	# Released early: the shot still goes, scaled by how far the capacitor
	# actually got. A tap is a plink, not a miss.
	var ratio := clampf(_charge / maxf(0.01, float(def.get("charge_time", 0.75))), 0.15, 1.0)
	_charge = 0.0
	fire(ability_id, {"charge": ratio})

func execute(ability_id: String, payload: Dictionary) -> bool:
	match ability_id:
		"railgun":
			return _railgun(payload)
		"concussion_round":
			return _concussion(payload)
		"seeker_drone":
			return _drone()
		"rocket_dash":
			return _dash(payload)
		"orbital_lance":
			return _lance(payload)
		"focus_marker":
			return _mark(payload)
	return false

func _railgun(payload: Dictionary) -> bool:
	var def: Dictionary = Content.ability("railgun")
	var target := pick_enemy(payload, float(def.get("range", 90.0)))
	if target == null:
		return false
	var charge: float = clampf(float(payload.get("charge", 1.0)), 0.15, 1.0)
	return Combat.apply_damage(player, target, float(def.get("damage", 185.0)) * charge, {
		"school": def.get("school", Content.School.ELECTRICAL),
		"from_position": player.global_position,
	}) > 0.0

## Knockback and hazard management: this is how an add gets peeled off the
## healer and out of a Corrosive Vent the party still has to stand near.
func _concussion(payload: Dictionary) -> bool:
	var def: Dictionary = Content.ability("concussion_round")
	var target := pick_enemy(payload, float(def.get("range", 40.0)))
	if target == null:
		return false
	Combat.apply_damage(player, target, float(def.get("damage", 40.0)), {
		"school": def.get("school", Content.School.KINETIC),
		"from_position": player.global_position,
	})
	if target.has_method("apply_knockback"):
		var away: Vector3 = (target as Node3D).global_position - player.global_position
		away.y = 0.0
		target.apply_knockback(away.normalized() * float(def.get("knockback", 12.0)))
	return true

func _drone() -> bool:
	var drone: SeekerDrone = preload("res://scenes/abilities/SeekerDrone.tscn").instantiate()
	drone.configure(player)
	# Parent first -- see the note in FieldMedic._overclock_surge.
	_spawn_root().add_child(drone, true)
	drone.global_position = player.global_position + Vector3(0.0, 2.0, 0.0)
	return true

func _dash(payload: Dictionary) -> bool:
	var def: Dictionary = Content.ability("rocket_dash")
	player.status_component.apply(def.get("grants", "dash_iframes"), player.peer_id)
	if not player.is_local:
		player.apply_dash(payload.get("move", Vector3.ZERO), float(def.get("impulse", 17.0)))
	return true

## A line, not a point: everything along the aim ray takes it. Lining the
## boss up behind a wave of adds is the whole trick.
func _lance(payload: Dictionary) -> bool:
	var def: Dictionary = Content.ability("orbital_lance")
	var origin: Vector3 = payload.get("origin", player.aim_point())
	var direction: Vector3 = (payload.get("direction", -player.global_transform.basis.z) as Vector3).normalized()
	var length: float = float(def.get("range", 90.0))
	var hit_any := false
	for enemy in player.get_tree().get_nodes_in_group("enemies"):
		if not alive(enemy) or not (enemy is Node3D):
			continue
		var offset: Vector3 = (enemy as Node3D).global_position - origin
		var along := offset.dot(direction)
		if along < 0.0 or along > length:
			continue
		if (offset - direction * along).length() > 2.2:
			continue
		Combat.apply_damage(player, enemy, float(def.get("damage", 900.0)), {
			"school": def.get("school", Content.School.THERMAL),
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

func _spawn_root() -> Node:
	var root := player.get_tree().get_first_node_in_group("spawn_root")
	return root if root != null else player.get_tree().current_scene
