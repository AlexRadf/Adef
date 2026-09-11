extends RoleKit
class_name FieldMedicKit
## The Field Medic: medium-range triage with a filler that pays for itself.
##
## The whole kit is built so the healer never looks away from the fight.
## The beam soft-locks, Smart Nano-Pulse does not need a target at all, and
## the pistol refunds Nano-Energy on a crit -- so doing damage is how you
## afford to heal, and the healer is playing the same game as everyone else.

const CHANNEL_REFRESH := 0.15

var _channel_target: Node = null
var _channel_active: bool = false
var _refresh_timer: float = 0.0

func _process(delta: float) -> void:
	if _channel_active and Net.is_server():
		_tick_beam(delta)

# ------------------------------------------------------------------ input

func on_pressed(ability_id: String) -> void:
	match ability_id:
		"nano_injector":
			set_channel(ability_id, true)
			_refresh_timer = 0.0
		"rocket_dash":
			# Predicted locally: a dash that waits for the server is a dash
			# that has already failed to clear the hazard. The charge target
			# rides along so the server moves remote copies the same way.
			var target := _charge_target()
			_predict_dash()
			fire(ability_id, {"charge": _path_or_empty(target)})
		_:
			fire(ability_id)

func on_held(ability_id: String) -> void:
	if ability_id != "nano_injector":
		return
	# The beam follows the reticle, so the target has to be resent as the
	# soft lock moves. Cheap, ordered, and the server still validates it.
	_refresh_timer -= get_process_delta_time()
	if _refresh_timer <= 0.0:
		_refresh_timer = CHANNEL_REFRESH
		set_channel(ability_id, true)

func on_released(ability_id: String) -> void:
	if ability_id == "nano_injector":
		set_channel(ability_id, false)

func _predict_dash() -> void:
	if player.ability_component != null and not player.ability_component.can_use("rocket_dash"):
		return
	var plan := _dash_plan(_charge_target())
	player.apply_dash(plan["direction"], plan["impulse"], plan["decay"])

## Who the Medic is charging to: whoever the reticle had, else whoever is
## worst off. Both have to be reachable -- a charge that stops halfway is
## worse than not charging at all.
func _charge_target() -> Node3D:
	var def: Dictionary = Content.ability("rocket_dash")
	var reach: float = float(def.get("ally_charge_range", 22.0))
	var soft := player.ally_targeting.current_target
	if _reachable(soft, reach):
		return soft
	var lowest := player.ally_targeting.lowest_health_ally(reach)
	# Nobody hurt and nobody aimed at: this is a plain evasive boost.
	if _reachable(lowest, reach) and lowest.health_component.get_health_percent() < 0.995:
		return lowest
	return null

func _reachable(target: Node, reach: float) -> bool:
	return alive(target) and target is Node3D and in_range(target, reach)

## Impulse is solved from the distance -- displacement is i^2 / (2 * decay)
## -- so the charge lands on the ally rather than short of them or through
## them, and is clamped so it can never become a launch across the room.
func _dash_plan(target: Node3D) -> Dictionary:
	var def: Dictionary = Content.ability("rocket_dash")
	var decay: float = float(def.get("decay", 24.0))
	var impulse: float = float(def.get("impulse", 12.0))
	if target == null:
		return {"direction": player.move_intent(), "impulse": impulse, "decay": decay}
	var offset: Vector3 = target.global_position - player.global_position
	offset.y = 0.0
	var distance := offset.length()
	if distance < 0.5:
		return {"direction": player.move_intent(), "impulse": impulse, "decay": decay}
	# Stop just short, so the charge does not shove the person being saved.
	var travel := maxf(0.5, distance - 1.4)
	var solved := sqrt(2.0 * decay * travel)
	return {
		"direction": offset / distance,
		"impulse": clampf(solved, impulse * 0.6, float(def.get("max_charge_impulse", 21.0))),
		"decay": decay,
	}

# ---------------------------------------------------------------- server

func execute(ability_id: String, payload: Dictionary) -> bool:
	match ability_id:
		"disruptor_pistol":
			return _disruptor_pistol(payload)
		"system_purge":
			return _system_purge(payload)
		"rocket_dash":
			return _rocket_dash(payload)
		"smart_nano_pulse":
			return _smart_pulse()
		"overclock_surge":
			return _overclock_surge()
		"focus_marker":
			return _focus_marker(payload)
	return false

func channel(ability_id: String, active: bool, payload: Dictionary) -> void:
	if ability_id != "nano_injector":
		return
	if not active:
		_channel_active = false
		_channel_target = null
		return
	var target := resolve(payload, "ally")
	if target == null:
		target = player  # self-heal when the reticle has nobody
	var def: Dictionary = Content.ability("nano_injector")
	if not alive(target) or not in_range(target, float(def.get("range", 35.0))):
		_channel_active = false
		_channel_target = null
		return
	_channel_target = target
	_channel_active = true

