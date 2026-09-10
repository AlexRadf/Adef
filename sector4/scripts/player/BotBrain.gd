extends Node
class_name BotBrain
## Drives a seat nobody is sitting in.
##
## A bot is a priority list evaluated top to bottom -- the first rule that
## both matches and produces a usable action wins -- plus a steering
## behaviour that runs underneath it every frame. The list decides what to
## press; the steering decides where to stand. Keeping those separate is
## what stops "walk out of the fire" and "heal the tank" from fighting each
## other for the same slot.
##
## Bots never bypass validation: every press goes through the same
## `RoleKit.server_fire` a human's button reaches, so a bot cannot do
## anything a player could not.

const DECISION_INTERVAL := 0.25

var player: PlayerCharacter = null

var _priorities: Array = []
var _positioning: Dictionary = {}
var _next_decision_at: float = 0.0
var _reaction: float = 0.6
var _interrupt_reaction: float = 0.35
var _channeling: String = ""
## When each watched condition first became true, so a bot reacts *late*
## rather than instantly -- the delay is the personality.
var _noticed_at: Dictionary = {}

func bind(body: PlayerCharacter) -> void:
	player = body
	_priorities = Content.BOT_PRIORITIES.get(body.role_id, [])
	_positioning = Content.BOT_POSITIONING.get(body.role_id, {})
	# Seeded off the seat so a given party is consistent between pulls but
	# no two bots share a reaction time.
	var jitter := randf()
	_reaction = lerpf(Content.BOT_REACTION["min"], Content.BOT_REACTION["max"], jitter)
	_interrupt_reaction = lerpf(
		Content.BOT_INTERRUPT_REACTION["min"], Content.BOT_INTERRUPT_REACTION["max"], jitter
	)

func _physics_process(delta: float) -> void:
	if player == null or player.is_dead or not Net.is_server():
		return
	_steer(delta)
	if _now() < _next_decision_at:
		return
	_next_decision_at = _now() + DECISION_INTERVAL
	_decide()

# ------------------------------------------------------------- the list

func _decide() -> void:
	for rule in _priorities:
		if rule.has("else"):
			_perform(rule["do"])
			return
		if not _condition(rule["if"]):
			continue
		if _perform(rule["do"]):
			return
	_stop_channel()

## "use:x" fires once. "channel:x" holds the beam open and is the only
## action that persists between decisions, so it has to be closed when the
## list moves on to something else.
func _perform(action: String) -> bool:
	var parts := action.split(":")
	var verb := parts[0]
	var ability_id: String = parts[1] if parts.size() > 1 else ""
	match verb:
		"use":
			_stop_channel()
			return player.kit.server_fire(ability_id, player.kit.bot_payload(_action_target(ability_id)))
		"channel":
			return _start_channel(ability_id)
	return false

func _start_channel(ability_id: String) -> bool:
	var target := _action_target(ability_id)
	if target == null:
		return false
	player.kit.channel(ability_id, true, player.kit.bot_payload(target))
	_channeling = ability_id
	return true

func _stop_channel() -> void:
	if _channeling == "":
		return
	player.kit.channel(_channeling, false, {})
	_channeling = ""

## Who an ability should be pointed at. Healing goes to the person who
## needs it; everything else goes at what the party has called.
func _action_target(ability_id: String) -> Node:
	var def: Dictionary = Content.ability(ability_id)
	match ability_id:
		"nano_injector", "smart_nano_pulse":
			return _lowest_ally()
		"system_purge":
			return player.ally_targeting.nearest_dispellable(
				def.get("dispel_types", ["performance"]), float(def.get("range", 35.0))
			)
		"kick":
			return _interruptible_enemy(float(def.get("range", 3.5)))
		"static_snare":
			return _caster_add()
		"concussion_round":
			return _add_near_healer()
		"rocket_dash", "directional_shield", "overclock_surge", "blur_step":
			return player
	return _focus_target()

# --------------------------------------------------------- the condition

func _condition(expr: String) -> bool:
	var parts := expr.split(":")
	var name := parts[0]
	var arg: float = float(parts[1]) if parts.size() > 1 else 0.0
	match name:
		"lost_aggro":
			return _delayed("lost_aggro", _lost_aggro(), _reaction)
		"marked_target_loose":
			var marked := FocusMarker.current(player.get_tree())
			return marked != null and _threat_leader_of(marked) != player
		"adds_loose":
			return _delayed("adds_loose", _adds_on_squishies() >= 2, _reaction)
		"self_in_hazard":
			return _delayed("hazard", _standing_in_hazard(), _reaction)
		"boss_casting_frontal":
			return _delayed("frontal", _boss_casting("plasma_sweep"), _reaction)
		"enemy_casting_interruptible":
			# The tightest window in the fight gets the shortest fuse.
			return _delayed("interrupt", _interruptible_enemy(3.5) != null, _interrupt_reaction)
		"ally_dispellable":
			return _delayed("dispel", player.ally_targeting.nearest_dispellable(["performance"], 35.0) != null, _reaction)
		"ally_below_pct":
			var lowest := _lowest_ally()
			return lowest != null and _health_pct(lowest) * 100.0 < arg
		"self_below_pct":
			return player.health_percent() * 100.0 < arg
		"party_wounded":
			return _delayed("wounded_%d" % int(arg), _wounded_count(0.75) >= int(arg), _reaction)
		"caster_add_up":
			return _caster_add() != null
		"add_on_healer":
			return _add_near_healer() != null
		"drone_ready":
			return _enemy_count() >= 1
		"boss_enraged":
			var boss := player.get_tree().get_first_node_in_group("boss")
			return boss != null and boss.get("is_enraged") == true
	return false

