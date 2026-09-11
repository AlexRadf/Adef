extends Node
class_name CastComponent
## Cast bars, channels, and the interrupt that stops them.
##
## Core Overcharge is the reason this exists: a 4.0s channel with a visible
## bar and a lethal payload, which one person is expected to kick. Trash
## casters use the identical component, so practising the interrupt on a
## Code-Disruptor is practising it on the boss.

signal cast_started(ability_id: String, duration: float, interruptible: bool)
signal cast_finished(ability_id: String)
signal cast_interrupted(ability_id: String)

var is_casting: bool = false
var ability_id: String = ""
var duration: float = 0.0
var elapsed: float = 0.0
var interruptible: bool = false

var _on_complete: Callable = Callable()

func _process(delta: float) -> void:
	if not is_casting:
		return
	elapsed += delta
	if elapsed < duration:
		return
	var finished := ability_id
	var callback := _on_complete
	_reset()
	cast_finished.emit(finished)
	if callback.is_valid():
		callback.call()

## Server-side. `on_complete` fires only if the cast is not interrupted.
func begin(id: String, seconds: float, can_interrupt: bool, on_complete: Callable) -> void:
	ability_id = id
	duration = maxf(0.0, seconds)
	elapsed = 0.0
	interruptible = can_interrupt
	is_casting = true
	_on_complete = on_complete
	cast_started.emit(id, duration, can_interrupt)
	if multiplayer.has_multiplayer_peer() and multiplayer.is_server():
		_replicate_start.rpc(id, duration, can_interrupt)
	# A zero-length cast still has to resolve, and resolving it here keeps
	# instant abilities on the same path as channelled ones.
	if duration <= 0.0:
		var callback := _on_complete
		_reset()
		cast_finished.emit(id)
		if callback.is_valid():
			callback.call()

## Returns true if something was actually stopped, so the Striker's kick
## can tell the difference between a good interrupt and a wasted cooldown.
func interrupt() -> bool:
	if not is_casting or not interruptible:
		return false
	var stopped := ability_id
	_reset()
	cast_interrupted.emit(stopped)
	if multiplayer.has_multiplayer_peer() and multiplayer.is_server():
		_replicate_stop.rpc(stopped, true)
	return true

func cancel() -> void:
	if not is_casting:
		return
	var stopped := ability_id
	_reset()
	cast_interrupted.emit(stopped)
	if multiplayer.has_multiplayer_peer() and multiplayer.is_server():
		_replicate_stop.rpc(stopped, false)

func progress() -> float:
	if not is_casting or duration <= 0.0:
		return 0.0
	return clampf(elapsed / duration, 0.0, 1.0)

func time_left() -> float:
	return maxf(0.0, duration - elapsed) if is_casting else 0.0

func _reset() -> void:
	is_casting = false
	ability_id = ""
	duration = 0.0
	elapsed = 0.0
	interruptible = false
	_on_complete = Callable()

@rpc("authority", "call_remote", "reliable")
func _replicate_start(id: String, seconds: float, can_interrupt: bool) -> void:
	ability_id = id
	duration = seconds
	elapsed = 0.0
	interruptible = can_interrupt
	is_casting = true
	cast_started.emit(id, seconds, can_interrupt)

@rpc("authority", "call_remote", "reliable")
func _replicate_stop(id: String, was_interrupted: bool) -> void:
	_reset()
	if was_interrupted:
		cast_interrupted.emit(id)
	else:
		cast_finished.emit(id)
