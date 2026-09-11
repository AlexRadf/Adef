extends Node3D
class_name AggroPack
## A linked squad of 2 to 4 mobs.
##
## The pack is the unit of engagement. Shooting one member brings the whole
## squad and nothing beyond it, which is what lets a party clear a floor by
## taking the room apart one pull at a time instead of running through it.

signal pack_cleared()

@export var pack_name: String = "Squad"

var members: Array[TrashMob] = []
var alerted: bool = false

func adopt(mob: TrashMob) -> void:
	members.append(mob)
	mob.pack = self
	mob.health_component.died.connect(_on_member_died)

## Wake the whole squad. The delay is deliberate: the mobs that were not
## shot take a beat to notice, so a pull reads as a squad reacting rather
## than four bodies turning on the same frame.
func alert(puller: Node) -> void:
	if alerted:
		return
	alerted = true
	for i in members.size():
		var mob := members[i]
		if not is_instance_valid(mob) or mob.is_dead:
			continue
		if i == 0:
			mob.alert(puller)
		else:
			_wake_later(mob, puller, Content.PULL_ALERT_DELAY * float(i))
	GameEvents.pack_alerted.emit(pack_name, alive_count())

func _wake_later(mob: TrashMob, puller: Node, delay: float) -> void:
	await get_tree().create_timer(delay).timeout
	if is_instance_valid(mob) and not mob.is_dead:
		mob.alert(puller)

func alive_count() -> int:
	var count := 0
	for mob in members:
		if is_instance_valid(mob) and not mob.is_dead:
			count += 1
	return count

func is_cleared() -> bool:
	return alive_count() == 0

func _on_member_died() -> void:
	if is_cleared():
		pack_cleared.emit()
