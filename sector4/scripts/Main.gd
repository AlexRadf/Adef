extends Node
## Entry point. Owns exactly one child at a time: the lobby, or the run.
class_name SectorMain

const LOBBY_SCENE := preload("res://scenes/ui/Lobby.tscn")
const HUB_SCENE := preload("res://scenes/hub/Hub.tscn")
const FLOOR_SCENE := preload("res://scenes/floor/Floor.tscn")

var _current: Node = null

func _ready() -> void:
	# Connecting takes you to the staging deck, not straight into a fight;
	# the floor is something you deploy to from the mission table.
	Net.game_started.connect(_on_game_started)
	Net.deployed.connect(_on_deployed)
	Net.server_disconnected.connect(_on_server_disconnected)
	Net.lobby_requested.connect(_on_server_disconnected)
	_swap_to(LOBBY_SCENE.instantiate())

func _swap_to(node: Node) -> void:
	if is_instance_valid(_current):
		_current.queue_free()
		remove_child(_current)
	_current = node
	add_child(node)

func _on_game_started() -> void:
	get_tree().paused = false
	_swap_to(HUB_SCENE.instantiate())

func _on_deployed() -> void:
	get_tree().paused = false
	_swap_to(FLOOR_SCENE.instantiate())

func _on_server_disconnected() -> void:
	get_tree().paused = false
	Input.mouse_mode = Input.MOUSE_MODE_VISIBLE
	_swap_to(LOBBY_SCENE.instantiate())
