// A LibreQuake level, drawn. The importer (tools/import-librequake.mjs)
// already did the hard part -- polygons, texture coordinates and a baked
// lightmap -- so this only puts those arrays on the GPU with three small
// shaders that draw the way Quake drew:
//
//   walls   texture x lightmap x 2  (Quake's overbright), nearest filtered
//   liquids fullbright, with the classic sine warp, water see-through
//   sky     two scrolling layers projected onto a flattened dome
//
// It also hands back the collision hulls, in metres, for collide.js.

import * as THREE from '../vendor/three.module.js';
import { createCollider } from './collide.js';

const ROOT = new URL('../assets/librequake/', import.meta.url);

const COMMON_VERT = /* glsl */ `
  attribute vec2 lmuv;
  varying vec2 vUv;
  varying vec2 vUv2;
  varying vec3 vWorld;
  #include <fog_pars_vertex>
  void main() {
    vUv = uv;
    vUv2 = lmuv;
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorld = world.xyz;
    vec4 mvPosition = viewMatrix * world;
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`;

const WALL_FRAG = /* glsl */ `
  uniform sampler2D map;
  uniform sampler2D lightmap;
  uniform float cutout;
  uniform float brightness;
  varying vec2 vUv;
  varying vec2 vUv2;
  #include <fog_pars_fragment>
  void main() {
    vec4 t = texture2D(map, vUv);
    if (cutout > 0.5 && t.a < 0.5) discard;
    vec3 light = texture2D(lightmap, vUv2).rgb * 3.98 * brightness;
    gl_FragColor = vec4(t.rgb * light, 1.0);
    #include <fog_fragment>
  }
`;

const LIQUID_FRAG = /* glsl */ `
  uniform sampler2D map;
  uniform float time;
  uniform float alpha;
  varying vec2 vUv;
  #include <fog_pars_fragment>
  void main() {
    // Quake's turbulence: each axis wobbles by a sine of the other.
    vec2 uv = vUv + 0.0625 * sin(vUv.yx * 6.2831 * 0.5 + time);
    vec4 t = texture2D(map, uv);
    gl_FragColor = vec4(t.rgb, alpha);
    #include <fog_fragment>
  }
`;

const SKY_FRAG = /* glsl */ `
  uniform sampler2D map;
  uniform float time;
  varying vec3 vWorld;
  void main() {
    // A Quake sky: the view ray squashed onto a low dome, with the back
    // layer (right half of the texture) under a faster front layer (left
    // half, black is transparent).
    vec3 dir = vWorld - cameraPosition;
    dir.y *= 3.0;
    dir = normalize(dir);
    vec2 st = dir.xz * (189.0 / 128.0) * 0.5;
    vec2 back = fract(st + time * 0.04);
    vec2 front = fract(st + time * 0.08);
    vec4 b = texture2D(map, vec2(0.5 + back.x * 0.5, back.y));
    vec4 f = texture2D(map, vec2(front.x * 0.5, front.y));
    float a = step(0.02, f.r + f.g + f.b);
    gl_FragColor = vec4(mix(b.rgb, f.rgb, a), 1.0);
  }
`;

const loader = new THREE.TextureLoader();
const textures = new Map();

// A texture the level names but LibreQuake does not ship: draw the
// classic purple-and-black checker rather than ask the server for it.
function checker() {
  const data = new Uint8Array(16 * 16 * 4);
  for (let i = 0; i < 256; i++) {
    const on = ((i % 16) >> 3) ^ ((i >> 4) >> 3);
    data.set(on ? [160, 40, 160, 255] : [20, 10, 20, 255], i * 4);
  }
  const t = new THREE.DataTexture(data, 16, 16);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.NearestFilter;
  t.needsUpdate = true;
  return t;
}

