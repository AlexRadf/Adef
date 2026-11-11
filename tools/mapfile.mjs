// A Quake .map reader and brush compiler -- the half of qbsp a renderer
// actually needs. A .map file is entities; an entity is key/value pairs
// plus brushes; a brush is the convex volume behind a set of planes. We
// turn each brush into its face polygons by clipping one huge quad per
// plane against all the others, which is all a convex hull is.
//
// Everything here is in Quake units with Z up. Conversion into metres
// and three.js axes happens once, at export.

const EPS = 0.01;

/* ------------------------------------------------------------ parsing */

export function parseMap(text) {
  const entities = [];
  let i = 0;
  const n = text.length;

  const skipSpace = () => {
    for (;;) {
      while (i < n && text.charCodeAt(i) <= 32) i++;
      if (text[i] === '/' && text[i + 1] === '/') {
        while (i < n && text[i] !== '\n') i++;
        continue;
      }
      return;
    }
  };
  const token = () => {
    skipSpace();
    if (i >= n) return null;
    const c = text[i];
    if (c === '"') {
      const end = text.indexOf('"', i + 1);
      const s = text.slice(i + 1, end);
      i = end + 1;
      return { q: s };
    }
    if ('{}()[]'.includes(c)) {
      i++;
      return c;
    }
    const start = i;
    while (i < n && text.charCodeAt(i) > 32 && !'{}()[]"'.includes(text[i])) i++;
    return text.slice(start, i);
  };
  const num = () => Number(token());

  for (;;) {
    const t = token();
    if (t === null) break;
    if (t !== '{') throw new Error(`expected { at ${i}, got ${JSON.stringify(t)}`);
    const ent = { props: {}, brushes: [] };
    for (;;) {
      const k = token();
      if (k === '}') break;
      if (k && k.q !== undefined) {
        const v = token();
        ent.props[k.q] = v.q;
        continue;
      }
      if (k === '{') {
        const faces = [];
        for (;;) {
          const f = token();
          if (f === '}') break;
          if (f !== '(') throw new Error(`bad brush at ${i}`);
          const pts = [];
          for (let p = 0; p < 3; p++) {
            if (p > 0) token(); // (
            pts.push([num(), num(), num()]);
            token(); // )
          }
          // Texture names may start with { (alpha masks), so read raw.
          skipSpace();
          let tex;
          if (text[i] === '"') tex = token().q;
          else {
            const start = i;
            while (i < n && text.charCodeAt(i) > 32) i++;
            tex = text.slice(start, i);
          }
          const face = { pts, tex };
          skipSpace();
          if (text[i] === '[') {
            token();
            face.u = [num(), num(), num(), num()];
            token();
            token();
            face.v = [num(), num(), num(), num()];
            token();
            face.rot = num();
            face.su = num();
            face.sv = num();
            face.valve = true;
          } else {
            face.offU = num();
            face.offV = num();
            face.rot = num();
            face.su = num();
            face.sv = num();
          }
          // Quake 2/3 style trailing flags, if any.
          skipSpace();
          while (i < n && /[-0-9]/.test(text[i])) token();
          faces.push(face);
        }
        ent.brushes.push(faces);
      }
    }
    entities.push(ent);
  }
  return entities;
}

/* ------------------------------------------------------------ vectors */

export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const scale = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const len = (a) => Math.hypot(a[0], a[1], a[2]);
export const norm = (a) => scale(a, 1 / (len(a) || 1));

/* ------------------------------------------------------------- brushes */

// Planes from three points, the qbsp way: the points wind clockwise seen
// from outside, so this cross product points out of the solid.
export function facePlane(face) {
  const [p0, p1, p2] = face.pts;
  const normal = norm(cross(sub(p0, p1), sub(p2, p1)));
  return { normal, dist: dot(normal, p1) };
}

function baseWinding(normal, dist) {
  // Pick the major axis, build an up vector off it, and make a quad far
  // bigger than any map.
  const ax = Math.abs(normal[0]);
  const ay = Math.abs(normal[1]);
  const az = Math.abs(normal[2]);
  let up = az >= ax && az >= ay ? [1, 0, 0] : [0, 0, 1];
  up = norm(sub(up, scale(normal, dot(up, normal))));
  const right = cross(up, normal);
  const org = scale(normal, dist);
  const B = 65536;
  const u = scale(up, B);
  const r = scale(right, B);
  return [add(sub(org, r), u), add(add(org, r), u), sub(add(org, r), u), sub(sub(org, r), u)];
}

