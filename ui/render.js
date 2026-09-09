// Renderer. Reads a snapshot and writes the DOM. It never mutates state
// and the sim never imports this file -- that separation is what lets
// sim.js run the same encounter headlessly in Node.

const el = (id) => document.getElementById(id);
const pct = (a, b) => `${Math.max(0, Math.min(100, (a / b) * 100))}%`;
const num = (n) => Math.round(n).toLocaleString('en-US');
const clock = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const ROLE_LETTER = { tank: 'V', healer: 'M', dps: 'S', boss: '☠', add: 's' };

export function render(view, content) {
  renderBoss(view);
  renderFrames(view);
  renderGrid(view);
  renderActions(view, content);
  renderThreat(view);
  renderSide(view, content);
}

function renderBoss(view) {
  const b = view.boss;
  const enrageHot = view.enrageIn <= 30 || view.enraged;
  el('bossFrame').innerHTML = `
    <div>
      <div class="boss-name ttl">${b.name}<small>${b.title || ''}</small></div>
      <div class="phase-tag">${view.phaseName}${view.enraged ? ' · QUAD DAMAGE ACTIVE' : ''}</div>
      <div class="bar boss-hp" style="margin-top:5px">
        <i style="width:${pct(b.hp, b.maxHp)}"></i>
        <span><b>${num(b.hp)} / ${num(b.maxHp)}</b><b>${b.hpPct.toFixed(1)}%</b></span>
      </div>
      ${
        b.cast
          ? `<div class="bar cast ${b.cast.interruptible ? 'interruptible' : ''}">
               <i style="width:${pct(b.cast.progress, 1)}"></i>
               <span><b>${b.cast.name}${b.cast.interruptible ? ' — INTERRUPTIBLE' : ''}</b><b>${b.cast.remaining.toFixed(1)}s</b></span>
             </div>`
          : `<div class="bar cast" style="opacity:.25"><span></span></div>`
      }
    </div>
    <div class="enrage ${enrageHot ? 'hot' : ''}">
      <div class="phase-tag">${view.enraged ? 'Enraged' : 'Enrage in'}</div>
      <b>${view.enraged ? '00:00' : clock(view.enrageIn)}</b>
      <div class="phase-tag" style="margin-top:4px">pull ${clock(view.seconds)}</div>
    </div>`;
}

function renderFrames(view) {
  el('raidFrames').innerHTML = view.party
    .map((u) => {
      const you = u.id === view.playerId;
      return `
      <div class="frame ${you ? 'you' : ''} ${u.id === view.playerAllyTarget ? 'target' : ''} ${u.alive ? '' : 'dead'}" data-unit="${u.id}">
        <div class="frame-top"><b>${u.name}${you ? ' (you)' : ''}</b><em>${u.title || u.role}</em></div>
        <div class="bar hp"><i style="width:${pct(u.hp, u.maxHp)}"></i>
          <span><b>${u.alive ? num(u.hp) : 'DEAD'}</b><b>${u.alive ? Math.round(u.hpPct) + '%' : ''}</b></span></div>
        <div class="bar res"><i style="width:${pct(u.resource, u.maxResource)}"></i></div>
        <div class="pips">${u.auras.filter(visiblePip).map(pip).join('')}</div>
        <div class="castline">${u.cast ? `▸ ${u.cast.name} ${u.cast.remaining.toFixed(1)}s` : u.moving ? '▸ moving' : ''}</div>
      </div>`;
    })
    .join('');
}

// Permanent, helpful auras are role passives -- they are flavour, not information.
const visiblePip = (a) => a.harmful || a.remaining !== null;

function pip(a) {
  const cls = a.dispelType ? 'magic' : a.harmful ? 'harm' : 'help';
  const stacks = a.stacks > 1 ? ` ×${a.stacks}` : '';
  const time = a.remaining === null ? '' : ` ${Math.ceil(a.remaining)}`;
  return `<span class="pip ${cls}" title="${a.name}">${a.name.slice(0, 12)}${stacks}${time}</span>`;
}

