extends Control
class_name ObjectivePanel
## What to do, right now, permanently on screen.
##
## The phase banner flashes and leaves; this stays. It answers the only
## question a lost player is actually asking -- "where am I supposed to be
## going and what is stopping me" -- and it counts down the thing that is
## in the way, so progress is visible rather than inferred.

const PANEL := Vector2(300.0, 62.0)

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
	var font := ThemeDB.fallback_font
	var at := Vector2(28.0, 92.0)
	var rect := Rect2(at, PANEL)
	draw_rect(rect, Color(0.03, 0.04, 0.06, 0.72))
	draw_rect(Rect2(at, Vector2(3.0, PANEL.y)), Color(1.0, 0.75, 0.2))

	draw_string(font, at + Vector2(13.0, 18.0), "OBJECTIVE",
		HORIZONTAL_ALIGNMENT_LEFT, -1, 11, Color(1.0, 0.75, 0.2, 0.9))
	draw_string(font, at + Vector2(13.0, 37.0), _headline(),
		HORIZONTAL_ALIGNMENT_LEFT, -1, 16, Color(1, 1, 1, 0.95))
	draw_string(font, at + Vector2(13.0, 54.0), _detail(),
		HORIZONTAL_ALIGNMENT_LEFT, -1, 12, Color(1, 1, 1, 0.6))

	var progress := _progress()
	if progress >= 0.0:
		var bar := Rect2(at + Vector2(0.0, PANEL.y), Vector2(PANEL.x, 4.0))
		draw_rect(bar, Color(0, 0, 0, 0.6))
		draw_rect(Rect2(bar.position, Vector2(bar.size.x * progress, bar.size.y)), Color(1.0, 0.75, 0.2))

func _headline() -> String:
	match _director.phase:
		FloorDirector.Phase.ELEVATOR_BREACH: return "Breach the sector"
		FloorDirector.Phase.TRASH: return "Clear the sector"
		FloorDirector.Phase.SECURITY_OVERRIDE: return "Hold the terminal"
		FloorDirector.Phase.BOSS: return "Destroy Unit-01"
		FloorDirector.Phase.ASCENT: return "Sector clear"
	return ""

## The specific, countable thing in the way. Vague objectives are the same
## as no objective.
func _detail() -> String:
	match _director.phase:
		FloorDirector.Phase.TRASH:
			var left := _alive("trash")
			return "%d hostile%s remaining · pull one pack at a time" % [left, "" if left == 1 else "s"]
		FloorDirector.Phase.SECURITY_OVERRIDE:
			var terminal := _terminal()
			if terminal == null:
				return "Find the security terminal"
			if terminal.is_unlocked:
				return "Override complete — the door is open"
			return "Stand on it. %d%% · adds incoming" % roundi(terminal.fraction() * 100.0)
		FloorDirector.Phase.BOSS:
			var boss := _director.boss
			if boss == null or not is_instance_valid(boss):
				return ""
			if boss.is_enraged:
				return "ENRAGED — recasts 25% faster"
			return "Kick Core Overcharge or the party dies"
		FloorDirector.Phase.ASCENT:
			return "Take the elevator up"
	return ""

func _progress() -> float:
	match _director.phase:
		FloorDirector.Phase.SECURITY_OVERRIDE:
			var terminal := _terminal()
			return terminal.fraction() if terminal != null else -1.0
		FloorDirector.Phase.BOSS:
			var boss := _director.boss
			if boss != null and is_instance_valid(boss):
				return 1.0 - boss.health_component.get_health_percent()
	return -1.0

func _terminal() -> SecurityTerminal:
	var node := get_tree().get_first_node_in_group("terminals")
	return node as SecurityTerminal if node is SecurityTerminal else null

func _alive(group: String) -> int:
	var count := 0
	for unit in get_tree().get_nodes_in_group(group):
		if unit.get("is_dead") != true:
			count += 1
	return count