// Keep the part of the polygon behind the plane (dot(n,p) <= d).
export function clipWinding(points, normal, dist) {
  const out = [];
  const m = points.length;
  for (let k = 0; k < m; k++) {
    const a = points[k];
    const b = points[(k + 1) % m];
    const da = dot(normal, a) - dist;
    const db = dot(normal, b) - dist;
    if (da <= EPS) out.push(a);
    if ((da < -EPS && db > EPS) || (da > EPS && db < -EPS)) {
      const t = da / (da - db);
      out.push(add(a, scale(sub(b, a), t)));
    }
  }
  return out;
}

// One brush in, its planes and face polygons out. Faces whose winding
// clips away to nothing were redundant planes and are dropped.
export function buildBrush(faces) {
  const planes = faces.map(facePlane);
  const polys = [];
  for (let k = 0; k < faces.length; k++) {
    const { normal, dist } = planes[k];
    if (!Number.isFinite(dist) || len(normal) < 0.5) continue;
    let w = baseWinding(normal, dist);
    // The base quad winds counter-clockwise seen from the front.
    for (let j = 0; j < faces.length && w.length >= 3; j++) {
      if (j === k) continue;
      const p = planes[j];
      // Coplanar duplicate: keep the first.
      if (dot(p.normal, normal) > 0.9999 && Math.abs(p.dist - dist) < EPS) {
        if (j < k) w = [];
        continue;
      }
      w = clipWinding(w, p.normal, p.dist);
    }
    if (w.length >= 3) polys.push({ face: faces[k], normal, dist, points: dedupe(w) });
  }
  const mins = [Infinity, Infinity, Infinity];
  const maxs = [-Infinity, -Infinity, -Infinity];
  for (const p of polys) {
    for (const v of p.points) {
      for (let a = 0; a < 3; a++) {
        mins[a] = Math.min(mins[a], v[a]);
        maxs[a] = Math.max(maxs[a], v[a]);
      }
    }
  }
  return { planes: planes.filter((p) => Number.isFinite(p.dist)), polys, mins, maxs };
}

function dedupe(points) {
  const out = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (!last || len(sub(p, last)) > 0.05) out.push(p);
  }
  while (out.length > 2 && len(sub(out[0], out[out.length - 1])) < 0.05) out.pop();
  return out;
}

export function pointInBrush(brush, p, eps = 0) {
  for (const pl of brush.planes) if (dot(pl.normal, p) - pl.dist > eps) return false;
  return true;
}

/* ------------------------------------------------------- texture axes */

// Quake's base axes for the standard (non-Valve) format: project onto
// the axial plane the face is closest to.
const BASE_AXIS = [
  [[0, 0, 1], [1, 0, 0], [0, -1, 0]],
  [[0, 0, -1], [1, 0, 0], [0, -1, 0]],
  [[1, 0, 0], [0, 1, 0], [0, 0, -1]],
  [[-1, 0, 0], [0, 1, 0], [0, 0, -1]],
  [[0, 1, 0], [1, 0, 0], [0, 0, -1]],
  [[0, -1, 0], [1, 0, 0], [0, 0, -1]],
];

export function textureAxes(face, normal) {
  if (face.valve) {
    return {
      u: face.u.slice(0, 3), v: face.v.slice(0, 3),
      offU: face.u[3], offV: face.v[3], su: face.su || 1, sv: face.sv || 1,
    };
  }
  let best = 0;
  let bestDot = -1;
  for (let k = 0; k < 6; k++) {
    const d = dot(normal, BASE_AXIS[k][0]);
    if (d > bestDot) {
      bestDot = d;
      best = k;
    }
  }
  let [, u, v] = BASE_AXIS[best];
  const a = ((face.rot || 0) * Math.PI) / 180;
  const s = Math.sin(a);
  const c = Math.cos(a);
  const rotate = (vec) => {
    const sv = vec[0] !== 0 ? 0 : 1;
    const tv = vec[2] !== 0 ? 2 : 1;
    const out = vec.slice();
    const ns = c * vec[sv] - s * vec[tv];
    const nt = s * vec[sv] + c * vec[tv];
    out[sv] = ns;
    out[tv] = nt;
    return out;
  };
  u = rotate(u);
  v = rotate(v);
  return { u, v, offU: face.offU, offV: face.offV, su: face.su || 1, sv: face.sv || 1 };
}

/* ---------------------------------------------------------- entities */

export const vec3 = (s, fallback = [0, 0, 0]) => (s ? s.trim().split(/\s+/).map(Number) : fallback);
