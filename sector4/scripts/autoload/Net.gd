extends Node
## ENet transport and the player registry.
##
## Peer ID 1 is the server and owns the truth: boss AI, damage numbers,
## hazard spawns and floor transitions all run there. Clients own their own
## input and their own camera, and nothing else.

const DEFAULT_PORT := 27400
const MAX_PLAYERS := 4

signal roster_changed()
signal connection_failed()
signal server_disconnected()
signal game_started()        ## the squad has reached the hub
signal deployed()            ## the squad is dropping into a floor
signal lobby_requested()

## peer_id -> {"name": String, "role": String, "ready": bool}
var roster: Dictionary = {}
var local_role: String = "field_medic"
var local_name: String = "Operative"
var in_game: bool = false

func _ready() -> void:
	multiplayer.peer_connected.connect(_on_peer_connected)
	multiplayer.peer_disconnected.connect(_on_peer_disconnected)
	multiplayer.connected_to_server.connect(_on_connected_to_server)
	multiplayer.connection_failed.connect(_on_connection_failed)
	multiplayer.server_disconnected.connect(_on_server_disconnected)

# ------------------------------------------------------------- lifecycle

func host_game(port: int = DEFAULT_PORT) -> Error:
	var peer := ENetMultiplayerPeer.new()
	var err := peer.create_server(port, MAX_PLAYERS)
	if err != OK:
		push_error("Sector-4: could not host on port %d (%s)" % [port, error_string(err)])
		return err
	multiplayer.multiplayer_peer = peer
	roster.clear()
	roster[1] = {"name": local_name, "role": local_role, "ready": false}
	roster_changed.emit()
	return OK

func join_game(address: String, port: int = DEFAULT_PORT) -> Error:
	var peer := ENetMultiplayerPeer.new()
	var err := peer.create_client(address, port)
	if err != OK:
		push_error("Sector-4: could not reach %s:%d (%s)" % [address, port, error_string(err)])
		return err
	multiplayer.multiplayer_peer = peer
	return OK

func leave() -> void:
	if multiplayer.multiplayer_peer != null:
		multiplayer.multiplayer_peer.close()
	multiplayer.multiplayer_peer = null
	roster.clear()
	in_game = false
	roster_changed.emit()

## Single-player and headless runs still want a valid roster, so solo mode
## is a one-peer server rather than a separate code path.
func start_solo() -> void:
	multiplayer.multiplayer_peer = null
	roster.clear()
	roster[1] = {"name": local_name, "role": local_role, "ready": true}
	in_game = true
	roster_changed.emit()

## True only when a real peer exists. Solo runs have no peer at all, so an
## unguarded `.rpc()` there is an error rather than a no-op -- every
## replication site asks this first.
func online() -> bool:
	return multiplayer.has_multiplayer_peer()

## Leave the run and go back to the lobby. Solo has nothing to disconnect
## from, so the intent is a signal rather than a dropped peer.
func quit_to_lobby() -> void:
	leave()
	lobby_requested.emit()

func is_server() -> bool:
	return multiplayer.multiplayer_peer == null or multiplayer.is_server()

func local_id() -> int:
	if multiplayer.multiplayer_peer == null:
		return 1
	return multiplayer.get_unique_id()

# ----------------------------------------------------------------- peers

func _on_peer_connected(id: int) -> void:
	if not multiplayer.is_server():
		return
	# The newcomer needs the roster as it stands; everyone else needs the
	# newcomer. Both go out from the server so there is one ordering.
	for peer_id in roster:
		_receive_roster_entry.rpc_id(id, peer_id, roster[peer_id])

func _on_peer_disconnected(id: int) -> void:
	roster.erase(id)
	roster_changed.emit()
	if multiplayer.is_server():
		_receive_roster_removal.rpc(id)

func _on_connected_to_server() -> void:
	_register_player.rpc_id(1, local_name, local_role)

func _on_connection_failed() -> void:
	multiplayer.multiplayer_peer = null
	connection_failed.emit()

func _on_server_disconnected() -> void:
	multiplayer.multiplayer_peer = null
	roster.clear()
	in_game = false
	server_disconnected.emit()

# ------------------------------------------------------------------ rpcs

@rpc("any_peer", "call_local", "reliable")
func _register_player(display_name: String, role_id: String) -> void:
	if not multiplayer.is_server():
		return
	var id := multiplayer.get_remote_sender_id()
	if id == 0:
		id = 1
	if not Content.ROLES.has(role_id):
		role_id = "field_medic"
	role_id = _free_role_or(role_id)
	var entry := {"name": display_name, "role": role_id, "ready": false}
	roster[id] = entry
	roster_changed.emit()
	_receive_roster_entry.rpc(id, entry)

## One of each role, so the trinity cannot be broken by two people picking
## the same button in the lobby.
func _free_role_or(preferred: String) -> String:
	var taken := {}
	for entry in roster.values():
		taken[entry["role"]] = true
	if not taken.has(preferred):
		return preferred
	for role_id in Content.ROLE_ORDER:
		if not taken.has(role_id):
			return role_id
	return preferred

@rpc("authority", "call_local", "reliable")
func _receive_roster_entry(id: int, entry: Dictionary) -> void:
	roster[id] = entry
	roster_changed.emit()

@rpc("authority", "call_local", "reliable")
func _receive_roster_removal(id: int) -> void:
	roster.erase(id)
	roster_changed.emit()

@rpc("any_peer", "call_local", "reliable")
func set_ready(is_ready: bool) -> void:
	if not multiplayer.is_server():
		return
	var id := multiplayer.get_remote_sender_id()
	if id == 0:
		id = 1
	if roster.has(id):
		roster[id]["ready"] = is_ready
		_receive_roster_entry.rpc(id, roster[id])

@rpc("any_peer", "call_local", "reliable")
func request_role(role_id: String) -> void:
	if not multiplayer.is_server():
		return
	var id := multiplayer.get_remote_sender_id()
	if id == 0:
		id = 1
	if not roster.has(id) or not Content.ROLES.has(role_id):
		return
	for peer_id in roster:
		if peer_id != id and roster[peer_id]["role"] == role_id:
			return
	roster[id]["role"] = role_id
	_receive_roster_entry.rpc(id, roster[id])

@rpc("authority", "call_local", "reliable")
func start_game() -> void:
	in_game = true
	game_started.emit()

## Leave the hub for a floor. The server calls it for everyone, so the
## squad always drops together rather than one person at a time.
func deploy() -> void:
	if Net.online() and not multiplayer.is_server():
		_request_deploy.rpc_id(1)
		return
	if Net.online():
		_begin_deploy.rpc()
	else:
		_begin_deploy()

@rpc("any_peer", "call_local", "reliable")
func _request_deploy() -> void:
	if multiplayer.is_server():
		_begin_deploy.rpc()

@rpc("authority", "call_local", "reliable")
func _begin_deploy() -> void:
	deployed.emit()

## Back to the staging deck after a run.
func return_to_hub() -> void:
	game_started.emit()

func everyone_ready() -> bool:
	if roster.is_empty():
		return false
	for entry in roster.values():
		if not entry["ready"]:
			return false
	return true
