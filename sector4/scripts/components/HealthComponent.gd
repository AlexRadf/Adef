extends Node
class_name HealthComponent
## Hit points, and nothing else.
##
## The server is the only thing that may change `current_health`; clients
## receive the result. Every write goes through `_set_health` so that the
## death check exists in exactly one place.

signal health_changed(current: float, maximum: float)
signal died()
signal revived()

@export var max_health: float = 100.0

var current_health: float = 0.0
var is_dead: bool = false

func _ready() -> void:
	if current_health <= 0.0 and not is_dead:
		current_health = max_health

func setup(maximum: float) -> void:
	max_health = maximum
	current_health = maximum
	is_dead = false
	health_changed.emit(current_health, max_health)

## 0.0 when dead, 1.0 at full. The soft-lock scorer reads this every frame,
## so it must stay branch-free and cheap.
func get_health_percent() -> float:
	if max_health <= 0.0:
		return 0.0
	return clampf(current_health / max_health, 0.0, 1.0)

func get_missing_health() -> float:
	return maxf(0.0, max_health - current_health)

## Server-side only. Returns the amount actually removed.
func reduce(amount: float) -> float:
	if is_dead or amount <= 0.0:
		return 0.0
	var before := current_health
	_set_health(current_health - amount)
	return before - current_health

## Server-side only. Returns the amount actually restored -- overheal is
## not counted, which is what keeps the healer's HPS readout honest.
func restore(amount: float) -> float:
	if is_dead or amount <= 0.0:
		return 0.0
	var before := current_health
	_set_health(current_health + amount)
	return current_health - before

func kill() -> void:
	_set_health(0.0)

func revive(pct: float = 0.35) -> void:
	if not is_dead:
		return
	is_dead = false
	_set_health(max_health * clampf(pct, 0.05, 1.0))
	revived.emit()
	_replicate.rpc(current_health, max_health, is_dead)

func _set_health(value: float) -> void:
	current_health = clampf(value, 0.0, max_health)
	health_changed.emit(current_health, max_health)
	if current_health <= 0.0 and not is_dead:
		is_dead = true
		died.emit()
	if multiplayer.has_multiplayer_peer() and multiplayer.is_server():
		_replicate.rpc(current_health, max_health, is_dead)

@rpc("authority", "call_remote", "unreliable_ordered")
func _replicate(current: float, maximum: float, dead: bool) -> void:
	max_health = maximum
	current_health = current
	var was_dead := is_dead
	is_dead = dead
	health_changed.emit(current_health, max_health)
	if is_dead and not was_dead:
		died.emit()
	elif was_dead and not is_dead:
		revived.emit()
