// The hub: LibreQuake's own "Episode Select" level, turned into the
// social space between raids.
//
// The level already had the right shape for it -- a hall of slipgates,
// one per episode -- so the portals are its own trigger_changelevel
// brushes, each now pointing at a raid instead of a map. Its teleporters
// still teleport. What is added on top is what a hub is for: people to
// talk to (a quartermaster, a quest board, a raid journal, a range
// master), other guardians standing about, and you, in third person,
// walking on real collision with Quake's step-up and air control.

import * as THREE from '../vendor/three.module.js';
import { createMover, boomLength } from './collide.js';

const SPEED = 8.6;
const UNIT = 1 / 32;

// Who stands where: the four co-op starts around the spawn are the
// level's own idea of "where people gather".
export const NPCS = [
  { id: 'quartermaster', name: 'Quartermaster Vell', title: 'Gear & Shards', colour: 0xc9a227, spot: 0, panel: 'vendor' },
  { id: 'bounties', name: 'Sister Ashgrave', title: 'Bounties', colour: 0x9a3b2a, spot: 1, panel: 'bounties', marker: '!' },
  { id: 'archivist', name: 'The Archivist', title: 'Raid Journal', colour: 0x4a6a9a, spot: 2, panel: 'journal' },
  { id: 'range', name: 'Rangemaster Oduya', title: 'Practice Range', colour: 0x5a8a3a, spot: 3, panel: 'range' },
];

// Other people in the tower, idling where deathmatch players would spawn.
const GUARDIANS = [
  ['Kestrel-7', 'tank', 41], ['Moth', 'healer', 33], ['Ashvale', 'dps', 47], ['Brannoc', 'dps', 22],
  ['Ivory Hex', 'healer', 52], ['Old Teodor', 'tank', 58],
];
const ROLE_COLOUR = { tank: 0x3d6a9e, healer: 0x3f8547, dps: 0xa35526 };

