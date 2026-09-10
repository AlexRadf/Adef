// A heads-up display, not a control panel: the 2D build's frames and
// action bar, thinned down to what you can read while looking at a fight.
//
// Everything mode-specific is driven by `view.rules`, which the sim
// fills in from the game's rule block. A new mode gets its panel by
// declaring a rule, not by adding a branch to the renderer.

const el = (id) => document.getElementById(id);
const pct = (a, b) => `${Math.max(0, Math.min(100, (a / b) * 100))}%`;
const num = (n) => Math.round(n).toLocaleString('en-US');
const clock = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

export function createHud(content) {
  let built = null;
  let lastFeed = 0;

  function build(view) {
    el('frames').innerHTML = view.party
      .map(
        (u) => `<div class="f plate" data-u="${u.id}">
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
    // Threat and team-ultimate panels are one row per party member.
    el('threatRows').innerHTML = view.party
      .map((u) => `<div class="tr" data-u="${u.id}"><b></b><div class="trb"><span></span></div><i></i></div>`)
      .join('');
    el('ultRows').innerHTML = view.party
      .map((u) => `<div class="tr" data-u="${u.id}"><b></b><div class="trb ult"><span></span></div><i></i></div>`)
      .join('');
    built = { playerId: view.playerId, ids: view.party.map((u) => u.id) };
    lastFeed = 0;
  }

  function paint(view, extra = {}) {
    if (!built || built.playerId !== view.playerId) build(view);
    const player = view.party.find((u) => u.id === view.playerId);
    const rules = view.rules || {};

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
    // A practice dummy has no enrage timer, and showing one that reads
    // 1666:36 teaches nothing.
    el('enrage').hidden = !!extra.lobby || view.enrageIn > 3600;
    el('enrage').textContent = view.enraged ? 'ENRAGED' : clock(view.enrageIn);
    el('enrage').classList.toggle('hot', view.enraged || view.enrageIn < 30);

    paintPoise(view, rules);
    paintThreat(view, rules);
    paintUlts(view, rules);
    paintItems(view);
    paintUpcoming(view);
    paintFeed(view);

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
      // Heat (Overload) and momentum (Slipgate) are the two meters that
      // only exist in one mode each, and they say what that mode is for.
      el('heatWrap').hidden = !player.heat;
      if (player.heat) {
        el('heatFill').style.width = pct(player.heat.heat, player.heat.max);
        el('heatWrap').classList.toggle('locked', player.heat.locked);
        el('heatText').textContent = player.heat.locked ? 'VENTING' : '';
      }
      el('moWrap').hidden = !rules.momentum;
      if (rules.momentum) {
        const t = Math.min(1, player.momentum / 22);
        el('moFill').style.width = `${t * 100}%`;
        el('moText').textContent = `+${Math.round(t * 18)}%`;
      }
      for (const [id, node] of Object.entries(abilityNodes())) {
        const cd = player.cooldowns[id] || 0;
        const a = content.abilities[id];
        const short = a.ultimate ? player.ultimate < 100 : player.resource < (a.cost || 0);
        const vented = !!player.heat && player.heat.locked && !a.ultimate;
        node.classList.toggle('off', !player.alive || cd > 0 || short || vented);
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
    el('practiceTag').hidden = !extra.practiceLabel;
    el('practiceTag').textContent = extra.practiceLabel || '';
  }

  /* ------------------------------------------------- mode-only panels */

  // The Pit: a guard bar. It is the reason to go round the back and the
  // reason to hold the parry, so it sits where you are already looking.
  function paintPoise(view, rules) {
    const on = rules.poiseMax > 0;
    el('poiseWrap').hidden = !on;
    if (!on) return;
    const staggered = view.boss.auras.some((a) => a.id === 'staggered' || a.name === 'Staggered');
    el('poiseFill').style.width = pct(view.boss.poise, rules.poiseMax);
    el('poiseWrap').classList.toggle('broken', staggered);
    el('poiseText').textContent = staggered ? 'GUARD BROKEN' : 'Guard';
  }

  // Azeroth: threat, as a fraction of whoever is holding it. The number
  // a WoW player actually plays against.
  function paintThreat(view, rules) {
    el('threat').hidden = !rules.threatMeter;
    if (!rules.threatMeter || !view.boss.threat) return;
    const threat = view.boss.threat;
    const top = Math.max(1, ...view.party.map((u) => threat[u.id] || 0));
    for (const u of view.party) {
      const row = el('threatRows').querySelector(`[data-u="${u.id}"]`);
      if (!row) continue;
      const share = (threat[u.id] || 0) / top;
      row.querySelector('b').textContent = u.name;
      row.querySelector('.trb span').style.width = `${share * 100}%`;
      row.querySelector('i').textContent = `${Math.round(share * 100)}%`;
      row.classList.toggle('pull', u.role !== 'tank' && share > 0.9);
      row.classList.toggle('lead', u.id === (view.boss.targetId || ''));
    }
  }

  // Overload: everyone's ultimate, because the whole mode is about
  // spending two of them in the same second.
  function paintUlts(view, rules) {
    el('ults').hidden = !rules.ultCombo;
    if (!rules.ultCombo) return;
    for (const u of view.party) {
      const row = el('ultRows').querySelector(`[data-u="${u.id}"]`);
      if (!row) continue;
      row.querySelector('b').textContent = u.name;
      row.querySelector('.trb span').style.width = pct(u.ultimate, 100);
      row.querySelector('i').textContent = u.ultimate >= 100 ? 'READY' : `${u.ultimate}%`;
      row.classList.toggle('live', !!u.ultActive);
      row.classList.toggle('pull', u.ultimate >= 100);
    }
    el('comboTag').hidden = (rules.combo || 0) < 2;
    el('comboTag').textContent = `OVERLOADED ×${rules.combo}`;
  }

  // Slipgate: item timers. Knowing the clock IS the map knowledge.
  function paintItems(view) {
    const items = view.pickups || [];
    el('items').hidden = !items.length;
    if (!items.length) return;
    el('items').innerHTML = items
      .map(
        (p) => `<div class="it ${p.ready ? 'up' : ''}"><b>${p.name}</b><i>${
          p.ready ? 'UP' : `${p.in.toFixed(0)}s`
        }</i></div>`
      )
      .join('');
  }

  // What is coming and when. The single biggest difference between
  // "learning a fight" and "being surprised by a fight".
  function paintUpcoming(view) {
    const list = view.hideTimers ? [] : view.upcoming || [];
    el('upcoming').hidden = !list.length;
    if (!list.length) return;
    el('upcoming').innerHTML = list
      .map(
        (u) => `<div class="up ${u.in < 2 ? 'soon' : ''}"><b>${u.name}</b><i>${u.in.toFixed(1)}s</i></div>`
      )
      .join('');
  }

  function paintFeed(view) {
    const feed = view.feed || [];
    const newest = feed.length ? feed[feed.length - 1].seq : 0;
    if (newest === lastFeed) return;
    lastFeed = newest;
    el('feed').innerHTML = feed
      .slice(-5)
      .map((l) => `<div class="fl ${l.kind}">${l.text}</div>`)
      .join('');
  }

  const abilityNodes = () =>
    Object.fromEntries([...el('abilities').children].map((n) => [n.dataset.a, n]));

  function reset() {
    built = null;
  }

  return { paint, reset };
}
