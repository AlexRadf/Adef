// The style picker: four independent axes, plus presets that set all
// four at once. Mixing them is the point — dodge rolls with party
// frames, or click-to-move with body-block tanking, are both one click
// away and both perfectly legal.

const AXES = [
  { id: 'movement', label: 'Movement' },
  { id: 'combat', label: 'Combat' },
  { id: 'healing', label: 'Healing' },
  { id: 'tanking', label: 'Tanking' },
];

export function createStylePicker(content, onChange) {
  const panel = document.getElementById('stylePanel');
  const choice = { ...content.styles.presets.raid };
  delete choice.name;
  delete choice.desc;

  const presetMatch = () =>
    Object.entries(content.styles.presets).find(([, p]) =>
      AXES.every((a) => p[a.id] === choice[a.id])
    );

  function draw() {
    const match = presetMatch();
    panel.innerHTML = `
      <div class="style-presets">
        <span class="style-lbl">Presets</span>
        ${Object.entries(content.styles.presets)
          .map(
            ([id, p]) => `<button class="g-btn wide ${match && match[0] === id ? 'sel' : ''}"
              data-preset="${id}" title="${p.desc} — bots win ${p.bots} of pulls with it">
              ${p.name} <i class="mute">${p.bots}</i></button>`
          )
          .join('')}
        <span class="mute" style="margin-left:auto">${match ? '' : 'custom mix'}</span>
      </div>
      ${AXES.map(
        (axis) => `<div class="style-row">
          <span class="style-lbl">${axis.label}</span>
          ${Object.values(content.styles[axis.id])
            .map(
              (opt) => `<button class="chip ${opt.id === choice[axis.id] ? 'sel' : ''}"
                data-axis="${axis.id}" data-opt="${opt.id}" title="${opt.blurb}">
                <b>${opt.name}</b>${opt.tagline} <i>bots ${opt.bots}</i></button>`
            )
            .join('')}
        </div>`
      ).join('')}
      <div class="style-note">${describe()}
        <br><span class="mute">Percentages are measured: how often four bots survive a pull with that
        option, against 47% for the plain raid baseline. Nothing here is guesswork, but nothing here
        is balanced to the decimal either — pick what feels right, not what reads highest.</span>
      </div>`;
  }

  function describe() {
    const parts = AXES.map((a) => content.styles[a.id][choice[a.id]]);
    return parts.map((p) => p.blurb).join(' ');
  }

  panel.addEventListener('click', (e) => {
    const preset = e.target.closest('[data-preset]');
    if (preset) {
      const p = content.styles.presets[preset.dataset.preset];
      for (const axis of AXES) choice[axis.id] = p[axis.id];
      draw();
      onChange({ ...choice });
      return;
    }
    const chip = e.target.closest('[data-axis]');
    if (!chip) return;
    choice[chip.dataset.axis] = chip.dataset.opt;
    draw();
    onChange({ ...choice });
  });

  draw();
  return {
    current: () => ({ ...choice }),
    label: () => {
      const match = presetMatch();
      return match ? match[1].name : 'Custom';
    },
  };
}
