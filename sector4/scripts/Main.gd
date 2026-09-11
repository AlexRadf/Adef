extends Node
## Entry point. Owns exactly one child at a time: the lobby, or the run.
class_name SectorMain

const LOBBY_SCENE := preload("res://scenes/ui/Lobby.tscn")
const FLOOR_SCENE := preload("res://scenes/floor/Floor.tscn")

var _current: Node = null

func _ready() -> void:
	Net.game_started.connect(_on_game_started)
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
	_swap_to(FLOOR_SCENE.instantiate())

func _on_server_disconnected() -> void:
	get_tree().paused = false
	Input.mouse_mode = Input.MOUSE_MODE_VISIBLE
	_swap_to(LOBBY_SCENE.instantiate())
