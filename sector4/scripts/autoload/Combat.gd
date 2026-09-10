extends Node
## The single choke point for every point of damage and healing.
##
## Nothing anywhere else may touch a HealthComponent directly. Everything
## arrives here, walks the source's modifiers and then the target's, feeds
## the threat tables and emits the events the HUD draws from. Shields,
## armour corrosion, the enrage and the ultimates are all just modifiers,
## so a new mechanic never means new arithmetic in twelve places.
##
## Server authority: these functions no-op on a client. Clients see the
## result through HealthComponent replication, never by predicting it.

func _is_authority() -> bool:
	return not multiplayer.has_multiplayer_peer() or multiplayer.is_server()

## Returns the damage actually dealt.
##
## opts: school, threat_mult, ability_id, crit_chance, crit_mult,
##       ignore_armor, is_crit (force), suppress_threat
func apply_damage(source: Node, target: Node, amount: float, opts: Dictionary = {}) -> float:
	if not _is_authority():
		return 0.0
	if not _is_alive(target) or amount <= 0.0:
		return 0.0

	var out := amount
	var is_crit: bool = opts.get("is_crit", false)

	# 1. the source's own output modifiers (Overclock Surge, Blur Step)
	var source_status := _status_of(source)
	if source_status != null:
		out *= source_status.get_stat("damage_dealt")

	# 2. critical strike
	if not is_crit:
		var crit_chance: float = opts.get("crit_chance", 0.0)
		if crit_chance > 0.0 and randf() < crit_chance:
			is_crit = true
	if is_crit:
		out *= float(opts.get("crit_mult", 2.0))

	# 3. the target's incoming modifiers (dash i-frames, shields)
	var target_status := _status_of(target)
	if target_status != null:
		out *= target_status.get_stat("damage_taken")

	# 4. the Enforcer's directional shield. It only counts if the blow
	#    arrives inside the arc, which is why the tank has to be pointed at
	#    what is hitting them rather than merely holding the button.
	out *= _guard_multiplier(target, opts)

	# 5. armour. `armor` on a role is the share of damage that gets
	#    through at full plating; System Corroded eats into the mitigation
	#    rather than into that number directly, so "-30% armour" costs the
	#    Enforcer 30% of what the plating was actually saving.
	if not opts.get("ignore_armor", false):
		out *= _armor_multiplier(target)

	if out <= 0.0:
		return 0.0

	var health: HealthComponent = _health_of(target)
	if health == null:
		return 0.0
	var dealt := health.reduce(out)

	# 6. threat, and the lifesteal that Overclock Surge grants
	if dealt > 0.0:
		if not opts.get("suppress_threat", false):
			_feed_threat(source, target, dealt * float(opts.get("threat_mult", 1.0)))
		_apply_lifesteal(source, dealt)
		_broadcast_damage.rpc(_path_of(source), _path_of(target), dealt, is_crit)
		_report_damage(source, target, dealt, is_crit)
	return dealt

## Returns the healing actually landed. Overheal is not counted.
func apply_heal(source: Node, target: Node, amount: float, opts: Dictionary = {}) -> float:
	if not _is_authority():
		return 0.0
	if not _is_alive(target) or amount <= 0.0:
		return 0.0

	var out := amount
	var source_status := _status_of(source)
	if source_status != null:
		out *= source_status.get_stat("healing_done")
	var target_status := _status_of(target)
	if target_status != null:
		out *= target_status.get_stat("healing_taken")

	var health: HealthComponent = _health_of(target)
	if health == null:
		return 0.0
	var healed := health.restore(out)

	if healed > 0.0:
		if not opts.get("suppress_threat", false):
			_feed_heal_threat(source, healed)
		_broadcast_heal.rpc(_path_of(source), _path_of(target), healed)
		_report_heal(source, target, healed)
	return healed

## Percentage-of-max damage, for System Shockwave. Routed through
## apply_damage so it still respects shields and the dash.
func apply_max_hp_damage(source: Node, target: Node, pct: float, opts: Dictionary = {}) -> float:
	var health: HealthComponent = _health_of(target)
	if health == null:
		return 0.0
	var merged := opts.duplicate()
	merged["ignore_armor"] = true
	return apply_damage(source, target, health.max_health * pct, merged)

# --------------------------------------------------------------- helpers

