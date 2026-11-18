// Procedural hand: anatomy as an SDF, meshed once, auto-skinned to a 17-bone rig.
// Local frame of the RIGHT hand: +Y toward the fingers, +Z dorsal (back of hand),
// thumb on -X. The left hand is the exact mirror (x -> -x).
import * as THREE from 'three';
import { surfaceNets, relaxOnSurface, sdRoundCone, sdEllipsoid, sdRoundBox, smin, segDist2 } from './sdf.js';
import { DEG, smoothstep, clamp } from './util.js';

const v = (x, y, z) => new THREE.Vector3(x, y, z);

export const FINGERS = [
  { name: 'index', mcp: v(-0.0265, 0.090, 0.0), dir: v(-0.10, 1, 0.0), len: [0.041, 0.025, 0.021], rad: [0.0097, 0.0087, 0.0077, 0.0068], meta: v(-0.019, 0.010, 0.0005), mr: 0.0112 },
  { name: 'middle', mcp: v(-0.0075, 0.094, 0.001), dir: v(-0.02, 1, 0.0), len: [0.045, 0.029, 0.022], rad: [0.0099, 0.0089, 0.0079, 0.0070], meta: v(-0.006, 0.008, 0.0015), mr: 0.0118 },
  { name: 'ring', mcp: v(0.0110, 0.089, 0.0), dir: v(0.075, 1, 0.0), len: [0.042, 0.027, 0.021], rad: [0.0093, 0.0084, 0.0075, 0.0066], meta: v(0.0065, 0.010, 0.001), mr: 0.0110 },
  { name: 'pinky', mcp: v(0.0280, 0.079, -0.002), dir: v(0.18, 1, 0.0), len: [0.033, 0.020, 0.019], rad: [0.0083, 0.0075, 0.0067, 0.0059], meta: v(0.0175, 0.013, -0.001), mr: 0.0104 },
];
export const THUMB = {
  cmc: v(-0.0205, 0.020, -0.011),
  dirs: [v(-0.746, 0.617, -0.249), v(-0.553, 0.804, -0.221), v(-0.45, 0.87, -0.20)],
  len: [0.046, 0.032, 0.028],
  rad: [0.0150, 0.0112, 0.0099, 0.0086],
  nail: v(-0.7, 0.0, 0.7),
};

// ---------------------------------------------------------------------------
// Joint positions & rest frames (right hand)
for (const f of FINGERS) {
  f.dir.normalize();
  f.joints = [f.mcp.clone()];
  for (let i = 0; i < 3; i++) f.joints.push(f.joints[i].clone().addScaledVector(f.dir, f.len[i]));
}
THUMB.dirs.forEach((d) => d.normalize());
THUMB.joints = [THUMB.cmc.clone()];
for (let i = 0; i < 3; i++) THUMB.joints.push(THUMB.joints[i].clone().addScaledVector(THUMB.dirs[i], THUMB.len[i]));

function frameQuat(y, zHint) {
  const Y = y.clone().normalize();
  const Z = zHint.clone().addScaledVector(Y, -zHint.dot(Y)).normalize();
  const X = new THREE.Vector3().crossVectors(Y, Z).normalize();
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(X, Y, Z));
}

// Bone table: world-rest position + orientation, parent index, weight segments.
export const BONES = [];
function addBone(name, parent, pos, quat, segs, sigma) {
  BONES.push({ name, parent, pos, quat, segs, sigma });
  return BONES.length - 1;
}
const ID = new THREE.Quaternion();
export const B_FOREARM = addBone('forearm', -1, v(0, 0, 0), ID.clone(), [[v(0, -0.11, 0), v(0, -0.006, 0)]], 0.009);
export const B_PALM = addBone('palm', 0, v(0, 0, 0), ID.clone(), [
  [v(0, -0.002, -0.002), v(0, 0.062, -0.003)],
  [v(-0.019, 0.004, -0.008), v(0.020, 0.008, -0.008)],
  ...FINGERS.map((f) => [f.meta.clone(), f.mcp.clone()]),
], 0.0085);
export const FINGER_BONES = FINGERS.map((f) => {
  const q = frameQuat(f.dir, v(0, 0, 1));
  const ids = [];
  for (let i = 0; i < 3; i++) {
    ids.push(addBone(`${f.name}${i + 1}`, i === 0 ? B_PALM : ids[i - 1], f.joints[i].clone(), q.clone(), [[f.joints[i].clone(), f.joints[i + 1].clone()]], 0.0045));
  }
  return ids;
});
export const THUMB_BONES = (() => {
  const ids = [];
  for (let i = 0; i < 3; i++) {
    const q = frameQuat(THUMB.dirs[i], THUMB.nail);
    ids.push(addBone(`thumb${i + 1}`, i === 0 ? B_PALM : ids[i - 1], THUMB.joints[i].clone(), q, [[THUMB.joints[i].clone(), THUMB.joints[i + 1].clone()]], i === 0 ? 0.007 : 0.005));
  }
  return ids;
})();

