#!/usr/bin/env node
// Imports LibreQuake levels (BSD-licensed, https://github.com/lavenderdotpet/LibreQuake)
// into something three.js can draw and the game can walk on.
//
//   node tools/import-librequake.mjs /path/to/librequake            # every map in MAPS
//   node tools/import-librequake.mjs /path/to/librequake --scan e1/lq_e1m7.map
//
// LibreQuake ships its levels as TrenchBroom .map source rather than
// compiled BSPs, so this does the useful half of a map compiler itself:
//
//   brushes   -> face polygons (clip a quad per plane by every other plane)
//   faces     -> triangles with Valve-220 texture coordinates
//   lights    -> a baked lightmap atlas, with real shadows (ray traced
//                against the brushes), sunlight and sky light, Quake's
//                linear falloff and its 2x overbright
//   brushes   -> collision hulls, in metres, for the walking controller
//   floors    -> arenas: 15 m squares of flat, open floor with headroom,
//                found automatically, because that is where a raid boss
//                can stand without the sim's arena poking through a wall
//
// Output goes to assets/librequake/: one .json + .bin + lightmap .png per
// map, and every texture a map uses copied across once.

import { readFileSync, writeFileSync, mkdirSync, readdirSync, copyFileSync, existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseMap, buildBrush, textureAxes, dot, sub, add, scale, cross, norm, len, vec3, pointInBrush } from './mapfile.mjs';
import { pngSize, encodeRGB } from './png.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', 'assets', 'librequake');
const UNITS_PER_METRE = 32; // a Quake player is 56 units: 1.75 m
const LUXEL = 16; // Quake's own lightmap resolution

// The levels this game uses, and what it uses them for. `arenas` pins
// which of the automatically found floors each encounter is fought on.
export const MAPS = [
  { id: 'hub', src: 'misc/start.map', role: 'hub' },
  { id: 'lq_e1m5', src: 'e1/lq_e1m5.map', role: 'raid' },
  { id: 'lq_e2m3', src: 'e2/lq_e2m3.map', role: 'raid' },
  { id: 'lq_e2m5', src: 'e2/lq_e2m5.map', role: 'raid' },
  { id: 'lq_e3m6', src: 'e3/lq_e3m6.map', role: 'raid' },
  { id: 'lq_e4m5', src: 'e4/lq_e4m5.map', role: 'raid' },
  { id: 'lq_end', src: 'misc/lq_end.map', role: 'raid' },
];

/* ---------------------------------------------------- classification */

const NODRAW = /^(skip|clip|trigger|hint|hintskip|origin|null|nodraw|star_?waterskip|\*waterskip|\*slimeskip|\*lavaskip|\*teleskip|\*h2oteleskip|clipmonster)$/i;
const RENDER_SOLID = new Set([
  'worldspawn', 'func_group', 'func_detail', 'func_detail_wall', 'func_wall', 'func_plat',
  'func_button', 'func_detail_fence', 'func_train',
]);
const RENDER_ONLY = new Set(['func_illusionary', 'func_detail_illusionary']);

function texKind(name) {
  const n = name.toLowerCase();
  if (n.startsWith('sky')) return 'sky';
  if (n.startsWith('*')) return 'liquid';
  if (n.startsWith('{')) return 'cutout';
  return 'wall';
}

/* --------------------------------------------------------- textures */

