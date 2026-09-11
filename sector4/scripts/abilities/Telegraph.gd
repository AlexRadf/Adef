extends Node3D
class_name Telegraph
## The danger, drawn on the floor, while there is still time to leave it.
##
## A 2 second cast the party cannot see is just delayed damage. The shape
## here is the same shape the ability resolves against -- the cone is the
## real 90 degrees, anchored to the boss and following its locked facing --
## so what you dodge is what would have hit you.

enum Shape { CONE, RING }

## Loaded rather than preloaded: this script is the scene's own script, so
## preloading it here would be a cycle.
const SCENE_PATH := "res://scenes/abilities/Telegraph.tscn"

const FILL := Color(1.0, 0.12, 0.10, 0.40)
const EDGE := Color(1.0, 0.55, 0.30, 0.95)
const EDGE_THICKNESS := 0.45

var shape: Shape = Shape.CONE
var radius: float = 14.0
var arc_degrees: float = 90.0
var duration: float = 2.0
var follow: Node3D = null

var _elapsed: float = 0.0
var _mesh: ImmediateMesh = null

@onready var _surface: MeshInstance3D = $Surface

static func cone(parent: Node, source: Node3D, reach: float, arc: float, seconds: float) -> Telegraph:
	var node: Telegraph = (load(SCENE_PATH) as PackedScene).instantiate()
	node.shape = Shape.CONE
	node.radius = reach
	node.arc_degrees = arc
	node.duration = seconds
	node.follow = source
	parent.add_child(node)
	return node

static func ring(parent: Node, source: Node3D, reach: float, seconds: float) -> Telegraph:
	var node: Telegraph = (load(SCENE_PATH) as PackedScene).instantiate()
	node.shape = Shape.RING
	node.radius = reach
	node.duration = seconds
	node.follow = source
	parent.add_child(node)
	return node

func _ready() -> void:
	_mesh = ImmediateMesh.new()
	_surface.mesh = _mesh
	var material := StandardMaterial3D.new()
	material.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	material.vertex_color_use_as_albedo = true
	material.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
	material.cull_mode = BaseMaterial3D.CULL_DISABLED
	# Drawn over the floor rather than fighting it for depth.
	material.no_depth_test = true
	_surface.material_override = material
	_surface.set_as_top_level(true)

func _process(delta: float) -> void:
	_elapsed += delta
	if _elapsed >= duration or follow == null or not is_instance_valid(follow):
		queue_free()
		return
	_rebuild()

## Fills up as the cast runs, so the bar on screen and the shape on the
## floor tell the same story: when it is full, it goes off.
func _rebuild() -> void:
	_mesh.clear_surfaces()
	var progress := clampf(_elapsed / maxf(0.01, duration), 0.0, 1.0)
	var origin: Vector3 = follow.global_position + Vector3(0.0, 0.06, 0.0)
	var facing := -follow.global_transform.basis.z
	facing.y = 0.0
	if facing.is_zero_approx():
		facing = Vector3.FORWARD
	facing = facing.normalized()

	_mesh.surface_begin(Mesh.PRIMITIVE_TRIANGLES)
	match shape:
		Shape.CONE:
			_build_cone(origin, facing, progress)
		Shape.RING:
			_build_ring(origin, progress)
	_mesh.surface_end()

## The outline shows the full extent from the first frame, so you know how
## far to run immediately; the fill sweeps out to meet it as the cast runs,
## so you also know how long you have.
func _build_cone(origin: Vector3, facing: Vector3, progress: float) -> void:
	var half := deg_to_rad(arc_degrees * 0.5)
	var steps := 24
	var base := facing.rotated(Vector3.UP, -half)
	var filled := radius * progress

	for i in steps:
		var a0 := 2.0 * half * float(i) / float(steps)
		var a1 := 2.0 * half * float(i + 1) / float(steps)
		var d0 := base.rotated(Vector3.UP, a0)
		var d1 := base.rotated(Vector3.UP, a1)

		# The wedge itself.
		_tri(origin, origin + d0 * filled, origin + d1 * filled, FILL)
		# The far rim, always at full reach.
		_band(origin + d0 * (radius - EDGE_THICKNESS), origin + d1 * (radius - EDGE_THICKNESS),
			origin + d0 * radius, origin + d1 * radius, EDGE)
		# The leading edge of the fill, so the sweep is readable as motion.
		if filled > EDGE_THICKNESS and filled < radius - EDGE_THICKNESS:
			_band(origin + d0 * (filled - EDGE_THICKNESS), origin + d1 * (filled - EDGE_THICKNESS),
				origin + d0 * filled, origin + d1 * filled, EDGE)

	# The two straight sides, which are what tell you which way to run.
	var right := facing.rotated(Vector3.UP, half)
	_side(origin, base, EDGE)
	_side(origin, right, EDGE)

func _side(origin: Vector3, direction: Vector3, colour: Color) -> void:
	var across := direction.cross(Vector3.UP).normalized() * (EDGE_THICKNESS * 0.5)
	_band(origin - across, origin + across,
		origin + direction * radius - across, origin + direction * radius + across, colour)

func _build_ring(origin: Vector3, progress: float) -> void:
	var steps := 40
	var inner := radius * (1.0 - progress)
	for i in steps:
		var a0 := TAU * float(i) / float(steps)
		var a1 := TAU * float(i + 1) / float(steps)
		var o0 := origin + Vector3(cos(a0), 0.0, sin(a0)) * radius
		var o1 := origin + Vector3(cos(a1), 0.0, sin(a1)) * radius
		var i0 := origin + Vector3(cos(a0), 0.0, sin(a0)) * inner
		var i1 := origin + Vector3(cos(a1), 0.0, sin(a1)) * inner
		_tri(i0, o0, o1, FILL)
		_tri(i0, o1, i1, FILL)

## A quad from two near points to two far points.
func _band(near_a: Vector3, near_b: Vector3, far_a: Vector3, far_b: Vector3, colour: Color) -> void:
	_tri(near_a, far_a, far_b, colour)
	_tri(near_a, far_b, near_b, colour)

func _tri(a: Vector3, b: Vector3, c: Vector3, colour: Color) -> void:
	_mesh.surface_set_color(colour)
	_mesh.surface_add_vertex(a)
	_mesh.surface_set_color(colour)
	_mesh.surface_add_vertex(b)
	_mesh.surface_set_color(colour)
	_mesh.surface_add_vertex(c)
