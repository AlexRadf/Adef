extends RoleKit
class_name KineticStrikerKit
## The Kinetic Striker: close-quarters flanker, and the party's interrupt.
##
## Section 6 hands this role one job that nobody else can cover -- Servo
## Kick into Core Overcharge. Everything else in the kit exists to keep the
## Striker close enough to be standing there when the bar comes up.

func on_pressed(ability_id: String) -> void:
	if ability_id == "rocket_dash":
		var def: Dictionary = Content.ability("rocket_dash")
		if player.ability_component != null and player.ability_component.can_use("rocket_dash"):
			player.apply_dash(player.move_intent(), float(def.get("impulse", 12.0)), float(def.get("decay", 24.0)))
	fire(ability_id)

func execute(ability_id: String, payload: Dictionary) -> bool:
	match ability_id:
		"mono_blade":
			return _blade(payload)
		"rupture":
			return _rupture(payload)
		"kick":
			return _kick(payload)
		"static_snare":
			return _snare(payload)
		"rocket_dash":
			return _dash(payload)
		"blur_step":
			return _blur()
		"focus_marker":
			return _mark(payload)
	return false

## A swing, not a shot: it hits inside an arc rather than along a ray, and
## it hits harder from behind. That 1.6x is why the Striker circles instead
## of standing where the tank is standing.
func _blade(payload: Dictionary) -> bool:
	var def: Dictionary = Content.ability("mono_blade")
	var reach: float = float(def.get("range", 3.2))
	var arc: float = float(def.get("arc_degrees", 110.0))
	var facing := -player.global_transform.basis.z
	facing.y = 0.0
	var hit_any := false
	for enemy in player.get_tree().get_nodes_in_group("enemies"):
		if not alive(enemy) or not (enemy is Node3D):
			continue
		var offset: Vector3 = (enemy as Node3D).global_position - player.global_position
		offset.y = 0.0
		if offset.length() > reach or offset.is_zero_approx() or facing.is_zero_approx():
			continue
		if rad_to_deg(facing.normalized().angle_to(offset.normalized())) > arc * 0.5:
			continue
		var damage: float = float(def.get("damage", 62.0))
		if _is_behind(enemy):
			damage *= float(def.get("backstab_mult", 1.6))
		Combat.apply_damage(player, enemy, damage, {
			"school": def.get("school", Content.School.KINETIC),
			"from_position": player.global_position,
		})
		hit_any = true
	if not hit_any:
		return false
	return true

func _is_behind(enemy: Node3D) -> bool:
	var enemy_facing := -enemy.global_transform.basis.z
	enemy_facing.y = 0.0
	var to_striker: Vector3 = player.global_position - enemy.global_position
	to_striker.y = 0.0
	if enemy_facing.is_zero_approx() or to_striker.is_zero_approx():
		return false
	return enemy_facing.normalized().dot(to_striker.normalized()) < -0.25

## The interrupt. It only spends itself on a cast that was actually
## stoppable, so a mistimed kick is a miss rather than a wasted cooldown.
func _kick(payload: Dictionary) -> bool:
	var def: Dictionary = Content.ability("kick")
	var reach: float = float(def.get("range", 3.5))
	var target := pick_enemy(payload, reach)
	if target == null:
		target = nearest_enemy(reach)
	if target == null:
		return false
	var cast = target.get("cast_component")
	if not (cast is CastComponent) or not cast.is_casting or not cast.interruptible:
		return false
	if not cast.interrupt():
		return false
	var status = target.get("status_component")
	if status is StatusEffectComponent:
		status.apply("interrupt_lockout", player.peer_id, float(def.get("lockout", 5.0)))
	Combat.apply_damage(player, target, float(def.get("damage", 25.0)), {
		"school": def.get("school", Content.School.KINETIC),
		"from_position": player.global_position,
	})
	return true

## Melee setup: open the armour, then hit the hole. It is the Striker's
## reason to commit to one target rather than swinging at whatever is
## nearest.
func _rupture(payload: Dictionary) -> bool:
	var def: Dictionary = Content.ability("rupture")
	var target := pick_enemy(payload, float(def.get("range", 3.5)))
	if target == null:
		target = nearest_enemy(float(def.get("range", 3.5)))
	if target == null:
		return false
	var status = target.get("status_component")
	if not (status is StatusEffectComponent):
		return false
	status.apply(def.get("applies", "ruptured"), player.peer_id)
	Combat.apply_damage(player, target, float(def.get("damage", 45.0)), {
		"school": def.get("school", Content.School.KINETIC),
		"from_position": player.global_position,
	})
	return true

func _snare(payload: Dictionary) -> bool:
	var def: Dictionary = Content.ability("static_snare")
	var target := pick_enemy(payload, float(def.get("range", 14.0)))
	if target == null:
		return false
	if target.has_method("apply_crowd_control"):
		target.apply_crowd_control(float(def.get("duration", 6.0)))
		return true
	return false

func _dash(payload: Dictionary) -> bool:
	var def: Dictionary = Content.ability("rocket_dash")
	player.status_component.apply(def.get("grants", "dash_iframes"), player.peer_id)
	if not player.is_local:
		player.apply_dash(payload.get("move", Vector3.ZERO), float(def.get("impulse", 12.0)), float(def.get("decay", 24.0)))
	return true

func _blur() -> bool:
	var def: Dictionary = Content.ability("blur_step")
	player.status_component.apply(def.get("grants", "overclocked"), player.peer_id, float(def.get("duration", 6.0)))
	return true

func _mark(payload: Dictionary) -> bool:
	var target := pick_enemy(payload, float(Content.ability("focus_marker").get("range", 60.0)))
	if target == null:
		return false
	FocusMarker.set_mark(player.get_tree(), target)
	return true
