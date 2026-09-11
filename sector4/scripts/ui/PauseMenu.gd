extends CanvasLayer
class_name PauseMenu
## Escape: stop, look at your kit, or leave.
##
## Solo actually pauses the tree. In a multiplayer run it deliberately does
## not -- one client cannot stop a shared simulation, and pretending
## otherwise would desync everyone else while you read the menu. The menu
## says which of the two you are in rather than quietly behaving
## differently.

const ROW := Vector2(260.0, 44.0)

var open: bool = false

var _buttons: Array[Dictionary] = []
var _hover: int = 0
var _showing_kit: bool = false

func _ready() -> void:
	# The menu has to keep running while everything else is stopped.
	process_mode = Node.PROCESS_MODE_ALWAYS
	add_to_group("pause")
	layer = 10
	_buttons = [
		{"label": "Resume", "action": "resume"},
		{"label": "Your kit", "action": "kit"},
		{"label": "Abort to hub", "action": "hub"},
		{"label": "Leave to lobby", "action": "leave"},
	]
	$Panel.process_mode = Node.PROCESS_MODE_ALWAYS
	$Panel.mouse_filter = Control.MOUSE_FILTER_IGNORE
	$Panel.set_anchors_preset(Control.PRESET_FULL_RECT)
	$Panel.draw.connect(_draw_panel)
	$Panel.visible = false

func _unhandled_input(event: InputEvent) -> void:
	if event.is_action_pressed("ui_cancel"):
		toggle()
		get_viewport().set_input_as_handled()
		return
	if not open:
		return
	if event.is_action_pressed("ui_down"):
		_hover = (_hover + 1) % _buttons.size()
	elif event.is_action_pressed("ui_up"):
		_hover = (_hover - 1 + _buttons.size()) % _buttons.size()
	elif event.is_action_pressed("ui_accept"):
		_activate(_buttons[_hover]["action"])
	elif event is InputEventMouseButton and event.pressed and event.button_index == MOUSE_BUTTON_LEFT:
		var index := _row_at(event.position)
		if index >= 0:
			_activate(_buttons[index]["action"])

func _process(_delta: float) -> void:
	if not open:
		return
	var index := _row_at(get_viewport().get_mouse_position())
	if index >= 0:
		_hover = index
	$Panel.queue_redraw()

func toggle() -> void:
	set_open(not open)

func set_open(value: bool) -> void:
	open = value
	$Panel.visible = open
	_showing_kit = false
	_hover = 0
	# Only a solo run may actually stop the world.
	if not Net.online():
		get_tree().paused = open
	Input.mouse_mode = Input.MOUSE_MODE_VISIBLE if open else Input.MOUSE_MODE_CAPTURED

func _activate(action: String) -> void:
	match action:
		"resume":
			set_open(false)
		"kit":
			_showing_kit = not _showing_kit
		"hub":
			set_open(false)
			get_tree().paused = false
			Net.return_to_hub()
		"leave":
			set_open(false)
			get_tree().paused = false
			Net.quit_to_lobby()

func _rows_origin() -> Vector2:
	var panel: Control = $Panel
	return Vector2((panel.size.x - ROW.x) * 0.5, panel.size.y * 0.42)

func _row_at(point: Vector2) -> int:
	if not open:
		return -1
	var origin := _rows_origin()
	for i in _buttons.size():
		var rect := Rect2(origin + Vector2(0.0, float(i) * (ROW.y + 8.0)), ROW)
		if rect.has_point(point):
			return i
	return -1

func _draw_panel() -> void:
	var panel: Control = $Panel
	var font := ThemeDB.fallback_font
	panel.draw_rect(Rect2(Vector2.ZERO, panel.size), Color(0.02, 0.03, 0.05, 0.82))

	var title := "PAUSED"
	var width := font.get_string_size(title, HORIZONTAL_ALIGNMENT_LEFT, -1, 46).x
	panel.draw_string(font, Vector2((panel.size.x - width) * 0.5, panel.size.y * 0.26), title,
		HORIZONTAL_ALIGNMENT_LEFT, -1, 46, Color(1, 1, 1, 0.95))

	# Say plainly whether the world is actually stopped.
	var note := "Solo run — the fight is stopped" if not Net.online() \
		else "Multiplayer — the fight is still running"
	var note_width := font.get_string_size(note, HORIZONTAL_ALIGNMENT_LEFT, -1, 14).x
	panel.draw_string(font, Vector2((panel.size.x - note_width) * 0.5, panel.size.y * 0.26 + 26.0),
		note, HORIZONTAL_ALIGNMENT_LEFT, -1, 14, Color(1, 1, 1, 0.5))

	var origin := _rows_origin()
	for i in _buttons.size():
		var rect := Rect2(origin + Vector2(0.0, float(i) * (ROW.y + 8.0)), ROW)
		var hot := i == _hover
		panel.draw_rect(rect, Color(0.08, 0.11, 0.16, 0.95) if hot else Color(0.04, 0.05, 0.08, 0.9))
		panel.draw_rect(rect, Color(0.35, 0.85, 1.0, 0.9) if hot else Color(1, 1, 1, 0.15), false, 1.5)
		panel.draw_string(font, rect.position + Vector2(16.0, 29.0), _buttons[i]["label"],
			HORIZONTAL_ALIGNMENT_LEFT, -1, 18, Color(1, 1, 1, 0.95) if hot else Color(1, 1, 1, 0.7))

	if _showing_kit:
		_draw_kit(panel, font, origin + Vector2(ROW.x + 30.0, 0.0))

## What each button does, in words. The ability bar has room for a name;
## this has room for why you would press it.
func _draw_kit(panel: Control, font: Font, at: Vector2) -> void:
	var player := PlayerCharacter.local(get_tree())
	if player == null:
		return
	var def: Dictionary = Content.role(player.role_id)
	panel.draw_string(font, at + Vector2(0.0, 18.0), def.get("display_name", player.role_id),
		HORIZONTAL_ALIGNMENT_LEFT, -1, 22, Color(0.35, 0.85, 1.0))
	var y := 46.0
	var bindings: Dictionary = Content.bindings_for_role(player.role_id)
	for action in Content.ABILITY_BAR_ORDER:
		if not bindings.has(action):
			continue
		var ability: Dictionary = Content.ability(bindings[action])
		var prompt := "%s / %s" % [Content.INPUT_LABELS.get(action, "?"), Content.INPUT_KEYS.get(action, "?")]
		panel.draw_string(font, at + Vector2(0.0, y), prompt, HORIZONTAL_ALIGNMENT_LEFT, -1, 12,
			Color(1.0, 0.85, 0.3, 0.9))
		panel.draw_string(font, at + Vector2(110.0, y), ability.get("display_name", ""),
			HORIZONTAL_ALIGNMENT_LEFT, -1, 14, Color(1, 1, 1, 0.92))
		var desc: String = ability.get("desc", "")
		if desc != "":
			panel.draw_string(font, at + Vector2(110.0, y + 15.0), desc, HORIZONTAL_ALIGNMENT_LEFT, 460, 11,
				Color(1, 1, 1, 0.5))
			y += 16.0
		y += 26.0
