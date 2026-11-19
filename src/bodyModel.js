// Torso, head, collar, cuffs and sleeves. All geometry is generated here.
import * as THREE from 'three';
import { surfaceNets, relaxOnSurface, sdEllipsoid, sdCapsule, sdSphere, sdRoundCone, smin, smax } from './sdf.js';
import { clamp, smoothstep, mulberry32, noise1 } from './util.js';

// ------------------------------------------------------------------ torso (suit jacket)
// local: origin at the hip pivot, +Y up the spine, +Z forward (chest), +X body's left
// the shoulder joint sits a few centimetres under the (padded) top of the shoulder
export const SHOULDER_L = new THREE.Vector3(0.184, 0.486, -0.014);
export const NECK_PIVOT = new THREE.Vector3(0, 0.655, -0.02);

// The jacket's shoulders are skinned to the arms (see SHOULDERS in glsl.js): the cap of
// each shoulder and a short stump of upper sleeve, modelled with the arm held at ARM_REST
// (body's left; mirror x for the right), turn rigidly with the upper arm about the
// shoulder joint, and the jacket between them and the body bends smoothly. The swept
// sleeve continues straight out of that stump, so jacket and sleeve stay one piece.
// (between the arms' real range: hanging at the lap, braced, reaching forward over the table)
export const ARM_REST = new THREE.Vector3(0.55, -0.55, 0.63).normalize();
// the stump reaches well down the upper arm: the sleeve starts on its plain cylinder, far
// from where it blends into the body, so the two meet without a step
export const STUMP = { len: 0.15, r: 0.0525, sleeveStart: 0.105 };
// the body without its shoulder caps
function torsoBodySDF(x, y, z) {
  let d = sdEllipsoid(x, y, z, 0, 0.12, 0.0, 0.162, 0.17, 0.112);
  d = smin(d, sdEllipsoid(x, y, z, 0, 0.345, 0.008, 0.178, 0.19, 0.118), 0.06);
  d = smin(d, sdEllipsoid(x, y, z, 0, 0.425, -0.036, 0.158, 0.11, 0.092), 0.04);
  // the line of the shoulders, neck to the top of each arm
  d = smin(d, sdCapsule(x, y, z, -0.13, 0.498, -0.016, 0.13, 0.498, -0.016, 0.056), 0.05);
  // base of the collar (the collar itself is a separate, finer mesh)
  d = smin(d, sdRoundCone(x, y, z, 0, 0.485, -0.012, 0, 0.53, -0.02, 0.082, 0.072), 0.03);
  return d;
}
// a shoulder cap (deltoid under the padding) and the top of the sleeve, both sides
function torsoArmSDF(x, y, z) {
  const ax = Math.abs(x), J = SHOULDER_L, U = ARM_REST, L = STUMP.len;
  let d = sdSphere(ax, y, z, J.x - 0.004, J.y + 0.006, J.z, 0.056);
  d = smin(d, sdCapsule(ax, y, z, J.x, J.y, J.z, J.x + U.x * L, J.y + U.y * L, J.z + U.z * L, STUMP.r), 0.025);
  return d;
}
// the body and the arm blend broadly round the shoulder, barely down the arm (or the
// blend webs the stump to the chest and the sleeve can't cover it)
function armBlend(x, y, z) {
  const J = SHOULDER_L, U = ARM_REST;
  const t = (Math.abs(x) - J.x) * U.x + (y - J.y) * U.y + (z - J.z) * U.z;
  return 0.04 - 0.032 * smoothstep(0.02, 0.07, t);
}
export function torsoSDF(x, y, z) {
  let d = smin(torsoBodySDF(x, y, z), torsoArmSDF(x, y, z), armBlend(x, y, z));
  // neck opening
  d = smax(d, -sdCapsule(x, y, z, 0, 0.52, -0.016, 0, 0.80, -0.04, 0.058), 0.008);
  // cut off below the seat
  d = smax(d, -(y + 0.02), 0.02);
  return d;
}
// how much a point of the jacket turns with the arm (0 body .. 1 arm)
export function torsoArmWeight(x, y, z) {
  const b = torsoBodySDF(x, y, z), a = torsoArmSDF(x, y, z);
  return smoothstep(-0.05, 0.06, b - a);
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
  const body = surfaceNets(torsoSDF, [-0.31, -0.06, -0.17], [0.31, 0.66, 0.17], 0.0098);
  relaxOnSurface(body, torsoSDF, 1, 0.4);
  const collar = surfaceNets(jacketCollarSDF, [-0.09, 0.49, -0.12], [0.09, 0.645, 0.09], 0.0047);
  relaxOnSurface(collar, jacketCollarSDF, 1, 0.35);
  const m = mergeMeshes([meshToArrays(body), meshToArrays(collar)]);
  // arm weights (the collar never moves with the arms)
  const nBody = body.positions.length / 3, nAll = m.positions.length / 3;
  const w = new Float32Array(nAll);
  for (let i = 0; i < nBody; i++) w[i] = torsoArmWeight(m.positions[i * 3], m.positions[i * 3 + 1], m.positions[i * 3 + 2]);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(m.positions, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(m.normals, 3));
  g.setAttribute('aShW', new THREE.BufferAttribute(w, 1));
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
// Rough, abstract faces: a skull, a soft face mass, a brow over shallow hollows,
// a nose and a jaw. No eyes, lips or other features: read as heads, not portraits.
function skinSDF(x, y, z) {
  const ax = Math.abs(x);
  let d = cranium(x, y, z);
  d = smin(d, sdEllipsoid(x, y, z, 0, 0.072, 0.032, 0.058, 0.07, 0.062), 0.03);     // face mass
  d = smin(d, sdEllipsoid(x, y, z, 0, 0.024, 0.044, 0.049, 0.034, 0.046), 0.03);    // jaw & chin
  d = smin(d, sdCapsule(ax, y, z, 0.0, 0.111, 0.077, 0.034, 0.109, 0.066, 0.0105), 0.022); // brow
  d = smax(d, -sdEllipsoid(ax, y, z, 0.031, 0.094, 0.093, 0.017, 0.011, 0.014), 0.012);   // soft hollows
  d = smin(d, sdRoundCone(x, y, z, 0, 0.100, 0.088, 0, 0.065, 0.103, 0.0072, 0.0098), 0.012); // nose
  d = smin(d, sdRoundCone(x, y, z, 0, -0.115, -0.022, 0, 0.045, -0.012, 0.0475, 0.0455), 0.03);   // neck
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
  // flatten into an ellipse (wrists are wider than deep), a faint seam on the outer side
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i);
    const a = Math.atan2(z, x);
    const seam = Math.exp(-(a * a) / 0.02) * 0.0016;
    // fitted close to the wrist (a few millimetres of play), so its inside stays hidden
    pos.setX(i, x * (1 + seam / 0.036) * 0.93);
    pos.setZ(i, z * 0.74);
  }
  g.computeVertexNormals();
  return g;
}
// ------------------------------------------------------------------ sleeve: tube rebuilt every frame
export class Sleeve {
  constructor(material, seed = 1) {
    this.NR = 18;
    this.NL = 36;
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
        // wound so the outside faces out: the cloth shader treats back faces as the
        // lining (darker, no sheen), which is what the whole sleeve used to render as
        idx.push(a, b, c, b, d, c);
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
    this._endR = new Float32Array(this.NR);
  }

