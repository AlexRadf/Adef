extends Node
class_name AbilityComponent
## Cooldowns and the resource bar.
##
## Attack speed is a cooldown scalar rather than an animation rate, so
## Neural Glitch (-25% attack speed) and Overclock Surge (+35%) both land
## on the same line of arithmetic and stack correctly with each other.

signal energy_changed(current: float, maximum: float)
signal ability_fired(ability_id: String)

@export var max_energy: float = 100.0
@export var energy_regen: float = 6.0

var energy: float = 0.0
var _ready_at: Dictionary = {}       # ability_id -> unix seconds
var _status: StatusEffectComponent = null

func _ready() -> void:
	energy = max_energy
	_status = get_parent().get("status_component")

func setup(maximum: float, regen: float) -> void:
	max_energy = maximum
	energy_regen = regen
	energy = maximum
	energy_changed.emit(energy, max_energy)

func _process(delta: float) -> void:
	if energy < max_energy:
		var before := energy
		energy = minf(max_energy, energy + energy_regen * delta)
		if not is_equal_approx(before, energy):
			energy_changed.emit(energy, max_energy)

# ------------------------------------------------------------ cooldowns

func is_ready(ability_id: String) -> bool:
	return _now() >= float(_ready_at.get(ability_id, 0.0))

func cooldown_remaining(ability_id: String) -> float:
	return maxf(0.0, float(_ready_at.get(ability_id, 0.0)) - _now())

func cooldown_fraction(ability_id: String) -> float:
	var total: float = _scaled_cooldown(ability_id)
	if total <= 0.0:
		return 0.0
	return clampf(cooldown_remaining(ability_id) / total, 0.0, 1.0)

func start_cooldown(ability_id: String) -> void:
	var seconds := _scaled_cooldown(ability_id)
	if seconds > 0.0:
		_ready_at[ability_id] = _now() + seconds

## A shorter cooldown is a faster attack, so attack_speed divides here.
func _scaled_cooldown(ability_id: String) -> float:
	var base: float = float(Content.ability(ability_id).get("cooldown", 0.0))
	if base <= 0.0:
		return 0.0
	var speed := 1.0
	if _status != null:
		speed = maxf(0.05, _status.get_stat("attack_speed"))
	return base / speed

# --------------------------------------------------------------- energy

func has_energy(cost: float) -> bool:
	return energy >= cost

func spend(cost: float) -> bool:
	if cost <= 0.0:
		return true
	if energy < cost:
		return false
	energy -= cost
	energy_changed.emit(energy, max_energy)
	return true

func refund(amount: float) -> void:
	if amount <= 0.0:
		return
	energy = minf(max_energy, energy + amount)
	energy_changed.emit(energy, max_energy)

func energy_fraction() -> float:
	if max_energy <= 0.0:
		return 0.0
	return clampf(energy / max_energy, 0.0, 1.0)

## One gate for "may I press this": off cooldown and paid for.
func can_use(ability_id: String) -> bool:
	var def: Dictionary = Content.ability(ability_id)
	if def.is_empty():
		return false
	if not is_ready(ability_id):
		return false
	return has_energy(float(def.get("cost", 0.0)))

## Commits the cost and the cooldown. Call this only once the ability has
## actually decided to go off, never while merely aiming it.
func commit(ability_id: String) -> bool:
	var def: Dictionary = Content.ability(ability_id)
	if def.is_empty() or not is_ready(ability_id):
		return false
	if not spend(float(def.get("cost", 0.0))):
		return false
	start_cooldown(ability_id)
	ability_fired.emit(ability_id)
	return true

func _now() -> float:
	return float(Time.get_ticks_msec()) / 1000.0
