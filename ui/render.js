// Renderer. Reads a snapshot and writes the DOM. It never mutates state
// and the sim never imports this file -- that separation is what lets
// sim.js run the same encounter headlessly in Node.
//
// The DOM is built once and updated in place. Rebuilding innerHTML at
// 10Hz would destroy every button between mousedown and mouseup, which
// silently eats clicks.

const el = (id) => document.getElementById(id);
const pct = (a, b) => `${Math.max(0, Math.min(100, (a / b) * 100))}%`;
const num = (n) => Math.round(n).toLocaleString('en-US');
const clock = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const ROLE_LETTER = { tank: 'V', healer: 'M', dps: 'S', boss: '☠', add: 's' };

const setText = (node, text) => {
  if (node.textContent !== text) node.textContent = text;
};
const setWidth = (node, width) => {
  if (node.style.width !== width) node.style.width = width;
};
const setClass = (node, name, on) => node.classList.toggle(name, !!on);

let R = null;

export function render(view, content, hud = {}) {
  if (!R || R.playerId !== view.playerId || R.mode !== view.mode.id) R = build(view, content);
  paintBoss(view);
  paintFrames(view, hud);
  paintGrid(view);
  paintActions(view, content, hud);
  paintThreat(view);
  paintSide(view);
}

export function resetRenderer() {
  R = null;
}

/* ----------------------------------------------------------- one-time */

function build(view, content) {
  const refs = { playerId: view.playerId, mode: view.mode.id, frames: new Map(), tokens: new Map(), buttons: new Map() };

  el('bossFrame').innerHTML = `
    <div>
      <div class="boss-name ttl"><span data-r="name"></span><small data-r="title"></small></div>
      <div class="phase-tag" data-r="phase"></div>
      <div class="bar boss-hp" style="margin-top:5px">
        <i data-r="hpFill"></i><span><b data-r="hpText"></b><b data-r="hpPct"></b></span>
      </div>
      <div class="bar cast" data-r="cast">
        <i data-r="castFill"></i><span><b data-r="castName"></b><b data-r="castTime"></b></span>
      </div>
    </div>
    <div class="enrage" data-r="enrage">
      <div class="phase-tag" data-r="enrageLabel"></div>
      <b data-r="enrageTime"></b>
      <div class="phase-tag" style="margin-top:4px" data-r="pullTime"></div>
    </div>`;
  refs.boss = collect(el('bossFrame'));

  const frames = el('raidFrames');
  frames.innerHTML = '';
  for (const u of view.party) {
    const node = document.createElement('div');
    node.className = 'frame';
    node.dataset.unit = u.id;
    node.innerHTML = `
      <div class="frame-top"><b data-r="name"></b><em data-r="title"></em></div>
      <div class="bar hp"><i data-r="hpFill"></i><span><b data-r="hpText"></b><b data-r="hpPct"></b></span></div>
      <div class="bar res"><i data-r="resFill"></i></div>
      <div class="pips" data-r="pips"></div>
      <div class="castline" data-r="cast"></div>`;
    frames.appendChild(node);
    refs.frames.set(u.id, { node, ...collect(node) });
  }

  const tiles = el('tiles');
  tiles.innerHTML = '';
  refs.cells = Array.from({ length: 25 }, (_, index) => {
    const node = document.createElement('div');
    node.className = 'cell';
    node.dataset.cell = index;
    node.innerHTML = '<div class="cd" data-r="cd"></div><div class="tag" data-r="tag"></div>';
    tiles.appendChild(node);
    return { node, ...collect(node) };
  });
  el('tokens').innerHTML = '';

  buildBar(refs);

  return refs;
}

