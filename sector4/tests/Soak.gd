extends Node
## A watchable solo run. Not an assertion suite -- a way to see whether the
## bots are actually playing.
##
##   godot --headless --path . res://tests/Soak.tscn
##
## It prints the floor phase and what is still alive once a second, which
## is enough to tell a party that is clearing the room from a party that is
## standing in the doorway.

const SECONDS := 70

func _ready() -> void:
	await get_tree().process_frame
	# A full bot party: this is the question the soak is actually asking.
	Net.start_solo()
	Net.roster = {}
	var level: FloorLevel = preload("res://scenes/floor/Floor.tscn").instantiate()
	add_child(level)
	var director: FloorDirector = level.director
	await get_tree().process_frame
	_watch_presses()

	for second in SECONDS:
		await get_tree().create_timer(1.0).timeout
		print("t=%3ds  %-18s  trash %d  party %s  %s" % [
			second + 1,
			FloorDirector.PHASE_NAMES[director.phase],
			_alive("trash"),
			_party_health(),
			_boss_line(director),
		])
		if director.phase == FloorDirector.Phase.ASCENT:
			print("floor cleared at t=%ds" % (second + 1))
			break
	_report_presses()
	get_tree().quit(0)

var _presses: Dictionary = {}

## Counts what each seat actually pressed. A bot that is not attacking is
## either choosing something else or failing to land it, and the tally is
## the only way to tell those two apart.
func _watch_presses() -> void:
	for unit in get_tree().get_nodes_in_group("party"):
		var abilities = unit.get("ability_component")
		if abilities is AbilityComponent:
			var role_id: String = unit.get("role_id")
			abilities.ability_fired.connect(func(id: String) -> void:
				var key := "%s/%s" % [role_id, id]
				_presses[key] = int(_presses.get(key, 0)) + 1)

func _report_presses() -> void:
	print("\n-- presses over the run --")
	var keys := _presses.keys()
	keys.sort()
	for key in keys:
		print("   %-42s %d" % [key, _presses[key]])

func _boss_line(director: FloorDirector) -> String:
	var boss := director.boss
	if boss == null or not is_instance_valid(boss):
		return ""
	var spread: PackedStringArray = []
	for unit in get_tree().get_nodes_in_group("party"):
		if unit is Node3D:
			spread.append("%d" % roundi(boss.global_position.distance_to((unit as Node3D).global_position)))
	return "boss %d%% z=%.0f  dist %s" % [
		roundi(boss.health_component.get_health_percent() * 100.0),
		boss.global_position.z,
		"/".join(spread),
	]

func _alive(group: String) -> int:
	var count := 0
	for unit in get_tree().get_nodes_in_group(group):
		if unit.get("is_dead") != true:
			count += 1
	return count

func _party_health() -> String:
	var parts: PackedStringArray = []
	for unit in get_tree().get_nodes_in_group("party"):
		var health = unit.get("health_component")
		if health is HealthComponent:
			parts.append("%d%%" % roundi(health.get_health_percent() * 100.0))
	return "/".join(parts)
