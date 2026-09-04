import * as THREE from 'three';
import { Accum, trs } from './util.js';
import { PALETTE } from './palette.js';

/**
 * WORLD — the assembler.
 *
 * Every module in src/world/ writes into one of these instead of touching the
 * scene, which is how a 120 m map of hundreds of thousands of triangles comes
 * out as ~100 draw calls:
 *
 *   add(key, geo, matrix, opts)   merge into the static batch for that surface
 *   proto(id, spec)               declare an instanced prop prototype
 *   place(id, matrix, masks)      add one instance
 *   box(surface, ...)             add an axis-aligned collision proxy
 *   light(light, opts)            register a punctual light with `render`
 *
 * Collision is authored separately from the visual mesh: proxies are cheap
 * boxes generated from the same numbers that built the geometry, so a doorway
 * is a real hole in the collision hull and the BVH stays in the low thousands
 * of triangles instead of chewing on every chamfer.
 */

const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1);
const _m = new THREE.Matrix4();
const _xm = new THREE.Matrix4();
const _v = new THREE.Vector3();
const _sph = new THREE.Sphere();
const _q = new THREE.Quaternion();
const _one = new THREE.Vector3(1, 1, 1);
const _UP = new THREE.Vector3(0, 1, 0);

/**
 * Spatial bucket size for chunked instance clouds (frustum culling + LOD).
 */
const CHUNK = 64;

export class Assembler {
  constructor({ materials, rng, render }) {
    this.materials = materials;
    this.rng = rng;
    this.render = render;
    this._mats = new Map();
    this._static = new Map();
    this._protos = new Map();
    this._collide = new Map();
    this._geoCache = new Map();
    this.lights = [];
    this.meshes = [];
    this.lodGroups = [];

    this.xform = new THREE.Matrix4();
    this._identity = true;
    this.interiorLights = [];
    this.lampAnchors = [];
    this.jitter = null;
    this.skirts = true;
    this.stats = { staticTris: 0, instTris: 0, instances: 0, drawCalls: 0, collideTris: 0 };
  }

  // -------------------------------------------------------------- transform --
  setTransform(ry, tx = 0, tz = 0) {
    _q.setFromAxisAngle(_UP, ry);
    _v.set(tx, 0, tz);
    _one.set(1, 1, 1);
    this.xform.compose(_v, _q, _one);
    this._identity = ry === 0 && tx === 0 && tz === 0;
    this.ry = ry;
    return this;
  }

  toWorld(x, y, z, out = new THREE.Vector3()) {
    return out.set(x, y, z).applyMatrix4(this.xform);
  }

  _x(matrix) {
    if (this._identity) return matrix ?? null;
    if (!matrix) return this.xform;
    return _xm.copy(this.xform).multiply(matrix);
  }

  // ------------------------------------------------------------- materials --
  mat(key) {
    let m = this._mats.get(key);
    if (m) return m;
    const def = PALETTE[key];
    if (!def) {
      console.warn(`[world] unknown palette key "${key}"`);
      return this.mat('concrete');
    }
    m = this.materials.get(def.name, def.opts);
    this._mats.set(key, m);
    return m;
  }

  surfaceOf(key) {
    return PALETTE[key]?.surface ?? 'concrete';
  }

  // --------------------------------------------------------- static batch --
  add(key, geo, matrix = null, opts = null) {
    let a = this._static.get(key);
    if (!a) {
      a = new Accum(`world:${key}`);
      this._static.set(key, a);
    }
    a.add(geo, this._x(matrix), opts);
    return this;
  }

  addBox(key, geo, x, y, z, ry = 0, sx = 1, sy = 1, sz = 1, opts = null) {
    return this.add(key, geo, trs(_m, x, y, z, ry, sx, sy, sz), opts);
  }

  cache(key, factory) {
    let g = this._geoCache.get(key);
    if (!g) {
      g = factory();
      this._geoCache.set(key, g);
    }
    return g;
  }

  addOnce(key, geo, matrix = null, opts = null) {
    this.add(key, geo, matrix, opts);
    geo.dispose();
    return this;
  }

  releaseCache() {
    for (const g of this._geoCache.values()) g.dispose();
    this._geoCache.clear();
  }

