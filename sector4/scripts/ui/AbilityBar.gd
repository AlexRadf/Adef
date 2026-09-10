extends Control
class_name AbilityBar
## Your kit, on screen.
##
## Four to six buttons is a small enough kit to memorise, but only after
## you have been told what they are once. Each slot shows its button, its
## name, whether it is ready, and what it costs -- so a new player can read
## their role off the bottom of the screen instead of off the design doc.

const SLOT := Vector2(96.0, 58.0)
const GAP := 8.0

var _player: PlayerCharacter = null
var _slots: Array = []

func _ready() -> void:
	mouse_filter = Control.MOUSE_FILTER_IGNORE
	set_anchors_preset(Control.PRESET_FULL_RECT)

func _process(_delta: float) -> void:
	if _player == null or not is_instance_valid(_player):
		_player = PlayerCharacter.local(get_tree())
		_slots = _build_slots()
	queue_redraw()

## The role's bindings, in the reading order from Content rather than
## whatever order the dictionary happens to iterate in.
func _build_slots() -> Array:
	if _player == null:
		return []
	var bindings: Dictionary = Content.bindings_for_role(_player.role_id)
	var out: Array = []
	for action in Content.ABILITY_BAR_ORDER:
		if bindings.has(action):
			out.append({"action": action, "ability": bindings[action]})
	for action in bindings:
		if not Content.ABILITY_BAR_ORDER.has(action):
			out.append({"action": action, "ability": bindings[action]})
	return out

func _draw() -> void:
	if _player == null or not is_instance_valid(_player) or _slots.is_empty():
		return
	var font := ThemeDB.fallback_font
	var total := float(_slots.size()) * SLOT.x + float(_slots.size() - 1) * GAP
	var origin := Vector2((size.x - total) * 0.5, size.y - SLOT.y - 22.0)

	for i in _slots.size():
		var slot: Dictionary = _slots[i]
		_draw_slot(font, origin + Vector2(float(i) * (SLOT.x + GAP), 0.0), slot)

func _draw_slot(font: Font, at: Vector2, slot: Dictionary) -> void:
	var ability_id: String = slot["ability"]
	var def: Dictionary = Content.ability(ability_id)
	var abilities := _player.ability_component
	var rect := Rect2(at, SLOT)

	var ready := abilities == null or abilities.can_use(ability_id)
	var cooling: float = abilities.cooldown_fraction(ability_id) if abilities != null else 0.0
	var affordable := abilities == null or abilities.has_energy(float(def.get("cost", 0.0)))

	draw_rect(rect, Color(0.03, 0.04, 0.06, 0.82))
	# The cooldown eats the slot from the bottom, so "how long left" is a
	# height rather than a number to read.
	if cooling > 0.0:
		draw_rect(Rect2(rect.position + Vector2(0.0, rect.size.y * (1.0 - cooling)),
			Vector2(rect.size.x, rect.size.y * cooling)), Color(0.55, 0.62, 0.85, 0.30))
	var edge := Color(0.35, 0.85, 1.0, 0.9) if ready else Color(0.5, 0.5, 0.55, 0.55)
	if not affordable and cooling <= 0.0:
		edge = Color(1.0, 0.55, 0.2, 0.8)
	draw_rect(rect, edge, false, 1.5)

	# Button prompt: pad above, keyboard below, because both are bound.
	var pad: String = Content.INPUT_LABELS.get(slot["action"], "")
	draw_string(font, at + Vector2(7.0, 16.0), pad, HORIZONTAL_ALIGNMENT_LEFT, -1, 13,
		Color(1.0, 0.85, 0.3, 0.95))
	var key: String = Content.INPUT_KEYS.get(slot["action"], "")
	draw_string(font, at + Vector2(SLOT.x - 7.0 - font.get_string_size(key, HORIZONTAL_ALIGNMENT_LEFT, -1, 11).x, 16.0),
		key, HORIZONTAL_ALIGNMENT_LEFT, -1, 11, Color(1, 1, 1, 0.4))

	var label: String = def.get("display_name", ability_id)
	var text_colour := Color(1, 1, 1, 0.92) if ready else Color(1, 1, 1, 0.45)
	_draw_wrapped(font, at + Vector2(7.0, 33.0), label, SLOT.x - 12.0, text_colour)

	var cost: float = float(def.get("cost", def.get("cost_per_second", 0.0)))
	if cost > 0.0:
		draw_string(font, at + Vector2(7.0, SLOT.y - 5.0), "%d" % roundi(cost),
			HORIZONTAL_ALIGNMENT_LEFT, -1, 11, Color(0.35, 0.8, 1.0, 0.85))
	if cooling > 0.0 and abilities != null:
		var remaining := abilities.cooldown_remaining(ability_id)
		var stamp := "%.1f" % remaining
		draw_string(font, at + Vector2(SLOT.x - 7.0 - font.get_string_size(stamp, HORIZONTAL_ALIGNMENT_LEFT, -1, 12).x, SLOT.y - 5.0),
			stamp, HORIZONTAL_ALIGNMENT_LEFT, -1, 12, Color(1, 1, 1, 0.75))

## Ability names are two or three words; a slot is one word wide. Wrap on
## spaces rather than letting the name run off the edge.
func _draw_wrapped(font: Font, at: Vector2, text: String, width: float, colour: Color) -> void:
	var words := text.split(" ")
	var line := ""
	var y := 0.0
	for word in words:
		var candidate := word if line == "" else line + " " + word
		if font.get_string_size(candidate, HORIZONTAL_ALIGNMENT_LEFT, -1, 12).x > width and line != "":
			draw_string(font, at + Vector2(0.0, y), line, HORIZONTAL_ALIGNMENT_LEFT, -1, 12, colour)
			y += 13.0
			line = word
		else:
			line = candidate
	if line != "":
		draw_string(font, at + Vector2(0.0, y), line, HORIZONTAL_ALIGNMENT_LEFT, -1, 12, colour)
