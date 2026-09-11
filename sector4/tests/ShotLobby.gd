extends Node
## Screenshots a menu. MODE=lobby or MODE=pause.
func _ready() -> void:
	await get_tree().process_frame
	var mode := OS.get_environment("MODE")
	if mode == "pause":
		Net.start_solo()
		Net.roster = {1: {"name": "You", "role": "field_medic", "ready": true}}
		add_child(preload("res://scenes/floor/Floor.tscn").instantiate())
		await get_tree().create_timer(2.0).timeout
		var menu: PauseMenu = get_tree().get_first_node_in_group("pause") as PauseMenu
		if menu != null:
			menu.set_open(true)
			menu._showing_kit = true
		await get_tree().create_timer(0.4).timeout
	elif mode == "hub" or mode == "armoury" or mode == "mission":
		Net.start_solo()
		Net.roster = {1: {"name": "You", "role": "field_medic", "ready": true}}
		var hub: Hub = preload("res://scenes/hub/Hub.tscn").instantiate()
		add_child(hub)
		await get_tree().create_timer(1.2).timeout
		if mode != "hub":
			var ui: HubUI = null
			for child in hub.get_children():
				if child is HubUI:
					ui = child as HubUI
			if ui != null:
				ui.open_panel("armoury" if mode == "armoury" else "mission")
			await get_tree().create_timer(0.4).timeout
	elif mode == "marker":
		Net.start_solo()
		Net.roster = {1: {"name": "You", "role": "field_medic", "ready": true}}
		add_child(preload("res://scenes/floor/Floor.tscn").instantiate())
		await get_tree().create_timer(2.0).timeout
		# Mark the nearest live mob, so the raid marker has something to
		# sit above.
		var best: Node = null
		var nearest := INF
		var eye := get_viewport().get_camera_3d()
		for mob in get_tree().get_nodes_in_group("trash"):
			if mob.get("is_dead") == true or eye == null:
				continue
			var d: float = eye.global_position.distance_to((mob as Node3D).global_position)
			if d < nearest:
				nearest = d
				best = mob
		FocusMarker.set_mark(get_tree(), best)
		await get_tree().create_timer(0.5).timeout
	else:
		add_child(preload("res://scenes/Main.tscn").instantiate())
		await get_tree().create_timer(1.5).timeout
	await RenderingServer.frame_post_draw
	get_viewport().get_texture().get_image().save_png("user://menu.png")
	print("saved")
	get_tree().quit(0)