  // ------------------------------------------------------------ instanced --
  proto(id, spec) {
    if (this._protos.has(id)) return id;
    this._protos.set(id, {
      id,
      geo: spec.geo,
      tilt: spec.tilt ?? 0,
      sink: spec.sink ?? 0,
      key: spec.key,
      skirt: spec.skirt ?? 0,
      castShadow: spec.castShadow !== false,
      receiveShadow: spec.receiveShadow !== false,
      chunk: spec.chunk !== false,
      maxDist: spec.maxDist ?? 0,
      matrices: [],
      masks: [],
      noPrepass: !!spec.noPrepass,
    });
    return id;
  }

  has(id) {
    return this._protos.has(id);
  }

  place(id, matrix, masks = null) {
    const p = this._protos.get(id);
    if (!p) {
      console.warn(`[world] no prop prototype "${id}"`);
      return this;
    }
    p.matrices.push(this._x(matrix).clone());
    p.masks.push(masks ? [masks[0], masks[1], masks[2]] : null);
    return this;
  }

  put(id, x, y, z, ry = 0, s = 1, masks = null, rx = 0, rz = 0) {
    const j = this.jitter;
    const p = this._protos.get(id);
    if (j) {
      if (p && p.tilt > 0) {
        const r = j.rng;
        ry += r.range(-j.yaw, j.yaw);
        rx += r.range(-p.tilt, p.tilt);
        rz += r.range(-p.tilt, p.tilt);
        s *= 1 + r.range(-j.scale, j.scale);
        y -= p.sink;
      }
    }
    trs(_m, x, y, z, ry, s, s, s, rx, rz);
    this.place(id, _m, masks);
    if (this.skirts && p && p.skirt > 0 && this._protos.has('dust_skirt')) {
      const rr = p.skirt * s;
      trs(_m, x, y + 0.004, z, (x * 2.7 + z * 1.9) % 6.283, rr, 1, rr);
      this.place('dust_skirt', _m, null);
    }
    return this;
  }

  putS(id, x, y, z, ry, sx, sy, sz, masks = null, rx = 0, rz = 0) {
    trs(_m, x, y, z, ry, sx, sy, sz, rx, rz);
    return this.place(id, _m, masks);
  }

  count(id) {
    return this._protos.get(id)?.matrices.length ?? 0;
  }

  // ------------------------------------------------------------ collision --
  box(surface, cx, cy, cz, sx, sy, sz, ry = 0) {
    let a = this._collide.get(surface);
    if (!a) {
      a = new Accum(`collide:${surface}`);
      this._collide.set(surface, a);
    }
    a.add(UNIT_BOX, this._x(trs(_m, cx, cy, cz, ry, sx, sy, sz)));
    return this;
  }

  collideGeo(surface, geo, matrix = null) {
    let a = this._collide.get(surface);
    if (!a) {
      a = new Accum(`collide:${surface}`);
      this._collide.set(surface, a);
    }
    a.add(geo, this._x(matrix));
    return this;
  }

  slabBox(surface, panelMatrix, x, y, w, h, t) {
    trs(_m, x, y, t * 0.5, 0, w, h, t);
    _m.premultiply(panelMatrix);
    let a = this._collide.get(surface);
    if (!a) {
      a = new Accum(`collide:${surface}`);
      this._collide.set(surface, a);
    }
    a.add(UNIT_BOX, this._x(_m));
    return this;
  }

  light(light, opts) {
    if (!this._identity) light.position.applyMatrix4(this.xform);
    this.lights.push({ light, opts });
    return this;
  }

