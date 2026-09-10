// Mouse and keyboard for a 3D arena. Movement is camera-relative, aim is
// wherever the crosshair meets the floor, and the primary is HELD rather
// than tapped -- the single biggest fix for combat feeling like mashing.

const MOVE_KEYS = { w: [0, -1], a: [-1, 0], s: [0, 1], d: [1, 0] };

export function createControls(canvas, rig, getView, hooks) {
  const held = new Set();
  const state = { firing: false, blocking: false, locked: false, sensitivity: 1, holdFire: false };

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
  function moveDirection() {
    let x = 0;
    let y = 0;
    for (const key of held) {
      x += MOVE_KEYS[key][0];
      y += MOVE_KEYS[key][1];
    }
    if (!x && !y) return { x: 0, y: 0 };
    const sin = Math.sin(rig.yaw);
    const cos = Math.cos(rig.yaw);
    // The camera looks along (-sin, -cos), so W has to go that way too.
    // Screen-space (x right, y forward) rotated into arena space.
    return { x: y * sin - x * cos, y: x * sin + y * cos };
  }

  return {
    state,
    moveDirection,
    isFiring: () => state.firing,
    setSensitivity: (s) => (state.sensitivity = s),
    setHoldFire: (h) => (state.holdFire = h),
  };
}
