// Input is queued, never applied immediately -- the tick consumes one
// action at phase 7, exactly like a bot decision.
//
// Everything binds pointerdown rather than click: a press should register
// the instant it happens, not only if the pointer is still over the same
// element when it comes back up.

export function createInput(queue, getView, hooks) {
  const push = (action) => {
    if (queue.length > 3) queue.shift();
    queue.push(action);
  };

  document.getElementById('grid').addEventListener('pointerdown', (e) => {
    const cell = e.target.closest('[data-cell]');
    if (cell) push({ type: 'move', cell: Number(cell.dataset.cell) });
  });

  document.getElementById('raidFrames').addEventListener('pointerdown', (e) => {
    const frame = e.target.closest('[data-unit]');
    if (frame) push({ type: 'targetAlly', unitId: frame.dataset.unit });
  });

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

  window.addEventListener('keydown', (e) => {
    if (e.key === ' ') {
      e.preventDefault();
      hooks.togglePause();
      return;
    }
    if (e.key === 'r' || e.key === 'R') return hooks.reset();
    if (e.key === 'Tab') {
      e.preventDefault();
      const view = getView();
      if (!view) return;
      const enemies = view.enemies.filter((u) => u.alive);
      if (!enemies.length) return;
      const i = enemies.findIndex((u) => u.id === view.playerTarget);
      push({ type: 'targetEnemy', unitId: enemies[(i + 1) % enemies.length].id });
      return;
    }
    const slot = Number(e.key);
    if (slot >= 1 && slot <= 4) {
      const view = getView();
      const player = view && view.party.find((u) => u.id === view.playerId);
      const abilityId = player && player.abilities[slot - 1];
      if (abilityId) push({ type: 'cast', abilityId });
    }
  });
}
