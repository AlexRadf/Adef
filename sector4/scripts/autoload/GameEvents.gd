extends Node
## Client-side signal bus.
##
## The UI never reaches into the simulation. Gameplay emits here, the HUD
## listens here, and neither one holds a reference to the other -- which is
## what lets the boss run on the server while the reticle runs on a client.

# -- combat ------------------------------------------------------------
signal damage_dealt(source_id: int, target: Node, amount: float, is_crit: bool)
signal healing_done(source_id: int, target: Node, amount: float)
signal unit_died(unit: Node)

# -- status ------------------------------------------------------------
signal status_applied(unit: Node, status_id: String)
signal status_removed(unit: Node, status_id: String)

# -- local player ------------------------------------------------------
signal soft_target_changed(target: Node)
signal energy_changed(current: float, maximum: float)
signal local_health_changed(current: float, maximum: float)
signal camera_preset_changed(index: int, distance: float)
signal ability_used(ability_id: String, cooldown: float)

# -- encounter ---------------------------------------------------------
signal boss_cast_started(ability_id: String, display_name: String, duration: float, interruptible: bool)
signal boss_cast_finished(ability_id: String, was_interrupted: bool)
signal boss_health_changed(current: float, maximum: float)
signal boss_enraged()
signal floor_phase_changed(phase: int, phase_name: String)
signal pack_alerted(pack_name: String, count: int)
signal target_marked(target: Node)
signal encounter_ended(victory: bool, reason: String)
