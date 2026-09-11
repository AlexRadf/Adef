extends Control
class_name Lobby
## Host, join, pick a seat, breach.
##
## The lobby exists to enforce one thing the fight cannot recover from: a
## party without a trinity. Roles are exclusive, so four people cannot all
## take the railgun and then wonder why nobody is holding the boss.

@onready var _address: LineEdit = %Address
@onready var _status: Label = %Status
@onready var _roster: VBoxContainer = %Roster
@onready var _roles: HBoxContainer = %Roles
@onready var _host_button: Button = %HostButton
@onready var _join_button: Button = %JoinButton
@onready var _solo_button: Button = %SoloButton
@onready var _ready_button: Button = %ReadyButton
@onready var _start_button: Button = %StartButton
@onready var _kit: VBoxContainer = %KitPreview

func _ready() -> void:
	Input.mouse_mode = Input.MOUSE_MODE_VISIBLE
	Net.roster_changed.connect(_refresh)
	Net.connection_failed.connect(func() -> void: _set_status("Could not reach that host.", true))
	Net.server_disconnected.connect(func() -> void: _set_status("The host went away.", true))
	_host_button.pressed.connect(_on_host)
	_join_button.pressed.connect(_on_join)
	_solo_button.pressed.connect(_on_solo)
	_ready_button.pressed.connect(_on_ready_pressed)
	_start_button.pressed.connect(_on_start)
	_build_role_buttons()
	_show_kit(Net.local_role)
	_refresh()

func _build_role_buttons() -> void:
	for role_id in Content.ROLE_ORDER:
		var def: Dictionary = Content.role(role_id)
		var button := Button.new()
		button.text = "%s\n%s" % [def["display_name"], _archetype_label(def["archetype"])]
		button.toggle_mode = true
		button.custom_minimum_size = Vector2(180.0, 64.0)
		button.pressed.connect(_on_role_picked.bind(role_id))
		button.set_meta("role_id", role_id)
		_roles.add_child(button)

func _archetype_label(archetype: String) -> String:
	match archetype:
		"tank": return "Aggro anchor"
		"healer": return "Triage"
		"melee_dps": return "Interrupts and flanking"
		"ranged_dps": return "Focus fire"
	return archetype

func _on_role_picked(role_id: String) -> void:
	Net.local_role = role_id
	_show_kit(role_id)
	if Net.roster.has(Net.local_id()):
		if Net.is_server():
			Net.request_role(role_id)
		else:
			Net.request_role.rpc_id(1, role_id)
	_refresh()

func _on_host() -> void:
	if Net.host_game() == OK:
		_set_status("Hosting on port %d. Waiting for the squad." % Net.DEFAULT_PORT, false)

func _on_join() -> void:
	var address := _address.text.strip_edges()
	if address == "":
		address = "127.0.0.1"
	if Net.join_game(address) == OK:
		_set_status("Connecting to %s..." % address, false)

## Solo is a one-peer server rather than a separate mode, so the code path
## the four-player game takes is the code path a lone tester takes.
func _on_solo() -> void:
	Net.start_solo()
	Net.start_game()   # -> the staging deck

func _on_ready_pressed() -> void:
	var mine: Dictionary = Net.roster.get(Net.local_id(), {})
	var next: bool = not mine.get("ready", false)
	if Net.is_server():
		Net.set_ready(next)
	else:
		Net.set_ready.rpc_id(1, next)

func _on_start() -> void:
	if not Net.is_server():
		return
	if Net.online():
		Net.start_game.rpc()
	else:
		Net.start_game()

## Always four rows. An empty squad list reads as "nothing is working";
## four rows with bots in them reads as "this is what you are about to
## play", which is the truth.
func _refresh() -> void:
	for child in _roster.get_children():
		child.queue_free()
	var taken := {}
	var by_role := {}
	for peer_id in Net.roster:
		var entry: Dictionary = Net.roster[peer_id]
		taken[entry["role"]] = true
		by_role[entry["role"]] = {"entry": entry, "peer": int(peer_id)}

	for role_id in Content.ROLE_ORDER:
		var label := Label.new()
		var role_name: String = Content.role(role_id).get("display_name", role_id)
		if by_role.has(role_id):
			var entry: Dictionary = by_role[role_id]["entry"]
			var mark := "READY" if entry["ready"] else "waiting"
			var you := "   (you)" if int(by_role[role_id]["peer"]) == Net.local_id() else ""
			label.text = "%-20s %s   [%s]%s" % [role_name, entry["name"], mark, you]
			label.modulate = Color(1, 1, 1)
		else:
			label.text = "%-20s bot will fill this seat" % role_name
			label.modulate = Color(1, 1, 1, 0.45)
		_roster.add_child(label)

	for button in _roles.get_children():
		var role_id: String = button.get_meta("role_id")
		var is_mine: bool = Net.roster.get(Net.local_id(), {}).get("role", Net.local_role) == role_id
		button.button_pressed = is_mine
		button.disabled = taken.has(role_id) and not is_mine

	var connected := Net.roster.has(Net.local_id())
	_ready_button.disabled = not connected
	_start_button.disabled = not (Net.is_server() and connected and Net.everyone_ready())
	_host_button.disabled = connected
	_join_button.disabled = connected

## What the role actually does, before you commit to it. Picking a seat
## from a name alone is a guess.
func _show_kit(role_id: String) -> void:
	for child in _kit.get_children():
		child.queue_free()
	var def: Dictionary = Content.role(role_id)
	if def.is_empty():
		return
	var heading := Label.new()
	heading.text = "%s — %d HP · %s" % [
		def.get("display_name", role_id), roundi(def.get("max_health", 0.0)),
		def.get("energy_name", "Energy"),
	]
	_kit.add_child(heading)
	var bindings: Dictionary = Content.bindings_for_role(role_id)
	for action in Content.ABILITY_BAR_ORDER:
		if not bindings.has(action):
			continue
		var ability: Dictionary = Content.ability(bindings[action])
		var row := Label.new()
		row.text = "  %-9s %-22s %s" % [
			Content.INPUT_LABELS.get(action, ""),
			ability.get("display_name", ""),
			ability.get("desc", ""),
		]
		row.modulate = Color(1, 1, 1, 0.62)
		_kit.add_child(row)

func _set_status(text: String, is_error: bool) -> void:
	_status.text = text
	_status.modulate = Color(1.0, 0.45, 0.4) if is_error else Color(1, 1, 1)