## A condition has to have been true for `delay` seconds before the bot
## acts on it. Rising-edge tracked, so a flickering condition does not
## reset the clock every frame.
func _delayed(key: String, is_true: bool, delay: float) -> bool:
	if not is_true:
		_noticed_at.erase(key)
		return false
	if not _noticed_at.has(key):
		_noticed_at[key] = _now()
		return false
	return _now() - float(_noticed_at[key]) >= delay

# ------------------------------------------------------------- steering

func _steer(delta: float) -> void:
	var anchor := _primary_enemy()
	var desired := player.global_position
	var look_at := anchor

	# Standing in a hazard outranks every other reason to be somewhere.
	var hazard := _hazard_under_foot()
	if hazard != null:
		var away: Vector3 = player.global_position - hazard.global_position
		away.y = 0.0
		if away.is_zero_approx():
			away = Vector3.FORWARD
		desired = hazard.global_position + away.normalized() * (hazard._radius + 3.0)
	elif anchor != null:
		desired = _station(anchor)
	else:
		# Nothing to fight. Go to the objective -- otherwise the party
		# finishes the room and then stands in it, and the Security
		# Override never gets held.
		desired = _rally_point(player.global_position)
		look_at = null

	var offset := desired - player.global_position
	offset.y = 0.0
	player.ai_move_intent = offset.normalized() if offset.length() > 0.9 else Vector3.ZERO
	if look_at != null:
		player.ai_face_target = (look_at as Node3D).global_position
	_avoid_crowding(delta)

## Where this role wants to stand relative to what it is fighting.
func _station(anchor: Node3D) -> Vector3:
	var kind: String = _positioning.get("role", "backline")
	var want: float = float(_positioning.get("range", 16.0))
	var centre := anchor.global_position
	match kind:
		"anchor":
			# The tank's real job on this boss: stand so the 90 degree cone
			# points away from everybody else. It puts itself on the far
			# side of the boss from the party's centre of mass, which drags
			# the boss round to face away from them.
			var party := _party_centroid_excluding(player)
			var facing: Vector3 = centre - party
			facing.y = 0.0
			if facing.is_zero_approx():
				facing = Vector3.FORWARD
			return centre + facing.normalized() * want
		"flank":
			# Behind it, for the 1.6x. Derived from the target's own facing
			# so it keeps working as the tank turns the boss.
			var behind := anchor.global_transform.basis.z
			behind.y = 0.0
			if behind.is_zero_approx():
				behind = Vector3.BACK
			return centre + behind.normalized() * want
		_:
			# Ranged: hold the line the tank is not on, at range.
			var from_boss: Vector3 = player.global_position - centre
			from_boss.y = 0.0
			if from_boss.is_zero_approx():
				from_boss = Vector3.BACK
			return centre + from_boss.normalized() * want
	return centre

## Bots that pile onto the same spot make Plasma Sweep hit everybody, so
## they push each other apart gently.
func _avoid_crowding(_delta: float) -> void:
	var push := Vector3.ZERO
	for other in player.get_tree().get_nodes_in_group("party"):
		if other == player or other.get("is_dead") == true or not (other is Node3D):
			continue
		var offset: Vector3 = player.global_position - (other as Node3D).global_position
		offset.y = 0.0
		var distance := offset.length()
		if distance > 0.05 and distance < 2.4:
			push += offset.normalized() * (2.4 - distance)
	if not push.is_zero_approx():
		player.ai_move_intent = (player.ai_move_intent + push * 0.6).normalized()

## Where to be when there is nothing to shoot: the terminal while it is
## still locked, otherwise wherever the human is.
func _rally_point(fallback: Vector3) -> Vector3:
	var terminal := player.get_tree().get_first_node_in_group("terminals")
	if terminal is SecurityTerminal and not (terminal as SecurityTerminal).is_unlocked:
		# Spread around it rather than stacking on the pillar, so an
		# Override wave does not catch the whole party in one spot.
		var spread := player.global_position - (terminal as SecurityTerminal).global_position
		spread.y = 0.0
		if spread.is_zero_approx():
			spread = Vector3.BACK
		return (terminal as SecurityTerminal).global_position + spread.normalized() * 1.6
	for unit in player.get_tree().get_nodes_in_group("players"):
		if unit == player or unit.get("is_bot") == true or unit.get("is_dead") == true:
			continue
		if unit is Node3D:
			return (unit as Node3D).global_position
	return fallback

