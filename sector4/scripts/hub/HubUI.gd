extends CanvasLayer
class_name HubUI
## The hub's screens: the walk-up prompt, the armoury, the roster board and
## the mission table.
##
## Drawn rather than built from Control nodes, for the same reason the rest
## of the HUD is: one file, no scene surgery to move a screen, and the
## layout lives next to the numbers it is laying out.

enum Screen { NONE, ARMOURY, ROSTER, MISSION }

const PANEL_SIZE := Vector2(1000.0, 648.0)
const ROW_HEIGHT := 52.0
const ROW_WIDTH := 600.0
const SUMMARY_X := 640.0

var screen: Screen = Screen.NONE
var _hover: int = 0
var _hub: Hub = null
var _status: String = ""
var _status_until: float = 0.0

@onready var _canvas: Control = $Canvas

func _ready() -> void:
	layer = 6
	_hub = get_parent() as Hub
	_canvas.set_anchors_preset(Control.PRESET_FULL_RECT)
	_canvas.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_canvas.draw.connect(_draw_canvas)

func _process(_delta: float) -> void:
	_canvas.queue_redraw()
	if screen != Screen.NONE:
		return
	# Walk-up prompt: press Interact while standing on a station.
	var station := _hub.station_in_reach() if _hub != null else null
	if station != null and Input.is_action_just_pressed("interact"):
		station.use()

func _unhandled_input(event: InputEvent) -> void:
	if screen == Screen.NONE:
		return
	if event.is_action_pressed("ui_cancel") or event.is_action_pressed("interact") 			or event.is_action_pressed("back_out"):
		close()
		get_viewport().set_input_as_handled()
		return
	var rows := _row_count()
	if event.is_action_pressed("ui_down"):
		_hover = (_hover + 1) % maxi(1, rows)
	elif event.is_action_pressed("ui_up"):
		_hover = (_hover - 1 + rows) % maxi(1, rows)
	elif event.is_action_pressed("ui_accept"):
		_activate(_hover)
	elif event is InputEventMouseButton and event.pressed and event.button_index == MOUSE_BUTTON_LEFT:
		if _close_rect().has_point(event.position) or not _panel_rect().has_point(event.position):
			# The X, or anywhere off the panel. A menu you can only leave
			# by guessing a key is a menu people get stuck in.
			close()
			get_viewport().set_input_as_handled()
			return
		var index := _row_at(event.position)
		if index >= 0:
			_activate(index)

func open_panel(station_id: String) -> void:
	match station_id:
		"armoury": screen = Screen.ARMOURY
		"roster": screen = Screen.ROSTER
		"mission": screen = Screen.MISSION
		_: screen = Screen.NONE
	_hover = 0
	Input.mouse_mode = Input.MOUSE_MODE_VISIBLE

func close() -> void:
	screen = Screen.NONE
	Input.mouse_mode = Input.MOUSE_MODE_CAPTURED

# --------------------------------------------------------------- actions

func _row_count() -> int:
	match screen:
		Screen.ARMOURY: return Content.MODULES.size()
		Screen.ROSTER: return Content.ROLE_ORDER.size()
		Screen.MISSION: return Content.FLOORS.size()
	return 0

func _activate(index: int) -> void:
	match screen:
		Screen.ARMOURY:
			var module_id: String = Content.MODULES.keys()[index]
			if not Loadout.toggle(_role(), module_id):
				_flash("All %d slots are full — strip one first." % Content.MODULE_SLOTS)
			_refit()
		Screen.ROSTER:
			_pick_role(Content.ROLE_ORDER[index])
		Screen.MISSION:
			_deploy(index)

func _pick_role(role_id: String) -> void:
	for peer_id in Net.roster:
		if peer_id != Net.local_id() and Net.roster[peer_id]["role"] == role_id:
			_flash("%s is taken." % Content.role(role_id).get("display_name", role_id))
			return
	Net.local_role = role_id
	if Net.online():
		Net.request_role.rpc_id(1, role_id)
	elif Net.roster.has(Net.local_id()):
		Net.roster[Net.local_id()]["role"] = role_id
		Net.roster_changed.emit()
	close()
	if _hub != null:
		_hub.rebuild_squad()

func _deploy(_floor_index: int) -> void:
	close()
	Net.deploy()

## Changing a loadout in the armoury has to show up on the operative
## standing in front of you, or the numbers are a promise rather than a
## fact.
func _refit() -> void:
	var body := PlayerCharacter.local(get_tree())
	if body == null:
		return
	var status = body.get("status_component")
	if not (status is StatusEffectComponent):
		return
	for status_id in status.active_ids():
		if str(status_id).begins_with("module_"):
			status.remove(status_id)
	Loadout.apply_to(body, _role())

