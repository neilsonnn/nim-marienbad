// Torso, head, collar, cuffs and sleeves. All geometry is generated here.
import * as THREE from 'three';
import { surfaceNets, relaxOnSurface, sdEllipsoid, sdCapsule, sdSphere, sdRoundCone, smin, smax } from './sdf.js';
import { clamp, smoothstep, mulberry32, noise1 } from './util.js';

// ------------------------------------------------------------------ torso (suit jacket)
// local: origin at the hip pivot, +Y up the spine, +Z forward (chest), +X body's left
export const SHOULDER_L = new THREE.Vector3(0.186, 0.466, -0.014);
export const NECK_PIVOT = new THREE.Vector3(0, 0.655, -0.02);

export function torsoSDF(x, y, z) {
  let d = sdEllipsoid(x, y, z, 0, 0.12, 0.0, 0.162, 0.17, 0.112);
  d = smin(d, sdEllipsoid(x, y, z, 0, 0.345, 0.008, 0.178, 0.19, 0.118), 0.06);
  d = smin(d, sdEllipsoid(x, y, z, 0, 0.425, -0.036, 0.158, 0.11, 0.092), 0.04);
  d = smin(d, sdCapsule(x, y, z, -0.155, 0.496, -0.014, 0.155, 0.496, -0.014, 0.058), 0.05);
  d = smin(d, sdSphere(x, y, z, -0.192, 0.474, -0.012, 0.060), 0.03);
  d = smin(d, sdSphere(x, y, z, 0.192, 0.474, -0.012, 0.060), 0.03);
  // base of the collar (the collar itself is a separate, finer mesh)
  d = smin(d, sdRoundCone(x, y, z, 0, 0.485, -0.012, 0, 0.53, -0.02, 0.082, 0.072), 0.03);
  // neck opening
  d = smax(d, -sdCapsule(x, y, z, 0, 0.52, -0.016, 0, 0.80, -0.04, 0.058), 0.008);
  // cut off below the seat
  d = smax(d, -(y + 0.02), 0.02);
  return d;
}

// The jacket collar: a rolled band standing up the back of the neck, dropping
// toward the front where it turns into the lapels. Meshed finely so its
// rolled top edge stays crisp.
export function jacketCollarSDF(x, y, z) {
  const az = -0.017 - (y - 0.52) * 0.12; // the band leans back with the neck
  const dx = x, dz = z - az;
  const r = Math.hypot(dx, dz) + 1e-6;
  const back = Math.max(0, -dz / r), front = Math.max(0, dz / r);
  // shell: thicker at the base, a soft roll at the top edge
  let d = Math.abs(r - (0.0685 + 0.006 * (0.56 - y))) - 0.0062;
  const top = 0.590 + 0.030 * back - 0.095 * front * front;
  d = smax(d, y - top, 0.0045);
  d = smax(d, 0.505 - y, 0.01);
  // roll line: the outer face bulges slightly just below the top edge
  d -= 0.0018 * Math.exp(-((y - top + 0.008) ** 2) / (0.006 * 0.006)) * smoothstep(0.06, 0.075, r);
  return d;
}
function meshToArrays(m) { return { positions: m.positions, normals: m.normals, indices: m.indices }; }
function mergeMeshes(list) {
  let vc = 0, ic = 0;
  for (const m of list) { vc += m.positions.length / 3; ic += m.indices.length; }
  const pos = new Float32Array(vc * 3), nor = new Float32Array(vc * 3), idx = new Uint32Array(ic);
  const extras = {};
  let vo = 0, io = 0;
  for (const m of list) {
    pos.set(m.positions, vo * 3);
    nor.set(m.normals, vo * 3);
    for (let i = 0; i < m.indices.length; i++) idx[io + i] = m.indices[i] + vo;
    for (const k in m.extra || {}) {
      const { array, size } = m.extra[k];
      if (!extras[k]) extras[k] = { array: new Float32Array(vc * size), size };
      extras[k].array.set(array, vo * size);
    }
    vo += m.positions.length / 3;
    io += m.indices.length;
  }
  return { positions: pos, normals: nor, indices: idx, extras };
}

