// Every screen the hub opens, drawn into one modal. Plain template
// strings and one delegated click handler: each button carries a
// data-act, and the caller's `actions` table decides what it does.

import { SLOTS, RARITY, bountyText, bountyGoal, MAX_POWER, BOUNTY_POOL } from './progress.js';

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const rarity = (id) => RARITY.find((r) => r.id === id) || RARITY[0];
const ROLE_NAME = { tank: 'Vanguard', healer: 'Field Medic', dps: 'Slayer' };

function item(it, extra = '') {
  const r = rarity(it.rarity);
  return `<div class="loot" style="--rc:${r.colour}">
    <b>${esc(it.name)}</b><em>${r.name} ${SLOTS.find((s) => s.id === it.slot).name}</em>
    <span class="pw">${it.power}</span>${it.from ? `<i>${esc(it.from)}</i>` : ''}${extra}</div>`;
}

export function createPanels(root, actions) {
  root.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b || b.disabled) return;
    const fn = actions[b.dataset.act];
    if (fn) fn(b.dataset.arg, b);
  });

  const show = (html) => {
    root.querySelector('.card').innerHTML = html;
    root.hidden = false;
  };
  const close = `<button class="go ghost" data-act="close">Back <kbd>Esc</kbd></button>`;

  return {
    hide: () => (root.hidden = true),
    get open() {
      return !root.hidden;
    },

    raid({ raid, progress, content, levels, game, role, heroic }) {
      const lock = progress.lockout(raid.id);
      const power = progress.power();
      const encs = raid.encounters
        .map((enc, i) => {
          const boss = content.bosses[enc.boss];
          const done = lock.killed.includes(i);
          const where = levels[enc.map] ? levels[enc.map] : enc.map;
          return `<div class="enc ${done ? 'done' : ''}"><b>${i + 1}. ${esc(boss.name)}</b> <em>${esc(boss.title)}</em>
            <span>${esc(where)}</span>${done ? '<i>defeated this week</i>' : ''}</div>`;
        })
        .join('');
      const next = raid.encounters.findIndex((_, i) => !lock.killed.includes(i));
      const chip = (act, on, arg, text) => `<button class="chip ${on ? 'on' : ''}" data-act="${act}" data-arg="${arg}">${text}</button>`;
      const games = Object.values(content.games).map((g) => chip('raidGame', g.id === game, g.id, `${g.name} <small>${g.inspiration}</small>`)).join('');
      const roles = Object.entries(ROLE_NAME).map(([id, n]) => chip('raidRole', id === role, id, n)).join('');
      const under = power < raid.power;
      show(`
        <h1 style="font-size:30px">${esc(raid.name)}</h1>
        <p>${esc(raid.tagline)}</p>
        <div class="pwrow"><span>Recommended power <b>${raid.power}</b></span>
          <span>Your power <b class="${under ? 'low' : ''}">${power}</b></span>
          <span>Levels: ${raid.maps.map((m) => esc(levels[m] || m)).join(' → ')}</span></div>
        <h2>Encounters</h2><div class="encs">${encs}</div>
        <h2>Difficulty</h2>
        <div class="chips">${chip('raidHeroic', !heroic, '0', 'Normal')}${chip('raidHeroic', heroic, '1', 'Heroic <small>telegraphs resolve 45% sooner · better loot</small>')}</div>
        <h2>Play it as</h2><div class="chips">${games}</div>
        <h2>Role</h2><div class="chips">${roles}</div>
        ${under ? '<p class="warn">You are under the recommended power. Gear softens the fight by up to 15%; it never replaces dodging.</p>' : ''}
        <div class="btnrow">
          <button class="go" data-act="launch" data-arg="${next < 0 ? 0 : next}">${next > 0 ? `Launch from checkpoint ${next + 1}` : next < 0 ? 'Launch (cleared this week)' : 'Launch'}</button>
          ${next > 0 ? '<button class="go ghost" data-act="launch" data-arg="0">From the start</button>' : ''}
          ${close}
        </div>`);
    },

    character({ progress, role }) {
      const p = progress.data;
      const gear = SLOTS.map((s) => item(p.gear[s.id])).join('');
      const stash = p.stash.length
        ? p.stash
            .map((it, i) => {
              const cur = p.gear[it.slot];
              const diff = it.power - cur.power;
              return item(it, `<div class="acts"><button class="chip ${diff > 0 ? 'on' : ''}" data-act="equip" data-arg="${i}">Equip ${diff > 0 ? `+${diff}` : diff < 0 ? diff : '='}</button>
                <button class="chip" data-act="scrap" data-arg="${i}">Scrap</button></div>`);
            })
            .join('')
        : '<p>Nothing in the stash. Raid bosses drop gear once a week each.</p>';
      show(`
        <h1 style="font-size:30px">${ROLE_NAME[role]} · Rank ${p.rank}</h1>
        <div class="pwrow"><span>Power <b>${progress.power()}</b> / ${MAX_POWER}</span><span>Rune Shards <b>${p.shards}</b></span>
          <span>${p.lifetime.kills} kills · ${p.lifetime.wipes} wipes</span></div>
        <h2>Equipped</h2><div class="loots">${gear}</div>
        <h2>Stash</h2><div class="loots">${stash}</div>
        <div class="btnrow">${close}<button class="go ghost" data-act="resetSave" style="font-size:12px">Reset character</button></div>`);
    },

    vendor({ progress }) {
      const p = progress.data;
      const slots = SLOTS.map((s) => `<button class="go small" data-act="buy" data-arg="${s.id}" ${p.shards < 60 ? 'disabled' : ''}>
        ${s.name}<small>Power ${Math.min(MAX_POWER, progress.power() + 1)} · 60 shards</small></button>`).join('');
      show(`
        <h1 style="font-size:30px">Quartermaster Vell</h1>
        <p>"Bosses only cough up gear once a week each. Bring me shards and I will make sure a bad week is not a wasted one."</p>
        <div class="pwrow"><span>Rune Shards <b>${p.shards}</b></span><span>Power <b>${progress.power()}</b></span></div>
        <h2>Requisition — one power above yours</h2><div class="btnrow">${slots}</div>
        <p style="font-size:11px">Scrap unwanted gear from the character screen (<kbd>I</kbd>) for a few shards.</p>
        <div class="btnrow">${close}</div>`);
    },

    bounties({ progress }) {
      const p = progress.data;
      const rows = p.bounties
        .map((b) => {
          const def = BOUNTY_POOL.find((d) => d.id === b.id);
          const goal = bountyGoal(b);
          const pct = Math.min(100, (b.progress / goal) * 100);
          return `<div class="bounty ${b.done ? 'done' : ''} ${b.claimed ? 'claimed' : ''}">
            <b>${esc(bountyText(b))}</b><em>${def.reward.xp} xp · ${def.reward.shards} shards</em>
            <div class="meter"><span style="width:${pct}%"></span></div>
            <i>${Math.floor(b.progress * 10) / 10} / ${goal}</i>
            ${b.done && !b.claimed ? `<button class="chip on" data-act="claim" data-arg="${b.id}">Turn in</button>` : b.claimed ? '<i>turned in</i>' : ''}</div>`;
        })
        .join('');
      show(`
        <h1 style="font-size:30px">Sister Ashgrave</h1>
        <p>"Four tasks a week, child. Do them in whatever order the slipgates allow."</p>
        <div class="bounties">${rows}</div>
        <p style="font-size:11px">New bounties every Tuesday.</p>
        <div class="btnrow">${close}</div>`);
    },

    journal({ content, raid, levels }) {
      const raids = Object.values(content.raids).sort((a, b) => a.tier - b.tier);
      const pick = raid || raids[0];
      const tabs = raids.map((r) => `<button class="chip ${r.id === pick.id ? 'on' : ''}" data-act="journal" data-arg="${r.id}">${esc(r.name)}</button>`).join('');
      const bosses = pick.encounters
        .map((enc) => {
          const boss = content.bosses[enc.boss];
          const mechanics = enc.mechanics
            ? enc.mechanics
            : [...new Set(boss.phases.flatMap((ph) => ph.timeline.map((t) => (content.abilities[t.ability] || {}).name)).filter(Boolean))];
          return `<div class="jboss"><b>${esc(boss.name)}</b> <em>${esc(boss.title)}</em>
            <span>${(boss.hp / 1e6).toFixed(1)}M health · ${boss.phases.length} phases · enrage ${Math.floor(boss.enrageAtSeconds / 60)}:${String(boss.enrageAtSeconds % 60).padStart(2, '0')}
            ${enc.botsWin !== undefined ? ` · bots survive ${enc.botsWin}%` : ''} · fought in ${esc(levels[enc.map] || enc.map)}</span>
            <ul>${mechanics.map((m) => `<li>${esc(m)}</li>`).join('')}</ul></div>`;
        })
        .join('');
      show(`
        <h1 style="font-size:30px">The Archivist</h1>
        <p>"Everything that has killed a raid team, written down. Read it before it reads you."</p>
        <div class="chips" style="justify-content:center">${tabs}</div>
        <p>${esc(pick.tagline)}</p>
        <div class="jbosses">${bosses}</div>
        <div class="btnrow">${close}</div>`);
    },

    range() {
      show(`
        <h1 style="font-size:30px">Rangemaster Oduya</h1>
        <p>"Dummies that don't hit back, or any single mechanic on a loop. Slow it down to a quarter speed if you need to.
        Nothing you do in there counts — which is the point."</p>
        <div class="btnrow"><button class="go" data-act="range">Take me to the range</button>${close}</div>`);
    },

    result({ raid, index, won, outcome, boss, stats, hasNext }) {
      const loot = outcome.loot.length ? `<h2>Loot</h2><div class="loots">${outcome.loot.map((it) => item(it)).join('')}</div>` : '';
      const lines = [
        `+${outcome.xp} xp${outcome.ranks ? ` · <b>Rank up!</b>` : ''}`,
        outcome.shards ? `+${outcome.shards} rune shards` : '',
        won && !outcome.firstThisWeek ? 'Already looted this week — practice and shards only' : '',
        outcome.bounties.length ? `Bounty complete: ${outcome.bounties.map((id) => esc(bountyText({ id }))).join(', ')}` : '',
        outcome.cleared ? `<b>${esc(raid.name)} cleared!</b>` : '',
      ].filter(Boolean);
      show(`
        <h1>${won ? `${esc(boss.name)} falls` : 'Wipe'}</h1>
        <p>${esc(raid.name)} · encounter ${index + 1} of ${raid.encounters.length}</p>
        <div class="extras" style="margin:12px auto; max-width:560px">${stats}</div>
        <div class="extras" style="margin:6px auto; max-width:560px">${lines.map((l) => `<div>${l}</div>`).join('')}</div>
        ${loot}
        <div class="btnrow">
          ${won && hasNext ? '<button class="go" data-act="nextEncounter">Through the slipgate →</button>' : ''}
          ${!won ? '<button class="go" data-act="retryEncounter">Pull again</button>' : ''}
          <button class="go ghost" data-act="toHub">Return to the hub</button>
        </div>`);
    },
  };
}