func _role() -> String:
	var body := PlayerCharacter.local(get_tree())
	return body.role_id if body != null else Net.local_role

func _flash(text: String) -> void:
	_status = text
	_status_until = _now() + 2.5

# ---------------------------------------------------------------- drawing

## A real target in the corner of the panel, sized for a mouse.
func _close_rect() -> Rect2:
	var rect := _panel_rect()
	return Rect2(rect.position + Vector2(rect.size.x - 52.0, 14.0), Vector2(38.0, 38.0))

func _draw_close_button(font: Font) -> void:
	var rect := _close_rect()
	var hot := rect.has_point(get_viewport().get_mouse_position())
	_canvas.draw_rect(rect, Color(0.14, 0.06, 0.07, 0.95) if hot else Color(0.06, 0.07, 0.10, 0.9))
	_canvas.draw_rect(rect, Color(1.0, 0.45, 0.4, 0.9) if hot else Color(1, 1, 1, 0.25), false, 1.5)
	var centre := rect.position + rect.size * 0.5
	var arm := 8.0
	var colour := Color(1.0, 0.6, 0.55) if hot else Color(1, 1, 1, 0.7)
	_canvas.draw_line(centre + Vector2(-arm, -arm), centre + Vector2(arm, arm), colour, 2.0)
	_canvas.draw_line(centre + Vector2(-arm, arm), centre + Vector2(arm, -arm), colour, 2.0)
	_canvas.draw_string(font, rect.position + Vector2(-26.0, 26.0), "Esc",
		HORIZONTAL_ALIGNMENT_LEFT, -1, 12, Color(1, 1, 1, 0.45))

func _panel_rect() -> Rect2:
	return Rect2((_canvas.size - PANEL_SIZE) * 0.5, PANEL_SIZE)

func _rows_origin() -> Vector2:
	return _panel_rect().position + Vector2(26.0, 108.0)

func _row_at(point: Vector2) -> int:
	var origin := _rows_origin()
	for i in _row_count():
		var width := ROW_WIDTH if screen != Screen.MISSION else 900.0
		var step := ROW_HEIGHT if screen != Screen.MISSION else ROW_HEIGHT + 30.0
		if Rect2(origin + Vector2(0.0, float(i) * step), Vector2(width, ROW_HEIGHT - 6.0)).has_point(point):
			return i
	return -1

func _draw_canvas() -> void:
	var font := ThemeDB.fallback_font
	if screen == Screen.NONE:
		_draw_deck_header(font)
		_draw_station_signs(font)
		_draw_empty_seats(font)
		_draw_prompt(font)
		return
	var rect := _panel_rect()
	_canvas.draw_rect(Rect2(Vector2.ZERO, _canvas.size), Color(0.02, 0.03, 0.05, 0.78))
	_canvas.draw_rect(rect, Color(0.04, 0.05, 0.08, 0.97))
	_canvas.draw_rect(rect, Color(0.35, 0.80, 1.0, 0.35), false, 1.5)

	match screen:
		Screen.ARMOURY: _draw_armoury(font, rect)
		Screen.ROSTER: _draw_roster(font, rect)
		Screen.MISSION: _draw_mission(font, rect)

	_draw_close_button(font)
	_canvas.draw_string(font, rect.position + Vector2(26.0, rect.size.y - 18.0),
		"Enter or click to select     Esc, B or click outside to go back",
		HORIZONTAL_ALIGNMENT_LEFT, -1, 13, Color(1, 1, 1, 0.55))
	if _now() < _status_until:
		_canvas.draw_string(font, rect.position + Vector2(360.0, rect.size.y - 18.0), _status,
			HORIZONTAL_ALIGNMENT_LEFT, -1, 12, Color(1.0, 0.6, 0.3))