let _torsoGeo = null;
export function torsoGeometry() {
  if (_torsoGeo) return _torsoGeo;
  const body = surfaceNets(torsoSDF, [-0.29, -0.06, -0.17], [0.29, 0.66, 0.17], 0.0098);
  relaxOnSurface(body, torsoSDF, 1, 0.4);
  const collar = surfaceNets(jacketCollarSDF, [-0.09, 0.49, -0.12], [0.09, 0.645, 0.09], 0.0047);
  relaxOnSurface(collar, jacketCollarSDF, 1, 0.35);
  const m = mergeMeshes([meshToArrays(body), meshToArrays(collar)]);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(m.positions, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(m.normals, 3));
  g.setIndex(new THREE.BufferAttribute(m.indices, 1));
  g.computeBoundingSphere();
  _torsoGeo = g;
  return g;
}

// ------------------------------------------------------------------ head
// local: origin at the top of the neck (rotation pivot), +Z face forward
function hairlineY(x, z) {
  const th = Math.abs(Math.atan2(x, z)); // 0 = front, PI = back
  let y = 0.156 - 0.040 * smoothstep(0.35, 1.15, th);
  y -= 0.112 * smoothstep(1.7, 2.8, th);
  return y;
}
function cranium(x, y, z) {
  return sdEllipsoid(x, y, z, 0, 0.106, -0.012, 0.0725, 0.088, 0.095);
}
// A gaunt, stern face: deep-set lidded eyes under a strong brow, high cheekbones
// over hollow cheeks, a long bridged nose, thin lips, a hard jaw.
export const EYE_L = [0.0315, 0.096, 0.073], EYE_R = 0.0118;
function skinSDF(x, y, z) {
  const ax = Math.abs(x); // the face is symmetric: model one side
  let d = cranium(x, y, z);
  // midface and forehead mass
  d = smin(d, sdEllipsoid(x, y, z, 0, 0.074, 0.030, 0.056, 0.064, 0.064), 0.03);
  // mandible: two rami meeting at the chin
  d = smin(d, sdCapsule(ax, y, z, 0.046, 0.040, -0.004, 0.040, 0.012, 0.030, 0.0135), 0.024);
  d = smin(d, sdCapsule(ax, y, z, 0.040, 0.012, 0.030, 0.013, -0.002, 0.074, 0.0125), 0.022);
  d = smin(d, sdEllipsoid(x, y, z, 0, 0.001, 0.080, 0.019, 0.016, 0.014), 0.014);
  // brow ridge and cheekbones
  d = smin(d, sdCapsule(ax, y, z, 0.006, 0.115, 0.082, 0.040, 0.113, 0.071, 0.0085), 0.012);
  d = smin(d, sdEllipsoid(ax, y, z, 0.049, 0.081, 0.058, 0.015, 0.011, 0.018), 0.014);
  // gaunt: temples and cheeks hollow under the bone
  d = smax(d, -sdEllipsoid(ax, y, z, 0.067, 0.112, 0.048, 0.010, 0.020, 0.016), 0.012);
  d = smax(d, -sdEllipsoid(ax, y, z, 0.055, 0.050, 0.055, 0.012, 0.016, 0.014), 0.014);
  // eye sockets (shallow) with eyeballs and heavy upper lids
  d = smax(d, -sdEllipsoid(ax, y, z, EYE_L[0], EYE_L[1] + 0.001, 0.088, 0.016, 0.011, 0.012), 0.006);
  d = Math.min(d, sdSphere(ax, y, z, EYE_L[0], EYE_L[1], EYE_L[2], EYE_R));
  const lid = smax(sdSphere(ax, y, z, EYE_L[0], EYE_L[1], EYE_L[2] - 0.0005, EYE_R + 0.0014), (EYE_L[1] - 0.0012) - y, 0.0015);
  d = smin(d, lid, 0.002);
  const lower = smax(sdSphere(ax, y, z, EYE_L[0], EYE_L[1], EYE_L[2] - 0.001, EYE_R + 0.0009), y - (EYE_L[1] - 0.0075), 0.0015);
  d = smin(d, lower, 0.002);
  // nose: bridge, tip, wings
  d = smin(d, sdRoundCone(x, y, z, 0, 0.104, 0.088, 0, 0.062, 0.108, 0.0055, 0.0078), 0.007);
  d = smin(d, sdSphere(x, y, z, 0, 0.058, 0.106, 0.0072), 0.004);
  d = smin(d, sdEllipsoid(ax, y, z, 0.0115, 0.056, 0.096, 0.0072, 0.0058, 0.0075), 0.004);
  d = smax(d, -sdSphere(ax, y, z, 0.0065, 0.051, 0.099, 0.0028), 0.002); // nostrils
  // thin lips with a parting line
  d = smin(d, sdEllipsoid(x, y, z, 0, 0.0355, 0.091, 0.022, 0.0055, 0.0085), 0.006);
  d = smin(d, sdEllipsoid(x, y, z, 0, 0.0265, 0.089, 0.020, 0.0055, 0.0082), 0.006);
  d = smax(d, -sdEllipsoid(x, y, z, 0, 0.031, 0.098, 0.024, 0.0011, 0.010), 0.0015);
  // neck + Adam's apple
  d = smin(d, sdRoundCone(x, y, z, 0, -0.115, -0.022, 0, 0.045, -0.012, 0.0475, 0.0455), 0.03);
  d = smin(d, sdSphere(x, y, z, 0, -0.012, 0.034, 0.011), 0.012);
  return d;
}
function hairThickness(x, y, z) {
  const hy = hairlineY(x, z);
  return 0.0075 * smoothstep(hy - 0.004, hy + 0.035, y) + 0.0004;
}
export function headSDF(x, y, z) {
  const skin = skinSDF(x, y, z);
  const hy = hairlineY(x, z);
  if (y < hy - 0.02) return skin;
  const hair = smax(cranium(x, y, z) - hairThickness(x, y, z), hy - 0.006 - y, 0.004);
  return smin(skin, hair, 0.003);
}

