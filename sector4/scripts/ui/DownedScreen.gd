extends Control
class_name DownedScreen
## What you see when you are on the floor.
##
## Being dead with no explanation is the worst state a game can leave you
## in: you cannot tell a death from a freeze, and you cannot tell whether
## you are waiting for something or whether the run is over. This says
## which, and how many of the squad are still up.

var _down: bool = false
var _standing: int = 0
var _wiped: bool = false
var _wipe_at: float = 0.0
var _pulse: float = 0.0

func _ready() -> void:
	mouse_filter = Control.MOUSE_FILTER_IGNORE
	set_anchors_preset(Control.PRESET_FULL_RECT)
	GameEvents.downed_state_changed.connect(_on_downed)
	GameEvents.party_wiped.connect(_on_wiped)
	GameEvents.party_respawned.connect(_on_respawned)

func _process(delta: float) -> void:
	_pulse = fmod(_pulse + delta * 2.4, TAU)
	if _down or _wiped:
		queue_redraw()

func _on_downed(is_down: bool, allies_standing: int) -> void:
	_down = is_down
	_standing = allies_standing

func _on_wiped() -> void:
	_wiped = true
	_wipe_at = _now()
	queue_redraw()

func _on_respawned() -> void:
	_wiped = false
	_down = false
	queue_redraw()

func _draw() -> void:
	if not _down and not _wiped:
		return
	var font := ThemeDB.fallback_font
	# The screen desaturates towards the middle rather than blacking out,
	# so you can still watch the fight you are waiting on.
	draw_rect(Rect2(Vector2.ZERO, size), Color(0.25, 0.02, 0.03, 0.34))

	if _wiped:
		_draw_wipe(font)
		return
	_draw_down(font)

func _draw_down(font: Font) -> void:
	var centre := size * 0.5
	_centred(font, "YOU ARE DOWN", centre.y - 40.0, 44, Color(1.0, 0.35, 0.30, 0.95))
	var line := "Waiting to respawn"
	if _standing > 0:
		line = "Waiting on the squad — %d still standing" % _standing
	_centred(font, line, centre.y - 4.0, 18, Color(1, 1, 1, 0.75))
	_centred(font, "If the last of them falls, the attempt resets.",
		centre.y + 22.0, 13, Color(1, 1, 1, 0.45))

func _draw_wipe(font: Font) -> void:
	var centre := size * 0.5
	var alpha := 0.6 + 0.4 * absf(sin(_pulse))
	_centred(font, "SQUAD DOWN", centre.y - 40.0, 50, Color(1.0, 0.3, 0.25, alpha))
	_centred(font, "The Centurion resets. Regrouping at the entrance.",
		centre.y - 2.0, 17, Color(1, 1, 1, 0.75))
	var left := maxf(0.0, FloorDirector.WIPE_HOLD - (_now() - _wipe_at))
	_centred(font, "%.0f" % ceilf(left), centre.y + 40.0, 30, Color(1, 1, 1, 0.55))

func _centred(font: Font, text: String, y: float, text_size: int, colour: Color) -> void:
	var width := font.get_string_size(text, HORIZONTAL_ALIGNMENT_LEFT, -1, text_size).x
	draw_string(font, Vector2((size.x - width) * 0.5, y), text,
		HORIZONTAL_ALIGNMENT_LEFT, -1, text_size, colour)

func _now() -> float:
	return float(Time.get_ticks_msec()) / 1000.0
