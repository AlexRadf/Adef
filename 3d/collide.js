// Walking on a Quake level. Every solid brush is a convex hull of planes,
// so colliding a box with the world is Quake's own trick: push each plane
// out by the box's extent along its normal and trace a point through the
// fattened hulls (CM_ClipBoxToBrush). Axial bevel planes from each
// brush's bounds stop the corners of angled brushes being too fat.
//
// Then a small Quake-flavoured mover on top: slide along what you hit,
// step up anything under 18 units, fall, jump, and stick to stairs.

const EPS = 0.03125 / 32; // DIST_EPSILON, in metres
const CELL = 4;

export function createCollider(planes, hulls) {
  const count = hulls.length / 8;
  const offset = { x: 0, y: 0, z: 0 };

  // Each brush as its planes plus six axial bevels.
  const brushes = [];
  for (let i = 0; i < count; i++) {
    const h = i * 8;
    const first = hulls[h];
    const n = hulls[h + 1];
    const min = [hulls[h + 2], hulls[h + 3], hulls[h + 4]];
    const max = [hulls[h + 5], hulls[h + 6], hulls[h + 7]];
    const p = [];
    for (let k = 0; k < n; k++) {
      const o = (first + k) * 4;
      p.push(planes[o], planes[o + 1], planes[o + 2], planes[o + 3]);
    }
    p.push(1, 0, 0, max[0], -1, 0, 0, -min[0], 0, 1, 0, max[1], 0, -1, 0, -min[1], 0, 0, 1, max[2], 0, 0, -1, -min[2]);
    brushes.push({ p: new Float32Array(p), min, max, mark: 0 });
  }

  // A flat grid over x/z so a trace only looks at nearby brushes.
  const grid = new Map();
  const key = (x, z) => `${x},${z}`;
  brushes.forEach((b) => {
    for (let x = Math.floor(b.min[0] / CELL); x <= Math.floor(b.max[0] / CELL); x++)
      for (let z = Math.floor(b.min[2] / CELL); z <= Math.floor(b.max[2] / CELL); z++) {
        const k = key(x, z);
        if (!grid.has(k)) grid.set(k, []);
        grid.get(k).push(b);
      }
  });
  let stamp = 0;

  function candidates(lo, hi) {
    stamp++;
    const out = [];
    for (let x = Math.floor(lo[0] / CELL); x <= Math.floor(hi[0] / CELL); x++)
      for (let z = Math.floor(lo[2] / CELL); z <= Math.floor(hi[2] / CELL); z++) {
        const list = grid.get(key(x, z));
        if (!list) continue;
        for (const b of list) {
          if (b.mark === stamp) continue;
          b.mark = stamp;
          if (b.max[1] < lo[1] || b.min[1] > hi[1]) continue;
          out.push(b);
        }
      }
    return out;
  }

  // Trace a box (half extents hx, hy, hz around its centre) from a to b.
  // Positions are in world space; the level may have been moved.
  function trace(a, b, half) {
    const s = [a.x - offset.x, a.y - offset.y, a.z - offset.z];
    const e = [b.x - offset.x, b.y - offset.y, b.z - offset.z];
    const lo = [Math.min(s[0], e[0]) - half[0] - 0.1, Math.min(s[1], e[1]) - half[1] - 0.1, Math.min(s[2], e[2]) - half[2] - 0.1];
    const hi = [Math.max(s[0], e[0]) + half[0] + 0.1, Math.max(s[1], e[1]) + half[1] + 0.1, Math.max(s[2], e[2]) + half[2] + 0.1];
    const result = { fraction: 1, normal: null, startSolid: false };
    for (const br of candidates(lo, hi)) {
      if (br.max[0] < lo[0] || br.min[0] > hi[0] || br.max[2] < lo[2] || br.min[2] > hi[2]) continue;
      let enter = -1;
      let leave = 1;
      let hitN = null;
      let startsOut = false;
      let endsOut = false;
      let miss = false;
      const p = br.p;
      for (let k = 0; k < p.length; k += 4) {
        const nx = p[k], ny = p[k + 1], nz = p[k + 2];
        const dist = p[k + 3] + Math.abs(nx) * half[0] + Math.abs(ny) * half[1] + Math.abs(nz) * half[2];
        const d1 = nx * s[0] + ny * s[1] + nz * s[2] - dist;
        const d2 = nx * e[0] + ny * e[1] + nz * e[2] - dist;
        if (d1 > 0) startsOut = true;
        if (d2 > 0) endsOut = true;
        if (d1 > 0 && d2 >= d1) {
          miss = true;
          break;
        }
        if (d1 <= 0 && d2 <= 0) continue;
        if (d1 > d2) {
          const f = (d1 - EPS) / (d1 - d2);
          if (f > enter) {
            enter = f;
            hitN = [nx, ny, nz];
          }
        } else {
          const f = (d1 + EPS) / (d1 - d2);
          if (f < leave) leave = f;
        }
      }
      if (miss) continue;
      if (!startsOut) {
        result.startSolid = true;
        if (!endsOut) {
          result.fraction = 0;
          return result;
        }
        continue;
      }
      if (enter < leave && enter > -1 && enter < result.fraction) {
        result.fraction = Math.max(0, enter);
        result.normal = hitN;
      }
    }
    return result;
  }

  return {
    trace,
    setOffset(v) {
      offset.x = v.x;
      offset.y = v.y;
      offset.z = v.z;
    },
    get size() {
      return brushes.length;
    },
  };
}