// ------------------------------------------------------------------ ear
// Ear-local frame: x = out of the ear plane, y = up, z = toward the face.
export function earSDF(x, y, z) {
  const cy = 0.002;
  const ry = 0.031;
  const rz = y > cy ? 0.0176 : 0.0176 - 0.0048 * Math.min(1, (cy - y) / 0.03);
  const ey = (y - cy) / ry, ez = (z + 0.001) / rz;
  const k = Math.sqrt(ey * ey + ez * ez);
  const d2 = (k - 1) * Math.min(ry, rz);
  // the blade is cupped: its rim stands away from the head
  const w = x - 0.0036 * k * k;
  let d = smax(d2, Math.abs(w) - 0.0011, 0.0016);
  // helix: a rolled rim along the outline, absent where it dives into the concha
  const gap = smoothstep(0.004, 0.010, z) * smoothstep(0.012, -0.004, y);
  const rim = Math.hypot(d2 + 0.0024, w - 0.0012) - 0.0021 + gap * 0.006;
  d = smin(d, rim, 0.0012);
  // concha: the deep bowl in front of the antihelix
  d = smax(d, -sdEllipsoid(x, y, z, 0.0034, -0.0045, 0.0035, 0.0046, 0.0105, 0.0074), 0.0016);
  // antihelix with its two crura
  d = smin(d, sdCapsule(x, y, z, 0.0026, 0.015, -0.0045, 0.0028, -0.007, -0.0072, 0.0021), 0.0022);
  d = smin(d, sdCapsule(x, y, z, 0.0024, 0.0145, -0.0045, 0.0022, 0.0215, 0.0035, 0.0015), 0.0018);
  // tragus & antitragus
  d = smin(d, sdEllipsoid(x, y, z, 0.0022, -0.0058, 0.0128, 0.0030, 0.0044, 0.0030), 0.0022);
  d = smin(d, sdEllipsoid(x, y, z, 0.0026, -0.0135, 0.0020, 0.0026, 0.0030, 0.0035), 0.002);
  // fleshy lobe
  d = smin(d, sdEllipsoid(x, y, z, 0.0012, -0.0238, 0.0008, 0.0034, 0.0076, 0.0072), 0.004);
  // root anchoring the front edge into the head
  d = smin(d, sdEllipsoid(x, y, z, -0.0045, -0.002, 0.0075, 0.0062, 0.021, 0.0085), 0.004);
  // conchal eminence: the fleshy back of the bowl that joins the ear to the skull
  d = smin(d, sdEllipsoid(x, y, z, -0.0035, -0.003, 0.0005, 0.0065, 0.0135, 0.0095), 0.004);
  return d;
}
let _ear = null;
function earMesh() {
  if (_ear) return _ear;
  const m = surfaceNets(earSDF, [-0.012, -0.036, -0.022], [0.0095, 0.036, 0.022], 0.0014);
  relaxOnSurface(m, earSDF, 1, 0.3);
  _ear = m;
  return m;
}
// place an ear on the head (side = +1 right of the face's frame, -1 left)
function placedEar(side) {
  const e = earMesh();
  const n = e.positions.length / 3;
  const tilt = new THREE.Matrix4().makeRotationX(-0.27);      // top leans back
  const flare = new THREE.Matrix4().makeRotationY(-0.30);     // back edge stands off the skull
  const at = new THREE.Matrix4().makeTranslation(0.0705, 0.085, -0.011);
  const M = at.multiply(flare).multiply(tilt);
  const N3 = new THREE.Matrix3().getNormalMatrix(M);
  const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3);
  const aux = new Float32Array(n * 4), tan = new Float32Array(n * 3);
  const v = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    const lx = e.positions[i * 3];
    v.fromArray(e.positions, i * 3).applyMatrix4(M);
    pos[i * 3] = v.x * side; pos[i * 3 + 1] = v.y; pos[i * 3 + 2] = v.z;
    v.fromArray(e.normals, i * 3).applyMatrix3(N3).normalize();
    nor[i * 3] = v.x * side; nor[i * 3 + 1] = v.y; nor[i * 3 + 2] = v.z;
    aux[i * 4] = 0; // no hair
    aux[i * 4 + 1] = 0.5;
    aux[i * 4 + 2] = smoothstep(-0.005, 0.001, lx); // thin cartilage transmits
    tan[i * 3 + 1] = -1;
  }
  let idx = e.indices;
  if (side < 0) {
    idx = idx.slice();
    for (let t = 0; t < idx.length; t += 3) { const tmp = idx[t + 1]; idx[t + 1] = idx[t + 2]; idx[t + 2] = tmp; }
  }
  return { positions: pos, normals: nor, indices: idx, extra: { aAux: { array: aux, size: 4 }, aAux3: { array: tan, size: 3 } } };
}