// ---------------------------------------------------------------------------
// The SDF of a relaxed right hand in its bind pose.
const fingerBounds = FINGERS.map((f) => ({ a: f.joints[0], b: f.joints[3], r: f.rad[0] + 0.016 }));
const thumbBound = { a: THUMB.joints[0], b: THUMB.joints[3], r: THUMB.rad[0] + 0.02 };

export function handSDF(x, y, z) {
  // forearm stub (elliptic cylinder, flattened) – hides inside the cuff
  const ex = x / 0.0265, ez = (z + 0.001) / 0.0185;
  let fore = (Math.sqrt(ex * ex + ez * ez) - 1) * 0.0185;
  fore = Math.max(fore, -(y + 0.115), y - 0.006);
  let d = fore;

  // palm slab + metacarpals + thenar / hypothenar eminences
  let palm = sdRoundBox(x + 0.0005, y - 0.050, z + 0.0040, 0.0272, 0.034, 0.0058, 0.0098);
  for (const f of FINGERS) {
    palm = smin(palm, sdRoundCone(x, y, z, f.meta.x, f.meta.y, f.meta.z + 0.001, f.mcp.x, f.mcp.y, f.mcp.z + 0.0015, f.mr * 1.04, f.rad[0] * 1.1), 0.010);
  }
  palm = smin(palm, sdEllipsoid(x, y, z, -0.021, 0.034, -0.0125, 0.0165, 0.025, 0.0125), 0.012);
  palm = smin(palm, sdEllipsoid(x, y, z, 0.0235, 0.040, -0.0095, 0.0115, 0.031, 0.0105), 0.010);
  d = smin(d, palm, 0.022);

  // fingers
  for (let fi = 0; fi < 4; fi++) {
    const f = FINGERS[fi];
    const bb = fingerBounds[fi];
    const bd = Math.sqrt(segDist2(x, y, z, bb.a.x, bb.a.y, bb.a.z, bb.b.x, bb.b.y, bb.b.z)) - bb.r;
    if (bd > 0.004) continue;
    const J = f.joints, R = f.rad;
    let fd = sdRoundCone(x, y, z, J[0].x, J[0].y, J[0].z, J[1].x, J[1].y, J[1].z, R[0], R[1]);
    fd = Math.min(fd, sdRoundCone(x, y, z, J[1].x, J[1].y, J[1].z, J[2].x, J[2].y, J[2].z, R[1], R[2]));
    fd = Math.min(fd, sdRoundCone(x, y, z, J[2].x, J[2].y, J[2].z, J[3].x, J[3].y, J[3].z, R[2], R[3]));
    // knuckle prominence over the MCP head
    fd = Math.min(fd, sdEllipsoid(x, y, z, J[0].x, J[0].y - 0.002, J[0].z + 0.0025, R[0] * 1.02, R[0] * 1.1, R[0] * 0.95));
    d = smin(d, fd, 0.0062);
  }
  // thumb
  {
    const bd = Math.sqrt(segDist2(x, y, z, thumbBound.a.x, thumbBound.a.y, thumbBound.a.z, thumbBound.b.x, thumbBound.b.y, thumbBound.b.z)) - thumbBound.r;
    if (bd < 0.004) {
      const J = THUMB.joints, R = THUMB.rad;
      let td = sdRoundCone(x, y, z, J[0].x, J[0].y, J[0].z, J[1].x, J[1].y, J[1].z, R[0], R[1]);
      td = Math.min(td, sdRoundCone(x, y, z, J[1].x, J[1].y, J[1].z, J[2].x, J[2].y, J[2].z, R[1], R[2]));
      td = Math.min(td, sdRoundCone(x, y, z, J[2].x, J[2].y, J[2].z, J[3].x, J[3].y, J[3].z, R[2], R[3]));
      d = smin(d, td, 0.011);
    }
  }
  return d;
}