function buildBar(refs) {
  const bar = el('actionBar');
  // Laid out like Quake's status bar: a big gold health readout, then
  // ammo, then what you are pointed at.
  bar.innerHTML = `
    <div class="hudstrip" data-r="strip">
      <div class="lbl">Health</div>
      <div class="big" data-r="health">—</div>
      <div class="lbl ammo" data-r="resName"></div>
      <div class="bar"><i data-r="resFill"></i><span><b data-r="resText"></b></span></div>
      <div class="lbl" data-r="stamLbl" hidden>Stamina</div>
      <div class="bar stam" data-r="stamBar" hidden><i data-r="stamFill"></i></div>
      <div class="lbl ult" data-r="ultLbl" hidden>Ultimate</div>
      <div class="bar ult" data-r="ultBar" hidden><i data-r="ultFill"></i><span><b data-r="ultText"></b></span></div>
      <div class="tgt" data-r="tgt"></div>
    </div>
    <div class="btns" data-r="btns"></div>`;
  refs.hud = collect(bar);
}

// The four buttons belong to whichever unit you are driving right now.
function buildButtons(view, content, player) {
  R.buttons = new Map();
  R.hud.btns.innerHTML = '';
  player.abilities.forEach((id, i) => {
    const a = content.abilities[id];
    const btn = document.createElement('button');
    btn.className = 'btn';
    btn.type = 'button';
    btn.dataset.ability = id;
    btn.title = `${a.name} — ${a.desc || ''}`;
    btn.innerHTML = `
      <span class="key">${i + 1}</span>
      <span class="ic">${a.icon || '◆'}</span>
      <span class="nm">${a.name}</span>
      ${a.cost ? `<span class="cost" data-r="cost">${a.cost}</span>` : ''}
      <span class="sweep" data-r="sweep" hidden></span>`;
    R.hud.btns.appendChild(btn);
    R.buttons.set(id, { node: btn, ...collect(btn) });
  });
}

// Map every [data-r] descendant to a named reference.
function collect(root) {
  const out = {};
  for (const node of root.querySelectorAll('[data-r]')) out[node.dataset.r] = node;
  return out;
}

/* -------------------------------------------------------------- paint */

function paintBoss(view) {
  const b = view.boss;
  const r = R.boss;
  setText(r.name, b.name);
  setText(r.title, b.title || '');
  setText(r.phase, `${view.phaseName}${view.enraged ? ' · QUAD DAMAGE ACTIVE' : ''}`);
  setWidth(r.hpFill, pct(b.hp, b.maxHp));
  setText(r.hpText, `${num(b.hp)} / ${num(b.maxHp)}`);
  setText(r.hpPct, `${b.hpPct.toFixed(1)}%`);

  const cast = b.cast;
  r.cast.style.opacity = cast ? '1' : '.25';
  setClass(r.cast, 'interruptible', cast && cast.interruptible);
  setWidth(r.castFill, cast ? pct(cast.progress, 1) : '0%');
  setText(r.castName, cast ? `${cast.name}${cast.interruptible ? ' — INTERRUPTIBLE' : ''}` : '');
  setText(r.castTime, cast ? `${cast.remaining.toFixed(1)}s` : '');

  setClass(r.enrage, 'hot', view.enraged || view.enrageIn <= 30);
  setText(r.enrageLabel, view.enraged ? 'Enraged' : 'Enrage in');
  setText(r.enrageTime, view.enraged ? '00:00' : clock(view.enrageIn));
  setText(r.pullTime, `pull ${clock(view.seconds)}`);
}

