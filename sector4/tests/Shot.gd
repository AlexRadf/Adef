extends Node
## Renders a frame of the real game and saves it to a PNG.
##
##   SHOT_DELAY=26 xvfb-run -a godot --path . \
##       --rendering-driver opengl3 --resolution 1600x900 res://tests/Shot.tscn
##
## The assertion suite proves the simulation is right; it cannot tell you
## the camera is inside the player's head or that six nameplates have piled
## into one another. This is how the visual layer gets checked.
##
## SHOT_DELAY picks the moment: a few seconds for the opening room, ~26 for
## a trash fight in progress, ~90 for the boss.

func _ready() -> void:
	await get_tree().process_frame
	Net.local_role = "field_medic"
	Net.start_solo()
	Net.roster = {1: {"name": "You", "role": "field_medic", "ready": true}}
	add_child(preload("res://scenes/floor/Floor.tscn").instantiate())

	var delay := 3.0
	var configured := OS.get_environment("SHOT_DELAY")
	if configured != "":
		delay = maxf(0.5, float(configured))
	await get_tree().create_timer(delay).timeout

	# Capture after the frame is actually on the GPU, or the image comes
	# back as whatever was there previously.
	await RenderingServer.frame_post_draw
	var image := get_viewport().get_texture().get_image()
	image.save_png("user://shot.png")
	print("saved: ", ProjectSettings.globalize_path("user://shot.png"))
	get_tree().quit(0)
