extends Node
## What each operative is carrying, and where it is written down.
##
## A loadout is a list of module ids per role. It is applied on spawn as
## permanent status effects, so equipment goes through exactly the same
## modifier walk as a boss debuff -- there is no second set of arithmetic
## for gear, and a module can never modify something the combat resolver
## does not already understand.

const SAVE_PATH := "user://loadout.cfg"

signal changed(role_id: String)

## role_id -> Array[String] of module ids
var equipped: Dictionary = {}

func _ready() -> void:
	load_from_disk()

# ----------------------------------------------------------------- reads

func for_role(role_id: String) -> Array:
	if not equipped.has(role_id):
		equipped[role_id] = _default_for(role_id)
	return equipped[role_id]

func has_module(role_id: String, module_id: String) -> bool:
	return for_role(role_id).has(module_id)

func slots_used(role_id: String) -> int:
	return for_role(role_id).size()

func is_full(role_id: String) -> bool:
	return slots_used(role_id) >= Content.MODULE_SLOTS

## The net effect of a role's whole loadout on one stat, for the armoury
## to show before you commit to it.
func combined_stat(role_id: String, stat: String) -> float:
	var value := 1.0
	for module_id in for_role(role_id):
		var mods: Dictionary = Content.module(module_id).get("modifiers", {})
		if mods.has(stat):
			value *= float(mods[stat])
	return value

## Every stat any equipped module touches, so the summary does not have to
## guess at a fixed list.
func touched_stats(role_id: String) -> Array:
	var out: Array = []
	for module_id in for_role(role_id):
		for stat in Content.module(module_id).get("modifiers", {}):
			if not out.has(stat):
				out.append(stat)
	out.sort()
	return out

# --------------------------------------------------------------- changes

## Returns true if the loadout actually changed. Equipping something
## already equipped removes it, so one button both fits and strips.
func toggle(role_id: String, module_id: String) -> bool:
	if Content.module(module_id).is_empty():
		return false
	var list: Array = for_role(role_id)
	if list.has(module_id):
		list.erase(module_id)
	elif list.size() < Content.MODULE_SLOTS:
		list.append(module_id)
	else:
		return false
	equipped[role_id] = list
	changed.emit(role_id)
	save_to_disk()
	return true

func clear(role_id: String) -> void:
	equipped[role_id] = []
	changed.emit(role_id)
	save_to_disk()

## A first-time player should not have to visit the armoury before the game
## is playable, so each role starts with something sensible fitted.
func _default_for(role_id: String) -> Array:
	match role_id:
		"enforcer": return ["reinforced_plating", "kinetic_dampers"]
		"field_medic": return ["trauma_protocol", "nano_capacitor"]
		"kinetic_striker": return ["servo_actuators", "overclocked_coils"]
		"railgun_specialist": return ["targeting_uplink", "nano_capacitor"]
	return []

# --------------------------------------------------------------- applying

## Fit the loadout to a body. Modules are zero-duration statuses, which is
## what makes them permanent and what makes them stack correctly with
## everything else the fight applies.
func apply_to(body: Node, role_id: String) -> void:
	var status = body.get("status_component")
	if not (status is StatusEffectComponent):
		return
	for module_id in for_role(role_id):
		status.apply(_status_id(module_id), 0, 0.0)

## Modules are registered as statuses on demand, so the armoury stays the
## single place a module is described.
static func _status_id(module_id: String) -> String:
	return "module_%s" % module_id

# ------------------------------------------------------------ persistence

func save_to_disk() -> void:
	var config := ConfigFile.new()
	for role_id in equipped:
		config.set_value("loadout", role_id, equipped[role_id])
	config.save(SAVE_PATH)

func load_from_disk() -> void:
	var config := ConfigFile.new()
	if config.load(SAVE_PATH) != OK:
		return
	for role_id in config.get_section_keys("loadout"):
		var stored = config.get_value("loadout", role_id, [])
		if typeof(stored) != TYPE_ARRAY:
			continue
		# Drop anything that no longer exists, so an old save cannot
		# resurrect a module that has been removed from the game.
		var cleaned: Array = []
		for module_id in stored:
			if not Content.module(module_id).is_empty() and cleaned.size() < Content.MODULE_SLOTS:
				cleaned.append(module_id)
		equipped[role_id] = cleaned