function texture(name, { repeat = true, nearest = true, missing = false } = {}) {
  if (missing) return checker();
  const key = `${name}|${repeat}|${nearest}`;
  if (textures.has(key)) return textures.get(key);
  const t = loader.load(new URL(`textures/${name}.png`, ROOT).href);
  t.colorSpace = THREE.NoColorSpace;
  // Quake's t axis runs down the image, as the PNG rows do.
  t.flipY = false;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  if (nearest) {
    // Chunky texels up close, mipmapped far away: the software renderer look.
    t.magFilter = THREE.NearestFilter;
    t.minFilter = THREE.NearestMipmapLinearFilter;
  }
  textures.set(key, t);
  return t;
}

export async function loadLevel(id) {
  const meta = await (await fetch(new URL(`maps/${id}.json`, ROOT))).json();
  const bin = await (await fetch(new URL(`maps/${id}.bin`, ROOT))).arrayBuffer();
  const view = (k) => new Float32Array(bin, meta.layout[k].offset, meta.layout[k].length);
  const pos = view('pos');
  const uv = view('uv');
  const uv2 = view('uv2');

  const lightmap = loader.load(new URL(`maps/${meta.lightmap.file}`, ROOT).href);
  lightmap.colorSpace = THREE.NoColorSpace;
  lightmap.flipY = false;
  lightmap.magFilter = THREE.LinearFilter;
  lightmap.minFilter = THREE.LinearFilter;
  lightmap.generateMipmaps = false;

  const group = new THREE.Group();
  group.name = `level:${id}`;
  const animated = [];

  for (const g of meta.groups) {
    const tex = meta.textures[g.tex];
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos.slice(g.start * 3, (g.start + g.count) * 3), 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv.slice(g.start * 2, (g.start + g.count) * 2), 2));
    geo.setAttribute('lmuv', new THREE.BufferAttribute(uv2.slice(g.start * 2, (g.start + g.count) * 2), 2));
    geo.computeBoundingSphere();

    let material;
    if (tex.kind === 'sky') {
      material = new THREE.ShaderMaterial({
        uniforms: { map: { value: texture(tex.name) }, time: { value: 0 } },
        vertexShader: COMMON_VERT.replace('#include <fog_pars_vertex>', '').replace('#include <fog_vertex>', ''),
        fragmentShader: SKY_FRAG,
      });
      animated.push(material);
    } else if (tex.kind === 'liquid') {
      const water = !/lava|tele|soul|meat/.test(tex.name);
      material = new THREE.ShaderMaterial({
        uniforms: { ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog), map: { value: texture(tex.name) }, time: { value: 0 }, alpha: { value: water ? 0.65 : 1 } },
        vertexShader: COMMON_VERT,
        fragmentShader: LIQUID_FRAG,
        fog: true,
        transparent: water,
        depthWrite: !water,
        side: THREE.DoubleSide,
      });
      animated.push(material);
    } else {
      material = new THREE.ShaderMaterial({
        uniforms: {
          ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
          map: { value: texture(tex.name, { missing: tex.missing }) },
          lightmap: { value: lightmap },
          cutout: { value: tex.kind === 'cutout' ? 1 : 0 },
          brightness: { value: 1 },
        },
        vertexShader: COMMON_VERT,
        fragmentShader: WALL_FRAG,
        fog: true,
        side: tex.kind === 'cutout' ? THREE.DoubleSide : THREE.FrontSide,
      });
    }
    const mesh = new THREE.Mesh(geo, material);
    mesh.matrixAutoUpdate = false;
    group.add(mesh);
  }

  const collider = createCollider(view('planes'), view('hulls'));

  return {
    id,
    meta,
    group,
    collider,
    // Liquids and skies move; nothing else does.
    tick(time) {
      for (const m of animated) m.uniforms.time.value = time;
    },
    setBrightness(k) {
      group.traverse((o) => {
        if (o.material && o.material.uniforms && o.material.uniforms.brightness) o.material.uniforms.brightness.value = k;
      });
    },
    dispose() {
      group.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) o.material.dispose();
      });
      lightmap.dispose();
    },
  };
}

// Where a level wants to be put so that a given point lands on the
// origin -- which is how a raid arena is lined up with the sim's room.
export function placeAt(level, point) {
  level.group.position.set(-point[0], -point[1], -point[2]);
  level.group.updateMatrixWorld(true);
  level.collider.setOffset(level.group.position);
}