const _headGeo = {};
export function headGeometry(cell = 0.0052) {
  if (_headGeo[cell]) return _headGeo[cell];
  const m = surfaceNets(headSDF, [-0.102, -0.13, -0.125], [0.102, 0.212, 0.122], cell);
  relaxOnSurface(m, headSDF, 1, 0.4);
  const n = m.positions.length / 3;
  const aux = new Float32Array(n * 4);
  const tan = new Float32Array(n * 3);
  const r = mulberry32(77);
  const jitter = Array.from({ length: 64 }, () => r());
  for (let i = 0; i < n; i++) {
    const x = m.positions[i * 3], y = m.positions[i * 3 + 1], z = m.positions[i * 3 + 2];
    const nx = m.normals[i * 3], ny = m.normals[i * 3 + 1], nz = m.normals[i * 3 + 2];
    const hy = hairlineY(x, z);
    // ragged natural hairline
    const th = Math.atan2(x, z);
    const rag = (noise1(th * 9.0) * 0.004 + noise1(th * 31.0 + 4.0) * 0.0015);
    let hair = smoothstep(hy - 0.010 + rag, hy + 0.012 + rag, y);
    // ears and face never get hair
    if (Math.abs(x) > 0.072 && y < 0.12 && Math.abs(z) < 0.035) hair *= smoothstep(0.11, 0.125, y);
    aux[i * 4] = hair;
    aux[i * 4 + 1] = jitter[i & 63];
    // combed straight back, then down over the crown and nape
    const back = smoothstep(0.02, -0.07, z);
    let tx = 0, ty = -0.22 - 0.9 * back, tz = -1.0 + 0.6 * back;
    const dn = tx * nx + ty * ny + tz * nz;
    tx -= dn * nx; ty -= dn * ny; tz -= dn * nz;
    const L = Math.hypot(tx, ty, tz) || 1;
    tan[i * 3] = tx / L; tan[i * 3 + 1] = ty / L; tan[i * 3 + 2] = tz / L;
  }
  const merged = mergeMeshes([
    { positions: m.positions, normals: m.normals, indices: m.indices, extra: { aAux: { array: aux, size: 4 }, aAux3: { array: tan, size: 3 } } },
    placedEar(1),
    placedEar(-1),
  ]);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(merged.positions, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(merged.normals, 3));
  g.setAttribute('aAux', new THREE.BufferAttribute(merged.extras.aAux.array, 4));
  g.setAttribute('aAux3', new THREE.BufferAttribute(merged.extras.aAux3.array, 3));
  g.setIndex(new THREE.BufferAttribute(merged.indices, 1));
  g.computeBoundingSphere();
  _headGeo[cell] = g;
  return g;
}

