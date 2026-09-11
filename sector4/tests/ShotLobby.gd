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
			if OS.get_environment("PAUSE_PAGE") == "settings":
				menu._in_settings = true
				menu._hover = 2
			else:
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
	elif mode == "fx":
		Net.start_solo()
		Net.roster = {1: {"name": "You", "role": "field_medic", "ready": true}}
		add_child(preload("res://scenes/floor/Floor.tscn").instantiate())
		await get_tree().create_timer(1.0).timeout
		# Pull the nearest pack so there is a fight to look at, and hurt a
		# squadmate so the healer's beam is live.
		var best: Node = null
		var nearest := INF
		for mob in get_tree().get_nodes_in_group("trash"):
			var d: float = Vector3(0, 0, 4).distance_to((mob as Node3D).global_position)
			if d < nearest:
				nearest = d
				best = mob
		if best != null:
			best.on_pulled_by(PlayerCharacter.local(get_tree()))
		for unit in get_tree().get_nodes_in_group("party"):
			if unit.get("is_bot") == true:
				unit.health_component.reduce(unit.health_component.max_health * 0.55)
		await get_tree().create_timer(float(OS.get_environment("SHOT_DELAY")) if OS.get_environment("SHOT_DELAY") != "" else 6.0).timeout
	elif mode == "downed" or mode == "wipe":
		Net.start_solo()
		Net.roster = {1: {"name": "You", "role": "field_medic", "ready": true}}
		add_child(preload("res://scenes/floor/Floor.tscn").instantiate())
		await get_tree().create_timer(1.0).timeout
		var me := PlayerCharacter.local(get_tree())
		if mode == "wipe":
			for unit in get_tree().get_nodes_in_group("party"):
				unit.health_component.kill()
		else:
			me.health_component.kill()
		await get_tree().create_timer(0.6).timeout
	elif mode == "objective":
		Net.start_solo()
		Net.roster = {1: {"name": "You", "role": "field_medic", "ready": true}}
		add_child(preload("res://scenes/floor/Floor.tscn").instantiate())
		await get_tree().create_timer(1.0).timeout
		# Clear the room so the objective becomes the terminal, and put the
		# camera where it can see the beacon.
		for mob in get_tree().get_nodes_in_group("trash"):
			mob.health_component.kill()
		await get_tree().create_timer(1.0).timeout
		var me := PlayerCharacter.local(get_tree())
		me.global_position = Vector3(0, 0.4, -28)
		await get_tree().create_timer(0.8).timeout
	elif mode == "telegraph":
		Net.start_solo()
		Net.roster = {1: {"name": "You", "role": "field_medic", "ready": true}}
		add_child(preload("res://scenes/floor/Floor.tscn").instantiate())
		await get_tree().create_timer(0.8).timeout
		# Put a boss right in front of the camera and start a Plasma Sweep,
		# so the cone is drawn where it can be seen.
		var boss: IronCenturion = preload("res://scenes/enemies/IronCenturion.tscn").instantiate()
		get_tree().get_first_node_in_group("spawn_root").add_child(boss)
		boss.global_position = Vector3(0, 0, -16)
		await get_tree().process_frame
		boss.arm()
		boss.on_pulled_by(PlayerCharacter.local(get_tree()))
		boss._begin("plasma_sweep", "threat_leader")
		await get_tree().create_timer(1.4).timeout
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