function textureIndex(root) {
  const index = new Map();
  const wads = join(root, 'texture-wads');
  for (const dir of readdirSync(wads, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    for (const f of readdirSync(join(wads, dir.name))) {
      if (!f.endsWith('.png')) continue;
      const key = f.slice(0, -4).toLowerCase();
      // A legacy folder never shadows a current one.
      const prev = index.get(key);
      if (!prev || (prev.includes('legacy') && !dir.name.includes('legacy'))) index.set(key, join(wads, dir.name, f));
    }
  }
  return index;
}

function resolveTexture(index, name) {
  const raw = name.toLowerCase();
  const n = raw.replace(/^\*/, 'star_').replace(/^\+/, 'plus_');
  for (const k of [n, `${n}_fbr`, raw, `${raw}_fbr`]) if (index.has(k)) return index.get(k);
  return null;
}

const safeName = (name) => name.toLowerCase().replace(/^\*/, 'star_').replace(/^\+/, 'plus_').replace(/^\{/, 'cut_').replace(/[^a-z0-9_]/g, '_');

/* -------------------------------------------------------- the level */

function loadLevel(root, src) {
  const text = readFileSync(join(root, 'lq1', 'maps', 'src', src), 'utf8');
  const entities = parseMap(text);

  // TrenchBroom layers marked "omit from export" are not part of the map.
  const omitted = new Set();
  for (const e of entities) {
    if (e.props._tb_type === '_tb_layer' && e.props._tb_layer_omit_from_export === '1') omitted.add(e.props._tb_id);
  }

  const brushes = []; // { planes, polys, mins, maxs, solid, render, liquid, sky[] }
  for (const e of entities) {
    const cls = e.props.classname;
    if (omitted.has(e.props._tb_layer) || omitted.has(e.props._tb_id)) continue;
    if (!e.brushes.length) continue;
    const renderSolid = RENDER_SOLID.has(cls);
    const renderOnly = RENDER_ONLY.has(cls);
    if (!renderSolid && !renderOnly) continue;
    for (const faces of e.brushes) {
      const b = buildBrush(faces);
      if (!b.polys.length) continue;
      const names = faces.map((f) => f.tex);
      const liquid = names.some((t) => t.startsWith('*'));
      const allClip = names.every((t) => /^(clip|clipmonster)$/i.test(t));
      b.liquid = liquid;
      b.solid = renderSolid && !liquid && !/^clipmonster$/i.test(names[0]);
      b.render = !allClip;
      b.occluder = b.solid && !allClip && !names.some((t) => t.startsWith('{'));
      b.planeTex = b.planes.map((_, k) => faces[k] && faces[k].tex);
      brushes.push(b);
    }
  }
  return { entities, brushes };
}

/* --------------------------------------------------- ray tracing BVH */

function buildBvh(items) {
  const nodes = [];
  function node(list) {
    const mins = [Infinity, Infinity, Infinity];
    const maxs = [-Infinity, -Infinity, -Infinity];
    for (const b of list) for (let a = 0; a < 3; a++) {
      mins[a] = Math.min(mins[a], b.mins[a]);
      maxs[a] = Math.max(maxs[a], b.maxs[a]);
    }
    const n = { mins, maxs, items: null, l: null, r: null };
    if (list.length <= 4) {
      n.items = list;
      return n;
    }
    const ext = sub(maxs, mins);
    const axis = ext[0] > ext[1] ? (ext[0] > ext[2] ? 0 : 2) : ext[1] > ext[2] ? 1 : 2;
    list.sort((p, q) => p.mins[axis] + p.maxs[axis] - q.mins[axis] - q.maxs[axis]);
    const mid = list.length >> 1;
    n.l = node(list.slice(0, mid));
    n.r = node(list.slice(mid));
    return n;
  }
  return items.length ? node(items) : null;
}

function rayBox(o, inv, mins, maxs, tmax) {
  let t0 = 0;
  let t1 = tmax;
  for (let a = 0; a < 3; a++) {
    let near = (mins[a] - o[a]) * inv[a];
    let far = (maxs[a] - o[a]) * inv[a];
    if (near > far) [near, far] = [far, near];
    if (near > t0) t0 = near;
    if (far < t1) t1 = far;
    if (t0 > t1) return false;
  }
  return true;
}

// Distance along the ray at which it enters the convex brush, and the
// plane it enters through; null if it misses within tmax.
function rayBrush(b, o, d, tmax) {
  let enter = -Infinity;
  let exit = tmax;
  let plane = -1;
  for (let k = 0; k < b.planes.length; k++) {
    const p = b.planes[k];
    const denom = dot(p.normal, d);
    const dist = dot(p.normal, o) - p.dist;
    if (Math.abs(denom) < 1e-9) {
      if (dist > 0) return null;
      continue;
    }
    const t = -dist / denom;
    if (denom < 0) {
      if (t > enter) {
        enter = t;
        plane = k;
      }
    } else if (t < exit) exit = t;
    if (enter > exit) return null;
  }
  if (enter < 0 || enter > tmax || plane < 0) return null;
  return { t: enter, plane };
}

function makeTracer(brushes) {
  const root = buildBvh(brushes.filter((b) => b.occluder));
  // Any hit at all between two points -- the shadow test.
  function blocked(from, to) {
    if (!root) return false;
    const d0 = sub(to, from);
    const tmax = len(d0);
    if (tmax < 1e-6) return false;
    const d = scale(d0, 1 / tmax);
    const inv = d.map((x) => (Math.abs(x) < 1e-12 ? 1e12 : 1 / x));
    const stack = [root];
    while (stack.length) {
      const n = stack.pop();
      if (!rayBox(from, inv, n.mins, n.maxs, tmax)) continue;
      if (n.items) {
        for (const b of n.items) if (rayBrush(b, from, d, tmax)) return true;
      } else stack.push(n.l, n.r);
    }
    return false;
  }
  // Nearest hit, and whether what it hit was sky.
  function first(from, dir, tmax) {
    if (!root) return null;
    const inv = dir.map((x) => (Math.abs(x) < 1e-12 ? 1e12 : 1 / x));
    let best = null;
    const stack = [root];
    while (stack.length) {
      const n = stack.pop();
      if (!rayBox(from, inv, n.mins, n.maxs, best ? best.t : tmax)) continue;
      if (n.items) {
        for (const b of n.items) {
          const h = rayBrush(b, from, dir, best ? best.t : tmax);
          if (h && (!best || h.t < best.t)) best = { t: h.t, tex: b.planeTex[h.plane] || '' };
        }
      } else stack.push(n.l, n.r);
    }
    return best;
  }
  return { blocked, first };
}

/* ------------------------------------------------------------ light */

function parseColour(s) {
  if (!s) return [1, 1, 1];
  let c = vec3(s);
  if (c.some((x) => x > 1)) c = c.map((x) => x / 255);
  const m = Math.max(...c, 1e-6);
  return c.map((x) => x / m);
}

function collectLights(entities) {
  const lights = [];
  for (const e of entities) {
    const cls = e.props.classname || '';
    if (!cls.startsWith('light')) continue;
    if (!e.props.origin) continue;
    const fallback = cls.includes('torch') || cls.includes('flame') ? 200 : 300;
    const value = Number(e.props.light ?? e.props._light ?? fallback);
    if (!(value > 0)) continue;
    lights.push({
      origin: vec3(e.props.origin),
      value,
      colour: parseColour(e.props._color),
      wait: Number(e.props.wait || 1) || 1,
      delay: Number(e.props.delay || 0),
    });
  }
  return lights;
}

function sunFrom(world) {
  const p = world.props;
  const mangle = vec3(p._sun_mangle || p._sunlight_mangle || '0 -90 0');
  const yaw = (mangle[0] * Math.PI) / 180;
  const pitch = (mangle[1] * Math.PI) / 180;
  // The direction the light travels; we want the way back to the sun.
  const travel = [Math.cos(yaw) * Math.cos(pitch), Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch)];
  return {
    toSun: norm(scale(travel, -1)),
    value: Number(p._sunlight || 0),
    colour: parseColour(p._sunlight_color),
    sky: Number(p._sunlight2 || 0),
    skyColour: parseColour(p._sunlight2_color || p._sunlight_color2),
    minlight: Math.max(Number(p.light || p._minlight || 0), 0),
    // ericw's light tool adds a radiosity bounce the mapper relied on when
    // lighting the level; we do not trace bounces, so allow for them.
    gain: p._bounce === '0' ? 1.15 : 1.45,
  };
}

// Hemisphere directions for sky light, fixed so the bake is repeatable.
const DOME = (() => {
  const out = [];
  const rings = [[0.95, 1], [0.7, 5], [0.35, 7]];
  for (const [z, count] of rings) {
    const r = Math.sqrt(1 - z * z);
    for (let k = 0; k < count; k++) {
      const a = (k / count) * Math.PI * 2 + z;
      out.push([Math.cos(a) * r, Math.sin(a) * r, z]);
    }
  }
  return out;
})();

function lightAt(point, normal, lights, sun, tracer) {
  const c = [0, 0, 0];
  const from = add(point, scale(normal, 1));
  for (const L of lights) {
    const toL = sub(L.origin, point);
    const dist = Math.max(1, len(toL));
    let amount;
    if (L.delay === 1) amount = (L.value * 128) / (dist * L.wait);
    else if (L.delay === 2) amount = (L.value * 128 * 128) / (dist * dist * L.wait * L.wait);
    else amount = L.value - dist * L.wait;
    if (amount < 1) continue;
    const cos = dot(normal, toL) / dist;
    if (cos <= 0) continue;
    amount *= 0.5 + 0.5 * cos; // ericw's default _anglescale of 0.5
    if (tracer.blocked(from, L.origin)) continue;
    for (let a = 0; a < 3; a++) c[a] += amount * L.colour[a];
  }
  if (sun.value > 0) {
    const cos = dot(normal, sun.toSun);
    if (cos > 0) {
      const hit = tracer.first(from, sun.toSun, 16384);
      if (hit && texKind(hit.tex) === 'sky') for (let a = 0; a < 3; a++) c[a] += sun.value * cos * sun.colour[a];
    }
  }
  if (sun.sky > 0) {
    let seen = 0;
    let weight = 0;
    for (const dir of DOME) {
      const cos = dot(normal, dir);
      if (cos <= 0) continue;
      weight += 1;
      const hit = tracer.first(from, dir, 16384);
      if (hit && texKind(hit.tex) === 'sky') seen += cos;
    }
    if (weight) for (let a = 0; a < 3; a++) c[a] += (sun.sky * seen * sun.skyColour[a]) / weight;
  }
  // A floor under the dark, because a browser has no gamma slider.
  const floor = Math.max(sun.minlight, 34);
  for (let a = 0; a < 3; a++) c[a] = Math.max(c[a] * sun.gain, floor);
  return c;
}

/* -------------------------------------------------- lightmap atlas */

function faceBasis(normal) {
  const az = Math.abs(normal[2]);
  let up = az > 0.7 ? [0, 1, 0] : [0, 0, 1];
  up = norm(sub(up, scale(normal, dot(up, normal))));
  return { s: norm(cross(up, normal)), t: up };
}

function pointInPoly(points, normal, p) {
  for (let k = 0; k < points.length; k++) {
    const a = points[k];
    const b = points[(k + 1) % points.length];
    const edge = sub(b, a);
    const inward = cross(normal, edge); // with CCW winding, points inward
    if (dot(inward, sub(p, a)) < -0.5) return false;
  }
  return true;
}

function packAtlas(rects) {
  // Shelf packing, tallest first. Width is fixed; height grows.
  const area = rects.reduce((s, r) => s + r.w * r.h, 0);
  let W = 256;
  while (W * W < area * 1.25) W *= 2;
  const order = rects.map((r, i) => i).sort((a, b) => rects[b].h - rects[a].h);
  let x = 0;
  let y = 0;
  let shelf = 0;
  for (const i of order) {
    const r = rects[i];
    if (x + r.w > W) {
      x = 0;
      y += shelf;
      shelf = 0;
    }
    r.x = x;
    r.y = y;
    x += r.w;
    shelf = Math.max(shelf, r.h);
  }
  let H = 1;
  while (H < y + shelf) H *= 2;
  return { W, H };
}

/* --------------------------------------------------- arena finding */

const ARENA_UNITS = 15 * UNITS_PER_METRE; // 5 sim cells of 3 m
const COL = 32;

function findArenas(brushes, want = 4, entities = []) {
  // Things a mapper put somewhere a player goes. A flat square with none of
  // these in or near it is the void outside the sealed level, not a room.
  const markers = entities
    .filter((e) => e.props.origin && /^(monster_|item_|weapon_|info_player|light|info_teleport|ambient_)/.test(e.props.classname || ''))
    .map((e) => vec3(e.props.origin));
  const solids = brushes.filter((b) => b.solid);
  const liquids = brushes.filter((b) => b.liquid);
  const mins = [Infinity, Infinity];
  const maxs = [-Infinity, -Infinity];
  for (const b of solids) for (let a = 0; a < 2; a++) {
    mins[a] = Math.min(mins[a], b.mins[a]);
    maxs[a] = Math.max(maxs[a], b.maxs[a]);
  }
  const nx = Math.ceil((maxs[0] - mins[0]) / COL);
  const ny = Math.ceil((maxs[1] - mins[1]) / COL);

  // Bucket brushes by footprint so a column only tests its neighbours.
  const BUCKET = 256;
  const buckets = new Map();
  const put = (list, b, tag) => {
    for (let bx = Math.floor(b.mins[0] / BUCKET); bx <= Math.floor(b.maxs[0] / BUCKET); bx++)
      for (let by = Math.floor(b.mins[1] / BUCKET); by <= Math.floor(b.maxs[1] / BUCKET); by++) {
        const key = `${bx},${by}`;
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push([b, tag]);
      }
  };
  for (const b of solids) put(buckets, b, 's');
  for (const b of liquids) put(buckets, b, 'l');

  // Where a vertical line through (x, y) is inside a brush.
  function span(b, x, y) {
    let lo = -Infinity;
    let hi = Infinity;
    for (const p of b.planes) {
      const nz = p.normal[2];
      const rest = p.normal[0] * x + p.normal[1] * y - p.dist;
      if (Math.abs(nz) < 1e-6) {
        if (rest > 0.01) return null;
        continue;
      }
      const z = -rest / nz;
      if (nz > 0) hi = Math.min(hi, z);
      else lo = Math.max(lo, z);
    }
    return lo < hi ? [lo, hi] : null;
  }

  // Per column: every standable floor and the ceiling above it.
  const floors = new Array(nx * ny);
  const levels = new Set();
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      const x = mins[0] + (i + 0.5) * COL;
      const y = mins[1] + (j + 0.5) * COL;
      const list = buckets.get(`${Math.floor(x / BUCKET)},${Math.floor(y / BUCKET)}`) || [];
      const solid = [];
      const wet = [];
      for (const [b, tag] of list) {
        const s = span(b, x, y);
        if (s) (tag === 's' ? solid : wet).push(s);
      }
      solid.sort((a, b) => a[0] - b[0]);
      const merged = [];
      for (const s of solid) {
        const last = merged[merged.length - 1];
        if (last && s[0] <= last[1] + 1) last[1] = Math.max(last[1], s[1]);
        else merged.push(s.slice());
      }
      const out = [];
      for (let k = 0; k < merged.length; k++) {
        const f = merged[k][1];
        const ceil = k + 1 < merged.length ? merged[k + 1][0] : Infinity;
        // Roofs outside the sealed level have no ceiling: not a floor.
        if (!Number.isFinite(f) || !Number.isFinite(ceil) || ceil - f < 72) continue;
        // Standing in lava or water is not a floor.
        if (wet.some((w) => w[0] < f + 40 && w[1] > f - 1)) continue;
        out.push([f, ceil]);
        levels.add(Math.round(f / 8) * 8);
      }
      floors[i * ny + j] = out;
    }
  }

  const need = Math.ceil((ARENA_UNITS + 2 * COL) / COL);
  const found = [];
  for (const z of levels) {
    const dp = new Int32Array(nx * ny);
    let best = 0;
    for (let i = 0; i < nx; i++) {
      for (let j = 0; j < ny; j++) {
        const ok = floors[i * ny + j].some(([f, c]) => Math.abs(f - z) <= 8 && c - f >= 192);
        if (!ok) continue;
        const up = i > 0 ? dp[(i - 1) * ny + j] : 0;
        const left = j > 0 ? dp[i * ny + j - 1] : 0;
        const diag = i > 0 && j > 0 ? dp[(i - 1) * ny + j - 1] : 0;
        const v = 1 + Math.min(up, left, diag);
        dp[i * ny + j] = v;
        best = Math.max(best, v);
      }
    }
    if (best < need) continue;
    for (let i = 0; i < nx; i++) {
      for (let j = 0; j < ny; j++) {
        const k = dp[i * ny + j];
        if (k < need) continue;
        // Only keep local maxima, or every square inside a big one counts.
        const ci = i - (k - 1) / 2;
        const cj = j - (k - 1) / 2;
        const cx = mins[0] + (ci + 0.5) * COL;
        const cy = mins[1] + (cj + 0.5) * COL;
        let headroom = Infinity;
        const col = floors[Math.round(ci) * ny + Math.round(cj)] || [];
        for (const [f, c] of col) if (Math.abs(f - z) <= 8) headroom = Math.min(headroom, c - f);
        found.push({ x: cx, y: cy, z, size: k * COL, headroom });
      }
    }
  }
  // Biggest rooms first, then spread them out across the level.
  const lived = (f) => {
    const reach = f.size / 2 + 256;
    return markers.filter((m) => Math.abs(m[0] - f.x) < reach && Math.abs(m[1] - f.y) < reach && m[2] > f.z - 64 && m[2] < f.z + Math.min(f.headroom, 1024)).length;
  };
  // Prefer rooms over plains: a modest arena with walls in sight reads as
  // a place; a square in the middle of a 100 m field does not.
  found.sort((a, b) => Math.min(b.size, 900) - Math.min(a.size, 900) || a.headroom - b.headroom);
  const chosen = [];
  for (const f of found) {
    if (lived(f) < 1) continue;
    if (chosen.some((c) => Math.hypot(c.x - f.x, c.y - f.y) < 900 && Math.abs(c.z - f.z) < 200)) continue;
    chosen.push(f);
    if (chosen.length >= want) break;
  }
  return chosen;
}