// ---------------------------------------------------------------------------
// Build geometry + skin weights + per-vertex detail channels.
let _cachedRight = null;
function buildRightGeometry() {
  if (_cachedRight) return _cachedRight;
  const t0 = performance.now();
  const mesh = surfaceNets(handSDF, [-0.106, -0.118, -0.056], [0.062, 0.206, 0.034], 0.0028);
  relaxOnSurface(mesh, handSDF, 2, 0.45);
  const { positions, normals, indices } = mesh;
  const n = positions.length / 3;

  const skinIndex = new Uint16Array(n * 4);
  const skinWeight = new Float32Array(n * 4);
  const aux = new Float32Array(n * 4); // nail, joint axial distance, dorsal factor, thickness

  const boneAxes = BONES.map((b) => {
    const m = new THREE.Matrix4().makeRotationFromQuaternion(b.quat);
    const X = new THREE.Vector3(), Y = new THREE.Vector3(), Z = new THREE.Vector3();
    m.extractBasis(X, Y, Z);
    return { X, Y, Z };
  });
  const distal = [...FINGER_BONES.map((ids, fi) => ({ b: ids[2], len: FINGERS[fi].len[2], r: FINGERS[fi].rad[3] })), { b: THUMB_BONES[2], len: THUMB.len[2], r: THUMB.rad[3] }];
  const joints = [];
  FINGERS.forEach((f, fi) => {
    for (let j = 0; j < 3; j++) joints.push({ p: f.joints[j], axis: f.dir, r: f.rad[j] * 1.45 });
  });
  for (let j = 1; j < 3; j++) joints.push({ p: THUMB.joints[j], axis: THUMB.dirs[j], r: THUMB.rad[j] * 1.45 });

  const P = new THREE.Vector3(), N = new THREE.Vector3(), q = new THREE.Vector3();
  const logw = new Float64Array(BONES.length);
  for (let i = 0; i < n; i++) {
    P.fromArray(positions, i * 3);
    N.fromArray(normals, i * 3);
    let best = -Infinity, bestB = 0;
    for (let b = 0; b < BONES.length; b++) {
      let d2 = Infinity;
      for (const [a, c] of BONES[b].segs) d2 = Math.min(d2, segDist2(P.x, P.y, P.z, a.x, a.y, a.z, c.x, c.y, c.z));
      const s = BONES[b].sigma;
      logw[b] = -d2 / (s * s);
      if (logw[b] > best) { best = logw[b]; bestB = b; }
    }
    // top-4
    const order = Array.from(logw.keys()).sort((a, b) => logw[b] - logw[a]).slice(0, 4);
    let sum = 0;
    const w = order.map((b) => {
      const x = Math.exp(logw[b] - best);
      sum += x;
      return x;
    });
    for (let k = 0; k < 4; k++) {
      skinIndex[i * 4 + k] = order[k];
      skinWeight[i * 4 + k] = w[k] / sum;
    }

    // nail mask
    let nail = 0;
    for (const dd of distal) {
      const bb = BONES[dd.b], ax = boneAxes[dd.b];
      q.copy(P).sub(bb.pos);
      const t = q.dot(ax.Y) / dd.len;
      const lat = Math.abs(q.dot(ax.X));
      const dor = q.dot(ax.Z);
      const r = dd.r * 1.12;
      const m = smoothstep(0.40, 0.56, t) * (1 - smoothstep(1.04, 1.16, t)) * smoothstep(0.30, 0.62, dor / r) * (1 - smoothstep(0.60, 0.86, lat / r));
      nail = Math.max(nail, m);
    }
    // nearest joint (for creases)
    let jAx = 1, jBest = 1e9;
    for (const J of joints) {
      q.copy(P).sub(J.p);
      const ax = q.dot(J.axis);
      const rad = Math.sqrt(Math.max(0, q.lengthSq() - ax * ax));
      if (rad > J.r) continue;
      if (Math.abs(ax) < jBest) { jBest = Math.abs(ax); jAx = ax; }
    }
    const dorsal = N.dot(boneAxes[bestB].Z);
    let thick = 2.5;
    if (bestB >= 2) {
      const fi = FINGER_BONES.findIndex((ids) => ids.includes(bestB));
      thick = fi >= 0 ? FINGERS[fi].rad[1] / 0.01 : THUMB.rad[1] / 0.01;
    }
    aux[i * 4] = nail;
    aux[i * 4 + 1] = clamp(jAx, -1, 1);
    aux[i * 4 + 2] = dorsal;
    aux[i * 4 + 3] = thick;
  }
  _cachedRight = { positions, normals, indices, skinIndex, skinWeight, aux, ms: performance.now() - t0, verts: n };
  return _cachedRight;
}

