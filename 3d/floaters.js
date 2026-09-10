// Floating combat text. The numbers come out of the sim as snapshot
// events, so this file only decides where on the screen they belong and
// how they fade -- nothing here can change a fight.
//
// DOM rather than sprites: text stays crisp at any distance, costs no
// texture uploads, and a pool of thirty divs is cheaper than thirty
// canvases.

import * as THREE from '../vendor/three.module.js';
import { toWorld } from './scene.js';

const POOL = 30;
const LIFE = 1.15; // seconds

export function createFloaters(layer) {
  const pool = [];
  for (let i = 0; i < POOL; i++) {
    const el = document.createElement('div');
    el.className = 'float';
    el.hidden = true;
    layer.appendChild(el);
    pool.push({ el, life: 0, at: new THREE.Vector3(), drift: 0, rise: 0 });
  }
  let next = 0;
  const scratch = new THREE.Vector3();

  function spawn(pos, text, kind, height = 1.9) {
    const slot = pool[next];
    next = (next + 1) % POOL;
    slot.life = LIFE;
    slot.at.copy(toWorld(pos)).setY(height);
    slot.drift = (Math.random() - 0.5) * 1.1;
    slot.rise = 1.5 + Math.random() * 0.5;
    slot.el.textContent = text;
    slot.el.className = `float ${kind}`;
    slot.el.hidden = false;
  }

  // One event kind per line, so the sim decides what happened and this
  // decides only how loud it looks.
  function ingest(view) {
    for (const e of view.events || []) {
      const unit = [...view.party, ...view.enemies].find((u) => u.id === e.unitId);
      if (!unit) continue;
      if (e.kind === 'hit' && e.amount > 0) {
        const mine = e.mine;
        const kind = unit.team === 'party' ? 'taken' : mine ? 'mine' : 'other';
        spawn(unit.pos, `${e.flanked ? '↯' : ''}${short(e.amount)}`, kind, unit.role === 'boss' ? 4.2 : 1.9);
      } else if (e.kind === 'healed' && e.amount > 0) {
        spawn(unit.pos, `+${short(e.amount)}`, 'heal');
      }
    }
  }

  function paint(camera, dt, size) {
    for (const slot of pool) {
      if (slot.life <= 0) continue;
      slot.life -= dt;
      if (slot.life <= 0) {
        slot.el.hidden = true;
        continue;
      }
      const t = 1 - slot.life / LIFE;
      scratch.copy(slot.at);
      scratch.x += slot.drift * t;
      scratch.y += slot.rise * t;
      scratch.project(camera);
      // Behind the camera: project() mirrors it into view, so drop it.
      if (scratch.z > 1) {
        slot.el.hidden = true;
        continue;
      }
      slot.el.hidden = false;
      slot.el.style.transform = `translate(-50%,-50%) translate(${((scratch.x + 1) / 2) * size.w}px,${
        ((1 - scratch.y) / 2) * size.h
      }px) scale(${1.15 - t * 0.3})`;
      slot.el.style.opacity = String(Math.min(1, slot.life / (LIFE * 0.45)));
    }
  }

  function reset() {
    for (const slot of pool) {
      slot.life = 0;
      slot.el.hidden = true;
    }
  }

  return { ingest, paint, reset };
}

// Six figures of damage on screen twenty times a second is unreadable.
const short = (n) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(Math.round(n));