function paintFrames(view, hud) {
  for (const u of view.party) {
    const r = R.frames.get(u.id);
    if (!r) continue;
    const slot = view.playerIds.indexOf(u.id);
    setText(r.name, view.mode.control === 'all' && slot >= 0 ? `F${slot + 1} ${u.name}` : u.name);
    setText(r.title, u.title || u.role);
    setWidth(r.hpFill, pct(u.hp, u.maxHp));
    setText(r.hpText, u.alive ? num(u.hp) : 'DEAD');
    setText(r.hpPct, u.alive ? `${Math.round(u.hpPct)}%` : '');
    setWidth(r.resFill, pct(u.resource, u.maxResource));
    setClass(r.node, 'you', u.id === view.playerId);
    setClass(r.node, 'mine', view.playerIds.includes(u.id) && u.id !== view.playerId);
    setClass(r.node, 'dead', !u.alive);
    setClass(r.node, 'target', u.id === activeAllyTarget(view));
    setClass(r.node, 'auto-target', !activeAllyTarget(view) && u.id === hud.autoHealTarget);
    setText(r.cast, u.cast ? `▸ ${u.cast.name} ${u.cast.remaining.toFixed(1)}s` : u.moving ? '▸ moving' : '');

    const auras = u.auras.filter(visiblePip);
    const sig = auras.map((a) => `${a.id}${a.stacks}${Math.ceil(a.remaining ?? 0)}`).join('|');
    if (r.pips.dataset.sig !== sig) {
      r.pips.dataset.sig = sig;
      r.pips.innerHTML = auras.map(pip).join('');
    }
  }
}

const activeUnit = (view) => view.party.find((u) => u.id === view.playerId) || null;
const activeAllyTarget = (view) => (activeUnit(view) || {}).allyTargetId || null;

// Permanent, helpful auras are role passives -- flavour, not information.
const visiblePip = (a) => a.harmful || a.remaining !== null;

function pip(a) {
  const cls = a.dispelType ? 'magic' : a.harmful ? 'harm' : 'help';
  const stacks = a.stacks > 1 ? ` ×${a.stacks}` : '';
  const time = a.remaining === null ? '' : ` ${Math.ceil(a.remaining)}`;
  return `<span class="pip ${cls}" title="${a.name}">${a.name.slice(0, 12)}${stacks}${time}</span>`;
}

function paintGrid(view) {
  // Hazards are areas with a position; the floor tile they sit on is a
  // rendering detail worked out here, not something the sim knows about.
  const byCell = new Map();
  for (const h of view.hazards) byCell.set(cellIndexOf(h), h);

  for (let i = 0; i < R.cells.length; i++) {
    const r = R.cells[i];
    const h = byCell.get(i);
    setClass(r.node, 'blast', h && h.kind === 'blast');
    setClass(r.node, 'split', h && h.kind === 'split');
    setClass(r.node, 'soak', h && h.kind === 'soak');
    setText(r.cd, h && !view.hideTimers ? Math.max(0, h.remaining).toFixed(1) : '');
    // Only the mechanics that ask something of you get a label; a lava
    // tile is self-explanatory once you have stood in one.
    setText(r.tag, h && h.kind === 'split' ? 'STACK' : h && h.kind === 'soak' ? `SOAK ${h.minSoakers}+` : '');
  }

  const layer = el('tokens');
  for (const u of [...view.party, ...view.enemies]) {
    let token = R.tokens.get(u.id);
    if (!token) {
      token = document.createElement('div');
      token.className = `token ${u.role}`;
      token.dataset.unit = u.id;
      token.innerHTML = `<span>${ROLE_LETTER[u.role] || '?'}</span><i class="aim" hidden></i>`;
      layer.appendChild(token);
      R.tokens.set(u.id, token);
    }
    token.hidden = !u.alive;
    token.title = `${u.name} — ${num(u.hp)}`;
    setClass(token, 'you', u.id === view.playerId);
    setClass(token, 'mine', view.playerIds.includes(u.id) && u.id !== view.playerId);
    setClass(token, 'moving', u.moving);
    setClass(token, 'blocking', u.blocking);
    token.style.left = `${(u.pos.x / 5) * 100}%`;
    token.style.top = `${(u.pos.y / 5) * 100}%`;
    // A facing pip, so the arena scheme shows where you are pointing.
    const pip = token.querySelector('.aim');
    const showAim = u.id === view.playerId && view.style.aim !== 'target';
    pip.hidden = !showAim;
    if (showAim) {
      pip.style.left = `${10 + u.facing.x * 11}px`;
      pip.style.top = `${10 + u.facing.y * 11}px`;
    }
  }

  // Healing fields are friendly ground: drawn under the tokens.
  const layerFields = el('fields');
  const sig = view.fields.map((f) => `${f.x.toFixed(1)},${f.y.toFixed(1)},${f.half}`).join('|');
  if (layerFields.dataset.sig !== sig) {
    layerFields.dataset.sig = sig;
    layerFields.innerHTML = view.fields
      .map(
        (f) => `<div class="field" style="left:${(f.x / 5) * 100}%; top:${(f.y / 5) * 100}%;
          width:${(f.half * 2 * 100) / 5}%; height:${(f.half * 2 * 100) / 5}%"></div>`
      )
      .join('');
  }

  const cross = el('crosshair');
  if (view.style.aim !== 'target' && !view.over) {
    cross.hidden = false;
    cross.style.left = `${(view.aim.x / 5) * 100}%`;
    cross.style.top = `${(view.aim.y / 5) * 100}%`;
  } else {
    cross.hidden = true;
  }
}

