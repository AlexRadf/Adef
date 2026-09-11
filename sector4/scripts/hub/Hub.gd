extends Node3D
class_name Hub
## The staging deck. Where a run starts, and where it comes back to.
##
## You join into this rather than into a menu: your operative is standing
## on a deck with the rest of the squad, and the armoury, the roster board
## and the mission table are places you walk to. The same PlayerCharacter,
## camera and controls as the fight, so the hub doubles as somewhere to get
## used to moving before anything is shooting at you.

const PLAYER_SCENE := preload("res://scenes/player/PlayerCharacter.tscn")
const STATION_SCENE := preload("res://scenes/hub/HubStation.tscn")
## Loaded rather than preloaded: HubUI refers back to this class, and a
## preload here would be a parse-time cycle.
const HUB_UI_PATH := "res://scenes/hub/HubUI.tscn"

const STATIONS := [
	{
		"id": "armoury", "title": "Armoury", "subtitle": "Fit modules",
		"at": Vector3(-9.0, 0.0, -6.0), "tint": Color(0.35, 0.80, 1.00),
	},
	{
		"id": "roster", "title": "Roster", "subtitle": "Change seat",
		"at": Vector3(0.0, 0.0, -10.0), "tint": Color(0.45, 0.92, 0.72),
	},
	{
		"id": "mission", "title": "Mission Table", "subtitle": "Select and deploy",
		"at": Vector3(9.0, 0.0, -6.0), "tint": Color(1.00, 0.72, 0.25),
	},
]

@onready var spawn_root: Node3D = $SpawnRoot

var _ui: HubUI = null

func _ready() -> void:
	spawn_root.add_to_group("spawn_root")
	add_child(preload("res://scenes/abilities/AbilityFx.tscn").instantiate())
	_build_deck()
	_build_lighting()
	_build_stations()
	_ui = (load(HUB_UI_PATH) as PackedScene).instantiate()
	add_child(_ui)
	# The deck gets the same pause menu as the floor, so Start does the
	# same thing everywhere rather than only in a fight.
	add_child(preload("res://scenes/ui/PauseMenu.tscn").instantiate())
	_spawn_squad()
	Input.mouse_mode = Input.MOUSE_MODE_CAPTURED

# ------------------------------------------------------------- the squad

## Only real people stand on the deck. An empty seat is shown as an empty
## seat -- a lit pad with the role's name on it -- rather than as a bot
## pretending to be a squadmate, because in the hub the question you are
## answering is "who is actually here".
func _spawn_squad() -> void:
	var taken := {}
	var slot := 0
	for peer_id in Net.roster:
		var role_id: String = Net.roster[peer_id].get("role", "field_medic")
		taken[role_id] = true
		_spawn_one(int(peer_id), role_id, slot, false)
		slot += 1
	for role_id in Content.ROLE_ORDER:
		if taken.has(role_id):
			continue
		_mark_empty_seat(role_id, slot)
		slot += 1

## An unfilled seat: a pad you can see, labelled, saying a bot will take it
## when the squad drops.
func _mark_empty_seat(role_id: String, slot: int) -> void:
	var pad := MeshInstance3D.new()
	var mesh := CylinderMesh.new()
	mesh.top_radius = 0.85
	mesh.bottom_radius = 0.85
	mesh.height = 0.05
	pad.mesh = mesh
	var material := StandardMaterial3D.new()
	material.albedo_color = Color(0.35, 0.42, 0.55, 0.5)
	material.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
	material.emission_enabled = true
	material.emission = Color(0.30, 0.40, 0.55)
	material.emission_energy_multiplier = 0.7
	pad.material_override = material
	pad.set_meta("empty_seat_role", role_id)
	pad.add_to_group("empty_seats")
	spawn_root.add_child(pad)
	pad.global_position = Vector3(-4.5 + 3.0 * float(slot), 0.05, 4.0)

func _spawn_one(peer_id: int, role_id: String, slot: int, as_bot: bool) -> void:
	var body: PlayerCharacter = PLAYER_SCENE.instantiate()
	body.name = "Hub_%s" % role_id
	body.peer_id = peer_id
	body.role_id = role_id
	body.is_bot = as_bot
	spawn_root.add_child(body, true)
	body.global_position = Vector3(-4.5 + 3.0 * float(slot), 0.4, 4.0)

