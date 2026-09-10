extends Node
class_name RoleKit
## Base class for the four kits, and the client-to-server ability protocol.
##
## The owning client decides *intent* -- which button, pointed where, at
## whom -- and the server decides *outcome*. The client's soft-lock choice
## is sent along as a suggestion; the server re-checks range and line of
## sight before honouring it, so a client that lies about what it can see
## gets nothing for the trouble.

## Loaded rather than preloaded: the subclasses extend this class, and a
## preload here would be a parse-time cycle.
const KIT_SCRIPTS := {
	"field_medic": "res://scripts/player/roles/FieldMedic.gd",
	"enforcer": "res://scripts/player/roles/Enforcer.gd",
	"kinetic_striker": "res://scripts/player/roles/KineticStriker.gd",
	"railgun_specialist": "res://scripts/player/roles/RailgunSpecialist.gd",
}

var player: PlayerCharacter = null

static func make(role_id: String) -> RoleKit:
	var path: String = KIT_SCRIPTS.get(role_id, "")
	if path == "":
		push_error("Sector-4: no kit for role '%s'" % role_id)
		return RoleKit.new()
	var script: Script = load(path)
	return script.new()

func bind(owner_body: PlayerCharacter) -> void:
	player = owner_body

# ------------------------------------------------------------ input hooks

func on_pressed(ability_id: String) -> void:
	fire(ability_id)

func on_held(_ability_id: String) -> void:
	pass

func on_released(_ability_id: String) -> void:
	pass

# --------------------------------------------------------------- protocol

## Ask the server to run an ability. Called on the owning client.
func fire(ability_id: String, extra: Dictionary = {}) -> void:
	if player == null or player.is_dead:
		return
	# A local gate so a button on cooldown does not spend a packet. The
	# server checks again -- this is a courtesy, not the rule.
	if player.ability_component != null and not player.ability_component.can_use(ability_id):
		return
	var payload := build_payload(ability_id)
	payload.merge(extra, true)
	if Net.is_server():
		_server_execute(ability_id, payload)
	else:
		_server_execute.rpc_id(1, ability_id, payload)

## What the client knows and the server cannot cheaply recompute: where the
## camera is looking, and which body the reticle had settled on.
func build_payload(_ability_id: String) -> Dictionary:
	return {
		"origin": player.aim_origin(),
		"direction": player.aim_direction(),
		"ally": _path_or_empty(player.ally_targeting.current_target),
		"enemy": _path_or_empty(player.enemy_targeting.current_target),
		"move": player.move_intent(),
	}

@rpc("any_peer", "call_local", "reliable")
func _server_execute(ability_id: String, payload: Dictionary) -> void:
	if not Net.is_server():
		return
	if not _sender_owns_this():
		return
	server_fire(ability_id, payload)

## The one place an ability is actually allowed to happen, whoever asked.
##
## A human's press arrives through `_server_execute`; a bot calls this
## directly, because there is no client on the other end of an empty seat.
## Both go through the same validation, so a bot can never do something a
## player could not.
func server_fire(ability_id: String, payload: Dictionary) -> bool:
	if player == null or player.is_dead:
		return false
	if not Content.role(player.role_id).get("abilities", []).has(ability_id):
		return false
	if player.ability_component != null and not player.ability_component.can_use(ability_id):
		return false
	if not execute(ability_id, payload):
		return false
	if player.ability_component != null:
		player.ability_component.commit(ability_id)
	if Net.online():
		_confirm.rpc(ability_id)
	elif player.is_local:
		GameEvents.ability_used.emit(ability_id, Content.ability(ability_id).get("cooldown", 0.0))
	return true

## The payload a bot supplies: it has no camera, so its "aim" is simply
## the line from its chest to whatever it decided to act on.
func bot_payload(target: Node) -> Dictionary:
	var direction := -player.global_transform.basis.z
	if target is Node3D:
		direction = ((target as Node3D).global_position + Vector3(0, 1.1, 0)) - player.aim_point()
		if direction.is_zero_approx():
			direction = -player.global_transform.basis.z
	var path := target.get_path() if target != null and is_instance_valid(target) else NodePath()
	return {
		"origin": player.aim_point(),
		"direction": direction.normalized(),
		"ally": path,
		"enemy": path,
		"move": player.move_intent(),
	}