## Every station is signposted from across the deck. A hub you have to
## walk into things to understand is a hub nobody explores.
func _draw_station_signs(font: Font) -> void:
	var camera := get_viewport().get_camera_3d()
	if camera == null:
		return
	for node in get_tree().get_nodes_in_group("hub_stations"):
		var station := node as HubStation
		if station == null:
			continue
		var head: Vector3 = station.global_position + Vector3(0.0, 3.1, 0.0)
		if camera.is_position_behind(head):
			continue
		var at := camera.unproject_position(head)
		var width := font.get_string_size(station.title, HORIZONTAL_ALIGNMENT_LEFT, -1, 17).x
		_canvas.draw_rect(Rect2(at + Vector2(-width * 0.5 - 10.0, -18.0), Vector2(width + 20.0, 42.0)),
			Color(0.02, 0.03, 0.05, 0.6))
		_canvas.draw_string(font, at + Vector2(-width * 0.5, 0.0), station.title,
			HORIZONTAL_ALIGNMENT_LEFT, -1, 17, station.tint)
		var sub_width := font.get_string_size(station.subtitle, HORIZONTAL_ALIGNMENT_LEFT, -1, 11).x
		_canvas.draw_string(font, at + Vector2(-sub_width * 0.5, 16.0), station.subtitle,
			HORIZONTAL_ALIGNMENT_LEFT, -1, 11, Color(1, 1, 1, 0.55))

## Labels over the unfilled seats, so the squad you are missing is as
## visible as the squad you have.
func _draw_empty_seats(font: Font) -> void:
	var camera := get_viewport().get_camera_3d()
	if camera == null:
		return
	for node in get_tree().get_nodes_in_group("empty_seats"):
		var pad := node as Node3D
		if pad == null:
			continue
		var head: Vector3 = pad.global_position + Vector3(0.0, 1.5, 0.0)
		if camera.is_position_behind(head):
			continue
		var at := camera.unproject_position(head)
		var role_id: String = pad.get_meta("empty_seat_role", "")
		var label: String = Content.role(role_id).get("display_name", role_id)
		var width := font.get_string_size(label, HORIZONTAL_ALIGNMENT_LEFT, -1, 14).x
		_canvas.draw_string(font, at + Vector2(-width * 0.5, 0.0), label,
			HORIZONTAL_ALIGNMENT_LEFT, -1, 14, Color(1, 1, 1, 0.55))
		var note := "bot fills on deploy"
		var note_width := font.get_string_size(note, HORIZONTAL_ALIGNMENT_LEFT, -1, 11).x
		_canvas.draw_string(font, at + Vector2(-note_width * 0.5, 15.0), note,
			HORIZONTAL_ALIGNMENT_LEFT, -1, 11, Color(1, 1, 1, 0.32))

## The walk-up prompt. Without this a station is just furniture.
func _draw_prompt(font: Font) -> void:
	var station := _hub.station_in_reach() if _hub != null else null
	if station == null:
		return
	var centre := _canvas.size * 0.5
	var line := "%s — %s" % [station.title, station.subtitle]
	var width := font.get_string_size(line, HORIZONTAL_ALIGNMENT_LEFT, -1, 18).x
	var at := Vector2(centre.x - width * 0.5, centre.y + 120.0)
	_canvas.draw_rect(Rect2(at + Vector2(-16.0, -24.0), Vector2(width + 32.0, 54.0)),
		Color(0.02, 0.03, 0.05, 0.75))
	_canvas.draw_string(font, at, line, HORIZONTAL_ALIGNMENT_LEFT, -1, 18, Color(1, 1, 1, 0.95))
	_canvas.draw_string(font, at + Vector2(0.0, 20.0), "Press  G  /  A", HORIZONTAL_ALIGNMENT_LEFT, -1, 13,
		station.tint)

func _draw_deck_header(font: Font) -> void:
	_canvas.draw_string(font, Vector2(30.0, 46.0), "STAGING DECK",
		HORIZONTAL_ALIGNMENT_LEFT, -1, 24, Color(1, 1, 1, 0.9))
	_canvas.draw_string(font, Vector2(30.0, 68.0),
		"Walk to a station and press G. Deploy from the mission table.",
		HORIZONTAL_ALIGNMENT_LEFT, -1, 13, Color(1, 1, 1, 0.5))

func _draw_title(font: Font, rect: Rect2, title: String, subtitle: String) -> void:
	_canvas.draw_string(font, rect.position + Vector2(26.0, 46.0), title,
		HORIZONTAL_ALIGNMENT_LEFT, -1, 30, Color(1, 1, 1, 0.96))
	_canvas.draw_string(font, rect.position + Vector2(26.0, 70.0), subtitle,
		HORIZONTAL_ALIGNMENT_LEFT, -1, 13, Color(1, 1, 1, 0.5))