## 1.0 unless the target is guarding and the hit came from inside the arc.
## `from_position` is optional -- an attack that does not say where it came
## from (a room-wide pulse) is never blocked, which is correct: you cannot
## raise a shield against the whole room.
func _guard_multiplier(target: Node, opts: Dictionary) -> float:
	var status := _status_of(target)
	if status == null or not status.has("guarded"):
		return 1.0
	if not opts.has("from_position"):
		return 1.0
	if not (target is Node3D):
		return 1.0
	var arc: float = 140.0
	var value = target.get("guard_arc_degrees")
	if typeof(value) == TYPE_FLOAT or typeof(value) == TYPE_INT:
		arc = float(value)
	var body := target as Node3D
	var from: Vector3 = opts["from_position"]
	var to_attacker := from - body.global_position
	to_attacker.y = 0.0
	if to_attacker.is_zero_approx():
		return 1.0
	var facing := -body.global_transform.basis.z
	facing.y = 0.0
	if facing.is_zero_approx():
		return 1.0
	var angle := rad_to_deg(facing.normalized().angle_to(to_attacker.normalized()))
	if angle > arc * 0.5:
		return 1.0
	return float(Content.status("guarded").get("guard_mult", 0.45))

func _armor_multiplier(target: Node) -> float:
	var base: float = 1.0
	var value = target.get("armor")
	if typeof(value) == TYPE_FLOAT or typeof(value) == TYPE_INT:
		base = float(value)
	base = clampf(base, 0.0, 1.0)
	var scale := 1.0
	var status := _status_of(target)
	if status != null:
		scale = status.get_stat("armor")
	var mitigation := (1.0 - base) * scale
	return clampf(1.0 - mitigation, 0.0, 4.0)

func _apply_lifesteal(source: Node, dealt: float) -> void:
	var status := _status_of(source)
	if status == null:
		return
	var share := status.get_stat_additive("lifesteal")
	if share <= 0.0:
		return
	var health: HealthComponent = _health_of(source)
	if health == null or health.is_dead:
		return
	var healed := health.restore(dealt * share)
	if healed > 0.0:
		_broadcast_heal.rpc(_path_of(source), _path_of(source), healed)
		_report_heal(source, source, healed)

func _feed_threat(source: Node, target: Node, amount: float) -> void:
	if source == null or amount <= 0.0:
		return
	var threat := _threat_of(target)
	if threat != null:
		threat.add_threat(source, amount * _threat_aura(source))

## Healing has to generate threat on everything currently fighting, or the
## Field Medic could out-heal the tank's aggro and never be hit for it.
func _feed_heal_threat(source: Node, healed: float) -> void:
	if source == null or healed <= 0.0:
		return
	for enemy in get_tree().get_nodes_in_group("enemies"):
		var threat := _threat_of(enemy)
		if threat == null:
			continue
		if threat.participants().is_empty():
			continue
		threat.add_threat(source, healed * threat.heal_threat_share * _threat_aura(source))

func _threat_aura(source: Node) -> float:
	var value = source.get("threat_aura") if source != null else null
	if typeof(value) == TYPE_FLOAT or typeof(value) == TYPE_INT:
		return float(value)
	return 1.0

func _health_of(unit: Node) -> HealthComponent:
	if unit == null or not is_instance_valid(unit):
		return null
	var node = unit.get("health_component")
	return node if node is HealthComponent else null

func _status_of(unit: Node) -> StatusEffectComponent:
	if unit == null or not is_instance_valid(unit):
		return null
	var node = unit.get("status_component")
	return node if node is StatusEffectComponent else null

func _threat_of(unit: Node) -> ThreatComponent:
	if unit == null or not is_instance_valid(unit):
		return null
	var node = unit.get("threat_component")
	return node if node is ThreatComponent else null

func _is_alive(unit: Node) -> bool:
	if unit == null or not is_instance_valid(unit):
		return false
	var health := _health_of(unit)
	return health != null and not health.is_dead

func _path_of(unit: Node) -> NodePath:
	if unit == null or not is_instance_valid(unit):
		return NodePath()
	return unit.get_path()

# ------------------------------------------------------- client feedback

func _report_damage(source: Node, target: Node, amount: float, is_crit: bool) -> void:
	var peer := _peer_of(source)
	GameEvents.damage_dealt.emit(peer, target, amount, is_crit)

func _report_heal(source: Node, target: Node, amount: float) -> void:
	GameEvents.healing_done.emit(_peer_of(source), target, amount)

func _peer_of(unit: Node) -> int:
	if unit == null or not is_instance_valid(unit):
		return 0
	var value = unit.get("peer_id")
	return int(value) if typeof(value) == TYPE_INT else 0

## Floating combat numbers come out of the server as events, so a client
## cannot invent a hit that did not happen.
@rpc("authority", "call_remote", "unreliable")
func _broadcast_damage(source_path: NodePath, target_path: NodePath, amount: float, is_crit: bool) -> void:
	var target := get_node_or_null(target_path)
	if target == null:
		return
	var source := get_node_or_null(source_path)
	_report_damage(source, target, amount, is_crit)

@rpc("authority", "call_remote", "unreliable")
func _broadcast_heal(source_path: NodePath, target_path: NodePath, amount: float) -> void:
	var target := get_node_or_null(target_path)
	if target == null:
		return
	var source := get_node_or_null(source_path)
	_report_heal(source, target, amount)