function makeGeometry(side) {
  const R = buildRightGeometry();
  const g = new THREE.BufferGeometry();
  let pos = R.positions, nor = R.normals, idx = R.indices;
  if (side === 'left') {
    pos = R.positions.slice();
    nor = R.normals.slice();
    for (let i = 0; i < pos.length; i += 3) { pos[i] = -pos[i]; nor[i] = -nor[i]; }
    idx = R.indices.slice();
    for (let t = 0; t < idx.length; t += 3) { const tmp = idx[t + 1]; idx[t + 1] = idx[t + 2]; idx[t + 2] = tmp; }
  }
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(R.skinIndex, 4));
  g.setAttribute('skinWeight', new THREE.BufferAttribute(R.skinWeight, 4));
  g.setAttribute('aAux', new THREE.BufferAttribute(R.aux, 4));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.computeBoundingSphere();
  g.boundingSphere.radius = 1.5;
  return g;
}

// ---------------------------------------------------------------------------
// Pose parameters: per finger [mcp, pip, dip, spread] (deg), thumb [cmcFlex, cmcAbd, cmcTwist, mcp, ip].
export const POSE_SIZE = 21;
export function pose(fingers, thumb) {
  const p = new Float32Array(POSE_SIZE);
  for (let f = 0; f < 4; f++) for (let k = 0; k < 4; k++) p[f * 4 + k] = fingers[f][k] ?? 0;
  for (let k = 0; k < 5; k++) p[16 + k] = thumb[k] ?? 0;
  return p;
}
export function lerpPose(a, b, t, out = new Float32Array(POSE_SIZE)) {
  for (let i = 0; i < POSE_SIZE; i++) out[i] = a[i] + (b[i] - a[i]) * t;
  return out;
}

export const POSES = {
  flat: pose([[6, 6, 3, 0], [6, 7, 3, 0], [7, 8, 4, 0], [8, 9, 5, 0]], [-4, 2, 0, 4, 6]),
  relaxed: pose([[22, 28, 14, -1], [26, 34, 18, 0], [30, 40, 20, 1], [34, 42, 22, 2]], [12, 8, 10, 14, 16]),
  // loose fist resting on its outer edge (the shot: foreground hand)
  fist: pose([[68, 96, 55, -3], [76, 100, 58, -1], [82, 100, 58, 1], [88, 96, 55, 3]], [26, 10, 22, 24, 22]),
  // flat, splayed support hand (the shot: far right hand)
  spread: pose([[4, 12, 10, 9], [3, 12, 12, 2], [5, 14, 12, 6], [8, 16, 12, 12]], [-10, 6, -6, 6, 12]),
  // fingertips down near the matches (the shot: far left hand)
  touch: pose([[34, 44, 22, 2], [40, 52, 28, 0], [52, 64, 34, -1], [62, 70, 40, -2]], [18, 6, 16, 16, 22]),
  // weight-bearing: palm pressed flat, fingers splayed and long
  brace: pose([[3, 4, 2, 12], [2, 4, 2, 3], [3, 5, 3, 7], [5, 6, 4, 15]], [-6, 8, -4, 4, 6]),
  // fingertips lightly on the stone, fingers long (the shot: far left hand)
  poised: pose([[14, 22, 12, 2], [16, 26, 14, 0], [22, 30, 16, -1], [28, 34, 18, -2]], [10, 0, 0, 10, 12]),
  // ready to pinch: index & thumb open, others tucked
  reach: pose([[26, 26, 12, 3], [50, 60, 36, 0], [64, 74, 42, -2], [72, 78, 46, -3]], [0, -2, 0, 4, 4]),
  // pinch / hold: thumb values solved at startup
  pinch: pose([[52, 52, 24, 1], [62, 74, 42, 0], [72, 84, 46, -2], [80, 86, 48, -3]], [20, -10, 0, 15, 12]),
  hold: null,
  release: null,
  tapUp: null,
};

