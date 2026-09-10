// Mouse and keyboard for a 3D arena. Movement is camera-relative, aim is
// wherever the crosshair meets the floor, and the primary is HELD rather
// than tapped -- the single biggest fix for combat feeling like mashing.

const MOVE_KEYS = { w: [0, -1], a: [-1, 0], s: [0, 1], d: [1, 0] };

// Screen-space input (x right, y down/forward) into arena space, given
// where the camera is looking. The camera looks along
// forward = (-sin yaw, -cos yaw); its right hand is cross(forward, up)
// = (cos yaw, -sin yaw). Getting the sign of `right` wrong swaps A and D,
// which is exactly what it did -- hence the test.
export function cameraRelative(input, yaw) {
  const sin = Math.sin(yaw);
  const cos = Math.cos(yaw);
  return { x: input.y * sin + input.x * cos, y: input.y * cos - input.x * sin };
}

// Xbox-style layout. Anything reporting through the Gamepad API works.
const PAD = {
  a: 0, b: 1, x: 2, y: 3,
  lb: 4, rb: 5, lt: 6, rt: 7,
  back: 8, start: 9,
};

export function createControls(canvas, rig, getView, hooks) {
  const held = new Set();
  const state = { firing: false, blocking: false, locked: false, sensitivity: 1, holdFire: false, pad: false };
  const wasDown = {};

  canvas.addEventListener('click', () => {
    if (!state.locked) canvas.requestPointerLock();
  });
  document.addEventListener('pointerlockchange', () => {
    state.locked = document.pointerLockElement === canvas;
    hooks.onPointerLock(state.locked);
  });
  document.addEventListener('mousemove', (e) => {
    if (state.locked) rig.look(e.movementX, e.movementY, state.sensitivity);
  });

  canvas.addEventListener('mousedown', (e) => {
    if (!state.locked) return;
    if (e.button === 0) state.firing = true;
    if (e.button === 2) hooks.setBlocking(true);
  });
  window.addEventListener('mouseup', (e) => {
    if (e.button === 0) state.firing = false;
    if (e.button === 2) hooks.setBlocking(false);
  });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  window.addEventListener('keydown', (e) => {
    const key = e.key.toLowerCase();
    if (MOVE_KEYS[key]) {
      held.add(key);
      e.preventDefault();
      return;
    }
    if (key === 'control' || key === 'q') return hooks.setBlocking(true);
    if (key === 'shift' && !e.repeat) return hooks.dash();
    if (key === ' ') {
      e.preventDefault();
      return hooks.togglePause();
    }
    if (key === 'r' && !e.repeat) return hooks.reset();
    if (e.key === 'Tab') {
      e.preventDefault();
      return hooks.cycleTarget();
    }
    const slot = Number(e.key);
    if (slot >= 1 && slot <= 4) hooks.fire(slot - 1);
  });

  window.addEventListener('keyup', (e) => {
    const key = e.key.toLowerCase();
    held.delete(key);
    if (key === 'control' || key === 'q') hooks.setBlocking(false);
  });

  window.addEventListener('blur', () => {
    held.clear();
    state.firing = false;
    hooks.setBlocking(false);
  });

  // Movement is relative to where you are looking, which is the whole
  // reason a 3D camera changes how a fight plays.
  function moveDirection(stick) {
    let x = 0;
    let y = 0;
    if (stick) {
      x = stick.x;
      y = stick.y;
    } else {
      for (const key of held) {
        x += MOVE_KEYS[key][0];
        y += MOVE_KEYS[key][1];
      }
    }
    if (!x && !y) return { x: 0, y: 0 };
    return cameraRelative({ x, y }, rig.yaw);
  }

  /* -------------------------------------------------------- gamepad */

  // Polled once a frame rather than event-driven, which is how pads work.
  function pollGamepad(dt) {
    const pad = navigator.getGamepads && [...navigator.getGamepads()].find((p) => p && p.connected);
    state.pad = !!pad;
    if (!pad) return null;

    const dead = (v) => (Math.abs(v) < 0.18 ? 0 : v);
    const [lx, ly, rx, ry] = [dead(pad.axes[0]), dead(pad.axes[1]), dead(pad.axes[2]), dead(pad.axes[3])];

    // Right stick looks. Frame-rate independent, unlike a mouse delta.
    if (rx || ry) rig.look(rx * 900 * dt, ry * 700 * dt, state.sensitivity);

    const down = (i) => !!(pad.buttons[i] && pad.buttons[i].pressed);
    const pressed = (i) => {
      const now = down(i);
      const edge = now && !wasDown[i];
      wasDown[i] = now;
      return edge;
    };

    if (pressed(PAD.a)) hooks.fire(0);
    if (pressed(PAD.b)) hooks.fire(1);
    if (pressed(PAD.x)) hooks.fire(2);
    if (pressed(PAD.y)) hooks.fire(3);
    if (pressed(PAD.rb)) hooks.dash();
    if (pressed(PAD.lb)) hooks.cycleTarget();
    if (pressed(PAD.start)) hooks.togglePause();
    if (pressed(PAD.back)) hooks.reset();

    state.firing = down(PAD.rt);
    const wantBlock = down(PAD.lt);
    if (wantBlock !== state.padBlocking) {
      state.padBlocking = wantBlock;
      hooks.setBlocking(wantBlock);
    }

    return lx || ly ? { x: lx, y: ly } : null;
  }

  return {
    state,
    pollGamepad,
    moveDirection,
    isFiring: () => state.firing,
    setSensitivity: (s) => (state.sensitivity = s),
    setHoldFire: (h) => (state.holdFire = h),
  };
}