## Swapping seat rebuilds the deck, so the operative you are looking at is
## always the one you are about to take into the fight.
func rebuild_squad() -> void:
	for child in spawn_root.get_children():
		child.queue_free()
	await get_tree().process_frame
	_spawn_squad()

# --------------------------------------------------------------- stations

func _build_stations() -> void:
	for def in STATIONS:
		var station: HubStation = STATION_SCENE.instantiate()
		station.station_id = def["id"]
		station.title = def["title"]
		station.subtitle = def["subtitle"]
		station.tint = def["tint"]
		add_child(station)
		station.global_position = def["at"]
		station.used.connect(_on_station_used)

func _on_station_used(station_id: String) -> void:
	if _ui != null:
		_ui.open_panel(station_id)

## The station the local operative is standing on, or null. The HUD asks
## every frame to decide whether to show a prompt.
func station_in_reach() -> HubStation:
	for station in get_tree().get_nodes_in_group("hub_stations"):
		if station is HubStation and (station as HubStation).occupied:
			return station as HubStation
	return null

# -------------------------------------------------------------- geometry

func _build_deck() -> void:
	var deck := _material(Color(0.17, 0.19, 0.24), 0.7)
	var wall := _material(Color(0.24, 0.27, 0.33), 0.65)
	var trim := _material(Color(0.20, 0.42, 0.55), 0.35)

	_slab(Vector3(0, -0.5, -4), Vector3(40, 1, 36), deck)
	_slab(Vector3(-20, 4, -4), Vector3(1, 9, 36), wall)
	_slab(Vector3(20, 4, -4), Vector3(1, 9, 36), wall)
	_slab(Vector3(0, 4, 14), Vector3(40, 9, 1), wall)
	_slab(Vector3(0, 4, -22), Vector3(40, 9, 1), wall)
	_slab(Vector3(0, 8.6, -4), Vector3(40, 1, 36), deck)

	# A lit strip down the middle of the deck, pointing at the far end:
	# the hub should tell you which way is "out" without a sign.
	for z in range(-20, 12, 4):
		_slab(Vector3(0, 0.02, float(z)), Vector3(1.4, 0.06, 2.2), trim)

	# The lift you actually leave through, behind the mission table.
	_slab(Vector3(16.0, 2.4, -14.0), Vector3(5.0, 5.0, 0.6), trim)

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
	mat.metallic = 0.3
	return mat

func _build_lighting() -> void:
	# The deck is enclosed, so a directional light would be stopped dead by
	# the ceiling. It is lit from inside instead, like the room it is.
	for spot in [
		Vector3(-9.0, 5.4, -6.0), Vector3(0.0, 5.4, -10.0), Vector3(9.0, 5.4, -6.0),
		Vector3(0.0, 5.4, 2.0), Vector3(-9.0, 5.4, 6.0), Vector3(9.0, 5.4, 6.0),
	]:
		var lamp := OmniLight3D.new()
		lamp.light_energy = 3.2
		lamp.omni_range = 17.0
		lamp.light_color = Color(0.80, 0.88, 1.0)
		lamp.shadow_enabled = false
		add_child(lamp)
		lamp.global_position = spot

	var key := DirectionalLight3D.new()
	key.rotation_degrees = Vector3(-62, -28, 0)
	key.light_energy = 0.35
	key.light_color = Color(0.80, 0.87, 1.0)
	key.shadow_enabled = true
	add_child(key)

	var env := WorldEnvironment.new()
	var environment := Environment.new()
	environment.background_mode = Environment.BG_COLOR
	environment.background_color = Color(0.05, 0.06, 0.09)
	environment.ambient_light_source = Environment.AMBIENT_SOURCE_COLOR
	environment.ambient_light_color = Color(0.34, 0.40, 0.52)
	environment.ambient_light_energy = 1.5
	environment.glow_enabled = true
	env.environment = environment
	add_child(env)