// ---------------------------------------------------------------------------
// Rig: builds THREE.Bones and a SkinnedMesh for one side.
const _mirrorQ = (q) => new THREE.Quaternion(q.x, -q.y, -q.z, q.w);
const _qa = new THREE.Quaternion(), _qb = new THREE.Quaternion(), _qc = new THREE.Quaternion();
const AX = new THREE.Vector3(1, 0, 0), AY = new THREE.Vector3(0, 1, 0), AZ = new THREE.Vector3(0, 0, 1);

export class HandRig {
  constructor(side, material) {
    this.side = side;
    this.sign = side === 'left' ? -1 : 1;
    this.group = new THREE.Group();
    this.group.name = `hand-${side}`;
    this.bones = [];
    this.restLocal = [];
    const worldRest = BONES.map((b) => ({
      pos: side === 'left' ? new THREE.Vector3(-b.pos.x, b.pos.y, b.pos.z) : b.pos.clone(),
      quat: side === 'left' ? _mirrorQ(b.quat) : b.quat.clone(),
    }));
    for (let i = 0; i < BONES.length; i++) {
      const bone = new THREE.Bone();
      bone.name = BONES[i].name;
      const par = BONES[i].parent;
      if (par < 0) {
        bone.position.copy(worldRest[i].pos);
        bone.quaternion.copy(worldRest[i].quat);
        this.group.add(bone);
      } else {
        const pq = worldRest[par].quat.clone().invert();
        bone.position.copy(worldRest[i].pos).sub(worldRest[par].pos).applyQuaternion(pq);
        bone.quaternion.copy(pq).multiply(worldRest[i].quat);
        this.bones[par].add(bone);
      }
      this.bones.push(bone);
      this.restLocal.push(bone.quaternion.clone());
    }
    this.worldRest = worldRest;
    if (material) {
      const geo = makeGeometry(side);
      this.mesh = new THREE.SkinnedMesh(geo, material);
      this.mesh.frustumCulled = false;
      this.group.add(this.mesh);
      this.group.updateMatrixWorld(true);
      this.mesh.bind(new THREE.Skeleton(this.bones), this.mesh.matrixWorld);
    }
    this.pose = new Float32Array(POSES.relaxed);
    this.wristQuat = new THREE.Quaternion(); // palm relative to forearm
  }

  // Apply pose params (+ wrist rotation relative to the forearm bone).
  applyPose(p = this.pose, wristLocal = this.wristQuat) {
    const s = this.sign;
    const B = this.bones;
    const set = (i, q) => {
      if (s < 0) q.set(q.x, -q.y, -q.z, q.w);
      B[i].quaternion.copy(this.restLocal[i]).multiply(q);
    };
    // palm (wrist joint)
    B[B_PALM].quaternion.copy(this.restLocal[B_PALM]).multiply(wristLocal);
    const spreadSign = [1, 0.25, -0.7, -1];
    for (let f = 0; f < 4; f++) {
      const ids = FINGER_BONES[f];
      const mcp = p[f * 4] * DEG, pip = p[f * 4 + 1] * DEG, dip = p[f * 4 + 2] * DEG, spr = p[f * 4 + 3] * DEG * spreadSign[f];
      _qa.setFromAxisAngle(AZ, spr);
      _qb.setFromAxisAngle(AX, -mcp);
      set(ids[0], _qc.copy(_qa).multiply(_qb));
      set(ids[1], _qc.setFromAxisAngle(AX, -pip));
      set(ids[2], _qc.setFromAxisAngle(AX, -dip));
    }
    const T = THUMB_BONES;
    _qa.setFromAxisAngle(AY, p[18] * DEG);
    _qb.setFromAxisAngle(AZ, p[17] * DEG);
    _qa.multiply(_qb);
    _qb.setFromAxisAngle(AX, -p[16] * DEG);
    set(T[0], _qc.copy(_qa).multiply(_qb));
    set(T[1], _qc.setFromAxisAngle(AX, -p[19] * DEG));
    set(T[2], _qc.setFromAxisAngle(AX, -p[20] * DEG));
  }