/* ------------------------------------------------------------ export */

const toThree = (p) => [p[0] / UNITS_PER_METRE, p[2] / UNITS_PER_METRE, -p[1] / UNITS_PER_METRE];
const dirToThree = (n) => [n[0], n[2], -n[1]];

function exportMap(root, spec, texIndex, usedTextures) {
  const t0 = Date.now();
  const { entities, brushes } = loadLevel(root, spec.src);
  const world = entities.find((e) => e.props.classname === 'worldspawn');
  const tracer = makeTracer(brushes);
  const lights = collectLights(entities);
  const sun = sunFrom(world);

  /* ---- faces worth drawing ----------------------------------------- */
  const solidList = brushes.filter((b) => b.solid && b.occluder);
  const faces = [];
  for (const b of brushes) {
    if (!b.render) continue;
    for (const poly of b.polys) {
      const tex = poly.face.tex;
      if (NODRAW.test(tex) || /skip$/i.test(tex)) continue;
      // Make the winding counter-clockwise seen from outside.
      let pts = poly.points;
      const area = pts.slice(1, -1).reduce((acc, p, k) => add(acc, cross(sub(p, pts[0]), sub(pts[k + 2], pts[0]))), [0, 0, 0]);
      if (dot(area, poly.normal) < 0) pts = pts.slice().reverse();
      if (len(area) < 0.5) continue;
      // A face buried in another solid brush can never be seen.
      const centre = scale(pts.reduce(add, [0, 0, 0]), 1 / pts.length);
      const probe = add(centre, scale(poly.normal, 0.5));
      if (texKind(tex) !== 'liquid' && solidList.some((o) => o !== b && probe[0] >= o.mins[0] - 1 && probe[0] <= o.maxs[0] + 1 &&
        probe[1] >= o.mins[1] - 1 && probe[1] <= o.maxs[1] + 1 && probe[2] >= o.mins[2] - 1 && probe[2] <= o.maxs[2] + 1 &&
        pointInBrush(o, probe, -0.01))) continue;
      faces.push({ tex, normal: poly.normal, points: pts, face: poly.face });
    }
  }

  /* ---- textures ----------------------------------------------------- */
  const texList = [];
  const texId = new Map();
  for (const f of faces) {
    if (texId.has(f.tex)) continue;
    const file = resolveTexture(texIndex, f.tex);
    const size = file ? pngSize(readFileSync(file)) : { w: 64, h: 64 };
    texId.set(f.tex, texList.length);
    const name = safeName(f.tex);
    texList.push({ name, src: f.tex, w: size.w, h: size.h, kind: texKind(f.tex), missing: !file });
    if (file) usedTextures.set(name, file);
  }

  /* ---- lightmap rects ---------------------------------------------- */
  const rects = [];
  for (const f of faces) {
    if (texKind(f.tex) !== 'wall' && texKind(f.tex) !== 'cutout') continue;
    const basis = faceBasis(f.normal);
    let smin = Infinity, smax = -Infinity, tmin = Infinity, tmax = -Infinity;
    for (const p of f.points) {
      const s = dot(p, basis.s);
      const t = dot(p, basis.t);
      smin = Math.min(smin, s); smax = Math.max(smax, s);
      tmin = Math.min(tmin, t); tmax = Math.max(tmax, t);
    }
    smin = Math.floor(smin / LUXEL) * LUXEL;
    tmin = Math.floor(tmin / LUXEL) * LUXEL;
    const lw = Math.ceil((smax - smin) / LUXEL) + 1;
    const lh = Math.ceil((tmax - tmin) / LUXEL) + 1;
    f.lm = { basis, smin, tmin, lw, lh };
    rects.push(f.lm);
    f.lm.w = lw + 2;
    f.lm.h = lh + 2;
  }
  const { W, H } = packAtlas(rects);
  const atlas = Buffer.alloc(W * H * 3, 0);

  let luxels = 0;
  for (const f of faces) {
    if (!f.lm) continue;
    const { basis, smin, tmin, lw, lh, x: ox, y: oy } = f.lm;
    const plane = dot(f.normal, f.points[0]);
    const centre = scale(f.points.reduce(add, [0, 0, 0]), 1 / f.points.length);
    const grid = [];
    for (let j = 0; j < lh; j++) {
      for (let i = 0; i < lw; i++) {
        const s = smin + i * LUXEL;
        const t = tmin + j * LUXEL;
        // Back onto the face plane: s, t and the normal are orthonormal.
        let p = add(add(scale(basis.s, s), scale(basis.t, t)), scale(f.normal, plane));
        // Luxels hanging off the edge of the face sample from inside it,
        // or every corner is lit by whatever is behind the wall.
        for (let step = 0; step < 6 && !pointInPoly(f.points, f.normal, p); step++) p = add(p, scale(sub(centre, p), 0.4));
        grid.push(lightAt(p, f.normal, lights, sun, tracer));
        luxels++;
      }
    }
    // Write with a one-luxel border so bilinear filtering never bleeds.
    for (let j = -1; j <= lh; j++) {
      for (let i = -1; i <= lw; i++) {
        const c = grid[Math.min(lh - 1, Math.max(0, j)) * lw + Math.min(lw - 1, Math.max(0, i))];
        const at = ((oy + 1 + j) * W + (ox + 1 + i)) * 3;
        // Stored at half scale (0-255 covers 0-510); the shader maps 128 to 1.0
        // and lets it go to 2x above that, which is Quake's overbright.
        for (let a = 0; a < 3; a++) atlas[at + a] = Math.min(255, Math.round(c[a] / 2));
      }
    }
  }

  /* ---- vertices ----------------------------------------------------- */
  const groups = new Map();
  for (const f of faces) {
    const id = texId.get(f.tex);
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(f);
  }
  const pos = [];
  const uv = [];
  const uv2 = [];
  const groupOut = [];
  for (const [id, list] of groups) {
    const tex = texList[id];
    const start = pos.length / 3;
    for (const f of list) {
      const ax = textureAxes(f.face, f.normal);
      const vert = (p) => {
        pos.push(...toThree(p));
        uv.push((dot(p, ax.u) / ax.su + ax.offU) / tex.w, (dot(p, ax.v) / ax.sv + ax.offV) / tex.h);
        if (f.lm) {
          const s = (dot(p, f.lm.basis.s) - f.lm.smin) / LUXEL;
          const t = (dot(p, f.lm.basis.t) - f.lm.tmin) / LUXEL;
          uv2.push((f.lm.x + 1 + s + 0.5) / W, (f.lm.y + 1 + t + 0.5) / H);
        } else uv2.push(0, 0);
      };
      for (let k = 1; k + 1 < f.points.length; k++) {
        vert(f.points[0]);
        vert(f.points[k]);
        vert(f.points[k + 1]);
      }
    }
    groupOut.push({ tex: id, start, count: pos.length / 3 - start });
  }

  /* ---- collision ---------------------------------------------------- */
  const planes = [];
  const hulls = [];
  for (const b of brushes) {
    if (!b.solid) continue;
    const first = planes.length / 4;
    for (const p of b.planes) {
      planes.push(...dirToThree(p.normal), p.dist / UNITS_PER_METRE);
    }
    const lo = toThree(b.mins);
    const hi = toThree(b.maxs);
    hulls.push(first, b.planes.length,
      Math.min(lo[0], hi[0]), Math.min(lo[1], hi[1]), Math.min(lo[2], hi[2]),
      Math.max(lo[0], hi[0]), Math.max(lo[1], hi[1]), Math.max(lo[2], hi[2]));
  }

  /* ---- entities the game cares about ------------------------------- */
  const things = [];
  const triggers = [];
  const bounds = (e) => {
    const all = e.brushes.map(buildBrush);
    const mins = [Infinity, Infinity, Infinity];
    const maxs = [-Infinity, -Infinity, -Infinity];
    for (const b of all) for (let a = 0; a < 3; a++) {
      mins[a] = Math.min(mins[a], b.mins[a]);
      maxs[a] = Math.max(maxs[a], b.maxs[a]);
    }
    const lo = toThree(mins);
    const hi = toThree(maxs);
    return [Math.min(lo[0], hi[0]), Math.min(lo[1], hi[1]), Math.min(lo[2], hi[2]), Math.max(lo[0], hi[0]), Math.max(lo[1], hi[1]), Math.max(lo[2], hi[2])];
  };
  for (const e of entities) {
    const p = e.props;
    const cls = p.classname || '';
    if (/^(info_player_start|info_player_deathmatch|info_player_coop|info_teleport_destination|info_intermission)$/.test(cls) ||
      cls.startsWith('monster_') || cls.startsWith('weapon_') || cls.startsWith('item_') || cls.startsWith('light')) {
      if (!p.origin) continue;
      const thing = { cls, at: toThree(vec3(p.origin)).map((x) => +x.toFixed(3)) };
      if (p.angle) thing.angle = Number(p.angle);
      if (p.mangle) thing.mangle = vec3(p.mangle);
      if (p.targetname) thing.targetname = p.targetname;
      if (cls.startsWith('light')) {
        // Only bright ones are worth a flame sprite or a real light.
        if (!cls.includes('torch') && !cls.includes('flame')) continue;
      }
      things.push(thing);
    }
    if (cls === 'trigger_changelevel' || cls === 'trigger_teleport') {
      triggers.push({ cls, map: p.map, target: p.target, box: bounds(e).map((x) => +x.toFixed(3)) });
    }
  }

  /* ---- arenas ------------------------------------------------------- */
  const arenas = spec.role === 'raid' ? findArenas(brushes, 4, entities) : [];

  /* ---- write -------------------------------------------------------- */
  const f32 = (a) => Buffer.from(new Float32Array(a).buffer);
  const parts = { pos: f32(pos), uv: f32(uv), uv2: f32(uv2), planes: f32(planes), hulls: f32(hulls) };
  const layout = {};
  let offset = 0;
  for (const [k, buf] of Object.entries(parts)) {
    layout[k] = { offset, length: buf.length / 4 };
    offset += buf.length;
  }
  mkdirSync(join(OUT, 'maps'), { recursive: true });
  writeFileSync(join(OUT, 'maps', `${spec.id}.bin`), Buffer.concat(Object.values(parts)));
  writeFileSync(join(OUT, 'maps', `${spec.id}.lm.png`), encodeRGB(W, H, atlas));
  const meta = {
    id: spec.id,
    source: `lq1/maps/src/${spec.src}`,
    title: world.props.message || spec.id,
    credits: world.props._credits || '',
    unitsPerMetre: UNITS_PER_METRE,
    fog: world.props._fog || '',
    sky: texList.find((t) => t.kind === 'sky')?.name || '',
    textures: texList.map(({ name, w, h, kind }) => ({ name, w, h, kind })),
    lightmap: { file: `${spec.id}.lm.png`, w: W, h: H },
    layout,
    groups: groupOut,
    things,
    triggers,
    arenas: arenas.map((a) => ({
      at: toThree([a.x, a.y, a.z]).map((x) => +x.toFixed(3)),
      size: +(a.size / UNITS_PER_METRE).toFixed(2),
      headroom: Number.isFinite(a.headroom) ? +(a.headroom / UNITS_PER_METRE).toFixed(2) : 99,
    })),
  };
  writeFileSync(join(OUT, 'maps', `${spec.id}.json`), JSON.stringify(meta));
  const missing = texList.filter((t) => t.missing).map((t) => t.name);
  console.log(`${spec.id.padEnd(8)} ${meta.title} — ${faces.length} faces, ${pos.length / 9} tris, ${hulls.length / 8} hulls, ` +
    `${lights.length} lights, ${luxels} luxels in ${W}x${H}, ${arenas.length} arenas, ${((Date.now() - t0) / 1000).toFixed(1)}s` +
    (missing.length ? `\n         missing textures: ${missing.join(' ')}` : ''));
  for (const a of meta.arenas) console.log(`         arena at ${a.at.join(', ')} — ${a.size} m clear, ${a.headroom} m headroom`);
}