func _draw_armoury(font: Font, rect: Rect2) -> void:
	var role_id := _role()
	_draw_title(font, rect, "ARMOURY", "%s · %d of %d slots fitted" % [
		Content.role(role_id).get("display_name", role_id),
		Loadout.slots_used(role_id), Content.MODULE_SLOTS,
	])
	var origin := _rows_origin()
	var ids: Array = Content.MODULES.keys()
	for i in ids.size():
		var module_id: String = ids[i]
		var def: Dictionary = Content.module(module_id)
		var row := Rect2(origin + Vector2(0.0, float(i) * ROW_HEIGHT), Vector2(ROW_WIDTH, ROW_HEIGHT - 6.0))
		var fitted := Loadout.has_module(role_id, module_id)
		var hot := i == _hover

		_canvas.draw_rect(row, Color(0.09, 0.12, 0.17, 0.95) if hot else Color(0.05, 0.06, 0.09, 0.9))
		if fitted:
			_canvas.draw_rect(Rect2(row.position, Vector2(4.0, row.size.y)), def.get("tint", Color.WHITE))
		if hot:
			_canvas.draw_rect(row, Color(0.35, 0.85, 1.0, 0.8), false, 1.5)

		_canvas.draw_string(font, row.position + Vector2(16.0, 22.0), def.get("display_name", module_id),
			HORIZONTAL_ALIGNMENT_LEFT, -1, 16,
			def.get("tint", Color.WHITE) if fitted else Color(1, 1, 1, 0.8))
		_canvas.draw_string(font, row.position + Vector2(16.0, 41.0), def.get("blurb", ""),
			HORIZONTAL_ALIGNMENT_LEFT, 322, 11, Color(1, 1, 1, 0.45))
		if fitted:
			_canvas.draw_string(font, row.position + Vector2(344.0, 22.0), "FITTED",
				HORIZONTAL_ALIGNMENT_LEFT, -1, 11, Color(0.4, 0.95, 0.6))

		# Every modifier, spelled out and inside the row. A module whose
		# effect you have to infer is a module nobody fits on purpose.
		var y := 22.0
		for stat in def.get("modifiers", {}):
			var value: float = float(def["modifiers"][stat])
			_canvas.draw_string(font, row.position + Vector2(408.0, y),
				"%s %s" % [_stat_label(stat), _delta_label(stat, value)],
				HORIZONTAL_ALIGNMENT_LEFT, -1, 12, _delta_colour(stat, value))
			y += 17.0

	_draw_loadout_summary(font, rect, role_id)

## The net result of everything fitted, so the trade-offs are visible as a
## total rather than as a pile of individual lines.
func _draw_loadout_summary(font: Font, rect: Rect2, role_id: String) -> void:
	var at := rect.position + Vector2(SUMMARY_X, 100.0)
	_canvas.draw_string(font, at, "NET EFFECT", HORIZONTAL_ALIGNMENT_LEFT, -1, 12, Color(1, 1, 1, 0.55))
	var stats: Array = Loadout.touched_stats(role_id)
	if stats.is_empty():
		_canvas.draw_string(font, at + Vector2(0.0, 22.0), "Nothing fitted.",
			HORIZONTAL_ALIGNMENT_LEFT, -1, 13, Color(1, 1, 1, 0.4))
		return
	var y := 22.0
	for stat in stats:
		var value := Loadout.combined_stat(role_id, stat)
		_canvas.draw_string(font, at + Vector2(0.0, y), _stat_label(stat),
			HORIZONTAL_ALIGNMENT_LEFT, -1, 13, Color(1, 1, 1, 0.7))
		_canvas.draw_string(font, at + Vector2(200.0, y), _delta_label(stat, value),
			HORIZONTAL_ALIGNMENT_LEFT, -1, 13, _delta_colour(stat, value))
		y += 20.0

func _draw_roster(font: Font, rect: Rect2) -> void:
	_draw_title(font, rect, "ROSTER", "One of each seat. Bots fill whatever nobody takes.")
	var origin := _rows_origin()
	var taken := {}
	for peer_id in Net.roster:
		if peer_id != Net.local_id():
			taken[Net.roster[peer_id]["role"]] = Net.roster[peer_id]["name"]
	for i in Content.ROLE_ORDER.size():
		var role_id: String = Content.ROLE_ORDER[i]
		var def: Dictionary = Content.role(role_id)
		var row := Rect2(origin + Vector2(0.0, float(i) * ROW_HEIGHT), Vector2(ROW_WIDTH, ROW_HEIGHT - 6.0))
		var mine := _role() == role_id
		var hot := i == _hover
		_canvas.draw_rect(row, Color(0.09, 0.12, 0.17, 0.95) if hot else Color(0.05, 0.06, 0.09, 0.9))
		if hot:
			_canvas.draw_rect(row, Color(0.35, 0.85, 1.0, 0.8), false, 1.5)
		_canvas.draw_string(font, row.position + Vector2(16.0, 22.0), def.get("display_name", role_id),
			HORIZONTAL_ALIGNMENT_LEFT, -1, 16, Color(1, 1, 1, 0.9))
		_canvas.draw_string(font, row.position + Vector2(16.0, 41.0),
			"%d HP · %s" % [roundi(def.get("max_health", 0.0)), def.get("energy_name", "")],
			HORIZONTAL_ALIGNMENT_LEFT, -1, 11, Color(1, 1, 1, 0.45))
		var note := "YOURS" if mine else ("taken by %s" % taken[role_id] if taken.has(role_id) else "free")
		_canvas.draw_string(font, row.position + Vector2(row.size.x - 150.0, 30.0), note,
			HORIZONTAL_ALIGNMENT_LEFT, -1, 12,
			Color(0.4, 0.95, 0.6) if mine else Color(1, 1, 1, 0.35))