  // ------------------------------------------------------------- finalize --
  finalize(root, physics) {
    for (const [key, acc] of this._static) {
      if (acc.empty) continue;
      const geo = acc.build();
      const mesh = new THREE.Mesh(geo, this.mat(key));
      mesh.name = `world_${key}`;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      mesh.userData.surface = this.surfaceOf(key);
      mesh.userData.collision = false;
      mesh.updateMatrix();
      root.add(mesh);
      this.meshes.push(mesh);
      this.stats.staticTris += geo.index.count / 3;
      this.stats.drawCalls++;
    }

    for (const p of this._protos.values()) {
      const n = p.matrices.length;
      if (n === 0) {
        p.geo.dispose();
        continue;
      }
      const buckets = new Map();
      if (p.chunk && n > 24) {
        for (let i = 0; i < n; i++) {
          const m = p.matrices[i];
          const gx = Math.floor(m.elements[12] / CHUNK);
          const gz = Math.floor(m.elements[14] / CHUNK);
          const k = gx * 97 + gz;
          let b = buckets.get(k);
          if (!b) buckets.set(k, (b = []));
          b.push(i);
        }
      } else {
        buckets.set(0, [...Array(n).keys()]);
      }

      const mat = this.mat(p.key);
      for (const list of buckets.values()) {
        const im = new THREE.InstancedMesh(p.geo, mat, list.length);
        im.name = `prop_${p.id}`;
        im.castShadow = p.castShadow;
        im.receiveShadow = p.receiveShadow;
        im.matrixAutoUpdate = false;
        im.userData.surface = this.surfaceOf(p.key);
        im.userData.collision = false;
        if (p.noPrepass) im.userData.owNoPrepass = true;
        let needColor = false;
        for (let j = 0; j < list.length; j++) if (p.masks[list[j]]) needColor = true;
        if (needColor) {
          const arr = new Float32Array(list.length * 3);
          for (let j = 0; j < list.length; j++) {
            const mk = p.masks[list[j]] ?? [1, 1, 1];
            arr[j * 3] = mk[0];
            arr[j * 3 + 1] = mk[1];
            arr[j * 3 + 2] = mk[2];
          }
          im.instanceColor = new THREE.InstancedBufferAttribute(arr, 3);
        }
        for (let j = 0; j < list.length; j++) im.setMatrixAt(j, p.matrices[list[j]]);
        im.instanceMatrix.needsUpdate = true;
        im.computeBoundingSphere();
        im.updateMatrix();
        root.add(im);
        this.meshes.push(im);
        this.stats.drawCalls++;
        this.stats.instances += list.length;
        const tri = (p.geo.index ? p.geo.index.count : p.geo.getAttribute('position').count) / 3;
        this.stats.instTris += tri * list.length;
        if (p.maxDist > 0) {
          im.userData.owLodDist = p.maxDist;
          this.lodGroups.push(im);
        }
      }
      p.matrices.length = 0;
      p.masks.length = 0;
    }

    // --- collision proxies ---
    const INVISIBLE = new THREE.MeshBasicMaterial({ visible: false });
    this.collisionRoot = new THREE.Group();
    this.collisionRoot.name = 'world_collision';
    this.collisionRoot.visible = false;
    root.add(this.collisionRoot);
    this.handles = [];
    for (const [surface, acc] of this._collide) {
      if (acc.empty) continue;
      const geo = acc.build();
      const mesh = new THREE.Mesh(geo, INVISIBLE);
      mesh.name = `collide_${surface}`;
      mesh.visible = false;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      this.collisionRoot.add(mesh);
      this.stats.collideTris += geo.index.count / 3;
      if (physics) this.handles.push(physics.addStatic(mesh, surface));
    }

    if (physics) {
      if (typeof physics.rebuildStaticAsync === 'function') {
        physics.rebuildStaticAsync();
      } else {
        physics.rebuildStatic();
      }
    }

    // --- lights ---
    for (const { light, opts } of this.lights) {
      root.add(light);
      this.render?.addLight?.(light, opts);
    }
    return this;
  }

  updateLod(camera) {
    for (let i = 0; i < this.lodGroups.length; i++) {
      const im = this.lodGroups[i];
      const s = im.boundingSphere;
      if (!s) continue;
      _sph.copy(s);
      const d = _v.copy(camera.position).distanceTo(_sph.center) - _sph.radius;
      im.visible = d < im.userData.owLodDist;
    }
  }

  dispose() {
    this.releaseCache();
    for (const m of this._mats.values()) m.dispose();
    this._mats.clear();
    for (const a of this._static.values()) a.dispose();
    this._static.clear();
    for (const a of this._collide.values()) a.dispose();
    this._collide.clear();
    for (const p of this._protos.values()) p.geo.dispose();
    this._protos.clear();
  }
}
