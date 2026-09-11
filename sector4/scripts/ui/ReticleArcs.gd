extends Control
class_name ReticleArcs
## The Arena Reticle from section 5.
##
## Everything the player needs mid-fight is drawn touching the crosshair,
## because that is where their eyes already are. Nano-Energy curves down
## the left of the reticle, the soft-locked target's health curves down the
## right, and active debuffs flash beside it. Nothing that matters lives in
## a corner of the screen.

const RADIUS := 46.0
const THICKNESS := 6.0
const GAP_DEGREES := 26.0

const COLOR_ENERGY := Color(0.30, 0.80, 1.00)
const COLOR_ENERGY_BG := Color(0.30, 0.80, 1.00, 0.16)
const COLOR_HEALTH := Color(0.35, 0.92, 0.55)
const COLOR_HEALTH_LOW := Color(1.00, 0.35, 0.30)
const COLOR_HEALTH_BG := Color(1.0, 1.0, 1.0, 0.14)
const COLOR_CROSS := Color(1, 1, 1, 0.85)

var energy_fraction: float = 1.0
var target_fraction: float = 0.0
var has_target: bool = false
var target_name: String = ""
var statuses: Array = []

var _flash: float = 0.0

func _ready() -> void:
	mouse_filter = Control.MOUSE_FILTER_IGNORE
	set_anchors_preset(Control.PRESET_FULL_RECT)
	GameEvents.energy_changed.connect(_on_energy)
	GameEvents.soft_target_changed.connect(_on_soft_target)

func _process(delta: float) -> void:
	_flash = fmod(_flash + delta * 3.0, TAU)
	_refresh_target()
	queue_redraw()

func _on_energy(current: float, maximum: float) -> void:
	energy_fraction = 0.0 if maximum <= 0.0 else clampf(current / maximum, 0.0, 1.0)

var _target: Node = null

func _on_soft_target(target: Node) -> void:
	_target = target
	has_target = target != null and is_instance_valid(target)
	target_name = str(target.get("display_name")) if has_target else ""

func _refresh_target() -> void:
	if _target == null or not is_instance_valid(_target):
		has_target = false
		target_fraction = 0.0
		return
	var health = _target.get("health_component")
	if health is HealthComponent:
		target_fraction = health.get_health_percent()

func _draw() -> void:
	var local := _local_player()
	if local != null and local.get("is_dead") == true:
		return
	var centre := size * 0.5
	_draw_crosshair(centre)
	# Left: Nano-Energy. Right: the soft-locked target's health. Both are
	# arcs rather than bars so they wrap the crosshair instead of competing
	# with it.
	_draw_arc_meter(centre, 180.0 - GAP_DEGREES, 180.0 + GAP_DEGREES, energy_fraction, COLOR_ENERGY, COLOR_ENERGY_BG, false)
	if has_target:
		var colour := COLOR_HEALTH_LOW if target_fraction < 0.4 else COLOR_HEALTH
		_draw_arc_meter(centre, -GAP_DEGREES, GAP_DEGREES, target_fraction, colour, COLOR_HEALTH_BG, true)
		_draw_target_label(centre)
	_draw_status_alerts(centre)

func _draw_crosshair(centre: Vector2) -> void:
	var inner := 5.0
	var outer := 13.0
	for direction in [Vector2.LEFT, Vector2.RIGHT, Vector2.UP, Vector2.DOWN]:
		draw_line(centre + direction * inner, centre + direction * outer, COLOR_CROSS, 2.0)
	draw_circle(centre, 1.6, COLOR_CROSS)

## Arcs fill from the middle of their span outwards in both directions, so
## a full bar closes a clean bracket around the crosshair and a low one
## reads instantly as "short".
func _draw_arc_meter(centre: Vector2, from_deg: float, to_deg: float, fraction: float,
		fill: Color, background: Color, mirrored: bool) -> void:
	var span := to_deg - from_deg
	var mid := from_deg + span * 0.5
	draw_arc(centre, RADIUS, deg_to_rad(from_deg), deg_to_rad(to_deg), 48, background, THICKNESS, true)
	if fraction <= 0.0:
		return
	var half := span * 0.5 * clampf(fraction, 0.0, 1.0)
	var start := mid - half
	var end := mid + half
	if mirrored:
		# The right arc grows downward from the top so the two meters
		# mirror one another rather than both sweeping the same way.
		start = mid - half
		end = mid + half
	draw_arc(centre, RADIUS, deg_to_rad(start), deg_to_rad(end), 48, fill, THICKNESS, true)

func _draw_target_label(centre: Vector2) -> void:
	var font := ThemeDB.fallback_font
	var pct := "%d%%" % roundi(target_fraction * 100.0)
	draw_string(font, centre + Vector2(RADIUS + 14.0, 5.0), pct,
		HORIZONTAL_ALIGNMENT_LEFT, -1, 15, COLOR_HEALTH if target_fraction >= 0.4 else COLOR_HEALTH_LOW)
	if target_name != "":
		draw_string(font, centre + Vector2(RADIUS + 14.0, 22.0), target_name,
			HORIZONTAL_ALIGNMENT_LEFT, -1, 12, Color(1, 1, 1, 0.7))

## Debuffs flash beside the crosshair in their own colour. A Neural Glitch
## you have not noticed is 25% of your damage gone, so it is not allowed to
## be subtle.
func _draw_status_alerts(centre: Vector2) -> void:
	var local := _local_player()
	if local == null:
		return
	var status = local.get("status_component")
	if not (status is StatusEffectComponent):
		return
	var harmful: Array = status.harmful_ids()
	if harmful.is_empty():
		return
	var font := ThemeDB.fallback_font
	var pulse := 0.55 + 0.45 * absf(sin(_flash))
	var y := centre.y - 74.0
	for status_id in harmful:
		var def: Dictionary = Content.status(status_id)
		var colour: Color = def.get("alert_color", Color(1, 0.5, 0.2))
		colour.a = pulse
		var label: String = def.get("display_name", status_id)
		var width := font.get_string_size(label, HORIZONTAL_ALIGNMENT_LEFT, -1, 14).x
		draw_rect(Rect2(centre.x - width * 0.5 - 8.0, y - 15.0, width + 16.0, 21.0), Color(0, 0, 0, 0.45 * pulse))
		draw_string(font, Vector2(centre.x - width * 0.5, y), label,
			HORIZONTAL_ALIGNMENT_LEFT, -1, 14, colour)
		y -= 26.0

func _local_player() -> Node:
	for player in get_tree().get_nodes_in_group("players"):
		if player.get("is_local") == true:
			return player
	return null