export function createHub({ scene, camera, rig, controls, level, progress, raids, onPortal, onInteract, getRole }) {
  const meta = level.meta;
  const root = new THREE.Group();
  root.name = 'hub';
  scene.add(root);
  root.add(level.group);
  level.group.position.set(0, 0, 0);
  level.group.updateMatrixWorld(true);
  level.collider.setOffset(level.group.position);

  const start = meta.things.find((t) => t.cls === 'info_player_start');
  // Entity origins are the middle of the hull; feet are 24 units lower.
  const feet = (t) => ({ x: t.at[0], y: t.at[1] - 24 * UNIT, z: t.at[2] });
  const spawn = feet(start);
  const mover = createMover(level.collider, spawn);
  const coop = meta.things.filter((t) => t.cls === 'info_player_coop');
  const dm = meta.things.filter((t) => t.cls === 'info_player_deathmatch');

  /* ------------------------------------------------------------ lights */

  // The level is lightmapped; bodies need light of their own.
  const hemi = new THREE.HemisphereLight(0xb8a6ff, 0x2a1e14, 1.3);
  root.add(hemi);
  const torches = [];
  for (const t of meta.things.filter((x) => x.cls.includes('torch'))) {
    const flame = new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.32, 6), new THREE.MeshBasicMaterial({ color: 0xffa040 }));
    flame.position.set(t.at[0], t.at[1] + 0.25, t.at[2]);
    root.add(flame);
    torches.push(flame);
  }

  /* ------------------------------------------------------------ bodies */

  function body(colour, height = 1.75) {
    const g = new THREE.Group();
    const mat = new THREE.MeshStandardMaterial({ color: colour, roughness: 0.6, metalness: 0.2 });
    const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.34, height - 0.95, 4, 10), mat);
    torso.position.y = height / 2 - 0.05;
    g.add(torso);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.2, 12, 10), new THREE.MeshStandardMaterial({ color: 0xd8c2a0, roughness: 0.8 }));
    head.position.y = height - 0.12;
    g.add(head);
    // A visor, so you can tell which way anyone is facing.
    const visor = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.08, 0.06), new THREE.MeshBasicMaterial({ color: 0x9fe8ff }));
    visor.position.set(0, height - 0.1, -0.19);
    g.add(visor);
    const shadow = new THREE.Mesh(new THREE.CircleGeometry(0.45, 18), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.45, depthWrite: false }));
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = 0.02;
    g.add(shadow);
    return g;
  }

  function label(lines, colour = '#e8dcc4') {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 128;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(canvas), depthTest: true, transparent: true }));
    sprite.scale.set(2.6, 0.65, 1);
    sprite.userData.draw = (ls, c = colour) => {
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, 512, 128);
      ctx.textAlign = 'center';
      ls.forEach((l, i) => {
        ctx.font = i === 0 ? '600 40px Impact, sans-serif' : '28px "Trebuchet MS", sans-serif';
        ctx.lineWidth = 6;
        ctx.strokeStyle = 'rgba(0,0,0,.85)';
        ctx.strokeText(l, 256, 46 + i * 42);
        ctx.fillStyle = i === 0 ? c : '#b8a98f';
        ctx.fillText(l, 256, 46 + i * 42);
      });
      sprite.material.map.needsUpdate = true;
    };
    sprite.userData.draw(lines);
    return sprite;
  }

  const me = body(ROLE_COLOUR[getRole()] || 0xa35526);
  root.add(me);

  const npcs = NPCS.map((n) => {
    const spot = coop[n.spot] || start;
    const g = body(n.colour, 1.9);
    const at = feet(spot);
    g.position.set(at.x, at.y, at.z);
    // Face the middle of the room, where the player spawns.
    g.rotation.y = Math.atan2(-(spawn.x - at.x), -(spawn.z - at.z));
    const tag = label([n.name, n.title], '#ffd27a');
    tag.position.y = 2.5;
    g.add(tag);
    let mark = null;
    if (n.marker) {
      mark = label([n.marker], '#ffcc33');
      mark.scale.set(1.6, 0.4, 1);
      mark.position.y = 3.05;
      g.add(mark);
    }
    root.add(g);
    return { ...n, group: g, mark, pos: at };
  });

  const guardians = GUARDIANS.map(([name, role, power], i) => {
    const spot = dm[i % Math.max(1, dm.length)] || start;
    const g = body(ROLE_COLOUR[role], 1.75 + (i % 3) * 0.05);
    const at = feet(spot);
    // Spread them a little so two never share a spawn.
    g.position.set(at.x + (i >= dm.length ? 1.2 : 0), at.y, at.z);
    g.rotation.y = (spot.angle || 0) * (Math.PI / 180) - Math.PI / 2 + Math.PI;
    const tag = label([name, `Power ${power}`], '#cfe3ff');
    tag.scale.multiplyScalar(0.8);
    tag.position.y = 2.25;
    g.add(tag);
    root.add(g);
    return { group: g, base: g.position.y, phase: i * 1.7, jumpAt: 4 + i * 3.3 };
  });

  /* ----------------------------------------------------------- portals */

  const portals = [];
  for (const t of meta.triggers.filter((x) => x.cls === 'trigger_changelevel')) {
    const raid = Object.values(raids).find((r) => r.portal === t.map);
    const kind = raid ? 'raid' : t.map === 'lq_e0m1' ? 'range' : 'sealed';
    const [x0, y0, z0, x1, y1, z1] = t.box;
    const centre = new THREE.Vector3((x0 + x1) / 2, Math.max(y0, y1) + 0.2, (z0 + z1) / 2);
    const lines = raid
      ? [raid.name, `Power ${raid.power} · ${raid.encounters.length} encounters`]
      : kind === 'range'
        ? ['Practice Range', 'Dummies and drills']
        : ['Sealed', 'This slipgate does not answer'];
    const tag = label(lines, raid ? '#ffd27a' : kind === 'range' ? '#a9e07a' : '#7d7060');
    tag.position.copy(centre).setY(centre.y + 2.6);
    root.add(tag);
    portals.push({ ...t, raid, kind, tag, inside: false });
  }
  const teleports = meta.triggers.filter((x) => x.cls === 'trigger_teleport');
  const destinations = meta.things.filter((t) => t.cls === 'info_teleport_destination');

  function overlaps(box, p) {
    const [x0, y0, z0, x1, y1, z1] = box;
    return p.x + 0.5 > x0 && p.x - 0.5 < x1 && p.z + 0.5 > z0 && p.z - 0.5 < z1 && p.y + 1.75 > y0 && p.y < y1;
  }

  /* ------------------------------------------------------------ update */

  let firstPerson = false;
  let wantJump = false;
  let active = true;
  let facing = 0;
  rig.yaw = (start.angle || 0) * (Math.PI / 180) - Math.PI / 2;

  function nearestNpc() {
    const p = mover.body.pos;
    let best = null;
    for (const n of npcs) {
      const d = Math.hypot(n.pos.x - p.x, n.pos.z - p.z);
      if (d < 2.8 && Math.abs(n.pos.y - p.y) < 1.5 && (!best || d < best.d)) best = { npc: n, d };
    }
    return best && best.npc;
  }

  function update(dt, time, stick) {
    if (!active) return;
    const dir = controls.moveDirection(stick);
    const len = Math.hypot(dir.x, dir.y) || 1;
    const k = Math.min(1, Math.hypot(dir.x, dir.y));
    const wish = { x: (dir.x / len) * SPEED * k, z: (dir.y / len) * SPEED * k };
    mover.move(wish, Math.min(dt, 0.05), wantJump);
    wantJump = false;

    const p = mover.body.pos;
    me.position.set(p.x, p.y, p.z);
    if (Math.hypot(wish.x, wish.z) > 0.1) facing = Math.atan2(-wish.x, -wish.z);
    me.rotation.y = damp(me.rotation.y, firstPerson ? rig.yaw : facing, Math.min(1, dt * 12));
    me.visible = !firstPerson;

    // Teleporters do what they did in Quake.
    for (const t of teleports) {
      if (!overlaps(t.box, p)) continue;
      const dest = destinations.find((d) => d.targetname === t.target);
      if (!dest) continue;
      mover.body.pos = feet(dest);
      mover.body.vel = { x: 0, y: 0, z: 0 };
      rig.yaw = (dest.angle || 0) * (Math.PI / 180) - Math.PI / 2;
    }
    // Portals open their launch card once per walk-in.
    for (const portal of portals) {
      const inside = overlaps(portal.box, p);
      if (inside && !portal.inside) onPortal(portal);
      portal.inside = inside;
    }

    for (const g of guardians) {
      // Idle sway, and the occasional hop every Quake player does while waiting.
      const tJump = (time + g.phase) % 9;
      g.group.position.y = g.base + (tJump < 0.5 ? Math.sin((tJump / 0.5) * Math.PI) * 0.7 : 0);
      g.group.rotation.y += Math.sin(time * 0.4 + g.phase) * 0.002;
    }
    for (const n of npcs) if (n.mark) n.mark.position.y = 3.05 + Math.sin(time * 3) * 0.08;
    for (const f of torches) f.scale.y = 0.85 + Math.sin(time * 17 + f.position.x) * 0.15;
    level.tick(time);

    placeCamera();
    return nearestNpc();
  }

  const UP = new THREE.Vector3(0, 1, 0);
  function placeCamera() {
    const p = mover.body.pos;
    const eye = new THREE.Vector3(p.x, p.y + 1.55, p.z);
    camera.quaternion.setFromEuler(new THREE.Euler(rig.pitch, rig.yaw, 0, 'YXZ'));
    if (firstPerson) {
      camera.position.copy(eye);
      return;
    }
    // Over the right shoulder, pulled in by any wall behind.
    const back = new THREE.Vector3(0, 0, 1).applyQuaternion(camera.quaternion);
    const right = new THREE.Vector3().crossVectors(back, UP).normalize().multiplyScalar(-0.55);
    const pivot = eye.clone().add(right).add(new THREE.Vector3(0, 0.25, 0));
    const want = 4.2;
    const boom = Math.max(0.4, boomLength(level.collider, pivot, back, want) - 0.25);
    camera.position.copy(pivot).addScaledVector(back, boom);
  }

  return {
    update,
    jump: () => (wantJump = true),
    toggleView: () => (firstPerson = !firstPerson),
    nearestNpc,
    portals,
    npcs,
    mover,
    setRole(role) {
      me.children[0].material.color.setHex(ROLE_COLOUR[role] || 0xa35526);
    },
    // Back out of a portal so the launch card does not reopen at once.
    stepBack() {
      const p = mover.body.pos;
      const portal = portals.find((x) => x.inside);
      if (!portal) return;
      const [x0, , z0, x1, , z1] = portal.box;
      const c = { x: (x0 + x1) / 2, z: (z0 + z1) / 2 };
      const away = { x: p.x - c.x, z: p.z - c.z };
      const l = Math.hypot(away.x, away.z) || 1;
      mover.move({ x: (away.x / l) * 40, z: (away.z / l) * 40 }, 0.05, false);
    },
    respawn() {
      mover.body.pos = { ...spawn };
      mover.body.vel = { x: 0, y: 0, z: 0 };
      rig.yaw = (start.angle || 0) * (Math.PI / 180) - Math.PI / 2;
    },
    show(on) {
      active = on;
      root.visible = on;
    },
    get active() {
      return active;
    },
  };
}

function damp(current, target, factor) {
  let delta = target - current;
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta < -Math.PI) delta += Math.PI * 2;
  return current + delta * factor;
}