/* --------------------------------------------------------------- mover */

// The Quake player hull, 32x32x56 units: 1 m wide, 1.75 m tall. Positions
// are the feet; the box centre sits 0.875 m above them.
export const HALF = [0.5, 0.875, 0.5];
const STEP = 18 / 32;
const GRAVITY = 25; // 800 u/s^2
const JUMP = 8.4; // 270 u/s
const lerp = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t });
const centre = (p) => ({ x: p.x, y: p.y + HALF[1], z: p.z });

export function createMover(collider, start) {
  const body = { pos: { ...start }, vel: { x: 0, y: 0, z: 0 }, onGround: false };

  function slide(dt) {
    let time = dt;
    const normals = [];
    for (let bump = 0; bump < 4 && time > 0; bump++) {
      const from = centre(body.pos);
      const to = { x: from.x + body.vel.x * time, y: from.y + body.vel.y * time, z: from.z + body.vel.z * time };
      const tr = collider.trace(from, to, HALF);
      if (tr.startSolid && tr.fraction === 0) {
        // Stuck: nudge upwards out of whatever this is.
        body.pos.y += 0.05;
        return;
      }
      const end = lerp(from, to, tr.fraction);
      body.pos = { x: end.x, y: end.y - HALF[1], z: end.z };
      if (tr.fraction === 1) return;
      time -= time * tr.fraction;
      normals.push(tr.normal);
      // Clip velocity against every plane hit so far (PM_ClipVelocity).
      for (const n of normals) {
        const back = body.vel.x * n[0] + body.vel.y * n[1] + body.vel.z * n[2];
        if (back < 0) {
          body.vel.x -= n[0] * back * 1.001;
          body.vel.y -= n[1] * back * 1.001;
          body.vel.z -= n[2] * back * 1.001;
        }
      }
    }
  }

  function groundCheck() {
    const from = centre(body.pos);
    const tr = collider.trace(from, { x: from.x, y: from.y - 0.08, z: from.z }, HALF);
    body.onGround = tr.fraction < 1 && tr.normal && tr.normal[1] > 0.7;
    return tr;
  }

  // wish: desired horizontal velocity in m/s. Returns nothing; read body.
  function move(wish, dt, jump) {
    groundCheck();
    if (body.onGround) {
      // Quake ground friction and acceleration, simplified.
      const accel = 10;
      body.vel.x += (wish.x - body.vel.x) * Math.min(1, accel * dt);
      body.vel.z += (wish.z - body.vel.z) * Math.min(1, accel * dt);
      if (body.vel.y < 0) body.vel.y = 0;
      if (jump) {
        body.vel.y = JUMP;
        body.onGround = false;
      }
    } else {
      // A little air control, as every Quake player expects.
      body.vel.x += (wish.x - body.vel.x) * Math.min(1, 2 * dt);
      body.vel.z += (wish.z - body.vel.z) * Math.min(1, 2 * dt);
      body.vel.y -= GRAVITY * dt;
    }

    // Try the move flat; then try it from a step higher and keep
    // whichever went further. That is how stairs work in Quake.
    const start = { ...body.pos };
    const startVel = { ...body.vel };
    slide(dt);
    const flat = { pos: { ...body.pos }, vel: { ...body.vel } };

    if (body.onGround || startVel.y <= 0) {
      body.pos = { ...start };
      body.vel = { ...startVel };
      const up = collider.trace(centre(start), { ...centre(start), y: centre(start).y + STEP }, HALF);
      body.pos.y += STEP * up.fraction;
      slide(dt);
      const c = centre(body.pos);
      const down = collider.trace(c, { ...c, y: c.y - STEP - 0.02 }, HALF);
      body.pos.y -= (STEP + 0.02) * down.fraction;
      const stepped = { pos: { ...body.pos }, vel: { ...body.vel } };
      const landedOn = down.normal && down.normal[1] > 0.7;
      const d2 = (p) => (p.x - start.x) ** 2 + (p.z - start.z) ** 2;
      if (!landedOn || d2(flat.pos) >= d2(stepped.pos) - 1e-6) {
        body.pos = flat.pos;
        body.vel = flat.vel;
      } else {
        body.vel.y = Math.min(0, flat.vel.y);
      }
    }
    // Stick to the floor going down stairs and slopes.
    const tr = groundCheck();
    if (!body.onGround && startVel.y <= 0 && !jump) {
      const c = centre(body.pos);
      const down = collider.trace(c, { ...c, y: c.y - STEP }, HALF);
      if (down.fraction < 1 && down.normal && down.normal[1] > 0.7) {
        body.pos.y -= STEP * down.fraction;
        body.onGround = true;
      }
    }
    void tr;
    // Nothing falls forever.
    if (body.pos.y < -200) body.pos = { ...start, y: start.y + 1 };
  }

  return { body, move, groundCheck };
}

// The camera boom shortened against the level, so a third-person camera
// never ends up inside a wall.
export function boomLength(collider, from, dir, want) {
  const to = { x: from.x + dir.x * want, y: from.y + dir.y * want, z: from.z + dir.z * want };
  const tr = collider.trace(from, to, [0.2, 0.2, 0.2]);
  return want * tr.fraction;
}
