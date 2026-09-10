// Four camera rigs. The camera is most of what separates these genres --
// where your eyes are decides what the fight is even asking of you.

import * as THREE from '../vendor/three.module.js';
import { toWorld, ARENA } from './scene.js';

// The camera has to stay in the room, or it ends up looking at the back
// of a wall -- which is exactly what it did the first time.
export const LIMIT = ARENA / 2 - 0.7;

// ...but clamping the position while keeping the framing is worse than
// the wall: in a corner the camera ends up a metre behind your head and
// six metres up, staring at your scalp while the boss sits off screen.
// So shorten the boom instead. The shot keeps its angle and only loses
// distance, which is what every third-person camera does at a wall.
export function fitInside(from, dir, want, limit = LIMIT) {
  let t = want;
  for (const axis of ['x', 'z']) {
    if (Math.abs(dir[axis]) < 1e-6) continue;
    const bound = dir[axis] > 0 ? limit : -limit;
    t = Math.min(t, (bound - from[axis]) / dir[axis]);
  }
  return Math.max(0, t);
}

function keepInside(camera, floor = 1.3) {
  camera.position.x = Math.max(-LIMIT, Math.min(LIMIT, camera.position.x));
  camera.position.z = Math.max(-LIMIT, Math.min(LIMIT, camera.position.z));
  camera.position.y = Math.max(floor, camera.position.y);
}

const UP = new THREE.Vector3(0, 1, 0);
const EYE = 1.55;

export function createRig() {
  let yaw = 0;
  let pitch = -0.18;
  const smoothed = new THREE.Vector3();
  let started = false;

  function look(dx, dy, sensitivity = 1) {
    yaw -= dx * 0.0022 * sensitivity;
    pitch -= dy * 0.0022 * sensitivity;
    pitch = Math.max(-1.25, Math.min(0.9, pitch));
  }

  // Where the crosshair meets the floor: the sim's aim point.
  function aimPoint(camera) {
    const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
    const origin = camera.position;
    if (Math.abs(dir.y) < 1e-4) return null;
    const t = -origin.y / dir.y;
    if (t <= 0) return null;
    return origin.clone().addScaledVector(dir, t);
  }

  function apply(camera, mode, player, lockTarget, dt) {
    const at = toWorld(player.pos);
    if (!started) {
      smoothed.copy(at);
      started = true;
    }
    // The camera chases the body rather than being welded to it.
    smoothed.lerp(at, Math.min(1, dt * 14));

    if (mode === 'lock' && lockTarget) {
      // Souls: the camera puts you and the thing killing you in one shot.
      const target = toWorld(lockTarget.pos);
      const away = new THREE.Vector3().subVectors(smoothed, target).setY(0);
      if (away.lengthSq() < 0.01) away.set(0, 0, 1);
      away.normalize();
      yaw = Math.atan2(away.x, away.z); // look back down the lock line
      const boom = Math.max(2.4, fitInside(smoothed, away, 6.2));
      camera.position
        .copy(smoothed)
        .addScaledVector(away, boom)
        .setY(2 + boom * 0.26);
      keepInside(camera, 2);
      camera.lookAt(target.x, 1.4, target.z);
      return;
    }

    const forward = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));

    if (mode === 'first') {
      camera.position.copy(at).setY(EYE);
      camera.quaternion.setFromEuler(new THREE.Euler(pitch, yaw, 0, 'YXZ'));
      return;
    }

    if (mode === 'shoulder') {
      const right = new THREE.Vector3().crossVectors(forward, UP).normalize();
      const offset = forward.clone().multiplyScalar(4.6).addScaledVector(right, -1.1);
      const want = offset.length();
      const boom = Math.max(1.8, fitInside(smoothed, offset.clone().normalize(), want));
      camera.position
        .copy(smoothed)
        .addScaledVector(offset.normalize(), boom)
        .setY(EYE + 1.15 - pitch * 2.6);
      keepInside(camera);
      camera.quaternion.setFromEuler(new THREE.Euler(pitch, yaw, 0, 'YXZ'));
      return;
    }

    // orbit: the MMO camera, hanging back and above. The height follows
    // the boom, so a shortened boom is a lower camera rather than a
    // top-down one.
    const flat = 8.5 * Math.cos(-pitch);
    const boom = Math.max(1.8, fitInside(smoothed, forward, flat));
    camera.position
      .copy(smoothed)
      .addScaledVector(forward, boom)
      .setY(1.5 + boom * Math.tan(-pitch) * 1.15);
    keepInside(camera, 1.6);
    // Hold the rig's own pitch rather than staring at the character.
    // Looking AT them from a boom the wall has cut to a metre points the
    // camera almost straight down, and the boss leaves the screen.
    camera.quaternion.setFromEuler(new THREE.Euler(pitch, yaw, 0, 'YXZ'));
  }

  // Point the camera at the middle of the room when a pull starts,
  // rather than at whatever wall the character happens to be facing.
  function aimAtCentre(player, mode) {
    const at = toWorld(player.pos);
    // The camera looks along (-sin yaw, -cos yaw); to look at the middle
    // of the room from out here, that has to point back towards it.
    yaw = Math.atan2(at.x, at.z);
    pitch = mode === 'orbit' ? -0.42 : mode === 'shoulder' ? -0.12 : -0.04;
    started = false;
  }

  return {
    apply,
    look,
    aimAtCentre,
    aimPoint,
    get yaw() {
      return yaw;
    },
    set yaw(v) {
      yaw = v;
    },
    get pitch() {
      return pitch;
    },
  };
}