const cellIndexOf = (p) =>
  Math.min(4, Math.max(0, Math.floor(p.y))) * 5 + Math.min(4, Math.max(0, Math.floor(p.x)));

function paintActions(view, content, hud) {
  const player = activeUnit(view);
  const bar = el('actionBar');
  bar.hidden = !player;
  if (!player) return;
  // In commander mode the bar follows whoever you are currently driving.
  if (R.barFor !== player.id) {
    buildButtons(view, content, player);
    R.barFor = player.id;
  }

  const h = R.hud;
  setText(h.health, player.alive ? num(player.hp) : 'DEAD');
  setClass(h.health, 'hurt', !player.alive || player.hpPct < 35);
  setText(h.resName, player.resourceName);
  // Stamina only exists when the style has something to spend it on.
  const hasUlt = player.hasUltimate;
  h.ultLbl.hidden = !hasUlt;
  h.ultBar.hidden = !hasUlt;
  if (hasUlt) {
    setWidth(h.ultFill, pct(player.ultimate, 100));
    setText(h.ultText, player.ultimate >= 100 ? 'READY' : `${player.ultimate}%`);
    setClass(h.ultBar, 'ready', player.ultimate >= 100);
    setClass(h.ultLbl, 'ready', player.ultimate >= 100);
  }
  const hasStamina = player.maxStamina > 0;
  h.stamLbl.hidden = !hasStamina;
  h.stamBar.hidden = !hasStamina;
  if (hasStamina) {
    setWidth(h.stamFill, pct(player.stamina, player.maxStamina));
    setClass(h.stamBar, 'blocking', player.blocking);
  }
  setText(h.resText, `${player.resource} / ${player.maxResource}`);
  setWidth(h.resFill, pct(player.resource, player.maxResource));
  setClass(h.strip, 'dry', player.resource < 12);
  // What this ability set is pointed at, in the terms the scheme uses.
  if (view.style.aim === 'crosshair') {
    setText(h.tgt, '▸ crosshair');
  } else if (player.role === 'healer') {
    const ally = view.party.find((u) => u.id === view.playerAllyTarget);
    const auto = view.party.find((u) => u.id === hud.autoHealTarget);
    setText(h.tgt, ally ? `▸ ${ally.name}` : auto ? `▸ ${auto.name} (auto)` : '');
  } else {
    const foe = view.enemies.find((e) => e.id === player.targetId);
    setText(h.tgt, foe ? `▸ ${foe.name}` : '');
  }

  for (const [id, r] of R.buttons) {
    const a = content.abilities[id];
    const cd = player.cooldowns[id] || 0;
    const poor = player.resource < (a.cost || 0);
    setClass(r.node, 'off', !player.alive || cd > 0 || poor);
    setClass(r.node, 'gcd', player.gcdRemaining > 0 && cd <= 0);
    setClass(r.node, 'queued', hud.queued === id);
    setClass(r.node, 'ready', !!a.ultimate && player.ultimate >= 100);
    if (r.cost) r.cost.style.color = poor ? '#ff6b6b' : '';
    r.sweep.hidden = cd <= 0;
    if (cd > 0) setText(r.sweep, cd.toFixed(1));
  }
}

