extends Control
class_name FloatingNumbers
## Damage and healing, drawn where it happened.
##
## Without these there is no feedback loop at all: you press a button, a
## bar somewhere moves a little, and nothing tells you the two were
## related. Your own hits are big and gold, other people's are small and
## grey, damage you take is red and healing is green -- so a glance says
## both "it worked" and "that one was mine".
##
## The numbers come out of the combat events the server emits, so the HUD
## cannot invent a hit that did not happen.

const LIFETIME := 1.05
const RISE := 62.0

class Pop:
	var where: Vector3
	var text: String
	var colour: Color
	var size: int
	var born: float
	var drift: float

var _pops: Array[Pop] = []

func _ready() -> void:
	mouse_filter = Control.MOUSE_FILTER_IGNORE
	set_anchors_preset(Control.PRESET_FULL_RECT)
	GameEvents.damage_dealt.connect(_on_damage)
	GameEvents.healing_done.connect(_on_heal)

func _process(_delta: float) -> void:
	var now := _now()
	# Oldest first, so a single pass from the front is enough.
	while not _pops.is_empty() and now - _pops[0].born > LIFETIME:
		_pops.remove_at(0)
	queue_redraw()

func _on_damage(source_peer: int, target: Node, amount: float, is_crit: bool) -> void:
	if not (target is Node3D) or amount < 1.0:
		return
	var local := PlayerCharacter.local(get_tree())
	var mine := local != null and source_peer == local.peer_id and source_peer != 0
	var to_me := target == local

	var colour := Color(0.75, 0.75, 0.8, 0.9)
	var text_size := 15
	if to_me:
		colour = Color(1.0, 0.35, 0.30)
		text_size = 21
	elif mine:
		colour = Color(1.0, 0.85, 0.35)
		text_size = 20
	var text := "%d" % roundi(amount)
	if is_crit:
		text += "!"
		text_size += 4
	_push(target as Node3D, text, colour, text_size)

func _on_heal(_source_peer: int, target: Node, amount: float) -> void:
	if not (target is Node3D) or amount < 1.0:
		return
	_push(target as Node3D, "+%d" % roundi(amount), Color(0.35, 0.95, 0.55, 0.92), 16)

func _push(target: Node3D, text: String, colour: Color, text_size: int) -> void:
	# A busy fight can emit dozens a second; past a point they stop being
	# information and start being weather.
	if _pops.size() > 48:
		_pops.remove_at(0)
	var pop := Pop.new()
	pop.where = target.global_position + Vector3(0.0, 1.7, 0.0)
	pop.text = text
	pop.colour = colour
	pop.size = text_size
	pop.born = _now()
	pop.drift = randf_range(-26.0, 26.0)
	_pops.append(pop)

func _draw() -> void:
	var camera := get_viewport().get_camera_3d()
	if camera == null:
		return
	var font := ThemeDB.fallback_font
	var now := _now()
	for pop in _pops:
		if camera.is_position_behind(pop.where):
			continue
		var age := (now - pop.born) / LIFETIME
		var at := camera.unproject_position(pop.where)
		at.y -= RISE * age
		at.x += pop.drift * age
		var colour := pop.colour
		colour.a *= clampf(1.0 - age * age, 0.0, 1.0)
		# Drawn twice, offset, so a number stays readable against a bright
		# floor telegraph.
		draw_string(font, at + Vector2(1.0, 1.0), pop.text, HORIZONTAL_ALIGNMENT_LEFT, -1, pop.size,
			Color(0, 0, 0, colour.a * 0.7))
		draw_string(font, at, pop.text, HORIZONTAL_ALIGNMENT_LEFT, -1, pop.size, colour)

func _now() -> float:
	return float(Time.get_ticks_msec()) / 1000.0