func _draw_mission(font: Font, rect: Rect2) -> void:
	_draw_title(font, rect, "MISSION TABLE", "Pick a floor. The squad deploys together.")
	var origin := _rows_origin()
	for i in Content.FLOORS.size():
		var floor_def: Dictionary = Content.FLOORS[i]
		var row := Rect2(origin + Vector2(0.0, float(i) * (ROW_HEIGHT + 30.0)), Vector2(900.0, ROW_HEIGHT + 22.0))
		var hot := i == _hover
		_canvas.draw_rect(row, Color(0.10, 0.09, 0.06, 0.95) if hot else Color(0.05, 0.06, 0.09, 0.9))
		_canvas.draw_rect(Rect2(row.position, Vector2(4.0, row.size.y)), Color(1.0, 0.72, 0.25))
		if hot:
			_canvas.draw_rect(row, Color(1.0, 0.78, 0.3, 0.85), false, 1.5)

		_canvas.draw_string(font, row.position + Vector2(18.0, 28.0), floor_def.get("name", "Sector"),
			HORIZONTAL_ALIGNMENT_LEFT, -1, 22, Color(1, 1, 1, 0.95))
		var boss: Dictionary = Content.boss(floor_def.get("boss", ""))
		var mobs := 0
		for pack in floor_def.get("packs", []):
			mobs += pack["types"].size()
		_canvas.draw_string(font, row.position + Vector2(18.0, 52.0),
			"%d hostiles · %d packs · security override · %s" % [
				mobs, floor_def.get("packs", []).size(),
				"%s, %s" % [boss.get("display_name", "?"), boss.get("title", "")],
			],
			HORIZONTAL_ALIGNMENT_LEFT, -1, 12, Color(1, 1, 1, 0.5))
		_canvas.draw_string(font, row.position + Vector2(row.size.x - 110.0, 44.0), "DEPLOY",
			HORIZONTAL_ALIGNMENT_LEFT, -1, 18,
			Color(1.0, 0.78, 0.3) if hot else Color(1, 1, 1, 0.35))

	# Say plainly that the ascent is one floor deep so far, rather than
	# leaving an empty board that reads as something failing to load.
	var after := origin + Vector2(0.0, float(Content.FLOORS.size()) * (ROW_HEIGHT + 30.0) + 12.0)
	_canvas.draw_string(font, after,
		"Sectors above this one are not built yet — the ascent loop takes the next entry the moment there is one.",
		HORIZONTAL_ALIGNMENT_LEFT, -1, 12, Color(1, 1, 1, 0.3))

# ----------------------------------------------------------------- labels

const STAT_LABELS := {
	"armor": "Plating",
	"move_speed": "Movement",
	"attack_speed": "Attack speed",
	"damage_dealt": "Damage dealt",
	"damage_taken": "Damage taken",
	"healing_done": "Healing done",
	"healing_taken": "Healing taken",
	"energy_regen": "Energy regen",
}

## Some stats are better low. "Damage taken -12%" has to read as a gain,
## so the sign is phrased rather than printed raw.
const LOWER_IS_BETTER := ["damage_taken"]

func _stat_label(stat: String) -> String:
	return STAT_LABELS.get(stat, stat)

func _delta_label(_stat: String, value: float) -> String:
	var pct := (value - 1.0) * 100.0
	return "%+.0f%%" % pct

func _delta_colour(stat: String, value: float) -> Color:
	var good := value > 1.0
	if LOWER_IS_BETTER.has(stat):
		good = value < 1.0
	if is_equal_approx(value, 1.0):
		return Color(1, 1, 1, 0.5)
	return Color(0.4, 0.95, 0.6) if good else Color(1.0, 0.55, 0.4)

func _now() -> float:
	return float(Time.get_ticks_msec()) / 1000.0
