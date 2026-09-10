// Gambit mode: you do not play the fight, you write the four priority
// lists and press pull. The lists are the same data the engine reads from
// /content/ai, and the "run N pulls" button is the headless runner from
// sim.js in a worker -- same sim, same seeds, same numbers.

import { CONDITION_SPECS, ACTION_SPECS } from '../engine/ai.js';

const ROLE_OF = { tank: 'ranger', healer: 'crash', dps: 'visor' };

export function createGambitEditor(content) {
  const panel = document.getElementById('gambitPanel');
  const lists = structuredClone(content.ai);
  let openRole = 'healer';
  let style = { movement: 'click', combat: 'tab', healing: 'frames', tanking: 'threat' };
  let modifiers = [];
  let worker = null;
  let lastResult = null;
  let busy = false;

  const abilitiesFor = (role) => {
    const member = content.parties.default.members.find((m) => m.id === ROLE_OF[role]);
    return member ? member.abilities : [];
  };

  const actionOptions = (role) => [
    ...ACTION_SPECS.map((a) => ({ value: a.id, label: a.label })),
    ...abilitiesFor(role).map((id) => ({ value: `cast:${id}`, label: `cast ${content.abilities[id].name}` })),
  ];

  function parseRule(rule) {
    if (rule.else || rule.if === undefined) return { id: 'always', args: [] };
    const [id, ...args] = String(rule.if).split(':');
    return { id, args };
  }

  function ruleRow(role, rule, index, count) {
    const parsed = parseRule(rule);
    const spec = CONDITION_SPECS.find((c) => c.id === parsed.id) || CONDITION_SPECS[0];
    const args = spec.args
      .map(
        (a, i) =>
          `${a.prefix ? `<span class="mute">${a.prefix}</span>` : ''}
           <input class="g-arg" data-role="${role}" data-index="${index}" data-arg="${i}"
                  value="${parsed.args[i] ?? a.value}" size="${String(a.value).length + 2}">
           ${a.suffix ? `<span class="mute">${a.suffix}</span>` : ''}`
      )
      .join('');

    return `<div class="g-rule">
      <span class="g-num">${index + 1}</span>
      <select class="g-if" data-role="${role}" data-index="${index}">
        ${CONDITION_SPECS.map((c) => `<option value="${c.id}" ${c.id === spec.id ? 'selected' : ''}>${c.label}</option>`).join('')}
      </select>
      ${args}
      <span class="mute">→</span>
      <select class="g-do" data-role="${role}" data-index="${index}">
        ${actionOptions(role)
          .map((o) => `<option value="${o.value}" ${o.value === rule.do ? 'selected' : ''}>${o.label}</option>`)
          .join('')}
      </select>
      <button class="g-btn" data-move="up" data-role="${role}" data-index="${index}" ${index === 0 ? 'disabled' : ''}>↑</button>
      <button class="g-btn" data-move="down" data-role="${role}" data-index="${index}" ${index === count - 1 ? 'disabled' : ''}>↓</button>
      <button class="g-btn" data-remove="1" data-role="${role}" data-index="${index}">✕</button>
    </div>`;
  }

  function draw() {
    const list = lists[openRole];
    panel.innerHTML = `
      <div class="g-tabs">
        ${['tank', 'healer', 'dps']
          .map((r) => `<button class="g-tab ${r === openRole ? 'sel' : ''}" data-tab="${r}">${r}</button>`)
          .join('')}
        <span class="mute" style="margin-left:auto">first rule that fits, wins</span>
      </div>
      <div class="g-list">${list.priority.map((r, i) => ruleRow(openRole, r, i, list.priority.length)).join('')}</div>
      <div class="g-tabs">
        <button class="g-btn wide" data-add="1">+ rule</button>
        <button class="g-btn wide" data-reset="1">reset ${openRole}</button>
        <span style="margin-left:auto"></span>
        <button class="g-btn wide" data-sim="100" ${busy ? 'disabled' : ''}>${busy ? 'simulating…' : 'run 100 pulls'}</button>
        <button class="g-btn wide" data-sim="400" ${busy ? 'disabled' : ''}>run 400</button>
      </div>
      <div class="g-result">${lastResult || 'Arrange the lists, then simulate them before you watch a pull.'}</div>`;
  }

  /* ------------------------------------------------------------ events */

  panel.addEventListener('click', (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    const list = lists[t.dataset.role || openRole];

    if (t.dataset.tab) openRole = t.dataset.tab;
    else if (t.dataset.add) list.priority.splice(list.priority.length - 1, 0, { if: 'always', do: 'wait' });
    else if (t.dataset.reset) lists[openRole] = structuredClone(content.ai[openRole]);
    else if (t.dataset.remove) list.priority.splice(Number(t.dataset.index), 1);
    else if (t.dataset.move) {
      const i = Number(t.dataset.index);
      const j = t.dataset.move === 'up' ? i - 1 : i + 1;
      [list.priority[i], list.priority[j]] = [list.priority[j], list.priority[i]];
    } else if (t.dataset.sim) return simulate(Number(t.dataset.sim));
    else return;
    draw();
  });

  panel.addEventListener('change', (e) => {
    const el = e.target;
    const role = el.dataset.role;
    if (!role) return;
    const rule = lists[role].priority[Number(el.dataset.index)];

    if (el.classList.contains('g-do')) rule.do = el.value;
    if (el.classList.contains('g-if') || el.classList.contains('g-arg')) {
      const row = el.closest('.g-rule');
      const id = row.querySelector('.g-if').value;
      const spec = CONDITION_SPECS.find((c) => c.id === id);
      const args = el.classList.contains('g-if')
        ? spec.args.map((a) => a.value)
        : [...row.querySelectorAll('.g-arg')].map((i) => i.value);
      delete rule.else;
      rule.if = [id, ...args.slice(0, spec.args.length)].join(':');
    }
    draw();
  });

  /* -------------------------------------------------------- simulation */

  function simulate(runs) {
    if (busy) return;
    busy = true;
    lastResult = 'starting…';
    draw();
    worker = worker || new Worker(new URL('./simworker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => {
      const r = e.data;
      if (r.type === 'progress') {
        lastResult = `simulating ${r.done} / ${r.runs}…`;
        panel.querySelector('.g-result').textContent = lastResult;
        return;
      }
      busy = false;
      const mmss = `${Math.floor(r.medianKill / 60)}:${String(Math.round(r.medianKill % 60)).padStart(2, '0')}`;
      lastResult = `
        <b>${r.winRate.toFixed(1)}% win</b> over ${r.runs} pulls ·
        median kill ${mmss} · ${r.deathsPerPull.toFixed(2)} deaths per pull<br>
        <span class="mute">${[Object.values(style).join('/'), ...modifiers].join(' + ')} · ${r.causes.map(([c, n]) => `${c} ${n}`).join(' · ') || 'nobody died'}</span>`;
      draw();
    };
    worker.postMessage({ style, modifiers, ai: lists, runs, seed: 1 });
  }

  draw();

  return {
    lists: () => structuredClone(lists),
    setModifiers(ids) {
      modifiers = ids;
      lastResult = null;
      if (!panel.hidden) draw();
    },
    setStyle(id) {
      style = id;
      lastResult = lastResult && `${lastResult}<br><span class="mute">(controls changed — simulate again)</span>`;
    },
    setVisible(on) {
      panel.hidden = !on;
    },
  };
}
