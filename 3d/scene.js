// The world, in three dimensions. Everything here reads a sim snapshot
// and pushes triangles; it never writes to state. One sim cell is three
// metres, which is what turns a 5x5 grid into a room you can run across.

import * as THREE from '../vendor/three.module.js';

export const CELL = 3;
export const ARENA = 5 * CELL;
export const toWorld = (p) => new THREE.Vector3((p.x - 2.5) * CELL, 0, (p.y - 2.5) * CELL);
export const toSim = (v) => ({ x: v.x / CELL + 2.5, y: v.z / CELL + 2.5 });

const ROLE_COLOUR = { tank: 0x3d6a9e, healer: 0x3f8547, dps: 0xa35526, boss: 0x8a1410, add: 0x6b3f8a };

export function createScene(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0a0806);
  scene.fog = new THREE.Fog(0x1a1109, 34, 88);

  const camera = new THREE.PerspectiveCamera(75, 16 / 9, 0.1, 200);

  /* ---------------------------------------------------------- lights */

  scene.add(new THREE.HemisphereLight(0x7c6a52, 0x241810, 1.25));
  const key = new THREE.DirectionalLight(0xffe2c0, 1.35);
  key.position.set(10, 22, 8);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.camera.left = -20;
  key.shadow.camera.right = 20;
  key.shadow.camera.top = 20;
  key.shadow.camera.bottom = -20;
  scene.add(key);
  // The pit glows from underneath -- it is why the room is lit at all.
  const pit = new THREE.PointLight(0xff6a10, 40, 30, 2);
  pit.position.set(0, 0.7, 0);
  scene.add(pit);
  // A cool fill from behind, so bodies read against the floor.
  const fill = new THREE.DirectionalLight(0x9fb4d0, 0.5);
  fill.position.set(-12, 9, -10);
  scene.add(fill);

  /* ----------------------------------------------------------- floor */

  const floorMat = new THREE.MeshStandardMaterial({ color: 0x5a5044, roughness: 0.95, metalness: 0.05 });
  const floor = new THREE.Mesh(new THREE.BoxGeometry(ARENA, 1, ARENA), floorMat);
  floor.position.y = -0.5;
  floor.receiveShadow = true;
  scene.add(floor);

  // Grouting, so a telegraph reads as "that tile" rather than "over there".
  const grout = new THREE.Group();
  for (let i = 0; i <= 5; i++) {
    for (const axis of [0, 1]) {
      const line = new THREE.Mesh(
        new THREE.BoxGeometry(axis ? ARENA : 0.12, 0.06, axis ? 0.12 : ARENA),
        new THREE.MeshStandardMaterial({ color: 0x191512, roughness: 1 })
      );
      const offset = -ARENA / 2 + i * CELL;
      line.position.set(axis ? 0 : offset, 0.01, axis ? offset : 0);
      grout.add(line);
    }
  }
  scene.add(grout);

  /* ----------------------------------------------------------- walls */

  const wallMat = new THREE.MeshStandardMaterial({ color: 0x453629, roughness: 0.9 });
  for (let i = 0; i < 4; i++) {
    const wall = new THREE.Mesh(new THREE.BoxGeometry(ARENA + 4, 7, 2), wallMat);
    wall.position.set(0, 3, -ARENA / 2 - 1).applyAxisAngle(new THREE.Vector3(0, 1, 0), (i * Math.PI) / 2);
    wall.rotation.y = (i * Math.PI) / 2;
    wall.receiveShadow = true;
    wall.castShadow = true;
    scene.add(wall);
    // A band of lava at the base of each wall, because this is a pit.
    const lava = new THREE.Mesh(
      new THREE.BoxGeometry(ARENA + 4, 0.28, 0.3),
      new THREE.MeshBasicMaterial({ color: 0xc8500e })
    );
    lava.position.copy(wall.position).setY(0.1);
    lava.rotation.y = wall.rotation.y;
    lava.translateZ(1.1);
    scene.add(lava);
  }

  /* ---------------------------------------------------------- actors */

  const actors = new Map();
  const actorLayer = new THREE.Group();
  scene.add(actorLayer);

  function actorFor(unit) {
    let actor = actors.get(unit.id);
    if (actor) return actor;

    const group = new THREE.Group();
    const boss = unit.role === 'boss';
    const radius = boss ? 1.5 : unit.role === 'add' ? 0.5 : 0.55;
    const height = boss ? 4.5 : unit.role === 'add' ? 1.4 : 1.8;

    const body = new THREE.Mesh(
      boss
        ? new THREE.IcosahedronGeometry(radius, 1)
        : new THREE.CapsuleGeometry(radius, height - radius * 2, 4, 12),
      new THREE.MeshStandardMaterial({
        color: ROLE_COLOUR[unit.role] || 0x888888,
        roughness: boss ? 0.5 : 0.7,
        flatShading: boss,
        emissive: boss ? 0x2a0400 : 0x000000,
      })
    );
    body.position.y = boss ? height / 2 : height / 2;
    body.castShadow = true;
    group.add(body);

    // A nose, so you can see which way anything is facing.
    const nose = new THREE.Mesh(
      new THREE.ConeGeometry(boss ? 0.5 : 0.22, boss ? 1.2 : 0.6, 8),
      new THREE.MeshBasicMaterial({ color: boss ? 0xff5522 : 0xf0e2c8 })
    );
    nose.rotation.x = Math.PI / 2;
    nose.position.set(0, boss ? height / 2 : height * 0.62, -(radius + (boss ? 0.5 : 0.25)));
    group.add(nose);

    const ring = new THREE.Mesh(
      new THREE.RingGeometry(radius + 0.15, radius + 0.32, 24),
      new THREE.MeshBasicMaterial({ color: 0xe8c46a, side: THREE.DoubleSide, transparent: true, opacity: 0 })
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.06;
    group.add(ring);

    // A nameplate, because "who is that green one" is not a question a
    // party game should make you ask.
    const plate = makePlate(unit.name);
    plate.position.y = height + (boss ? 1.6 : 0.55);
    group.add(plate);

    actor = { group, body, ring, plate, height, prev: null, lastLabel: '' };
    actorLayer.add(group);
    actors.set(unit.id, actor);
    return actor;
  }

  /* ------------------------------------------------------ telegraphs */

  const marks = new THREE.Group();
  scene.add(marks);
  const markPool = [];
  function markMesh(i) {
    if (markPool[i]) return markPool[i];
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.75, depthWrite: false })
    );
    mesh.rotation.x = -Math.PI / 2;
    marks.add(mesh);
    markPool[i] = mesh;
    return mesh;
  }

  const HAZARD_COLOUR = { blast: 0xff7a18, split: 0x7b4fd0, soak: 0x2f8fb4, heal: 0x7ea23c };

  function paintGround(view, time) {
    const items = [
      ...view.hazards.map((h) => ({ ...h, colour: HAZARD_COLOUR[h.kind] })),
      ...view.fields.map((f) => ({ ...f, colour: HAZARD_COLOUR.heal, remaining: 1, total: 1 })),
    ];
    markPool.forEach((m) => (m.visible = false));
    items.forEach((item, i) => {
      const mesh = markMesh(i);
      mesh.visible = true;
      const size = item.half * 2 * CELL;
      mesh.scale.set(size, size, 1);
      const at = toWorld(item);
      mesh.position.set(at.x, 0.08, at.z);
      mesh.material.color.setHex(item.colour);
      // Tighter pulse as it gets closer to going off.
      const urgency = item.total ? 1 - Math.max(0, item.remaining) / item.total : 0.5;
      mesh.material.opacity = 0.28 + 0.5 * urgency * (0.6 + 0.4 * Math.sin(time * (4 + urgency * 14)));
    });
  }

  /* --------------------------------------------------------- painting */

  function paint(view, alpha, time, opts = {}) {
    for (const unit of [...view.party, ...view.enemies]) {
      const actor = actorFor(unit);
      actor.group.visible = unit.alive;
      if (!unit.alive) continue;

      // Interpolate between sim ticks: the sim runs at 10Hz, this does not.
      const target = toWorld(unit.pos);
      if (!actor.prev) actor.prev = target.clone();
      actor.group.position.lerpVectors(actor.prev, target, alpha);
      actor.faceTarget = Math.atan2(unit.facing.x, unit.facing.y);
      actor.group.rotation.y = damp(actor.group.rotation.y, actor.faceTarget, 0.25);

      // Redraw only when the number actually changed.
      const label = `${unit.name}|${Math.round(unit.hpPct)}`;
      if (actor.lastLabel !== label) {
        actor.lastLabel = label;
        drawPlate(actor.plate, unit.name, unit.hpPct, unit.team === 'party' ? '#e8dcc4' : '#ff9a7a');
      }
      const mine = unit.id === view.playerId;
      actor.group.visible = !(mine && opts.hideSelf);
      // Never label yourself, and let plates fade out up close so they
      // do not swallow the screen when somebody runs past the camera.
      const toCamera = actor.group.position.distanceTo(opts.cameraPos || actor.group.position);
      actor.plate.visible = !mine && toCamera > 2.4;
      actor.plate.material.opacity = Math.min(1, Math.max(0, (toCamera - 2.4) / 2));
      actor.ring.material.opacity = mine ? 0.85 : unit.team === 'party' ? 0.25 : 0;
      actor.body.material.emissiveIntensity = unit.blocking ? 1 : 0;
      if (unit.blocking) actor.body.material.emissive.setHex(0x2f6fa8);
      else if (unit.role === 'boss') actor.body.material.emissive.setHex(0x2a0400);
      else actor.body.material.emissive.setHex(0x000000);
    }
    paintGround(view, time);
  }

  // Called once per sim tick so interpolation has somewhere to come from.
  function commit(view) {
    for (const unit of [...view.party, ...view.enemies]) {
      const actor = actors.get(unit.id);
      if (actor) actor.prev = toWorld(unit.pos);
    }
  }

  function resize() {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (canvas.width === w && canvas.height === h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / Math.max(1, h);
    camera.updateProjectionMatrix();
  }

  return { renderer, scene, camera, paint, commit, resize, actors, actorFor };
}