  // Pad points (index & thumb) in the coordinate frame of `this.group` after applyPose.
  padPoints(outIndex, outThumb) {
    this.group.updateMatrixWorld(true);
    const inv = new THREE.Matrix4().copy(this.group.matrixWorld).invert();
    const fi = FINGER_BONES[0][2], ti = THUMB_BONES[2];
    outIndex.set(0, FINGERS[0].len[2] * 0.70, -FINGERS[0].rad[3] * 0.5).applyMatrix4(this.bones[fi].matrixWorld).applyMatrix4(inv);
    outThumb.set(0, THUMB.len[2] * 0.70, -THUMB.rad[3] * 0.5).applyMatrix4(this.bones[ti].matrixWorld).applyMatrix4(inv);
  }
}

// ---------------------------------------------------------------------------
// Thumb poses are solved, not hand-authored: the CMC joint is a saddle whose
// axes do not map to intuitive angles, so every named pose states a goal.
const _pd = new THREE.Vector3(), _pn = new THREE.Vector3(), _tn = new THREE.Vector3();
const _sa = new THREE.Vector3(), _sb = new THREE.Vector3(), _sc = new THREE.Vector3(), _sd = new THREE.Vector3();
const LIMITS = [[-25, 75], [-65, 45], [-55, 65], [-12, 70], [-18, 85]];

function segSegDist(a, b, c, d) {
  // approximate: sample one segment, exact point-segment on the other
  let best = Infinity;
  for (let i = 0; i <= 4; i++) {
    _sd.lerpVectors(a, b, i / 4);
    best = Math.min(best, Math.sqrt(segDist2(_sd.x, _sd.y, _sd.z, c.x, c.y, c.z, d.x, d.y, d.z)));
  }
  return best;
}
function boneSeg(rig, b, len, outA, outB) {
  outA.set(0, 0, 0).applyMatrix4(rig.bones[b].matrixWorld);
  outB.set(0, len, 0).applyMatrix4(rig.bones[b].matrixWorld);
}
// penalty for the thumb passing through the index / middle fingers or the palm
function thumbCollision(rig) {
  let pen = 0;
  const tA = new THREE.Vector3(), tB = new THREE.Vector3();
  for (let k = 1; k < 3; k++) {
    boneSeg(rig, THUMB_BONES[k], THUMB.len[k], tA, tB);
    for (let f = 0; f < 2; f++)
      for (let j = 0; j < 3; j++) {
        boneSeg(rig, FINGER_BONES[f][j], FINGERS[f].len[j], _sa, _sb);
        const d = segSegDist(tA, tB, _sa, _sb);
        const lim = (THUMB.rad[k + 1] + FINGERS[f].rad[j + 1]) * 0.92;
        if (d < lim) pen += (lim - d) * (lim - d) * 4e6;
      }
    // palm slab (in hand space): keep the thumb out of it
    for (let i = 0; i <= 3; i++) {
      _sc.lerpVectors(tA, tB, i / 3);
      const inside = -sdRoundBox(_sc.x + 0.0005, _sc.y - 0.050, _sc.z + 0.004, 0.0272, 0.034, 0.0058, 0.0098) + THUMB.rad[k + 1] * 0.8;
      if (inside > 0) pen += inside * inside * 4e6;
    }
  }
  return pen;
}
function thumbPad(rig, out) {
  return out.set(0, THUMB.len[2] * 0.70, -THUMB.rad[3] * 0.5).applyMatrix4(rig.bones[THUMB_BONES[2]].matrixWorld);
}
function solveThumb(base, objective, start = null) {
  const rig = new HandRig('right', null);
  const p = new Float32Array(base);
  const cost = () => {
    rig.applyPose(p);
    rig.group.updateMatrixWorld(true);
    let c = objective(rig, p);
    c += thumbCollision(rig);
    for (let k = 0; k < 5; k++) {
      const [lo, hi] = LIMITS[k];
      const v = p[16 + k];
      if (v < lo) c += (lo - v) ** 2 * 0.05;
      if (v > hi) c += (v - hi) ** 2 * 0.05;
    }
    // mild preference for a natural, unstrained thumb
    c += ((p[19] - 15) / 60) ** 2 * 0.2 + ((p[20] - 15) / 60) ** 2 * 0.2 + (p[18] / 80) ** 2 * 0.2;
    return c;
  };
  let best = Infinity;
  if (start) {
    for (let k = 0; k < 5; k++) p[16 + k] = start[k];
    best = cost();
  } else {
    let bp = null;
    for (let fl = -20; fl <= 70; fl += 10)
      for (let ab = -60; ab <= 40; ab += 10)
        for (let tw = -45; tw <= 60; tw += 15)
          for (const mc of [0, 20, 40]) {
            p[16] = fl; p[17] = ab; p[18] = tw; p[19] = mc; p[20] = mc;
            const c = cost();
            if (c < best) { best = c; bp = [fl, ab, tw, mc, mc]; }
          }
    for (let k = 0; k < 5; k++) p[16 + k] = bp[k];
  }
  let step = 6;
  for (let it = 0; it < 500 && step > 0.05; it++) {
    let improved = false;
    for (let k = 16; k < 21; k++) {
      for (const dir of [1, -1]) {
        const old = p[k];
        p[k] = old + dir * step;
        const c = cost();
        if (c < best) { best = c; improved = true; break; }
        p[k] = old;
      }
    }
    if (!improved) step *= 0.6;
  }
  return p;
}