@rpc("authority", "call_local", "unreliable")
func _confirm(ability_id: String) -> void:
	if player != null and player.is_local:
		GameEvents.ability_used.emit(ability_id, Content.ability(ability_id).get("cooldown", 0.0))

## Channels are stateful, so they get their own message rather than being
## squeezed into the one-shot path.
func set_channel(ability_id: String, active: bool) -> void:
	if player == null:
		return
	var payload := build_payload(ability_id)
	if Net.is_server():
		_server_channel(ability_id, active, payload)
	else:
		_server_channel.rpc_id(1, ability_id, active, payload)

@rpc("any_peer", "call_local", "reliable")
func _server_channel(ability_id: String, active: bool, payload: Dictionary) -> void:
	if not Net.is_server():
		return
	if not _sender_owns_this(): return
	channel(ability_id, active, payload)

func _sender_owns_this() -> bool:
	if not multiplayer.has_multiplayer_peer():
		return true
	var sender := multiplayer.get_remote_sender_id()
	if sender == 0:
		sender = 1
	return sender == player.get_multiplayer_authority()

# ---------------------------------------------------------------- to fill

## Return true if the ability actually went off. Returning false leaves the
## cooldown and the resource untouched, which is what makes "no target in
## range" cost nothing.
func execute(_ability_id: String, _payload: Dictionary) -> bool:
	return false

func channel(_ability_id: String, _active: bool, _payload: Dictionary) -> void:
	pass

# ------------------------------------------------------- shared helpers

func _path_or_empty(node: Node) -> NodePath:
	return node.get_path() if node != null and is_instance_valid(node) else NodePath()

func resolve(payload: Dictionary, key: String) -> Node:
	var path: NodePath = payload.get(key, NodePath())
	if path.is_empty():
		return null
	var node := player.get_node_or_null(path)
	if node == null or not is_instance_valid(node):
		return null
	return node

func in_range(target: Node, distance: float) -> bool:
	if target == null or not (target is Node3D):
		return false
	return player.global_position.distance_to((target as Node3D).global_position) <= distance

func alive(target: Node) -> bool:
	return target != null and is_instance_valid(target) and target.get("is_dead") != true

## Server-side line of sight, so the client's claim gets checked.
func has_los(target: Node) -> bool:
	if not (target is Node3D):
		return false
	var space := player.get_world_3d().direct_space_state
	var query := PhysicsRayQueryParameters3D.create(
		player.aim_point(), (target as Node3D).global_position + Vector3(0, 1.1, 0), 1, [player.get_rid()]
	)
	var hit := space.intersect_ray(query)
	return hit.is_empty() or hit.get("collider") == target

## A hitscan shot along the aim ray, used by every primary that is not a
## melee swing.
func raycast_enemy(payload: Dictionary, distance: float) -> Node:
	var origin: Vector3 = payload.get("origin", player.aim_point())
	var direction: Vector3 = payload.get("direction", -player.global_transform.basis.z)
	var space := player.get_world_3d().direct_space_state
	var query := PhysicsRayQueryParameters3D.create(
		origin, origin + direction.normalized() * distance, 0xFFFFFFFF, [player.get_rid()]
	)
	var hit := space.intersect_ray(query)
	if hit.is_empty():
		return null
	var collider = hit.get("collider")
	if collider is Combatant and player.is_hostile_to(collider):
		return collider
	return null

## Falls back to the soft-locked enemy when the ray misses, so a shot that
## grazes a shoulder still counts. The reticle promised a target; honouring
## it is the point of a soft lock.
func pick_enemy(payload: Dictionary, distance: float) -> Node:
	var hit := raycast_enemy(payload, distance)
	if hit != null:
		return hit
	var soft := resolve(payload, "enemy")
	if alive(soft) and in_range(soft, distance) and has_los(soft):
		return soft
	return null

func nearest_enemy(distance: float) -> Node:
	var best: Node = null
	var nearest := INF
	for enemy in player.get_tree().get_nodes_in_group("enemies"):
		if not alive(enemy) or not (enemy is Node3D):
			continue
		var d: float = player.global_position.distance_to((enemy as Node3D).global_position)
		if d <= distance and d < nearest:
			nearest = d
			best = enemy
	return best