function paintThreat(view) {
  const rows = Object.entries(view.boss.threat || {})
    .sort((a, b) => b[1] - a[1])
    .map(([id, v], i) => {
      const u = view.party.find((p) => p.id === id);
      if (!u) return '';
      return `<div class="threat ${i === 0 ? 'lead' : ''}"><b>${i === 0 ? '◆ ' : ''}${u.name}</b><span>${num(v / 1000)}k</span></div>`;
    })
    .join('');
  const html = `<h3>Threat — ${view.boss.name}</h3>${rows || '<div class="threat">—</div>'}`;
  const node = el('threatPanel');
  if (node.dataset.sig !== html) {
    node.dataset.sig = html;
    node.innerHTML = html;
  }
}

function paintSide(view) {
  const adds = view.enemies.filter((u) => u.role === 'add' && u.alive);
  const target = view.enemies.find((e) => e.id === (activeUnit(view) || {}).targetId) || view.boss;
  const html = `
    <h3>Target</h3>
    <div class="enemy"><b>${target.name}</b> <span style="color:var(--dim)">${Math.round(target.hpPct)}%</span></div>
    <h3>Adds</h3>
    ${
      adds.length
        ? adds
            .map(
              (a) => `<div class="enemy" data-enemy="${a.id}" style="cursor:pointer">
        <b>${a.name}</b>
        <div class="bar hp" style="height:12px"><i style="width:${pct(a.hp, a.maxHp)}"></i>
          <span><b>${Math.round(a.hpPct)}%</b></span></div></div>`
            )
            .join('')
        : '<div class="threat">none</div>'
    }
    <h3 style="margin-top:10px">Ground</h3>
    <div class="legend">
      <div><span class="k" style="color:var(--fire)">▲</span> Lava Geyser — get out before the timer hits zero.</div>
      <div><span class="k" style="color:var(--void)">⛓</span> Chain of Souls — everyone into that tile, it splits.</div>
      <div><span class="k" style="color:var(--soak)">◎</span> Void Well — two bodies minimum or the raid eats it.</div>
      <div><span class="k" style="color:#8be2ff">⚡</span> Blue cast bar — interrupt it.</div>
      <div><span class="k" style="color:#9ec8ff">☣</span> Blue pip — dispel it.</div>
    </div>`;
  const node = el('sidePanel');
  if (node.dataset.sig !== html) {
    node.dataset.sig = html;
    node.innerHTML = html;
  }
}

/* ------------------------------------------------------------- the end */

export function renderEnd(view, content, stats) {
  const won = view.result === 'kill';
  const title = stats.title || (won ? 'Chthon Falls' : view.result === 'timeout' ? 'Out of Time' : 'Wipe');
  const subtitle =
    stats.subtitle ||
    (won
      ? 'The pit closes. The strike team walks out.'
      : `The party is dead with Chthon at ${view.boss.hpPct.toFixed(1)}% health.`);
  const scoreboard = stats.scoreboard || [
    [clock(view.seconds), 'Duration'],
    [num(stats.playerDamage), 'Your damage'],
    [num(stats.playerHealing), 'Your healing'],
  ];

  el('endCard').innerHTML = `
    <h1 style="${won || stats.title ? '' : 'color:var(--blood)'}">${title}</h1>
    <p>${subtitle}</p>
    <div class="result-stats">
      ${scoreboard.map(([value, label]) => `<div><b>${value}</b><em>${label}</em></div>`).join('')}
    </div>
    <div class="keys">${
      stats.deaths.length
        ? stats.deaths.map((d) => `${d.name} — ${d.cause} at ${clock(d.tick / 10)}`).join('<br>')
        : 'Nobody died. Clean pull.'
    }</div>
    <button class="go" id="retryBtn" style="margin-top:16px">Again</button>`;
  el('endOverlay').classList.remove('hide');
}
