extends Node
## Player settings, saved to disk.
##
## A deliberately small list: the things that stop someone playing at all
## if they are wrong. Sensitivity that does not suit your hand and an
## inverted stick are not preferences, they are barriers.

const SAVE_PATH := "user://settings.cfg"

signal changed()

const DEFAULTS := {
	"mouse_sensitivity": 0.0022,
	"stick_sensitivity": 2.6,
	"invert_look_y": false,
	"field_of_view": 78.0,
	"show_damage_numbers": true,
}

const SPEC := {
	"mouse_sensitivity": {
		"label": "Mouse sensitivity", "min": 0.0005, "max": 0.0070,
		"step": 0.0003, "format": "%.4f",
	},
	"stick_sensitivity": {
		"label": "Stick sensitivity", "min": 0.8, "max": 6.0,
		"step": 0.2, "format": "%.1f",
	},
	"invert_look_y": {"label": "Invert look Y", "toggle": true},
	"field_of_view": {
		"label": "Field of view", "min": 65.0, "max": 105.0,
		"step": 2.0, "format": "%.0f",
	},
	"show_damage_numbers": {"label": "Damage numbers", "toggle": true},
}

const ORDER := [
	"mouse_sensitivity", "stick_sensitivity", "invert_look_y",
	"field_of_view", "show_damage_numbers",
]

var values: Dictionary = {}

func _ready() -> void:
	values = DEFAULTS.duplicate()
	load_from_disk()

func get_value(id: String) -> Variant:
	return values.get(id, DEFAULTS.get(id, 0.0))

func label_for(id: String) -> String:
	return SPEC.get(id, {}).get("label", id)

## What to print beside the label. Toggles read as words; the rest use
## their own format, because 0.0022 and 78 want different precision.
func display(id: String) -> String:
	var spec: Dictionary = SPEC.get(id, {})
	if spec.get("toggle", false):
		return "On" if bool(get_value(id)) else "Off"
	return (spec.get("format", "%.2f") as String) % float(get_value(id))

## Nudge a setting. `direction` is -1 or +1; a toggle ignores it and flips.
func nudge(id: String, direction: int) -> void:
	var spec: Dictionary = SPEC.get(id, {})
	if spec.is_empty():
		return
	if spec.get("toggle", false):
		values[id] = not bool(get_value(id))
	else:
		values[id] = clampf(
			float(get_value(id)) + float(spec.get("step", 0.1)) * float(direction),
			float(spec.get("min", 0.0)), float(spec.get("max", 1.0))
		)
	changed.emit()
	save_to_disk()

func reset() -> void:
	values = DEFAULTS.duplicate()
	changed.emit()
	save_to_disk()

## True when a pad is plugged in, so prompts can show the device actually
## in the player's hands rather than both at once.
func has_gamepad() -> bool:
	return not Input.get_connected_joypads().is_empty()

func save_to_disk() -> void:
	var config := ConfigFile.new()
	for id in values:
		config.set_value("settings", id, values[id])
	config.save(SAVE_PATH)

func load_from_disk() -> void:
	var config := ConfigFile.new()
	if config.load(SAVE_PATH) != OK:
		return
	for id in config.get_section_keys("settings"):
		# Anything with no spec is dropped, so an old save cannot
		# resurrect a setting the game no longer has.
		if SPEC.has(id):
			values[id] = config.get_value("settings", id, get_value(id))
	changed.emit()
