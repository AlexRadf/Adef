extends Node
class_name StatusEffectComponent
## Buffs and debuffs, and the one place a stat gets modified.
##
## Neural Glitch, System Corroded, Overclock Surge, the dash i-frames and
## the boss enrage are all the same struct: a duration and a bag of
## multipliers. Damage and healing ask this component for a stat and
## multiply, so a new debuff is a Content entry and no new code.

signal status_applied(status_id: String)
signal status_removed(status_id: String)
signal statuses_changed()

## status_id -> {"expires_at": float, "source": int, "stacks": int,
##               "absorb": float}
var _active: Dictionary = {}

signal absorb_changed(remaining: float, maximum: float)

func _process(_delta: float) -> void:
	if not _is_authority():
		return
	var now := _now()
	var expired: Array[String] = []
	for status_id in _active:
		var entry: Dictionary = _active[status_id]
		var expires: float = entry["expires_at"]
		if expires > 0.0 and now >= expires:
			expired.append(status_id)
	for status_id in expired:
		remove(status_id)

# ------------------------------------------------------------- authority

func apply(status_id: String, source_peer: int = 0, duration_override: float = -1.0) -> void:
	if not _is_authority():
		return
	_apply_local(status_id, source_peer, duration_override)
	if multiplayer.has_multiplayer_peer():
		_replicate_apply.rpc(status_id, source_peer, duration_override)

func remove(status_id: String) -> void:
	if not _is_authority():
		return
	_remove_local(status_id)
	if multiplayer.has_multiplayer_peer():
		_replicate_remove.rpc(status_id)

## Strips the first effect matching any of `types` and returns its id, or
## "" if there was nothing to purge. Returning the id is what lets System
## Purge report what it actually cleaned.
func dispel(types: Array) -> String:
	if not _is_authority():
		return ""
	for status_id in _active.keys():
		var def: Dictionary = Content.status(status_id)
		if types.has(def.get("dispel_type", "")):
			remove(status_id)
			return status_id
	return ""

func clear_all() -> void:
	for status_id in _active.keys():
		remove(status_id)

# ----------------------------------------------------------------- reads

func has(status_id: String) -> bool:
	return _active.has(status_id)

func active_ids() -> Array:
	return _active.keys()

func harmful_ids() -> Array:
	var out: Array = []
	for status_id in _active:
		if Content.status(status_id).get("harmful", false):
			out.append(status_id)
	return out

func has_dispellable(types: Array) -> bool:
	for status_id in _active:
		if types.has(Content.status(status_id).get("dispel_type", "")):
			return true
	return false

func time_left(status_id: String) -> float:
	if not _active.has(status_id):
		return 0.0
	var expires: float = _active[status_id]["expires_at"]
	if expires <= 0.0:
		return INF
	return maxf(0.0, expires - _now())

# ---------------------------------------------------------------- shields

## Total shielding left across every absorb effect.
func absorb_remaining() -> float:
	var total := 0.0
	for status_id in _active:
		total += float(_active[status_id].get("absorb", 0.0))
	return total

## Spend shielding against an incoming hit and return what is left to take
## off the health bar. Pools are drained in the order they were applied, so
## the oldest shield breaks first.
func consume_absorb(amount: float) -> float:
	var remaining := amount
	var spent_any := false
	for status_id in _active.keys():
		if remaining <= 0.0:
			break
		var pool: float = float(_active[status_id].get("absorb", 0.0))
		if pool <= 0.0:
			continue
		var spent: float = minf(pool, remaining)
		remaining -= spent
		spent_any = true
		var left := pool - spent
		if left <= 0.0001:
			# A shield that has soaked its last point is gone, and should
			# say so rather than lingering as an empty buff.
			remove(status_id)
		else:
			_active[status_id]["absorb"] = left
	if spent_any:
		absorb_changed.emit(absorb_remaining(), 0.0)
	return remaining

## The product of every active modifier for `stat`. Absent means 1.0, so a
## unit with no statuses multiplies by one and costs nothing to ask.
func get_stat(stat: String) -> float:
	var value := 1.0
	for status_id in _active:
		var mods: Dictionary = Content.status(status_id).get("modifiers", {})
		if mods.has(stat):
			value *= float(mods[stat])
	return value

## Additive read for stats that are a flat share rather than a multiplier
## (lifesteal). Absent means 0.0.
func get_stat_additive(stat: String) -> float:
	var value := 0.0
	for status_id in _active:
		var mods: Dictionary = Content.status(status_id).get("modifiers", {})
		if mods.has(stat):
			value += float(mods[stat])
	return value

# --------------------------------------------------------------- interna

func _apply_local(status_id: String, source_peer: int, duration_override: float) -> void:
	var def: Dictionary = Content.status(status_id)
	if def.is_empty():
		push_warning("Sector-4: unknown status '%s'" % status_id)
		return
	var duration: float = duration_override if duration_override >= 0.0 else float(def.get("duration", 0.0))
	var expires: float = 0.0 if duration <= 0.0 else _now() + duration
	var is_new := not _active.has(status_id)
	var stacks := 1
	if not is_new:
		stacks = int(_active[status_id].get("stacks", 1)) + 1
	var entry := {"expires_at": expires, "source": source_peer, "stacks": stacks}
	# A shield carries its own pool. Re-applying refreshes it rather than
	# stacking, so two barriers do not silently become one enormous one.
	var absorb: float = float(def.get("absorb", 0.0))
	if absorb > 0.0:
		entry["absorb"] = absorb
	_active[status_id] = entry
	if absorb > 0.0:
		absorb_changed.emit(absorb_remaining(), absorb)
	if is_new:
		status_applied.emit(status_id)
		GameEvents.status_applied.emit(get_parent(), status_id)
	statuses_changed.emit()

func _remove_local(status_id: String) -> void:
	if not _active.erase(status_id):
		return
	status_removed.emit(status_id)
	GameEvents.status_removed.emit(get_parent(), status_id)
	statuses_changed.emit()

func _now() -> float:
	return float(Time.get_ticks_msec()) / 1000.0

func _is_authority() -> bool:
	return not multiplayer.has_multiplayer_peer() or multiplayer.is_server()

@rpc("authority", "call_remote", "reliable")
func _replicate_apply(status_id: String, source_peer: int, duration_override: float) -> void:
	_apply_local(status_id, source_peer, duration_override)

@rpc("authority", "call_remote", "reliable")
func _replicate_remove(status_id: String) -> void:
	_remove_local(status_id)
