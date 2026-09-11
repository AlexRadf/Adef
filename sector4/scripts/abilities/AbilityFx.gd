extends Node3D
class_name AbilityFx
## The visible half of the kit.
##
## Everything here is drawn from events the server already emits, so an
## effect can never show a shot that did not happen. It is all immediate
## geometry -- lines, quads, expanding rings -- because primitives that
## read clearly beat assets that do not exist.
##
## One autoload-ish node per floor, parented under the spawn root.

const TRACER_SECONDS := 0.16
const RING_SECONDS := 0.42

static var instance: AbilityFx = null

class Tracer:
	var from: Vector3
	var to: Vector3
	var colour: Color
	var born: float
	var width: float

class Ring:
	var at: Vector3
	var colour: Color
	var born: float
	var radius: float

## unit -> {"target": Node3D, "colour": Color, "until": float}
var _beams: Dictionary = {}
var _tracers: Array[Tracer] = []
var _rings: Array[Ring] = []

@onready var _draw: MeshInstance3D = $Draw
var _mesh: ImmediateMesh = null

func _ready() -> void:
	instance = self
	_mesh = ImmediateMesh.new()
	_draw.mesh = _mesh
	var material := StandardMaterial3D.new()
	material.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	material.vertex_color_use_as_albedo = true
	material.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
	material.blend_mode = BaseMaterial3D.BLEND_MODE_ADD
	material.cull_mode = BaseMaterial3D.CULL_DISABLED
	material.no_depth_test = false
	_draw.material_override = material
	# Effects are drawn in world space; the node itself never moves.
	_draw.set_as_top_level(true)
	_draw.global_position = Vector3.ZERO

# ------------------------------------------------------------------ api

static func tracer(from: Vector3, to: Vector3, colour: Color, width: float = 0.05) -> void:
	if instance == null:
		return
	var line := Tracer.new()
	line.from = from
	line.to = to
	line.colour = colour
	line.width = width
	line.born = instance._now()
	instance._tracers.append(line)

static func impact(at: Vector3, colour: Color, radius: float = 0.9) -> void:
	if instance == null:
		return
	var ring := Ring.new()
	ring.at = at
	ring.colour = colour
	ring.radius = radius
	ring.born = instance._now()
	instance._rings.append(ring)

## A beam that persists while it is being re-asserted. The healer's channel
## re-states it every tick, so it lives exactly as long as the channel.
static func beam(source: Node3D, target: Node3D, colour: Color, hold: float = 0.25) -> void:
	if instance == null or source == null or target == null:
		return
	instance._beams[source] = {"target": target, "colour": colour, "until": instance._now() + hold}

func _process(_delta: float) -> void:
	var now := _now()
	while not _tracers.is_empty() and now - _tracers[0].born > TRACER_SECONDS:
		_tracers.remove_at(0)
	while not _rings.is_empty() and now - _rings[0].born > RING_SECONDS:
		_rings.remove_at(0)
	for source in _beams.keys():
		if not is_instance_valid(source) or now > _beams[source]["until"]:
			_beams.erase(source)
	_rebuild()

# -------------------------------------------------------------- drawing

func _rebuild() -> void:
	_mesh.clear_surfaces()
	if _tracers.is_empty() and _rings.is_empty() and _beams.is_empty():
		return
	var camera := get_viewport().get_camera_3d()
	var eye := camera.global_position if camera != null else Vector3.UP
	_mesh.surface_begin(Mesh.PRIMITIVE_TRIANGLES)

	var now := _now()
	for line in _tracers:
		var fade := 1.0 - (now - line.born) / TRACER_SECONDS
		_quad(line.from, line.to, line.width, Color(line.colour, line.colour.a * fade), eye)

	for source in _beams:
		var entry: Dictionary = _beams[source]
		var target: Node3D = entry["target"]
		if not is_instance_valid(target):
			continue
		# A beam pulses along its length so it reads as flowing rather than
		# as a static stick between two capsules.
		var from: Vector3 = (source as Node3D).global_position + Vector3(0, 1.2, 0)
		var to: Vector3 = target.global_position + Vector3(0, 1.2, 0)
		var wobble := 0.045 + 0.02 * sin(now * 18.0)
		_quad(from, to, wobble, entry["colour"], eye)

	for ring in _rings:
		var age := (now - ring.born) / RING_SECONDS
		_ring(ring.at, ring.radius * (0.35 + age), Color(ring.colour, ring.colour.a * (1.0 - age)), eye)

	_mesh.surface_end()

## A camera-facing quad along a segment: the cheapest thing that reads as a
## beam from any angle.
func _quad(from: Vector3, to: Vector3, width: float, colour: Color, eye: Vector3) -> void:
	var along := to - from
	if along.length_squared() < 0.0001:
		return
	var side := along.normalized().cross((from - eye).normalized())
	if side.length_squared() < 0.0001:
		side = Vector3.UP
	side = side.normalized() * width

	_tri(from - side, from + side, to + side, colour)
	_tri(from - side, to + side, to - side, colour)

func _ring(at: Vector3, radius: float, colour: Color, eye: Vector3) -> void:
	var normal := (eye - at).normalized()
	var basis_x := normal.cross(Vector3.UP)
	if basis_x.length_squared() < 0.0001:
		basis_x = Vector3.RIGHT
	basis_x = basis_x.normalized()
	var basis_y := normal.cross(basis_x).normalized()
	var steps := 18
	var thickness := radius * 0.16
	for i in steps:
		var a0 := TAU * float(i) / float(steps)
		var a1 := TAU * float(i + 1) / float(steps)
		var outer0 := at + (basis_x * cos(a0) + basis_y * sin(a0)) * radius
		var outer1 := at + (basis_x * cos(a1) + basis_y * sin(a1)) * radius
		var inner0 := at + (basis_x * cos(a0) + basis_y * sin(a0)) * (radius - thickness)
		var inner1 := at + (basis_x * cos(a1) + basis_y * sin(a1)) * (radius - thickness)
		_tri(inner0, outer0, outer1, colour)
		_tri(inner0, outer1, inner1, colour)

func _tri(a: Vector3, b: Vector3, c: Vector3, colour: Color) -> void:
	_mesh.surface_set_color(colour)
	_mesh.surface_add_vertex(a)
	_mesh.surface_set_color(colour)
	_mesh.surface_add_vertex(b)
	_mesh.surface_set_color(colour)
	_mesh.surface_add_vertex(c)

func _now() -> float:
	return float(Time.get_ticks_msec()) / 1000.0