// pads facing each other at a given gap (precision pinch)
function pinchObjective(gap) {
  const a = new THREE.Vector3(), b = new THREE.Vector3();
  const fi = FINGER_BONES[0][2], ti = THUMB_BONES[2];
  return (rig) => {
    rig.padPoints(a, b);
    const d = a.distanceTo(b);
    let c = (d - gap) * (d - gap) * 1e6;
    _pd.copy(a).sub(b).normalize();
    _tn.set(0, 0, -1).transformDirection(rig.bones[ti].matrixWorld);
    _pn.set(0, 0, -1).transformDirection(rig.bones[fi].matrixWorld);
    c += (1 - _tn.dot(_pd)) * 2.0 + (1 + _pn.dot(_pd)) * 1.0;
    return c;
  };
}
// thumb pad resting against a point defined on a finger bone (bone-local)
function restObjective(bone, local, faceDir = null) {
  const g = new THREE.Vector3(), t = new THREE.Vector3();
  return (rig) => {
    g.copy(local).applyMatrix4(rig.bones[bone].matrixWorld);
    thumbPad(rig, t);
    let c = t.distanceToSquared(g) * 1e6;
    if (faceDir) {
      _tn.set(0, 0, -1).transformDirection(rig.bones[THUMB_BONES[2]].matrixWorld);
      _pd.copy(g).sub(t);
      c += 0;
    }
    return c;
  };
}
function solvePinch(base, gap, start = null) {
  const p = solveThumb(base, pinchObjective(gap), start);
  const rig = new HandRig('right', null);
  rig.applyPose(p);
  const a = new THREE.Vector3(), b = new THREE.Vector3();
  rig.padPoints(a, b);
  return { pose: p, dist: a.distanceTo(b) };
}