  /**
   * S shoulder, E elbow, W wrist joint (world). refUp: hint for the frames' up.
   * Builds a smooth swept tube with elbow folds and a sleeve opening short of the wrist.
   * opts.start: the tube begins this far down the upper arm from S, inside the jacket's
   * shoulder stump (which turns with the arm, see ARM_REST), with radius opts.rShoulder
   * a hair over the stump's so the sleeve covers it. Without it (trouser legs) the tube
   * starts a little behind S and flares.
   */
  build(S, E, W, refUp, opts = {}) {
    const NR = this.NR, NL = this.NL;
    const rS = opts.rShoulder ?? 0.056, rE = opts.rElbow ?? 0.047, rW = opts.rWrist ?? 0.0385;
    const endBack = opts.endBack ?? 0.026;
    const sewn = opts.start !== undefined;
    const u = new THREE.Vector3().subVectors(E, S);
    const l1 = u.length(); u.normalize();
    const f = new THREE.Vector3().subVectors(W, E);
    const l2 = f.length(); f.normalize();
    const end = W.clone().addScaledVector(f, -endBack);
    const bend = Math.acos(clamp(u.dot(f), -1, 1)); // 0 straight
    const fillet = Math.min(0.06, l1 * 0.4, l2 * 0.4) * (0.4 + 0.6 * smoothstep(0.1, 1.2, bend));
    const E1 = E.clone().addScaledVector(u, -fillet);
    const E2 = E.clone().addScaledVector(f, fillet);
    // dense centreline: upper arm -> elbow fillet -> forearm
    const D = this._dense || (this._dense = Array.from({ length: 64 }, () => new THREE.Vector3()));
    let n = 0;
    const push = (v) => { D[n++].copy(v); };
    const p = new THREE.Vector3(), tmp = new THREE.Vector3();
    const start = S.clone().addScaledVector(u, sewn ? Math.min(opts.start, l1 - fillet - 0.02) : -0.035);
    for (let i = 0; i <= 12; i++) push(p.lerpVectors(start, E1, i / 12));
    const iF = n;
    for (let i = 1; i <= 10; i++) {
      const t = i / 10;
      push(p.copy(E1).multiplyScalar((1 - t) * (1 - t)).addScaledVector(E, 2 * (1 - t) * t).addScaledVector(E2, t * t));
    }
    const iElbow = iF + 4;
    for (let i = 1; i <= 10; i++) push(p.lerpVectors(E2, end, i / 10));
    const cum = this._cum || (this._cum = new Float32Array(64));
    cum[0] = 0;
    for (let i = 1; i < n; i++) cum[i] = cum[i - 1] + D[i].distanceTo(D[i - 1]);
    const total = cum[n - 1];
    const sElbowD = cum[iElbow];
    // rings evenly spaced by arc length along it
    const pts = this._pts || (this._pts = Array.from({ length: NL }, () => ({ p: new THREE.Vector3(), s: 0, d: 0 })));
    let seg = 1;
    for (let i = 0; i < NL; i++) {
      const d = (i / (NL - 1)) * total;
      while (seg < n - 1 && cum[seg] < d) seg++;
      const t = clamp((d - cum[seg - 1]) / Math.max(cum[seg] - cum[seg - 1], 1e-9), 0, 1);
      pts[i].p.lerpVectors(D[seg - 1], D[seg], t);
      pts[i].s = i / (NL - 1);
      pts[i].d = d;
    }
    const inner = new THREE.Vector3().addVectors(S, W).multiplyScalar(0.5).sub(E);
    if (inner.lengthSq() < 1e-8) inner.copy(refUp).cross(u);
    inner.normalize();
    // rotation-minimising frames
    const T = this._t, Nn = this._n, B = this._b;
    T.subVectors(pts[1].p, pts[0].p).normalize();
    Nn.copy(refUp).addScaledVector(T, -refUp.dot(T));
    if (Nn.lengthSq() < 1e-8) Nn.set(0, 1, 0).addScaledVector(T, -T.y);
    Nn.normalize();
    const pos = this.pos;
    const bendAmt = smoothstep(0.25, 1.9, bend);
    // toward the opening the rings turn and flatten to match the cuff inside (opts.endX:
    // the cuff's width axis; opts.endFlat: its depth / width), so the hem sits evenly
    // around it instead of standing off it on some sides
    const endX = opts.endX || null, endFlat = opts.endFlat ?? 0.93;
    const Nr = this._nr || (this._nr = new THREE.Vector3()), Br = this._br || (this._br = new THREE.Vector3());
    const Xp = this._xp || (this._xp = new THREE.Vector3());
    let flat = 0.93;
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
      Nr.copy(Nn);
      Br.copy(B);
      const wEnd = endX ? smoothstep(sElbowD + 0.03, total - 0.015, dist) : 0;
      if (wEnd > 0) {
        Xp.copy(endX).addScaledVector(T, -endX.dot(T));
        if (Xp.lengthSq() > 1e-8) {
          Xp.normalize();
          const ang = Math.atan2(tmp.crossVectors(B, Xp).dot(T), B.dot(Xp)) * wEnd;
          Br.applyAxisAngle(T, ang);
          Nr.applyAxisAngle(T, ang);
        }
      }
      // round where it covers the shoulder stump, an easy oval down the arm
      const oval = sewn ? smoothstep(0.09, 0.17, dist) : 1;
      flat = 1 + (0.93 - 1) * oval + (endFlat - 0.93) * wEnd;
      // radius profile (full over the stump, tapering from its end)
      const dE = dist - sElbowD;
      let r;
      if (dE < 0) r = rS + (rE - rS) * smoothstep(sewn ? 0.08 : 0, 1, dist / sElbowD);
      else r = rE + (rW - rE) * smoothstep(0, 1, dE / (total - sElbowD));
      // (sewn: the first ring starts tucked inside the shoulder cap, never on its surface)
      if (sewn) r *= 0.82 + 0.18 * smoothstep(0.0, 0.035, dist);
      else r += 0.006 * (1 - smoothstep(0.0, 0.08, dist));
      const elbowEnv = Math.exp(-(dE * dE) / (0.055 * 0.055));
      const cuffEnv = smoothstep(total - 0.07, total - 0.01, dist);
      for (let k = 0; k < NR; k++) {
        const a = (k / NR) * Math.PI * 2;
        const ca = Math.cos(a), sa = Math.sin(a);
        tmp.copy(Nr).multiplyScalar(ca).addScaledVector(Br, sa);
        const inn = tmp.dot(inner);
        // folds on the inside of the bend, a couple of drag lines on the outside
        let disp = 0;
        disp += 0.0055 * bendAmt * elbowEnv * Math.max(0, inn) ** 1.5 * Math.sin(dE / 0.0135 * Math.PI + a * 1.7 + this.phase[0]);
        disp -= 0.0035 * bendAmt * elbowEnv * Math.max(0, inn) ** 2;
        disp += 0.0018 * bendAmt * elbowEnv * Math.max(0, -inn) * Math.sin(a * 3 + dE * 60 + this.phase[1]);
        // bunching above the cuff (outward only: the end of the sleeve never dips in
        // toward the cuff or its own folded lining)
        disp += 0.0016 * cuffEnv * (0.5 + 0.5 * Math.sin(a * 5 + this.phase[2] + dist * 90));
        // cloth irregularity (none over the shoulder stump: it would let the stump through)
        disp += 0.0012 * (1 - cuffEnv) * oval * Math.sin(a * 2 + dist * 23 + this.phase[3]) * Math.sin(dist * 11 + this.phase[4]);
        const rr = r + disp;
        if (i === NL - 1) this._endR[k] = rr;
        const ex = rr, ey = rr * flat;
        const o = (i * NR + k) * 3;
        pos[o] = cur.x + Nr.x * ca * ey + Br.x * sa * ex;
        pos[o + 1] = cur.y + Nr.y * ca * ey + Br.y * sa * ex;
        pos[o + 2] = cur.z + Nr.z * ca * ey + Br.z * sa * ex;
      }
    }
    // lip: fold the fabric back inside the opening to give it thickness. Each lining ring
    // follows the opening's own radius at that angle, tucked well inside it, so it can
    // never poke out through the outer cloth (that showed as bright slivers at the hem).
    const last = pts[NL - 1].p;
    const lipIn = [0.0010, 0.0022, 0.0040];
    const lipBack = [0.0012, 0.003, 0.03];
    for (let e = 0; e < this.extra; e++) {
      const c = tmp.copy(last).addScaledVector(T, -lipBack[e]);
      for (let k = 0; k < NR; k++) {
        const a = (k / NR) * Math.PI * 2;
        const ca = Math.cos(a), sa = Math.sin(a);
        const o = ((NL + e) * NR + k) * 3;
        const rr = Math.min(this._endR[k], rW) - lipIn[e];
        pos[o] = c.x + (Nr.x * ca * flat + Br.x * sa) * rr;
        pos[o + 1] = c.y + (Nr.y * ca * flat + Br.y * sa) * rr;
        pos[o + 2] = c.z + (Nr.z * ca * flat + Br.z * sa) * rr;
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
