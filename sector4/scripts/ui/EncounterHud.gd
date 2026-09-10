extends Control
class_name EncounterHud
## The parts of the fight that are not the reticle: the boss cast bar, the
## phase banner, the terminal's unlock, and your own health.
##
## Core Overcharge gets the loudest thing on screen. It is the one cast in
## the fight that kills everybody, and a party that misses it should never
## be able to say they did not see it.

const CAST_BAR := Vector2(420.0, 26.0)

var boss_cast_name: String = ""
var boss_cast_progress: float = 0.0
var boss_cast_interruptible: bool = false
var boss_casting: bool = false

var boss_health: float = 0.0
var boss_max_health: float = 0.0
var boss_enraged: bool = false

var phase_name: String = ""
var _phase_shown_at: float = -99.0
var _pulse: float = 0.0

var local_health: float = 0.0
var local_max_health: float = 0.0

var _cast: CastComponent = null

func _ready() -> void:
	mouse_filter = Control.MOUSE_FILTER_IGNORE
	set_anchors_preset(Control.PRESET_FULL_RECT)
	GameEvents.boss_cast_started.connect(_on_cast_started)
	GameEvents.boss_cast_finished.connect(_on_cast_finished)
	GameEvents.boss_health_changed.connect(_on_boss_health)
	GameEvents.boss_enraged.connect(func() -> void: boss_enraged = true)
	GameEvents.floor_phase_changed.connect(_on_phase)
	GameEvents.local_health_changed.connect(_on_local_health)

func _process(delta: float) -> void:
	_pulse = fmod(_pulse + delta * 5.0, TAU)
	if boss_casting and _cast != null and is_instance_valid(_cast):
		boss_cast_progress = _cast.progress()
	queue_redraw()

func _on_cast_started(ability_id: String, display: String, _duration: float, interruptible: bool) -> void:
	boss_cast_name = display
	boss_cast_interruptible = interruptible
	boss_cast_progress = 0.0
	boss_casting = true
	var boss := get_tree().get_first_node_in_group("boss")
	_cast = boss.get("cast_component") if boss != null else null
	# Core Overcharge is the wipe. It is worth its own emphasis, and the
	# ability id is what says so rather than a magic string in the UI.
	if ability_id == "core_overcharge":
		_phase_shown_at = _now()
		phase_name = "INTERRUPT — CORE OVERCHARGE"

func _on_cast_finished(_ability_id: String, _was_interrupted: bool) -> void:
	boss_casting = false
	_cast = null

func _on_boss_health(current: float, maximum: float) -> void:
	boss_health = current
	boss_max_health = maximum

func _on_local_health(current: float, maximum: float) -> void:
	local_health = current
	local_max_health = maximum

func _on_phase(_phase: int, name_text: String) -> void:
	phase_name = name_text
	_phase_shown_at = _now()

func _draw() -> void:
	var font := ThemeDB.fallback_font
	if boss_max_health > 0.0:
		_draw_boss_health(font)
	if boss_casting:
		_draw_cast_bar(font)
	if _now() - _phase_shown_at < 4.0:
		_draw_banner(font)
	if local_max_health > 0.0:
		_draw_local_health(font)
	_draw_terminal(font)

func _draw_boss_health(font: Font) -> void:
	var width := 620.0
	var rect := Rect2(Vector2((size.x - width) * 0.5, 26.0), Vector2(width, 18.0))
	var fraction := clampf(boss_health / boss_max_health, 0.0, 1.0)
	draw_rect(rect, Color(0, 0, 0, 0.6))
	var colour := Color(1.0, 0.30, 0.25) if boss_enraged else Color(0.85, 0.45, 0.30)
	draw_rect(Rect2(rect.position, Vector2(rect.size.x * fraction, rect.size.y)), colour)
	# The 50% line is where the fight changes, so it is drawn on the bar
	# rather than left for the party to guess at.
	var half_x := rect.position.x + rect.size.x * 0.5
	draw_line(Vector2(half_x, rect.position.y), Vector2(half_x, rect.end.y), Color(1, 1, 1, 0.55), 1.5)
	var label := "UNIT-01 · IRON CENTURION   %d%%" % roundi(fraction * 100.0)
	if boss_enraged:
		label += "   ENRAGED"
	draw_string(font, rect.position + Vector2(6.0, -5.0), label, HORIZONTAL_ALIGNMENT_LEFT, -1, 14, Color(1, 1, 1, 0.9))

func _draw_cast_bar(font: Font) -> void:
	var rect := Rect2(Vector2((size.x - CAST_BAR.x) * 0.5, 78.0), CAST_BAR)
	draw_rect(rect.grow(2.0), Color(0, 0, 0, 0.7))
	var colour := Color(1.0, 0.85, 0.15) if boss_cast_interruptible else Color(0.65, 0.65, 0.72)
	if boss_cast_interruptible:
		colour.a = 0.75 + 0.25 * absf(sin(_pulse))
	draw_rect(Rect2(rect.position, Vector2(rect.size.x * boss_cast_progress, rect.size.y)), colour)
	var label := boss_cast_name
	if boss_cast_interruptible:
		label += "   ← KICK IT"
	draw_string(font, rect.position + Vector2(8.0, 19.0), label, HORIZONTAL_ALIGNMENT_LEFT, -1, 16, Color(0.05, 0.05, 0.05))

func _draw_banner(font: Font) -> void:
	var age := _now() - _phase_shown_at
	var alpha := clampf(1.0 - (age - 3.0), 0.0, 1.0)
	var width := font.get_string_size(phase_name, HORIZONTAL_ALIGNMENT_LEFT, -1, 30).x
	draw_string(font, Vector2((size.x - width) * 0.5, size.y * 0.30), phase_name,
		HORIZONTAL_ALIGNMENT_LEFT, -1, 30, Color(1, 1, 1, alpha))

func _draw_local_health(font: Font) -> void:
	var rect := Rect2(Vector2(38.0, size.y - 62.0), Vector2(260.0, 20.0))
	var fraction := clampf(local_health / local_max_health, 0.0, 1.0)
	draw_rect(rect, Color(0, 0, 0, 0.6))
	draw_rect(Rect2(rect.position, Vector2(rect.size.x * fraction, rect.size.y)),
		Color(0.35, 0.92, 0.55) if fraction > 0.35 else Color(1.0, 0.35, 0.30))
	draw_string(font, rect.position + Vector2(8.0, 15.0), "%d / %d" % [roundi(local_health), roundi(local_max_health)],
		HORIZONTAL_ALIGNMENT_LEFT, -1, 13, Color(0.05, 0.05, 0.05))

func _draw_terminal(font: Font) -> void:
	var terminal := get_tree().get_first_node_in_group("terminals")
	if terminal == null or not (terminal is SecurityTerminal):
		return
	var pane := terminal as SecurityTerminal
	if pane.is_unlocked:
		return
	var rect := Rect2(Vector2(size.x - 300.0, size.y - 62.0), Vector2(240.0, 18.0))
	draw_rect(rect, Color(0, 0, 0, 0.6))
	draw_rect(Rect2(rect.position, Vector2(rect.size.x * pane.fraction(), rect.size.y)), Color(1.0, 0.75, 0.2))
	draw_string(font, rect.position + Vector2(0.0, -6.0), "SECURITY OVERRIDE", HORIZONTAL_ALIGNMENT_LEFT, -1, 13, Color(1, 1, 1, 0.85))

func _now() -> float:
	return float(Time.get_ticks_msec()) / 1000.0
