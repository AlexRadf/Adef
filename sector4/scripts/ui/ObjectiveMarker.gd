extends Control
class_name ObjectiveMarker
## Points at whatever the floor currently wants from you.
##
## Knowing the objective is not the same as knowing where it is. "Clear the
## sector" with a patrol drone wandering two rooms away, or "hold the
## terminal" with no idea which glowing thing that is, reads as the game
## being broken rather than as a task. So the objective gets a diamond in
## the world, an arrow at the screen edge when it is behind you, and a
## distance either way.

const EDGE_MARGIN := 64.0

var _director: FloorDirector = null

func _ready() -> void:
	mouse_filter = Control.MOUSE_FILTER_IGNORE
	set_anchors_preset(Control.PRESET_FULL_RECT)

func _process(_delta: float) -> void:
	if _director == null or not is_instance_valid(_director):
		_director = get_tree().get_first_node_in_group("director") as FloorDirector
	queue_redraw()

func _draw() -> void:
	if _director == null or not is_instance_valid(_director):
		return
	var camera := get_viewport().get_camera_3d()
	if camera == null:
		return
	var target := _objective_target()
	if target == null:
		return
	var local := PlayerCharacter.local(get_tree())
	if local == null or local.is_dead:
		return

	var point: Vector3 = target.global_position + Vector3(0.0, 2.6, 0.0)
	var distance := local.global_position.distance_to(target.global_position)
	var font := ThemeDB.fallback_font
	var colour := _objective_colour()

	if camera.is_position_behind(point):
		_draw_edge_arrow(font, camera, point, distance, colour)
		return
	var at := camera.unproject_position(point)
	if not Rect2(Vector2.ZERO, size).grow(-EDGE_MARGIN * 0.5).has_point(at):
		_draw_edge_arrow(font, camera, point, distance, colour)
		return
	_draw_diamond(at, colour)
	_draw_distance(font, at + Vector2(0.0, 26.0), distance, colour)

## A diamond rather than a dot: it reads as a marker at a glance and does
## not get confused with a nameplate or a hit marker.
func _draw_diamond(at: Vector2, colour: Color) -> void:
	var pulse := 1.0 + 0.12 * sin(float(Time.get_ticks_msec()) / 240.0)
	var r := 11.0 * pulse
	draw_colored_polygon(PackedVector2Array([
		at + Vector2(0, -r), at + Vector2(r, 0), at + Vector2(0, r), at + Vector2(-r, 0),
	]), Color(colour, 0.22))
	var inner := r * 0.55
	draw_colored_polygon(PackedVector2Array([
		at + Vector2(0, -inner), at + Vector2(inner, 0), at + Vector2(0, inner), at + Vector2(-inner, 0),
	]), colour)

## Off screen: clamp to the border and point. Without this the objective
## simply vanishes the moment you turn around.
func _draw_edge_arrow(font: Font, camera: Camera3D, point: Vector3, distance: float, colour: Color) -> void:
	var centre := size * 0.5
	var at := camera.unproject_position(point)
	if camera.is_position_behind(point):
		at = centre - (at - centre)
	var offset := at - centre
	if offset.is_zero_approx():
		return
	var bounds := size * 0.5 - Vector2(EDGE_MARGIN, EDGE_MARGIN)
	var scale_x: float = bounds.x / maxf(0.001, absf(offset.x))
	var scale_y: float = bounds.y / maxf(0.001, absf(offset.y))
	var edge := centre + offset * minf(scale_x, scale_y)

	var direction := offset.normalized()
	var across := Vector2(-direction.y, direction.x)
	draw_colored_polygon(PackedVector2Array([
		edge + direction * 14.0, edge - direction * 6.0 + across * 10.0,
		edge - direction * 6.0 - across * 10.0,
	]), colour)
	_draw_distance(font, edge + direction * -24.0, distance, colour)

func _draw_distance(font: Font, at: Vector2, distance: float, colour: Color) -> void:
	var text := "%dm" % roundi(distance)
	var width := font.get_string_size(text, HORIZONTAL_ALIGNMENT_LEFT, -1, 12).x
	draw_rect(Rect2(at + Vector2(-width * 0.5 - 5.0, -12.0), Vector2(width + 10.0, 16.0)),
		Color(0, 0, 0, 0.5))
	draw_string(font, at + Vector2(-width * 0.5, 0.0), text,
		HORIZONTAL_ALIGNMENT_LEFT, -1, 12, Color(colour, 0.95))

func _objective_colour() -> Color:
	match _director.phase:
		FloorDirector.Phase.SECURITY_OVERRIDE: return Color(1.0, 0.75, 0.2)
		FloorDirector.Phase.BOSS: return Color(1.0, 0.35, 0.3)
	return Color(0.45, 0.9, 1.0)

## What to point at, phase by phase. During the clear it is the nearest
## live hostile, because "10 remaining" with no direction is the exact
## state that makes a floor feel stuck.
func _objective_target() -> Node3D:
	match _director.phase:
		FloorDirector.Phase.TRASH:
			return _nearest_live("trash")
		FloorDirector.Phase.SECURITY_OVERRIDE:
			var terminal := get_tree().get_first_node_in_group("terminals")
			return terminal as Node3D if terminal is Node3D else null
		FloorDirector.Phase.BOSS:
			var boss := _director.boss
			return boss if boss != null and is_instance_valid(boss) and not boss.is_dead else null
	return null

func _nearest_live(group: String) -> Node3D:
	var local := PlayerCharacter.local(get_tree())
	if local == null:
		return null
	var best: Node3D = null
	var nearest := INF
	for unit in get_tree().get_nodes_in_group(group):
		if unit.get("is_dead") == true or not (unit is Node3D):
			continue
		var d: float = local.global_position.distance_to((unit as Node3D).global_position)
		if d < nearest:
			nearest = d
			best = unit as Node3D
	return best
