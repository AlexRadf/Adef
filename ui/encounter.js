// The opponent picker. Either the handcrafted fight, or a procedural one
// rolled from a seed and auto-tuned against the headless sim before you
// ever see it -- so a random encounter arrives with its difficulty
// already measured rather than hoped for.

export function createEncounterPicker(content, onChange) {
  const panel = document.getElementById('encounterPanel');
  const state = {
    kind: 'chthon',
    seed: 1 + Math.floor(Math.random() * 99998),
    scheme: 'raid',
    busy: false,
    stage: '',
    encounter: null,
    report: null,
  };

  let worker = null;

  function draw() {
    const chthon = content.bosses.chthon;
    panel.innerHTML = `
      <div class="chips" style="margin:0 0 10px">
        <button class="chip ${state.kind === 'chthon' ? 'sel' : ''}" data-kind="chthon" style="flex:1">
          <b>${chthon.name}</b>The handcrafted fight. The same one every time, tuned by hand.
          <i>bots win 45%</i>
        </button>
        <button class="chip ${state.kind === 'random' ? 'sel' : ''}" data-kind="random" style="flex:1">
          <b>Random</b>A procedural encounter, generated from a seed and balanced against a few
          hundred simulated pulls before you get it. <i>you have never seen this fight</i>
        </button>
      </div>
      ${state.kind === 'random' ? randomPanel() : ''}`;
  }

  function randomPanel() {
    if (state.busy) return `<div class="scout"><span class="mute">${state.stage || 'rolling…'}</span></div>`;
    if (!state.encounter) {
      return `<div class="scout">
        <span class="mute">seed</span>
        <input class="g-arg" id="seedBox" value="${state.seed}" size="7">
        <button class="g-btn wide" data-roll="1">roll it</button>
        <span class="mute">— the same seed always makes the same fight, so you can hand one to somebody else</span>
      </div>`;
    }

    const b = state.encounter.boss;
    const r = state.report;
    return `<div class="scout">
      <div class="scout-head">
        <b>${b.name}</b><span class="mute">, ${b.title}</span>
        <span style="margin-left:auto" class="mute">seed ${b.seed}</span>
      </div>
      <div class="mute" style="margin-bottom:6px">
        ${(b.hp / 1e6).toFixed(1)}M health · enrage at ${Math.floor(b.enrageAtSeconds / 60)}:${String(b.enrageAtSeconds % 60).padStart(2, '0')} ·
        ${b.phases.length} phases · bots survive it ≈${Math.round(r.winRate * 100)}% of the time,
        killing it around ${Math.floor(r.medianKill / 60)}:${String(Math.round(r.medianKill % 60)).padStart(2, '0')}
      </div>
      <ul class="scout-list">${state.encounter.mechanics.map((m) => `<li>${m}</li>`).join('')}</ul>
      <div class="scout">
        <input class="g-arg" id="seedBox" value="${state.seed}" size="7">
        <button class="g-btn wide" data-roll="1">roll another</button>
        ${state.accepted === false ? '<span class="mute">— this one came out lopsided; roll again</span>' : ''}
      </div>
    </div>`;
  }

  panel.addEventListener('click', (e) => {
    const chip = e.target.closest('[data-kind]');
    if (chip) {
      state.kind = chip.dataset.kind;
      draw();
      if (state.kind === 'random' && !state.encounter) roll();
      else notify();
      return;
    }
    if (e.target.closest('[data-roll]')) {
      const box = document.getElementById('seedBox');
      const typed = Number(box && box.value);
      state.seed = Number.isFinite(typed) && typed > 0 ? Math.floor(typed) : 1 + Math.floor(Math.random() * 99998);
      state.encounter = null;
      roll();
    }
  });

  function roll() {
    if (state.busy) return;
    state.busy = true;
    state.stage = 'rolling a new fight';
    draw();
    worker = worker || new Worker(new URL('./simworker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => {
      if (e.data.type === 'progress') {
        state.stage = e.data.stage;
        draw();
        return;
      }
      state.busy = false;
      state.encounter = e.data.encounter;
      state.report = e.data.report;
      state.accepted = e.data.accepted;
      // Pick the next seed now, so "roll another" is one click.
      state.seed = 1 + Math.floor(Math.random() * 99998);
      draw();
      notify();
    };
    worker.postMessage({ type: 'generate', seed: state.seed, scheme: state.scheme });
  }

  const notify = () => onChange(state.kind === 'random' ? state.encounter : null);

  draw();

  return {
    current: () => (state.kind === 'random' ? state.encounter : null),
    setScheme(id) {
      state.scheme = id;
    },
  };
}