// ------------------------------------------------------------------ shirt collar (white band at the neck)
export function collarGeometry() {
  // ring around Y with a rolled top edge; slightly higher at the back
  const pts = [
    new THREE.Vector2(0.0565, -0.012),
    new THREE.Vector2(0.0590, -0.010),
    new THREE.Vector2(0.0600, 0.018),
    new THREE.Vector2(0.0590, 0.0225),
    new THREE.Vector2(0.0565, 0.0235),
    new THREE.Vector2(0.0545, 0.021),
    new THREE.Vector2(0.0545, -0.010),
  ];
  for (const p of pts) p.x *= 0.935; // sits inside the jacket's neck opening, hugging the neck
  const g = new THREE.LatheGeometry(pts, 48);
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    // tilt: back higher than front, front opens into a small V
    const back = -z / 0.06;
    let ny = y + back * 0.010;
    const front = smoothstep(0.035, 0.058, z) * smoothstep(0.025, 0.0, Math.abs(x));
    ny -= front * Math.max(0, y + 0.012) * 0.9;
    pos.setY(i, ny);
  }
  g.computeVertexNormals();
  return g;
}

// ------------------------------------------------------------------ shirt cuff (around the wrist)
export function cuffGeometry() {
  // local: +Y along the forearm toward the hand. A French cuff: double fold of
  // starched cotton, its turned-back layer giving a soft ridge halfway along.
  const pts = [
    [0.0330, -0.066], [0.0352, -0.065], [0.0360, -0.040], [0.0366, -0.034], [0.0369, -0.031],
    [0.0364, -0.028], [0.0366, -0.006], [0.0362, -0.0018], [0.0352, 0.0], [0.0338, -0.0006],
    [0.0331, -0.0035], [0.0328, -0.012], [0.0326, -0.065],
  ].map(([r, y]) => new THREE.Vector2(r, y));
  const g = new THREE.LatheGeometry(pts, 40);
  // flatten into an ellipse (wrists are wider than deep) and open the seam where the link joins
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i);
    const a = Math.atan2(z, x);
    const seam = Math.exp(-(a * a) / 0.02) * 0.0016;
    pos.setX(i, x * (1 + seam / 0.036));
    pos.setZ(i, z * 0.86);
  }
  g.computeVertexNormals();
  return g;
}
export function cufflinkGeometry() {
  // a small domed oval link
  const g = new THREE.SphereGeometry(1, 20, 10, 0, Math.PI * 2, 0, Math.PI * 0.5);
  g.scale(0.0062, 0.0022, 0.0048);
  g.rotateZ(-Math.PI / 2);
  return g;
}

