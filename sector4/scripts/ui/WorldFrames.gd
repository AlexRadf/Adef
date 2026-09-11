extends Control
class_name WorldFrames
## Health bars and status icons projected above people's heads.
##
## `unproject_position` turns a world point into a screen point, so these
## are drawn in 2D but positioned in 3D -- they stay over the right body
## when the camera swings, and they vanish when the body is behind you.

const BAR_SIZE := Vector2(74.0, 7.0)
const ENEMY_BAR_SIZE := Vector2(58.0, 5.0)

func _ready() -> void:
	mouse_filter = Control.MOUSE_FILTER_IGNORE
	set_anchors_preset(Control.PRESET_FULL_RECT)

func _process(_delta: float) -> void:
	queue_redraw()

func _draw() -> void:
	var camera := get_viewport().get_camera_3d()
	if camera == null:
		return
	var soft_target := _soft_target()
	for unit in get_tree().get_nodes_in_group("party"):
		_draw_frame(camera, unit, BAR_SIZE, Color(0.35, 0.92, 0.55), true, unit == soft_target)
	for unit in get_tree().get_nodes_in_group("enemies"):
		# A dormant mob thirty metres away is scenery, and a bare red bar
		# floating over it reads as a glitch rather than as information.
		# Enemies earn a nameplate by being close, awake, or called.
		if not _enemy_is_interesting(unit, camera):
			continue
		# Only the one you are pointing at, the one that was called, and
		# the boss get a name. Six overlapping labels in a trash pull is
		# less readable than none.
		_draw_frame(camera, unit, ENEMY_BAR_SIZE, Color(0.95, 0.35, 0.30),
			_enemy_deserves_name(unit), unit == soft_target)

func _draw_frame(camera: Camera3D, unit: Node, bar: Vector2, colour: Color,
		show_name: bool, is_soft_target: bool) -> void:
	if not (unit is Node3D) or unit.get("is_dead") == true:
		return
	var body := unit as Node3D
	var head := body.global_position + Vector3(0.0, 2.35, 0.0)
	# Behind the camera projects to a nonsense point, so cull it first.
	if camera.is_position_behind(head):
		return
	var distance := camera.global_position.distance_to(head)
	if distance > 60.0:
		return
	var at := camera.unproject_position(head)
	var fade := clampf(1.0 - (distance - 45.0) / 25.0, 0.25, 1.0)

	var health = unit.get("health_component")
	var fraction: float = health.get_health_percent() if health is HealthComponent else 1.0

	var rect := Rect2(at - bar * 0.5, bar)
	draw_rect(rect, Color(0, 0, 0, 0.55 * fade))
	draw_rect(Rect2(rect.position, Vector2(bar.x * fraction, bar.y)), Color(colour, fade))
	if is_soft_target:
		draw_rect(rect.grow(2.0), Color(1, 1, 1, 0.9 * fade), false, 1.5)

	var font := ThemeDB.fallback_font
	if show_name:
		var label := str(unit.get("display_name"))
		var width := font.get_string_size(label, HORIZONTAL_ALIGNMENT_LEFT, -1, 12).x
		var text_at := at + Vector2(-width * 0.5, -bar.y - 6.0)
		draw_rect(Rect2(text_at + Vector2(-4.0, -11.0), Vector2(width + 8.0, 15.0)),
			Color(0, 0, 0, 0.55 * fade))
		draw_string(font, text_at, label, HORIZONTAL_ALIGNMENT_LEFT, -1, 12,
			Color(1, 1, 1, 0.92 * fade))

	_draw_status_pips(unit, at + Vector2(0.0, bar.y * 0.5 + 12.0), fade)
	if _is_marked(unit):
		# Well above the nameplate. A raid marker is a call across the
		# room, so it has to clear the head and everything attached to it.
		_draw_focus_marker(at + Vector2(0.0, -bar.y - 38.0), fade)

func _is_marked(unit: Node) -> bool:
	var status = unit.get("status_component")
	return status is StatusEffectComponent and status.has(FocusMarker.STATUS)

## A downward chevron, bobbing, in the marker's red. Drawn as geometry
## rather than a glyph so it stays the same size and shape at any distance.
func _draw_focus_marker(at: Vector2, fade: float) -> void:
	var bob := sin(float(Time.get_ticks_msec()) / 220.0) * 3.0
	var tip := at + Vector2(0.0, bob)
	var w := 9.0
	var h := 13.0
	var colour := Color(1.0, 0.22, 0.22, 0.95 * fade)
	draw_colored_polygon(PackedVector2Array([
		tip, tip + Vector2(-w, -h), tip + Vector2(w, -h),
	]), colour)
	draw_colored_polygon(PackedVector2Array([
		tip + Vector2(0.0, -4.0), tip + Vector2(-w * 0.45, -h - 5.0), tip + Vector2(w * 0.45, -h - 5.0),
	]), Color(0, 0, 0, 0.45 * fade))

## One coloured pip per active effect. The Focus Marker is drawn separately
## and much higher, because it is a call rather than a condition.
func _draw_status_pips(unit: Node, at: Vector2, fade: float) -> void:
	var status = unit.get("status_component")
	if not (status is StatusEffectComponent):
		return
	var ids: Array = status.active_ids()
	if ids.is_empty():
		return
	var x := at.x - float(ids.size()) * 5.0
	for status_id in ids:
		if status_id == FocusMarker.STATUS:
			continue
		var def: Dictionary = Content.status(status_id)
		var colour: Color = def.get("alert_color", Color(1, 1, 1))
		colour.a = fade
		draw_rect(Rect2(Vector2(x, at.y), Vector2(7.0, 4.0)), colour)
		x += 10.0

## Close enough to matter, awake, or wearing the Focus Marker.
func _enemy_is_interesting(unit: Node, camera: Camera3D) -> bool:
	if not (unit is Node3D):
		return false
	var status = unit.get("status_component")
	if status is StatusEffectComponent and status.has(FocusMarker.STATUS):
		return true
	if unit.has_method("is_awake") and unit.is_awake():
		return true
	if unit.is_in_group("boss"):
		return true
	return camera.global_position.distance_to((unit as Node3D).global_position) < 26.0

func _enemy_deserves_name(unit: Node) -> bool:
	if unit.is_in_group("boss"):
		return true
	var status = unit.get("status_component")
	if status is StatusEffectComponent and status.has(FocusMarker.STATUS):
		return true
	return unit == _enemy_soft_target()

func _enemy_soft_target() -> Node:
	for player in get_tree().get_nodes_in_group("players"):
		if player.get("is_local") != true:
			continue
		var targeting = player.get("enemy_targeting")
		if targeting is SoftLockTargeting:
			return targeting.current_target
	return null

func _soft_target() -> Node:
	for player in get_tree().get_nodes_in_group("players"):
		if player.get("is_local") != true:
			continue
		var targeting = player.get("ally_targeting")
		if targeting is SoftLockTargeting:
			return targeting.current_target
	return null
