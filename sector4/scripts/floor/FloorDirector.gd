extends Node
class_name FloorDirector
## The floor progression loop from section 1, as a state machine.
##
##   ELEVATOR BREACH -> TACTICAL TRASH -> SECURITY OVERRIDE
##                   -> SECTOR BOSS     -> ELEVATOR ASCENT
##
## It runs on the server and announces transitions to everyone. The order
## is the design: you cannot reach the boss without clearing the room, and
## you cannot open the door without holding the terminal.

enum Phase { ELEVATOR_BREACH, TRASH, SECURITY_OVERRIDE, BOSS, ASCENT }

const PHASE_NAMES := {
	Phase.ELEVATOR_BREACH: "Elevator Breach",
	Phase.TRASH: "Clear the Sector",
	Phase.SECURITY_OVERRIDE: "Security Override",
	Phase.BOSS: "Sector Boss",
	Phase.ASCENT: "Elevator Ascent",
}

signal phase_changed(phase: Phase)

@export var floor_index: int = 0
@export var auto_start: bool = true

var phase: Phase = Phase.ELEVATOR_BREACH
var packs: Array[AggroPack] = []
var boss: IronCenturion = null

var _def: Dictionary = {}
var _spawn_root: Node = null
var _terminal: SecurityTerminal = null

func _ready() -> void:
	_def = Content.FLOORS[clampi(floor_index, 0, Content.FLOORS.size() - 1)]
	_spawn_root = get_tree().get_first_node_in_group("spawn_root")
	if _spawn_root == null:
		_spawn_root = get_parent()
	if auto_start and Net.is_server():
		call_deferred("begin")

func begin() -> void:
	_set_phase(Phase.ELEVATOR_BREACH)
	_spawn_trash()
	_set_phase(Phase.TRASH)

# ---------------------------------------------------------------- phases

func _set_phase(next: Phase) -> void:
	phase = next
	phase_changed.emit(phase)
	GameEvents.floor_phase_changed.emit(int(phase), PHASE_NAMES.get(phase, "?"))
	if Net.is_server() and multiplayer.has_multiplayer_peer():
		_replicate_phase.rpc(int(phase))

@rpc("authority", "call_remote", "reliable")
func _replicate_phase(next: int) -> void:
	phase = next as Phase
	phase_changed.emit(phase)
	GameEvents.floor_phase_changed.emit(next, PHASE_NAMES.get(phase, "?"))

# ------------------------------------------------------------------ mobs

func _spawn_trash() -> void:
	var mob_scene: PackedScene = preload("res://scenes/enemies/TrashMob.tscn")
	for pack_def in _def.get("packs", []):
		var pack := AggroPack.new()
		pack.pack_name = "Squad %d" % (packs.size() + 1)
		_spawn_root.add_child(pack)
		pack.global_position = pack_def["origin"]
		var types: Array = pack_def["types"]
		for i in types.size():
			var mob: TrashMob = mob_scene.instantiate()
			mob.mob_type = types[i]
			_spawn_root.add_child(mob, true)
			# Fan the squad out around its origin so a pack reads as a
			# formation rather than a stack of bodies in one spot.
			var angle := TAU * float(i) / float(types.size())
			mob.global_position = pack_def["origin"] + Vector3(cos(angle) * 2.4, 0.0, sin(angle) * 2.4)
			pack.adopt(mob)
		pack.pack_cleared.connect(_on_pack_cleared)
		packs.append(pack)

	for patrol_def in _def.get("patrols", []):
		var mob: TrashMob = mob_scene.instantiate()
		mob.mob_type = patrol_def["type"]
		var route := PackedVector3Array()
		for point in patrol_def["route"]:
			route.append(point)
		mob.patrol_route = route
		_spawn_root.add_child(mob, true)
		mob.global_position = route[0]
		mob.add_to_group("patrols")
		# A patrol belongs to no pack, so nothing else would ever report
		# it dead -- and killing it last would leave the door shut with an
		# empty room. It gets its own clear check.
		mob.health_component.died.connect(_on_pack_cleared)

func _on_pack_cleared() -> void:
	if phase != Phase.TRASH:
		return
	if not _all_trash_cleared():
		return
	_open_security_override()

func _all_trash_cleared() -> bool:
	for pack in packs:
		if is_instance_valid(pack) and not pack.is_cleared():
			return false
	# The patrol counts too, or the party could walk past it to the door.
	for patrol in get_tree().get_nodes_in_group("patrols"):
		if is_instance_valid(patrol) and patrol.get("is_dead") != true:
			return false
	return true

# ------------------------------------------------------- security override

func _open_security_override() -> void:
	_set_phase(Phase.SECURITY_OVERRIDE)
	var terminal: SecurityTerminal = preload("res://scenes/floor/SecurityTerminal.tscn").instantiate()
	terminal.unlock_seconds = float(_def.get("terminal_unlock_seconds", 12.0))
	terminal.wave_count = int(_def.get("terminal_waves", 2))
	terminal.wave_types = _def.get("terminal_wave_types", ["sentry_drone"])
	_spawn_root.add_child(terminal, true)
	terminal.global_position = _def["terminal"]
	terminal.unlocked.connect(_on_terminal_unlocked)
	_terminal = terminal

func _on_terminal_unlocked() -> void:
	_spawn_boss()

# ------------------------------------------------------------------ boss

func _spawn_boss() -> void:
	_set_phase(Phase.BOSS)
	var scene: PackedScene = preload("res://scenes/enemies/IronCenturion.tscn")
	boss = scene.instantiate()
	boss.boss_id = _def.get("boss", "unit_01")
	_spawn_root.add_child(boss, true)
	boss.global_position = _def.get("boss_origin", Vector3(0, 0, -70))
	boss.health_component.died.connect(_on_boss_died)
	boss.begin_encounter()

func _on_boss_died() -> void:
	_set_phase(Phase.ASCENT)
	GameEvents.encounter_ended.emit(true, "%s destroyed" % Content.boss(_def.get("boss", "unit_01")).get("title", "Boss"))

## Called by the ascent elevator once the party is aboard. The next floor
## is the same loop with a harder sheet of numbers, so there is one code
## path rather than a special case per floor.
func advance_floor() -> void:
	if phase != Phase.ASCENT:
		return
	floor_index += 1
	if floor_index >= Content.FLOORS.size():
		GameEvents.encounter_ended.emit(true, "Megastructure cleared")
		return
	_def = Content.FLOORS[floor_index]
	packs.clear()
	boss = null
	begin()
