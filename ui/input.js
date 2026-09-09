// Two control philosophies over one sim. Both push the same input types
// into the same queue, consumed at phase 7 of the tick exactly like a bot
// decision -- the engine has no idea which scheme is driving it.
//
//   raid  — click to move, tab-target, abilities on a global cooldown
//   arena — WASD, mouse aim, no target lock, no casts
//
// Everything binds pointerdown rather than click: a press should register
// the instant it happens, not only if the pointer is still over the same
// element when it comes back up.

const ARENA_SIZE = 5;

export function createInput(queue, getView, hooks) {
  const state = { scheme: 'raid', mode: 'solo', held: new Set() };

  const push = (action) => {
    if (queue.length > 3) queue.shift();
    queue.push(action);
  };

  // Selection-style inputs replace a pending one instead of stacking up,
  // so a moving mouse can never flood the queue.
  const replace = (action) => {
    const i = queue.findIndex((q) => q.type === action.type);
    if (i >= 0) queue[i] = action;
    else queue.push(action);
  };

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
    if (state.scheme === 'raid') push({ type: 'move', pos: arenaPoint(e), unitId: getView()?.playerId });
    else fire(0); // click to fire your first weapon
  });

  grid.addEventListener('pointermove', (e) => {
    if (state.scheme !== 'arena') return;
    const p = arenaPoint(e);
    replace({ type: 'aim', x: p.x, y: p.y });
  });

  grid.addEventListener('contextmenu', (e) => e.preventDefault());

  /* ------------------------------------------------------ the panels */

  // Clicking a party member means "I want to drive you" when you command
  // the whole party, and "heal that one" when you are driving one slot.
  // Right-click is always the heal target.
  const frames = document.getElementById('raidFrames');
  frames.addEventListener('pointerdown', (e) => {
    const frame = e.target.closest('[data-unit]');
    if (!frame) return;
    const commanding = state.mode === 'commander';
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

  /* ------------------------------------------------------- keyboard */

  const fire = (slot) => {
    const view = getView();
    const player = view && view.party.find((u) => u.id === view.playerId);
    const abilityId = player && player.abilities[slot];
    if (abilityId) push({ type: 'cast', abilityId, unitId: player.id });
  };

  const MOVE_KEYS = { w: [0, -1], a: [-1, 0], s: [0, 1], d: [1, 0] };

  const sendHeldDirection = () => {
    let x = 0;
    let y = 0;
    for (const key of state.held) {
      x += MOVE_KEYS[key][0];
      y += MOVE_KEYS[key][1];
    }
    replace({ type: 'moveDir', x, y });
  };

  window.addEventListener('keydown', (e) => {
    const key = e.key.toLowerCase();

    if (e.key === ' ') {
      e.preventDefault();
      return hooks.togglePause();
    }
    if (key === 'r' && !e.repeat) return hooks.reset();

    // F1-F4 switch which character you are commanding.
    const partySlot = ['f1', 'f2', 'f3', 'f4'].indexOf(key);
    if (partySlot >= 0) {
      e.preventDefault();
      const view = getView();
      const id = view && view.playerIds[partySlot];
      if (id) push({ type: 'select', unitId: id });
      return;
    }

    if (state.scheme === 'arena' && MOVE_KEYS[key]) {
      e.preventDefault();
      if (!state.held.has(key)) {
        state.held.add(key);
        sendHeldDirection();
      }
      return;
    }

    if (e.key === 'Tab') {
      e.preventDefault();
      if (state.scheme !== 'raid') return; // the arena has no target lock
      const view = getView();
      if (!view) return;
      const enemies = view.enemies.filter((u) => u.alive);
      if (!enemies.length) return;
      const i = enemies.findIndex((u) => u.id === view.playerTarget);
      push({ type: 'targetEnemy', unitId: enemies[(i + 1) % enemies.length].id });
      return;
    }

    const slot = Number(e.key);
    if (slot >= 1 && slot <= 4) fire(slot - 1);
  });

  window.addEventListener('keyup', (e) => {
    const key = e.key.toLowerCase();
    if (state.held.delete(key)) sendHeldDirection();
  });

  // Releasing the window should not leave you running into the fire.
  window.addEventListener('blur', () => {
    if (!state.held.size) return;
    state.held.clear();
    sendHeldDirection();
  });

  // Clicking a token on the grid also picks who you are commanding.
  document.getElementById('tokens').addEventListener('pointerdown', (e) => {
    const token = e.target.closest('[data-unit]');
    if (token && state.mode === 'commander') push({ type: 'select', unitId: token.dataset.unit });
  });

  return {
    setScheme(scheme, mode) {
      state.scheme = scheme;
      state.mode = mode;
      state.held.clear();
    },
  };
}
