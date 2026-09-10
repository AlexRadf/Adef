// Input, split along the same axes as the styles. Everything pushes the
// same input types into the same queue, consumed at phase 7 of the tick
// exactly like a bot decision -- the engine has no idea which style is
// driving it.
//
//   movement  click to walk, or WASD, plus a dash on Shift
//   combat    tab-target, crosshair, or lock-on
//   healing   frames, crosshair, smart, or fields placed on the ground
//   tanking   threat and taunts, or block held on Ctrl / right mouse
//
// Everything binds pointerdown rather than click: a press should register
// the instant it happens, not only if the pointer is still over the same
// element when it comes back up.

const ARENA_SIZE = 5;
const MOVE_KEYS = { w: [0, -1], a: [-1, 0], s: [0, 1], d: [1, 0] };

export function createInput(queue, getView, hooks) {
  const held = new Set();
  let blocking = false;

  const push = (action) => {
    if (queue.length > 3) queue.shift();
    queue.push(action);
  };

  // Selection-style inputs replace a pending one rather than stacking, so
  // a moving mouse can never flood the queue.
  const replace = (action) => {
    const i = queue.findIndex((q) => q.type === action.type);
    if (i >= 0) queue[i] = action;
    else queue.push(action);
  };

  const style = () => (getView() || {}).style || {};
  const usesWasd = () => style().movement !== 'click';

  const grid = document.getElementById('grid');
  const arenaPoint = (event) => {
    const box = grid.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(ARENA_SIZE, ((event.clientX - box.left) / box.width) * ARENA_SIZE)),
      y: Math.max(0, Math.min(ARENA_SIZE, ((event.clientY - box.top) / box.height) * ARENA_SIZE)),
    };
  };

  /* ------------------------------------------------------ the arena */

  grid.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (e.button === 2) return setBlocking(true);
    const view = getView();
    if (!usesWasd()) push({ type: 'move', pos: arenaPoint(e), unitId: view && view.playerId });
    else fire(0);
  });
  grid.addEventListener('pointerup', (e) => {
    if (e.button === 2) setBlocking(false);
  });
  // The crosshair is always live: ground-targeted heals need it even when
  // the combat style does not.
  grid.addEventListener('pointermove', (e) => {
    const p = arenaPoint(e);
    replace({ type: 'aim', x: p.x, y: p.y });
  });
  grid.addEventListener('contextmenu', (e) => e.preventDefault());

  /* ------------------------------------------------------ the panels */

  const frames = document.getElementById('raidFrames');
  frames.addEventListener('pointerdown', (e) => {
    const frame = e.target.closest('[data-unit]');
    if (!frame) return;
    const commanding = ((getView() || {}).mode || {}).control === 'all';
    if (e.button === 2 || !commanding) push({ type: 'targetAlly', unitId: frame.dataset.unit });
    else push({ type: 'select', unitId: frame.dataset.unit });
  });
  frames.addEventListener('contextmenu', (e) => e.preventDefault());

  document.getElementById('sidePanel').addEventListener('pointerdown', (e) => {
    const enemy = e.target.closest('[data-enemy]');
    if (enemy) push({ type: 'targetEnemy', unitId: enemy.dataset.enemy });
  });

  document.getElementById('actionBar').addEventListener('pointerdown', (e) => {
    const btn = e.target.closest('[data-ability]');
    if (!btn) return;
    e.preventDefault(); // keep focus off the button so 1-4 keep working
    push({ type: 'cast', abilityId: btn.dataset.ability });
  });

  document.getElementById('tokens').addEventListener('pointerdown', (e) => {
    const token = e.target.closest('[data-unit]');
    if (token && ((getView() || {}).mode || {}).control === 'all') {
      push({ type: 'select', unitId: token.dataset.unit });
    }
  });

  /* ------------------------------------------------------- keyboard */

  const fire = (slot) => {
    const view = getView();
    const player = view && view.party.find((u) => u.id === view.playerId);
    const abilityId = player && player.abilities[slot];
    if (abilityId) push({ type: 'cast', abilityId, unitId: player.id });
  };

  const sendHeldDirection = () => {
    let x = 0;
    let y = 0;
    for (const key of held) {
      x += MOVE_KEYS[key][0];
      y += MOVE_KEYS[key][1];
    }
    replace({ type: 'moveDir', x, y });
  };

  function setBlocking(on) {
    if (!style().blocking || blocking === on) return;
    blocking = on;
    push({ type: 'block', on });
  }

  window.addEventListener('keydown', (e) => {
    const key = e.key.toLowerCase();

    if (e.key === ' ') {
      e.preventDefault();
      return hooks.togglePause();
    }
    if (key === 'r' && !e.repeat) return hooks.reset();
    if (key === 'control') return setBlocking(true);

    // Shift is the dash, when the movement style has one.
    if (key === 'shift' && !e.repeat && style().dash) {
      e.preventDefault();
      return push({ type: 'dash' });
    }

    if (usesWasd() && MOVE_KEYS[key]) {
      e.preventDefault();
      if (!held.has(key)) {
        held.add(key);
        sendHeldDirection();
      }
      return;
    }

    const partySlot = ['f1', 'f2', 'f3', 'f4'].indexOf(key);
    if (partySlot >= 0) {
      e.preventDefault();
      const view = getView();
      const id = view && view.playerIds[partySlot];
      if (id) push({ type: 'select', unitId: id });
      return;
    }

    if (e.key === 'Tab') {
      e.preventDefault();
      if (style().aim === 'crosshair') return; // no target lock to cycle
      const view = getView();
      if (!view) return;
      const enemies = view.enemies.filter((u) => u.alive);
      if (!enemies.length) return;
      const me = view.party.find((u) => u.id === view.playerId);
      const i = enemies.findIndex((u) => u.id === (me && me.targetId));
      push({ type: 'targetEnemy', unitId: enemies[(i + 1) % enemies.length].id });
      return;
    }

    const slot = Number(e.key);
    if (slot >= 1 && slot <= 4) fire(slot - 1);
  });

  window.addEventListener('keyup', (e) => {
    const key = e.key.toLowerCase();
    if (key === 'control') setBlocking(false);
    if (held.delete(key)) sendHeldDirection();
  });

  // Releasing the window should not leave you running into the fire.
  window.addEventListener('blur', () => {
    setBlocking(false);
    if (!held.size) return;
    held.clear();
    sendHeldDirection();
  });
}