/* -------------------------------------------------------------- main */

const args = process.argv.slice(2);
const root = args[0];
if (!root || !existsSync(join(root, 'lq1', 'maps', 'src'))) {
  console.error('usage: node tools/import-librequake.mjs /path/to/LibreQuake [--scan map.map ...] [--only id,id]');
  process.exit(1);
}

if (args[1] === '--scan') {
  // Arena candidates only, for picking which levels to raid in.
  for (const src of args.slice(2)) {
    const { brushes, entities } = loadLevel(root, src);
    const arenas = findArenas(brushes, 4, entities);
    console.log(`${src}: ${arenas.map((a) => `${(a.size / 32).toFixed(0)}m@${a.z}`).join('  ') || 'no arena'}`);
  }
  process.exit(0);
}

const only = args[1] === '--only' ? new Set(args[2].split(',')) : null;
const texIndex = textureIndex(root);
const used = new Map();
for (const spec of MAPS) if (!only || only.has(spec.id)) exportMap(root, spec, texIndex, used);

mkdirSync(join(OUT, 'textures'), { recursive: true });
for (const [name, file] of used) copyFileSync(file, join(OUT, 'textures', `${name}.png`));
copyFileSync(join(root, 'docs', 'COPYING'), join(OUT, 'COPYING'));
if (existsSync(join(root, 'docs', 'CREDITS'))) copyFileSync(join(root, 'docs', 'CREDITS'), join(OUT, 'CREDITS'));
console.log(`${used.size} textures copied`);
