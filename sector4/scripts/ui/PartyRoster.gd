extends Control
class_name PartyRoster
## Four health bars in a fixed place.
##
## The world-space frames tell you about whoever you are looking at. The
## healer needs to know about the person behind them, and the tank needs to
## know the healer is alive -- so the party also lives in a corner where it
## never moves and never goes off screen.

const ROW := Vector2(212.0, 26.0)

const ROLE_TINT := {
	"tank": Color(0.30, 0.55, 0.95),
	"healer": Color(0.35, 0.90, 0.65),
	"melee_dps": Color(0.95, 0.55, 0.25),
	"ranged_dps": Color(0.85, 0.35, 0.85),
}

func _ready() -> void:
	mouse_filter = Control.MOUSE_FILTER_IGNORE
	set_anchors_preset(Control.PRESET_FULL_RECT)

func _process(_delta: float) -> void:
	queue_redraw()

func _draw() -> void:
	var font := ThemeDB.fallback_font
	var members := _ordered_party()
	var origin := Vector2(28.0, 176.0)
	for i in members.size():
		_draw_row(font, origin + Vector2(0.0, float(i) * (ROW.y + 5.0)), members[i])

## Stable order, so a bar never swaps places mid-fight and gets misread.
func _ordered_party() -> Array:
	var out: Array = []
	for role_id in Content.ROLE_ORDER:
		for unit in get_tree().get_nodes_in_group("party"):
			if unit.get("role_id") == role_id:
				out.append(unit)
	return out

func _draw_row(font: Font, at: Vector2, unit: Node) -> void:
	var health = unit.get("health_component")
	var fraction: float = health.get_health_percent() if health is HealthComponent else 1.0
	var dead: bool = unit.get("is_dead") == true
	var role_id: String = str(unit.get("role_id"))
	var def: Dictionary = Content.role(role_id)
	var tint: Color = ROLE_TINT.get(def.get("archetype", ""), Color(0.7, 0.7, 0.7))

	draw_rect(Rect2(at, ROW), Color(0.03, 0.04, 0.06, 0.72))
	draw_rect(Rect2(at, Vector2(3.0, ROW.y)), tint)
	if not dead:
		draw_rect(Rect2(at + Vector2(3.0, 0.0), Vector2((ROW.x - 3.0) * fraction, ROW.y)),
			Color(tint, 0.26))

	var is_you: bool = unit.get("is_local") == true
	if is_you:
		draw_rect(Rect2(at, ROW), Color(1, 1, 1, 0.55), false, 1.0)

	var label: String = def.get("display_name", role_id)
	if unit.get("is_bot") == true:
		label += "  (bot)"
	elif is_you:
		label += "  (you)"
	draw_string(font, at + Vector2(10.0, 17.0), label, HORIZONTAL_ALIGNMENT_LEFT, -1, 12,
		Color(1, 1, 1, 0.35) if dead else Color(1, 1, 1, 0.9))

	var stamp := "DEAD" if dead else "%d%%" % roundi(fraction * 100.0)
	var stamp_colour := Color(1.0, 0.3, 0.3) if dead or fraction < 0.35 else Color(1, 1, 1, 0.75)
	draw_string(font, at + Vector2(ROW.x - 8.0 - font.get_string_size(stamp, HORIZONTAL_ALIGNMENT_LEFT, -1, 12).x, 17.0),
		stamp, HORIZONTAL_ALIGNMENT_LEFT, -1, 12, stamp_colour)

	_draw_status_pips(unit, at + Vector2(ROW.x - 46.0, ROW.y - 5.0))

## Debuffs on other people are the healer's job, so they show here too.
func _draw_status_pips(unit: Node, at: Vector2) -> void:
	var status = unit.get("status_component")
	if not (status is StatusEffectComponent):
		return
	var x := at.x
	for status_id in status.harmful_ids():
		var colour: Color = Content.status(status_id).get("alert_color", Color(1, 1, 1))
		draw_rect(Rect2(Vector2(x, at.y), Vector2(9.0, 3.0)), colour)
		x += 12.0