export function initPoses() {
  const t0 = performance.now();
  const I = FINGER_BONES[0], M = FINGER_BONES[1];
  // fist: thumb pad pressed across the back of the index/middle middle phalanges
  POSES.fist = solveThumb(POSES.fist, restObjective(I[1], new THREE.Vector3(0.004, FINGERS[0].len[1] * 0.55, FINGERS[0].rad[1] + THUMB.rad[3] * 0.55)));
  // relaxed & touch: thumb pad lightly beside the index middle phalanx
  POSES.relaxed = solveThumb(POSES.relaxed, restObjective(I[1], new THREE.Vector3(-(FINGERS[0].rad[1] + 0.009), FINGERS[0].len[1] * 0.4, -0.006)));
  POSES.touch = solveThumb(POSES.touch, restObjective(I[1], new THREE.Vector3(-(FINGERS[0].rad[1] + 0.008), FINGERS[0].len[1] * 0.2, -0.004)));
  POSES.poised = solveThumb(POSES.poised, restObjective(I[0], new THREE.Vector3(-(FINGERS[0].rad[0] + 0.012), FINGERS[0].len[0] * 0.75, -0.010)));
  // flat / spread: thumb out to the side, pad down
  POSES.flat = solveThumb(POSES.flat, restObjective(I[0], new THREE.Vector3(-0.05, 0.005, -0.012)));
  POSES.spread = solveThumb(POSES.spread, restObjective(I[0], new THREE.Vector3(-0.058, -0.004, -0.014)));
  POSES.brace = solveThumb(POSES.brace, restObjective(I[0], new THREE.Vector3(-0.062, -0.010, -0.016)));
  // pinch family
  const pinch = solvePinch(POSES.pinch, 0.0074);
  POSES.pinch = pinch.pose;
  const ts = Array.from(pinch.pose.slice(16));
  const hold = solvePinch(POSES.pinch, 0.0100, ts);
  POSES.hold = hold.pose;
  POSES.holdWide = solvePinch(POSES.pinch, 0.0140, ts).pose;
  // reach: an opposed open "C", ready to close on a match
  POSES.reach = solvePinch(POSES.reach, 0.036, ts).pose;
  POSES.release = lerpPose(POSES.hold, POSES.reach, 0.8);
  // finger tap (index lifted)
  POSES.tapUp = new Float32Array(POSES.spread);
  POSES.tapUp[0] = -14; POSES.tapUp[1] = 4; POSES.tapUp[2] = 2;
  return { pinch: pinch.dist, hold: hold.dist, ms: performance.now() - t0 };
}

export function handGeometryStats() {
  const R = buildRightGeometry();
  return { verts: R.verts, tris: R.indices.length / 3, ms: R.ms };
}

// Points (bone-local) used for the table-penetration constraint & contact AO.
export const CONTACT_POINTS = (() => {
  const pts = [];
  FINGER_BONES.forEach((ids, f) => {
    const F = FINGERS[f];
    for (let k = 0; k < 3; k++) {
      pts.push({ bone: ids[k], p: new THREE.Vector3(0, 0, 0), r: F.rad[k] });
      pts.push({ bone: ids[k], p: new THREE.Vector3(0, F.len[k] * 0.5, 0), r: (F.rad[k] + F.rad[k + 1]) * 0.5 });
    }
    pts.push({ bone: ids[2], p: new THREE.Vector3(0, F.len[2], 0), r: F.rad[3] });
  });
  for (let k = 0; k < 3; k++) {
    pts.push({ bone: THUMB_BONES[k], p: new THREE.Vector3(0, THUMB.len[k] * 0.5, 0), r: (THUMB.rad[k] + THUMB.rad[k + 1]) * 0.5 });
  }
  pts.push({ bone: THUMB_BONES[2], p: new THREE.Vector3(0, THUMB.len[2], 0), r: THUMB.rad[3] });
  // palm: knuckle heads & heel (in palm-bone local coords == hand rest coords)
  for (const F of FINGERS) pts.push({ bone: B_PALM, p: F.mcp.clone(), r: F.rad[0] * 1.05 });
  pts.push({ bone: B_PALM, p: new THREE.Vector3(0.0, 0.045, -0.006), r: 0.016 });
  pts.push({ bone: B_PALM, p: new THREE.Vector3(0.020, 0.025, -0.006), r: 0.012 });
  pts.push({ bone: B_PALM, p: new THREE.Vector3(-0.018, 0.028, -0.008), r: 0.014 });
  pts.push({ bone: B_PALM, p: new THREE.Vector3(0.0, 0.0, 0.0), r: 0.019 });
  return pts;
})();