// ------------------------------------------------------------------ sleeve: tube rebuilt every frame
export class Sleeve {
  constructor(material, seed = 1) {
    this.NR = 18;
    this.NL = 30;
    this.extra = 3; // lip rings at the opening
    const rings = this.NL + this.extra;
    const g = new THREE.BufferGeometry();
    this.pos = new Float32Array(rings * this.NR * 3);
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(rings * this.NR * 3), 3));
    const idx = [];
    for (let r = 0; r < rings - 1; r++)
      for (let k = 0; k < this.NR; k++) {
        const a = r * this.NR + k, b = r * this.NR + ((k + 1) % this.NR);
        const c = (r + 1) * this.NR + k, d = (r + 1) * this.NR + ((k + 1) % this.NR);
        idx.push(a, c, b, b, c, d);
      }
    g.setIndex(idx);
    // stable fabric coordinates so the weave does not swim as the arm moves
    const fab = new Float32Array(rings * this.NR * 3);
    for (let r = 0; r < rings; r++)
      for (let k = 0; k < this.NR; k++) {
        const o = (r * this.NR + k) * 3;
        fab[o] = Math.min(r, this.NL - 1) * 0.022;
        fab[o + 1] = Math.cos((k / this.NR) * Math.PI * 2) * 0.05;
        fab[o + 2] = Math.sin((k / this.NR) * Math.PI * 2) * 0.05 + seed * 0.37;
      }
    g.setAttribute('aAux3', new THREE.BufferAttribute(fab, 3));
    this.geometry = g;
    this.mesh = new THREE.Mesh(g, material);
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    const r = mulberry32(seed * 977);
    this.phase = Array.from({ length: 8 }, () => r() * 6.283);
    this._t = new THREE.Vector3();
    this._n = new THREE.Vector3();
    this._b = new THREE.Vector3();
  }

  /**
   * S shoulder, E elbow, W wrist joint (world). fwdZ: dorsal hint for the forearm frame.
   * Builds a smooth swept tube with elbow folds and a sleeve opening short of the wrist.
   */
  build(S, E, W, refUp, opts = {}) {
    const NR = this.NR, NL = this.NL;
    const rS = opts.rShoulder ?? 0.056, rE = opts.rElbow ?? 0.047, rW = opts.rWrist ?? 0.0385;
    const endBack = opts.endBack ?? 0.026;
    const u = new THREE.Vector3().subVectors(E, S);
    const l1 = u.length(); u.normalize();
    const f = new THREE.Vector3().subVectors(W, E);
    const l2 = f.length(); f.normalize();
    const start = S.clone().addScaledVector(u, -0.035);
    const end = W.clone().addScaledVector(f, -endBack);
    const bend = Math.acos(clamp(u.dot(f), -1, 1)); // 0 straight
    const fillet = Math.min(0.06, l1 * 0.4, l2 * 0.4) * (0.4 + 0.6 * smoothstep(0.1, 1.2, bend));
    const E1 = E.clone().addScaledVector(u, -fillet);
    const E2 = E.clone().addScaledVector(f, fillet);
    // path samples by arc length
    const pts = [];
    const lenA = start.distanceTo(E1), lenC = E2.distanceTo(end);
    const lenB = fillet * 2 * 0.92;
    const total = lenA + lenB + lenC;
    const inner = new THREE.Vector3().addVectors(S, W).multiplyScalar(0.5).sub(E);
    if (inner.lengthSq() < 1e-8) inner.copy(refUp).cross(u);
    inner.normalize();
    const p = new THREE.Vector3(), tmp = new THREE.Vector3();
    const sElbow = (lenA + lenB * 0.5) / total;
    for (let i = 0; i < NL; i++) {
      // denser sampling near the elbow
      let s = i / (NL - 1);
      s = s + 0.12 * Math.sin((s - sElbow) * Math.PI * 2) * 0.0;
      const d = s * total;
      if (d <= lenA) p.copy(start).lerp(E1, d / lenA);
      else if (d <= lenA + lenB) {
        const t = (d - lenA) / lenB;
        // quadratic bezier E1 -> E -> E2
        p.copy(E1).multiplyScalar((1 - t) * (1 - t)).addScaledVector(E, 2 * (1 - t) * t).addScaledVector(E2, t * t);
      } else p.copy(E2).lerp(end, (d - lenA - lenB) / lenC);
      pts.push({ p: p.clone(), s, d });
    }
    // rotation-minimising frames
    const T = this._t, Nn = this._n, B = this._b;
    T.subVectors(pts[1].p, pts[0].p).normalize();
    Nn.copy(refUp).addScaledVector(T, -refUp.dot(T)).normalize();
    const pos = this.pos;
    const bendAmt = smoothstep(0.25, 1.9, bend);
    const ringCenters = [];
    for (let i = 0; i < NL; i++) {
      const cur = pts[i].p;
      if (i > 0) {
        const nT = tmp.subVectors(i < NL - 1 ? pts[i + 1].p : cur, i < NL - 1 ? cur : pts[i - 1].p).normalize();
        // double reflection (Wang 2008) simplified to a projection for small steps
        Nn.addScaledVector(nT, -Nn.dot(nT)).normalize();
        T.copy(nT);
      }
      B.crossVectors(T, Nn).normalize();
      const s = pts[i].s;
      const dist = pts[i].d;
      // radius profile
      const dE = dist - (lenA + lenB * 0.5);
      let r;
      if (dE < 0) r = rS + (rE - rS) * smoothstep(0, 1, (dist) / (lenA + lenB * 0.5));
      else r = rE + (rW - rE) * smoothstep(0, 1, dE / (lenC + lenB * 0.5));
      // the shoulder end flares into the torso
      r += 0.006 * (1 - smoothstep(0.0, 0.08, dist));
      const elbowEnv = Math.exp(-(dE * dE) / (0.055 * 0.055));
      const cuffEnv = smoothstep(total - 0.07, total - 0.01, dist);
      for (let k = 0; k < NR; k++) {
        const a = (k / NR) * Math.PI * 2;
        const ca = Math.cos(a), sa = Math.sin(a);
        tmp.copy(Nn).multiplyScalar(ca).addScaledVector(B, sa);
        const inn = tmp.dot(inner);
        // folds on the inside of the bend, a couple of drag lines on the outside
        let disp = 0;
        disp += 0.0055 * bendAmt * elbowEnv * Math.max(0, inn) ** 1.5 * Math.sin(dE / 0.0135 * Math.PI + a * 1.7 + this.phase[0]);
        disp -= 0.0035 * bendAmt * elbowEnv * Math.max(0, inn) ** 2;
        disp += 0.0018 * bendAmt * elbowEnv * Math.max(0, -inn) * Math.sin(a * 3 + dE * 60 + this.phase[1]);
        // bunching above the cuff
        disp += 0.0016 * cuffEnv * Math.sin(a * 5 + this.phase[2] + dist * 90);
        // cloth irregularity
        disp += 0.0012 * Math.sin(a * 2 + dist * 23 + this.phase[3]) * Math.sin(dist * 11 + this.phase[4]);
        const rr = (r + disp) * (k % 2 === 0 ? 1 : 1);
        const ex = rr, ey = rr * 0.93;
        const o = (i * NR + k) * 3;
        pos[o] = cur.x + Nn.x * ca * ey + B.x * sa * ex;
        pos[o + 1] = cur.y + Nn.y * ca * ey + B.y * sa * ex;
        pos[o + 2] = cur.z + Nn.z * ca * ey + B.z * sa * ex;
      }
      ringCenters.push(cur.clone());
    }
    // lip: fold the fabric back inside the opening to give it thickness
    const last = pts[NL - 1].p;
    const lipR = [rW - 0.0012, rW - 0.0028, rW - 0.0032];
    const lipBack = [0.0012, 0.003, 0.03];
    for (let e = 0; e < this.extra; e++) {
      const c = tmp.copy(last).addScaledVector(T, -lipBack[e]);
      for (let k = 0; k < NR; k++) {
        const a = (k / NR) * Math.PI * 2;
        const ca = Math.cos(a), sa = Math.sin(a);
        const o = ((NL + e) * NR + k) * 3;
        const rr = lipR[e];
        pos[o] = c.x + (Nn.x * ca * 0.93 + B.x * sa) * rr;
        pos[o + 1] = c.y + (Nn.y * ca * 0.93 + B.y * sa) * rr;
        pos[o + 2] = c.z + (Nn.z * ca * 0.93 + B.z * sa) * rr;
      }
    }
    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.computeVertexNormals();
    this.geometry.attributes.normal.needsUpdate = true;
  }
}

