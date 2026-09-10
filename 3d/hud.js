// A heads-up display, not a control panel: the 2D build's frames and
// action bar, thinned down to what you can read while looking at a fight.

const el = (id) => document.getElementById(id);
const pct = (a, b) => `${Math.max(0, Math.min(100, (a / b) * 100))}%`;
const num = (n) => Math.round(n).toLocaleString('en-US');
const clock = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

export function createHud(content) {
  let built = null;

  function build(view) {
    el('frames').innerHTML = view.party
      .map(
        (u) => `<div class="f" data-u="${u.id}">
          <div class="fn"><b></b><i></i></div>
          <div class="fb"><span></span></div>
          <div class="fp"></div>
        </div>`
      )
      .join('');
    const player = view.party.find((u) => u.id === view.playerId);
    el('abilities').innerHTML = (player ? player.abilities : [])
      .map((id, i) => {
        const a = content.abilities[id];
        return `<div class="ab" data-a="${id}">
          <b>${i + 1}</b><span class="ic">${a.icon || '◆'}</span>
          <em>${a.name}</em><div class="cd"></div></div>`;
      })
      .join('');
    built = { playerId: view.playerId, ids: view.party.map((u) => u.id) };
  }

  function paint(view, extra = {}) {
    if (!built || built.playerId !== view.playerId) build(view);
    const player = view.party.find((u) => u.id === view.playerId);

    for (const u of view.party) {
      const node = el('frames').querySelector(`[data-u="${u.id}"]`);
      if (!node) continue;
      node.classList.toggle('dead', !u.alive);
      node.classList.toggle('me', u.id === view.playerId);
      node.querySelector('b').textContent = u.name;
      node.querySelector('i').textContent = u.alive ? `${Math.round(u.hpPct)}%` : 'DEAD';
      node.querySelector('.fb span').style.width = pct(u.hp, u.maxHp);
      const pips = u.auras.filter((a) => a.harmful || a.remaining !== null);
      node.querySelector('.fp').innerHTML = pips
        .map((a) => `<i class="${a.dispelType ? 'magic' : a.harmful ? 'harm' : 'help'}">${a.name.slice(0, 10)}</i>`)
        .join('');
    }

    const boss = view.boss;
    el('bossName').textContent = boss.name;
    el('bossFill').style.width = pct(boss.hp, boss.maxHp);
    el('bossPct').textContent = `${boss.hpPct.toFixed(1)}%`;
    const cast = boss.cast;
    el('bossCast').hidden = !cast;
    if (cast) {
      el('bossCast').classList.toggle('int', cast.interruptible);
      el('bossCastFill').style.width = pct(cast.progress, 1);
      el('bossCastName').textContent = cast.interruptible ? `${cast.name} — INTERRUPT` : cast.name;
    }
    el('enrage').textContent = view.enraged ? 'ENRAGED' : clock(view.enrageIn);
    el('enrage').classList.toggle('hot', view.enraged || view.enrageIn < 30);

    if (player) {
      el('hp').textContent = player.alive ? num(player.hp) : 'DEAD';
      el('hp').classList.toggle('hurt', !player.alive || player.hpPct < 35);
      el('ammoLbl').textContent = player.resourceName;
      el('ammoFill').style.width = pct(player.resource, player.maxResource);
      const ult = player.hasUltimate;
      el('ultWrap').hidden = !ult;
      if (ult) {
        el('ultFill').style.width = pct(player.ultimate, 100);
        el('ultWrap').classList.toggle('ready', player.ultimate >= 100);
        el('ultText').textContent = player.ultimate >= 100 ? 'READY' : `${player.ultimate}%`;
      }
      const stam = player.maxStamina > 0;
      el('stamWrap').hidden = !stam;
      if (stam) {
        el('stamFill').style.width = pct(player.stamina, player.maxStamina);
        el('stamWrap').classList.toggle('blocking', player.blocking);
      }
      for (const [id, node] of Object.entries(abilityNodes())) {
        const cd = player.cooldowns[id] || 0;
        const a = content.abilities[id];
        const short = a.ultimate ? player.ultimate < 100 : player.resource < (a.cost || 0);
        node.classList.toggle('off', !player.alive || cd > 0 || short);
        node.classList.toggle('ready', !!a.ultimate && player.ultimate >= 100);
        node.querySelector('.cd').textContent = cd > 0 ? cd.toFixed(1) : '';
      }
    }

    if (extra.lobby) {
      const { dps, hps } = extra.lobby;
      el('lobbyStats').textContent = hps > dps ? `${num(hps)} healing per second` : `${num(dps)} damage per second`;
    }
    el('padTag').hidden = !extra.pad;
    el('target').textContent = extra.targetName || '';
    el('mode').textContent = extra.modeName || '';
  }

  const abilityNodes = () =>
    Object.fromEntries([...el('abilities').children].map((n) => [n.dataset.a, n]));

  function reset() {
    built = null;
  }

  return { paint, reset };
}