# -------------------------------------------------------------- queries

func _primary_enemy() -> Node3D:
	var marked := FocusMarker.current(player.get_tree())
	if marked != null and marked.get("is_dead") != true:
		return marked as Node3D
	var boss := player.get_tree().get_first_node_in_group("boss")
	if boss != null and boss.get("is_dead") != true:
		return boss as Node3D
	return _nearest_enemy(80.0)

func _focus_target() -> Node:
	return _primary_enemy()

func _nearest_enemy(limit: float) -> Node3D:
	var best: Node3D = null
	var nearest := limit
	for enemy in player.get_tree().get_nodes_in_group("enemies"):
		if enemy.get("is_dead") == true or not (enemy is Node3D):
			continue
		var d: float = player.global_position.distance_to((enemy as Node3D).global_position)
		if d < nearest:
			nearest = d
			best = enemy as Node3D
	return best

func _enemy_count() -> int:
	var count := 0
	for enemy in player.get_tree().get_nodes_in_group("enemies"):
		if enemy.get("is_dead") != true:
			count += 1
	return count

func _lowest_ally() -> Node3D:
	return player.ally_targeting.lowest_health_ally(45.0)

func _wounded_count(threshold: float) -> int:
	var count := 0
	for unit in player.get_tree().get_nodes_in_group("party"):
		if unit.get("is_dead") == true:
			continue
		if _health_pct(unit) < threshold:
			count += 1
	return count

func _health_pct(unit: Node) -> float:
	var health = unit.get("health_component")
	return health.get_health_percent() if health is HealthComponent else 1.0

func _lost_aggro() -> bool:
	var boss := _primary_enemy()
	if boss == null:
		return false
	var leader := _threat_leader_of(boss)
	return leader != null and leader != player

func _threat_leader_of(enemy: Node) -> Node:
	var threat = enemy.get("threat_component")
	return threat.get_leader() if threat is ThreatComponent else null

## Adds that have wandered onto somebody who cannot take a hit. This is
## what makes the tank's slam and the sniper's knockback fire at the right
## moment instead of on cooldown.
func _adds_on_squishies() -> int:
	var count := 0
	for enemy in player.get_tree().get_nodes_in_group("trash"):
		if enemy.get("is_dead") == true:
			continue
		var leader := _threat_leader_of(enemy)
		if leader != null and leader != player and _is_squishy(leader):
			count += 1
	return count

func _add_near_healer() -> Node:
	for enemy in player.get_tree().get_nodes_in_group("trash"):
		if enemy.get("is_dead") == true or not (enemy is Node3D):
			continue
		var leader := _threat_leader_of(enemy)
		if leader != null and _is_squishy(leader):
			return enemy
	return null

func _is_squishy(unit: Node) -> bool:
	var role_id = unit.get("role_id")
	if typeof(role_id) != TYPE_STRING:
		return false
	return Content.role(role_id).get("archetype", "") in ["healer", "ranged_dps"]

func _caster_add() -> Node:
	for enemy in player.get_tree().get_nodes_in_group("trash"):
		if enemy.get("is_dead") == true:
			continue
		if Content.mob(enemy.get("mob_type")).get("ranged", false):
			return enemy
	return null

func _interruptible_enemy(reach: float) -> Node:
	for enemy in player.get_tree().get_nodes_in_group("enemies"):
		if enemy.get("is_dead") == true or not (enemy is Node3D):
			continue
		var cast = enemy.get("cast_component")
		if not (cast is CastComponent) or not cast.is_casting or not cast.interruptible:
			continue
		if player.global_position.distance_to((enemy as Node3D).global_position) <= reach + 2.0:
			return enemy
	return null

func _boss_casting(ability_id: String) -> bool:
	var boss := player.get_tree().get_first_node_in_group("boss")
	if boss == null:
		return false
	var cast = boss.get("cast_component")
	return cast is CastComponent and cast.is_casting and cast.ability_id == ability_id

func _standing_in_hazard() -> bool:
	return _hazard_under_foot() != null

func _hazard_under_foot() -> HazardZone:
	for hazard in player.get_tree().get_nodes_in_group("hazards"):
		if not (hazard is HazardZone):
			continue
		var zone := hazard as HazardZone
		var offset: Vector3 = player.global_position - zone.global_position
		offset.y = 0.0
		if offset.length() <= zone._radius:
			return zone
	return null

func _party_centroid_excluding(exclude: Node) -> Vector3:
	var total := Vector3.ZERO
	var count := 0
	for unit in player.get_tree().get_nodes_in_group("party"):
		if unit == exclude or unit.get("is_dead") == true or not (unit is Node3D):
			continue
		total += (unit as Node3D).global_position
		count += 1
	return total / float(count) if count > 0 else Vector3.ZERO

func _now() -> float:
	return float(Time.get_ticks_msec()) / 1000.0