// ------------------------------------------------------------------ legs (trousers), in the hip frame
function capsuleBetween(a, b, r0, r1) {
  const len = a.distanceTo(b);
  const g = new THREE.CylinderGeometry(r1, r0, len, 14, 4, false);
  const cap0 = new THREE.SphereGeometry(r0, 14, 8, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2);
  cap0.translate(0, -len / 2, 0);
  const cap1 = new THREE.SphereGeometry(r1, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2);
  cap1.translate(0, len / 2, 0);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
  const m = new THREE.Matrix4().compose(a.clone().add(b).multiplyScalar(0.5), q, new THREE.Vector3(1, 1, 1));
  return [g, cap0, cap1].map((x) => x.applyMatrix4(m));
}
export function legsGeometry(seated) {
  const parts = [];
  for (const s of [-1, 1]) {
    const hip = new THREE.Vector3(s * 0.088, 0.02, 0.0);
    if (seated) {
      const knee = new THREE.Vector3(s * 0.11, 0.0, 0.43);
      const ankle = new THREE.Vector3(s * 0.12, -0.40, 0.47);
      parts.push(...capsuleBetween(hip, knee, 0.078, 0.058), ...capsuleBetween(knee, ankle, 0.054, 0.042));
    } else {
      const knee = new THREE.Vector3(s * 0.10, -0.47, 0.03);
      const ankle = new THREE.Vector3(s * 0.105, -0.88, 0.0);
      parts.push(...capsuleBetween(hip, knee, 0.078, 0.058), ...capsuleBetween(knee, ankle, 0.054, 0.042));
    }
  }
  // merge
  let vc = 0, ic = 0;
  for (const p of parts) { vc += p.attributes.position.count; ic += p.index.count; }
  const pos = new Float32Array(vc * 3), nor = new Float32Array(vc * 3), idx = new Uint32Array(ic);
  let vo = 0, io = 0;
  for (const p of parts) {
    pos.set(p.attributes.position.array, vo * 3);
    nor.set(p.attributes.normal.array, vo * 3);
    for (let i = 0; i < p.index.count; i++) idx[io + i] = p.index.array[i] + vo;
    vo += p.attributes.position.count;
    io += p.index.count;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.computeBoundingSphere();
  return g;
}
