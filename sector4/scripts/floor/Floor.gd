extends Node3D
class_name FloorLevel
## One floor of the megastructure: geometry, players, and the director.
##
## The geometry is built in code rather than placed by hand, because the
## layout is load-bearing rather than decorative. Line-of-sight pulling
## only exists if there is something to break line of sight *with*, so the
## pillars and the corridor doorway are gameplay, and they are generated
## from the same numbers the director spawns packs at.

const PLAYER_SCENE := preload("res://scenes/player/PlayerCharacter.tscn")
const HUD_SCENE := preload("res://scenes/ui/ArenaReticle.tscn")
const PAUSE_SCENE := preload("res://scenes/ui/PauseMenu.tscn")

@onready var spawn_root: Node3D = $SpawnRoot
@onready var director: FloorDirector = $FloorDirector

var _players: Dictionary = {}
var _entries: Array[Vector3] = []

func _ready() -> void:
	# Running this scene on its own (F6 in the editor, or as the main
	# scene) would drop you into a floor with no lobby and no seat picked.
	# Bounce to the real entry point instead, so the game always starts
	# where it is meant to. Tools that add a Floor as a child -- the soak
	# and the screenshot runner -- are unaffected, because for them this is
	# not the current scene.
	if get_tree().current_scene == self and Net.roster.is_empty() and not Net.in_game:
		call_deferred("_bounce_to_lobby")
		return
	spawn_root.add_to_group("spawn_root")
	_build_geometry()
	_build_lighting()
	add_child(HUD_SCENE.instantiate())
	add_child(preload("res://scenes/abilities/AbilityFx.tscn").instantiate())
	add_child(PAUSE_SCENE.instantiate())
	if Net.is_server():
		_spawn_players()
		director.register_entry_points(_entries)
		director.call_deferred("_watch_party")

func _bounce_to_lobby() -> void:
	get_tree().change_scene_to_file("res://scenes/Main.tscn")

# -------------------------------------------------------------- players

## Humans first, then bots for whatever is left over. The fight is designed
## around four seats and every one of the boss's abilities is answered by a
## specific one of them, so a short party is not a harder game -- it is an
## unfinishable one.
func _spawn_players() -> void:
	# No roster at all means nobody is playing -- a headless soak or an
	# attract run. Give every seat to a bot rather than inventing a human
	# who is not there to drive it.
	var roster := Net.roster
	var slot := 0
	var taken := {}
	for peer_id in roster:
		var role_id: String = roster[peer_id].get("role", "field_medic")
		taken[role_id] = true
		_spawn_player(int(peer_id), role_id, slot, false)
		slot += 1
	for role_id in Content.ROLE_ORDER:
		if taken.has(role_id):
			continue
		_spawn_player(0, role_id, slot, true)
		slot += 1

func _spawn_player(peer_id: int, role_id: String, slot: int, as_bot: bool) -> void:
	var player: PlayerCharacter = PLAYER_SCENE.instantiate()
	player.name = "Player_%d" % peer_id if not as_bot else "Bot_%s" % role_id
	player.peer_id = peer_id
	player.role_id = role_id
	player.is_bot = as_bot
	spawn_root.add_child(player, true)
	# The elevator mouth: the party arrives together, spread across the
	# doorway rather than stacked inside one another.
	var entry := Vector3(-3.0 + 2.0 * float(slot), 0.4, 4.0)
	player.global_position = entry
	_entries.append(entry)
	_players[peer_id] = player

# ------------------------------------------------------------- geometry

func _build_geometry() -> void:
	var pale := _material(Color(0.30, 0.33, 0.38), 0.65)
	var dark := _material(Color(0.16, 0.17, 0.20), 0.8)
	var accent := _material(Color(0.20, 0.45, 0.55), 0.4)

	# The run itself: a long hall, a doorway, then the boss chamber.
	_slab(Vector3(0, -0.5, -30), Vector3(46, 1, 100), dark)      # deck
	_slab(Vector3(-23, 4, -30), Vector3(1, 9, 100), pale)        # west wall
	_slab(Vector3(23, 4, -30), Vector3(1, 9, 100), pale)         # east wall
	_slab(Vector3(0, 4, 20), Vector3(46, 9, 1), pale)            # behind the lift
	_slab(Vector3(0, 4, -80), Vector3(46, 9, 1), pale)           # far wall

	# The doorway into the boss chamber. Two stubs and a lintel, so the
	# fight has a threshold you can stand behind.
	_slab(Vector3(-14, 4, -56), Vector3(18, 9, 1.2), pale)
	_slab(Vector3(14, 4, -56), Vector3(18, 9, 1.2), pale)
	_slab(Vector3(0, 7.5, -56), Vector3(11, 2, 1.2), pale)

	# Pillars. These are the LoS tool: a Code-Disruptor that can see you
	# will stand and shoot, and the only way to make it move is to put one
	# of these between the two of you.
	for spot in [
		Vector3(-9, 0, -14), Vector3(9, 0, -14),
		Vector3(-9, 0, -26), Vector3(9, 0, -26),
		Vector3(-9, 0, -38), Vector3(9, 0, -38),
		Vector3(-15, 0, -44), Vector3(15, 0, -44),
	]:
		_slab(spot + Vector3(0, 4.0, 0), Vector3(2.4, 8, 2.4), accent)

	# Cover either side of the terminal, so holding it is a position rather
	# than a spot on the floor.
	_slab(Vector3(-6, 1.2, -48), Vector3(4, 2.4, 1.2), pale)
	_slab(Vector3(6, 1.2, -48), Vector3(4, 2.4, 1.2), pale)

func _slab(centre: Vector3, size: Vector3, mat: StandardMaterial3D) -> void:
	var body := StaticBody3D.new()
	body.collision_layer = 1
	body.collision_mask = 0
	var shape := CollisionShape3D.new()
	var box := BoxShape3D.new()
	box.size = size
	shape.shape = box
	body.add_child(shape)
	var mesh := MeshInstance3D.new()
	var box_mesh := BoxMesh.new()
	box_mesh.size = size
	mesh.mesh = box_mesh
	mesh.material_override = mat
	body.add_child(mesh)
	add_child(body)
	body.global_position = centre

func _material(colour: Color, roughness: float) -> StandardMaterial3D:
	var mat := StandardMaterial3D.new()
	mat.albedo_color = colour
	mat.roughness = roughness
	mat.metallic = 0.35
	return mat

func _build_lighting() -> void:
	var sun := DirectionalLight3D.new()
	sun.rotation_degrees = Vector3(-58, -35, 0)
	sun.light_energy = 1.05
	sun.light_color = Color(0.72, 0.82, 1.0)
	sun.shadow_enabled = true
	add_child(sun)

	var env := WorldEnvironment.new()
	var environment := Environment.new()
	environment.background_mode = Environment.BG_COLOR
	environment.background_color = Color(0.04, 0.05, 0.08)
	environment.ambient_light_source = Environment.AMBIENT_SOURCE_COLOR
	environment.ambient_light_color = Color(0.30, 0.35, 0.45)
	environment.ambient_light_energy = 0.95
	environment.fog_enabled = true
	environment.fog_light_color = Color(0.06, 0.09, 0.14)
	environment.fog_density = 0.006
	environment.glow_enabled = true
	env.environment = environment
	add_child(env)