## Steady restoration, paid for by the second. Running the bar dry drops
## the beam rather than letting it tick for free.
func _tick_beam(delta: float) -> void:
	var def: Dictionary = Content.ability("nano_injector")
	if not alive(_channel_target) or not in_range(_channel_target, float(def.get("range", 35.0))):
		_channel_active = false
		return
	var cost: float = float(def.get("cost_per_second", 9.0)) * delta
	if player.ability_component == null or not player.ability_component.spend(cost):
		_channel_active = false
		return
	Combat.apply_heal(player, _channel_target, float(def.get("heal_per_second", 58.0)) * delta)

# ------------------------------------------------------------- abilities

func _disruptor_pistol(payload: Dictionary) -> bool:
	var def: Dictionary = Content.ability("disruptor_pistol")
	var target := pick_enemy(payload, float(def.get("range", 30.0)))
	if target == null:
		return false
	var crit_chance: float = float(def.get("crit_chance", 0.0))
	var was_crit := randf() < crit_chance
	var dealt := Combat.apply_damage(player, target, float(def.get("damage", 13.0)), {
		"school": def.get("school", Content.School.NANO),
		"is_crit": was_crit,
		"crit_mult": def.get("crit_mult", 2.0),
	})
	# "Critical hits refund 10% Nano-Energy" -- the line that makes the
	# healer's filler part of the healing budget rather than a distraction.
	if was_crit and dealt > 0.0 and player.ability_component != null:
		var refund: float = player.ability_component.max_energy * float(def.get("crit_energy_refund_pct", 0.10))
		player.ability_component.refund(refund)
	return dealt > 0.0

func _system_purge(payload: Dictionary) -> bool:
	var def: Dictionary = Content.ability("system_purge")
	var types: Array = def.get("dispel_types", ["performance"])
	var target := resolve(payload, "ally")
	# The reticle target first, then whoever is actually corroded. The
	# Enforcer is usually the answer and is usually not who you are aiming
	# at, because they are facing the other way holding the boss.
	if not _can_purge(target, types, def):
		target = player.ally_targeting.nearest_dispellable(types, float(def.get("range", 35.0)))
	if not _can_purge(target, types, def):
		return false
	var status: StatusEffectComponent = target.get("status_component")
	var purged := status.dispel(types)
	if purged == "":
		return false
	AbilityFx.tracer(
		player.aim_point(), (target as Node3D).global_position + Vector3(0, 1.2, 0),
		Color(0.75, 0.95, 1.0, 0.9), 0.07
	)
	AbilityFx.impact((target as Node3D).global_position + Vector3(0, 1.2, 0),
		Color(0.75, 0.95, 1.0, 0.95), 1.1)
	Combat.apply_heal(player, target, float(def.get("heal_on_cleanse", 60.0)))
	return true

func _can_purge(target: Node, types: Array, def: Dictionary) -> bool:
	if not alive(target) or not in_range(target, float(def.get("range", 35.0))):
		return false
	var status = target.get("status_component")
	return status is StatusEffectComponent and status.has_dispellable(types)

func _rocket_dash(payload: Dictionary) -> bool:
	var def: Dictionary = Content.ability("rocket_dash")
	player.status_component.apply(def.get("grants", "dash_iframes"), player.peer_id)
	# Remote peers still need to see the movement; the owner already has it.
	if not player.is_local:
		var target := resolve(payload, "charge")
		var plan := _dash_plan(target as Node3D if target is Node3D else null)
		if target == null:
			plan["direction"] = payload.get("move", Vector3.ZERO)
		player.apply_dash(plan["direction"], plan["impulse"], plan["decay"])
	return true

func _smart_pulse() -> bool:
	var def: Dictionary = Content.ability("smart_nano_pulse")
	var target := player.ally_targeting.lowest_health_ally(float(def.get("range", 40.0)))
	if target == null:
		return false
	# Nobody is hurt: hold the cooldown rather than spending it on a full
	# health bar.
	if target.get("health_component").get_health_percent() >= 0.999:
		return false
	return Combat.apply_heal(player, target, float(def.get("heal", 280.0))) > 0.0

func _overclock_surge() -> bool:
	var field: GroundField = preload("res://scenes/abilities/GroundField.tscn").instantiate()
	field.configure("overclock_surge", player.peer_id)
	# Parent first: global_position on a node outside the tree silently
	# falls back to local coordinates, which would drop the field at the
	# world origin instead of under the Medic's feet.
	_spawn_root().add_child(field, true)
	field.global_position = player.global_position
	return true

func _focus_marker(payload: Dictionary) -> bool:
	var def: Dictionary = Content.ability("focus_marker")
	var target := pick_enemy(payload, float(def.get("range", 60.0)))
	if target == null:
		return false
	FocusMarker.set_mark(player.get_tree(), target)
	return true

func _spawn_root() -> Node:
	var root := player.get_tree().get_first_node_in_group("spawn_root")
	return root if root != null else player.get_tree().current_scene