function renderGrid(view) {
  const units = [...view.party, ...view.enemies];
  el('grid').innerHTML = view.cells
    .map((c) => {
      const h = c.hazard;
      const occupants = units
        .filter((u) => u.cell === c.index && u.alive)
        .map(
          (u) =>
            `<div class="token ${u.role} ${u.id === view.playerId ? 'you' : ''} ${u.moving ? 'moving' : ''}"
                  title="${u.name} — ${num(u.hp)}">${ROLE_LETTER[u.role] || '?'}</div>`
        )
        .join('');
      const tag = h ? (h.kind === 'split' ? 'STACK' : h.kind === 'soak' ? `SOAK ${h.minSoakers}+` : h.name) : '';
      return `<div class="cell ${h ? h.kind : ''}" data-cell="${c.index}">
        ${h ? `<div class="cd">${Math.max(0, h.remaining).toFixed(1)}</div>` : ''}
        ${occupants}
        ${h ? `<div class="tag">${tag}</div>` : ''}
      </div>`;
    })
    .join('');
}

function renderActions(view, content) {
  const player = view.party.find((u) => u.id === view.playerId);
  if (!player) return;
  el('actionBar').innerHTML = player.abilities
    .map((id, i) => {
      const a = content.abilities[id];
      const cd = player.cooldowns[id] || 0;
      const gcd = player.gcdRemaining / 10;
      const poor = player.resource < (a.cost || 0);
      const disabled = !player.alive || cd > 0 || poor;
      return `<button class="btn ${gcd > 0 && cd <= 0 ? 'gcd' : ''}" data-ability="${id}" ${disabled ? 'disabled' : ''}
        title="${a.name} — ${a.desc || ''}">
        <span class="key">${i + 1}</span>
        <span class="ic">${a.icon || '◆'}</span>
        <span class="nm">${a.name}</span>
        ${a.cost ? `<span class="cost" style="${poor ? 'color:#ff6b6b' : ''}">${a.cost}</span>` : ''}
        ${cd > 0 ? `<span class="sweep">${cd.toFixed(1)}</span>` : ''}
      </button>`;
    })
    .join('');
}

function renderThreat(view) {
  const boss = view.boss;
  const rows = Object.entries(boss.threat || {})
    .sort((a, b) => b[1] - a[1])
    .map(([id, v], i) => {
      const u = view.party.find((p) => p.id === id);
      if (!u) return '';
      return `<div class="threat ${i === 0 ? 'lead' : ''}"><b>${i === 0 ? '◆ ' : ''}${u.name}</b><span>${num(v / 1000)}k</span></div>`;
    })
    .join('');
  el('threatPanel').innerHTML = `<h3>Threat — ${boss.name}</h3>${rows || '<div class="threat">—</div>'}`;
}

function renderSide(view, content) {
  const adds = view.enemies.filter((u) => u.role === 'add' && u.alive);
  el('sidePanel').innerHTML = `
    <h3>Target</h3>
    <div class="enemy"><b>${(view.enemies.find((e) => e.id === view.playerTarget) || view.boss).name}</b></div>
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
}

export function renderEnd(view, content, stats) {
  const card = el('endCard');
  const won = view.result === 'kill';
  card.innerHTML = `
    <h1 style="${won ? '' : 'color:var(--blood)'}">${won ? 'Chthon Falls' : view.result === 'timeout' ? 'Out of Time' : 'Wipe'}</h1>
    <p>${
      won
        ? 'The pit closes. The strike team walks out.'
        : `The party is dead with Chthon at ${view.boss.hpPct.toFixed(1)}% health.`
    }</p>
    <div class="result-stats">
      <div><b>${clock(view.seconds)}</b><em>Duration</em></div>
      <div><b>${num(stats.playerDamage)}</b><em>Your damage</em></div>
      <div><b>${num(stats.playerHealing)}</b><em>Your healing</em></div>
    </div>
    <div class="keys">${stats.deaths.length ? stats.deaths.map((d) => `${d.name} — ${d.cause} at ${clock(d.tick / 10)}`).join('<br>') : 'Nobody died. Clean pull.'}</div>
    <button class="go" id="retryBtn" style="margin-top:16px">Pull Again</button>`;
  el('endOverlay').classList.remove('hide');
}