// Nameplates are canvas textures: cheap, crisp, and no font loading.
function makePlate(name) {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 64;
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: new THREE.CanvasTexture(canvas),
      depthTest: false,
      transparent: true,
    })
  );
  sprite.scale.set(1.7, 0.42, 1);
  sprite.userData = { canvas, name };
  return sprite;
}

function drawPlate(sprite, name, hpPct, colour) {
  const { canvas } = sprite.userData;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, 256, 64);
  ctx.font = '600 28px Impact, sans-serif';
  ctx.textAlign = 'center';
  ctx.lineWidth = 5;
  ctx.strokeStyle = 'rgba(0,0,0,.85)';
  ctx.strokeText(name, 128, 28);
  ctx.fillStyle = colour;
  ctx.fillText(name, 128, 28);
  ctx.fillStyle = 'rgba(0,0,0,.75)';
  ctx.fillRect(40, 38, 176, 12);
  ctx.fillStyle = hpPct > 35 ? '#7ea23c' : '#c8391f';
  ctx.fillRect(42, 40, Math.max(0, Math.min(1, hpPct / 100)) * 172, 8);
  sprite.material.map.needsUpdate = true;
}

function damp(current, target, factor) {
  let delta = target - current;
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta < -Math.PI) delta += Math.PI * 2;
  return current + delta * factor;
}
