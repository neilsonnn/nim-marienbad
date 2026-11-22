// Bodies, arms and hands: everything that moves procedurally.
import * as THREE from 'three';
import { HandRig, POSES, CONTACT_POINTS, lerpPose, POSE_SIZE, B_PALM, FINGERS, FINGER_BONES, THUMB_BONES } from './handModel.js';
import { Sleeve, torsoGeometry, headGeometry, collarGeometry, cuffGeometry, SHOULDER_L, NECK_PIVOT, ARM_REST, STUMP } from './bodyModel.js';
import { clamp, lerp, smoothstep, minJerk, noise1, fnoise, Spring, DEG, quatFromYZ, rand } from './util.js';
import { TABLE_Y, TABLE_R, L_NO_MIRROR, L_MAIN_ONLY, L_NO_SHADOW } from './world.js';
// (REACH_SOFT / REACH_MAX defined below with the solver)

const UP = new THREE.Vector3(0, 1, 0);
const AXIS_X = new THREE.Vector3(1, 0, 0), AXIS_Y = new THREE.Vector3(0, 1, 0), AXIS_Z = new THREE.Vector3(0, 0, 1);
const _qT = new THREE.Quaternion();
const _qFlip = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
const _qIdent = new THREE.Quaternion();
const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3();
const _q1 = new THREE.Quaternion(), _q2 = new THREE.Quaternion();
const _m1 = new THREE.Matrix4();

// ------------------------------------------------------------------ diagnostics (?debug=loop)
// Per-move maxima of everything that reads as "wrong" in an arm: overreach, the elbow
// riding up, the arm sinking into the body, elbow snaps, jerky lean, extreme wrists.
export const DIAG = {
  on: false,
  cur: null,
  log: [],
  begin(label, hand) {
    if (!this.on) return;
    this.cur = { label, hand, t0: performance.now(), shortfall: 0, elbowUp: -1, pen: 0, elbowSpeed: 0, leanAcc: 0, wrist: 0, face: 9 };
  },
  end() {
    if (!this.on || !this.cur) return;
    const c = this.cur;
    const fails = [];
    if (c.shortfall > 0.006) fails.push(`overreach ${(c.shortfall * 1000).toFixed(0)}mm`);
    if (c.elbowUp > 0.45) fails.push(`elbow up ${c.elbowUp.toFixed(2)}`);
    if (c.pen > 0.012) fails.push(`arm in body ${(c.pen * 1000).toFixed(0)}mm`);
    if (c.elbowSpeed > 7) fails.push(`elbow snap ${c.elbowSpeed.toFixed(1)}rad/s`);
    if (c.leanAcc > 6) fails.push(`lean jerk ${c.leanAcc.toFixed(1)}rad/s²`);
    if (c.wrist > 95) fails.push(`wrist ${c.wrist.toFixed(0)}°`);
    if (c.face < 0.035) fails.push(`hand at face ${(c.face * 1000).toFixed(0)}mm`);
    c.fails = fails;
    delete c.hand;
    this.log.push(c);
    if (fails.length) console.warn(`[diag] ${c.label}: ${fails.join(', ')}`);
    this.cur = null;
  },
  sample(hand, arm, actor, dt) {
    const c = this.cur;
    if (!c || dt <= 0) return;
    const mine = c.hand === hand;
    if (mine) {
      c.shortfall = Math.max(c.shortfall, arm.shortfall);
      c.elbowUp = Math.max(c.elbowUp, arm.elbowDir.y);
      c.elbowSpeed = Math.max(c.elbowSpeed, arm.elbowSpeed);
      c.wrist = Math.max(c.wrist, hand.wristBend / DEG);
      c.pen = Math.max(c.pen, arm.bodyPen);
      for (const b of actor.headSpheres) c.face = Math.min(c.face, hand.displayWrist.distanceTo(_v3.set(b.x, b.y, b.z)) - b.r);
    }
    if (c.hand && c.hand.actor === actor) c.leanAcc = Math.max(c.leanAcc, Math.abs(actor.leanAcc));
  },
  summary() {
    const bad = this.log.filter((c) => c.fails.length);
    return { moves: this.log.length, failing: bad.length, fails: bad.map((c) => `${c.label}: ${c.fails.join(', ')}`) };
  },
};

// ------------------------------------------------------------------ two-bone IK
// Reach is soft-limited: the arm eases toward (but never reaches) a locked-straight
// elbow, so there is always a little kink and no visible snap at full extension.
export const REACH_SOFT = 0.9, REACH_MAX = 0.972;
export function softReach(len, L, soft = REACH_SOFT, max = REACH_MAX) {
  const s = L * soft, m = L * max;
  return len <= s ? len : s + (m - s) * Math.tanh((len - s) / (m - s));
}
export function solveTwoBone(S, W, L1, L2, poleDir, outE, outW) {
  const d = _v1.subVectors(W, S);
  const len = d.length();
  const reach = clamp(len, Math.abs(L1 - L2) + 1e-3, L1 + L2 - 1e-4);
  d.multiplyScalar(1 / Math.max(len, 1e-6));
  const a = (L1 * L1 - L2 * L2 + reach * reach) / (2 * reach);
  const h = Math.sqrt(Math.max(L1 * L1 - a * a, 0));
  const perp = _v2.copy(poleDir).addScaledVector(d, -poleDir.dot(d));
  if (perp.lengthSq() < 1e-8) perp.set(0, -1, 0).addScaledVector(d, d.y);
  perp.normalize();
  outE.copy(S).addScaledVector(d, a).addScaledVector(perp, h);
  outW.copy(S).addScaledVector(d, reach);
  return len - reach; // > 0 means overstretched
}

// ------------------------------------------------------------------ arm (sleeve + cuff)
// points along the arm tested for collisions: [fraction (0..1 upper arm, 1..2 forearm), radius]
const ARM_SAMPLES = [[0.62, 0.042], [1.0, 0.048], [1.3, 0.044], [1.65, 0.04]];
class Arm {
  constructor(actor, side, mats, seed) {
    this.actor = actor;
    this.side = side; // 'left' | 'right' (anatomical)
    this.s = side === 'left' ? 1 : -1; // torso local +X is the body's left
    this.L1 = actor.armLen[0];
    this.L2 = actor.armLen[1];
    this.sleeve = new Sleeve(mats.sleeve, seed);
    actor.scene.add(this.sleeve.mesh);
    this.cuff = new THREE.Mesh(cuffGeometry(), mats.shirt);
    this.cuff.matrixAutoUpdate = false;
    actor.scene.add(this.cuff);
    this.S = new THREE.Vector3();
    this.E = new THREE.Vector3();
    this.W = new THREE.Vector3();
    this.foreQuat = new THREE.Quaternion();
    const pl = (actor.poles && actor.poles[side]) || actor.pole || [0.75, -0.45, -0.55];
    this.poleLocal = new THREE.Vector3(this.s * pl[0], pl[1], pl[2]).normalize();
    this.poleWeight = (actor.poleWeights && actor.poleWeights[side]) ?? 0.12; // how hard the elbow is pulled to its pole
    this.elbowFloor = (actor.elbowFloors && actor.elbowFloors[side]) ?? null; // the elbow never drops below this height
    // a target point pinned beside the shoulder that the elbow aims at: [out to his side,
    // up, forward] in metres, turning with his body but never with his hand
    const off = actor.poleOffsets && actor.poleOffsets[side];
    this.poleOffset = off ? new THREE.Vector3(off[0], off[1], off[2]) : null;
    this._po = new THREE.Vector3();
    this.shortfall = 0;
    this.elbowSpeed = 0;
    this.bodyPen = 0;
    this.pole = new THREE.Vector3();
    this.goal = new THREE.Vector3(); // ?ik: the wrist target asked of the arm this frame
    this.poleTarget = new THREE.Vector3(); // ?ik: the point the elbow is pulled toward
    this.protract = new Spring(0, 0.3);
    this.protractTarget = 0;
    // elbow direction (perpendicular to shoulder->wrist), smoothed in world space so it never pops
    this.swivel = new Spring(0, 0.11); // kept for diagnostics: angle of the elbow from its pole
    this.elbowDir = new THREE.Vector3();
    this._hasElbow = false;
    this._cand = new THREE.Vector3();
    this._best = new THREE.Vector3();
    this._prevDir = new THREE.Vector3();
    this._qPT = new THREE.Quaternion();
    this._prevE = new THREE.Vector3();
    this._tgt = new THREE.Vector3();
    this._u = new THREE.Vector3();
    this._w = new THREE.Vector3();
    this._p = new THREE.Vector3();
    this._dir = new THREE.Vector3();
  }
  // debug: cost terms for the current elbow and for one swung to the pole
  probe() {
    const L = this.L1 + this.L2, dir = this._dir.subVectors(this.W, this.S);
    const len = dir.length(); dir.normalize();
    const a = (this.L1 * this.L1 - this.L2 * this.L2 + len * len) / (2 * len);
    const h = Math.sqrt(Math.max(this.L1 * this.L1 - a * a, 0));
    const cur = this.elbowDir.clone();
    const pole = this.pole.clone().addScaledVector(dir, -this.pole.dot(dir)).normalize();
    const w = new THREE.Vector3().crossVectors(dir, cur);
    const ang = Math.atan2(pole.dot(w), pole.dot(cur));
    return { ext: len / L, penCur: this._penetration(dir, a, h, cur, w, 0), penPole: this._penetration(dir, a, h, cur, w, ang), poleAng: ang, dir: dir.toArray().map((x) => +x.toFixed(2)), pole: pole.toArray().map((x) => +x.toFixed(2)) };
  }
  // How far the elbow / forearm / upper arm sink into the body for a swivel angle.
  _penetration(dir, a, h, u, w, ang) {
    const body = this.actor.bodySpheres;
    const ca = Math.cos(ang), sa = Math.sin(ang);
    // elbow
    const ex = this.S.x + dir.x * a + h * (u.x * ca + w.x * sa);
    const ey = this.S.y + dir.y * a + h * (u.y * ca + w.y * sa);
    const ez = this.S.z + dir.z * a + h * (u.z * ca + w.z * sa);
    let pen = 0;
    // sample the upper arm (beyond the shoulder cap), the elbow and the forearm
    for (const [t, r] of ARM_SAMPLES) {
      let px, py, pz;
      if (t <= 1) { px = this.S.x + (ex - this.S.x) * t; py = this.S.y + (ey - this.S.y) * t; pz = this.S.z + (ez - this.S.z) * t; }
      else {
        const k = t - 1; // fraction along the forearm toward the wrist
        px = ex + (this.W.x - ex) * k; py = ey + (this.W.y - ey) * k; pz = ez + (this.W.z - ez) * k;
      }
      for (const b of body) {
        const dx = px - b.x, dy = py - b.y, dz = pz - b.z;
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        const o = b.r + r - d;
        if (o > 0) pen += o * o;
      }
      // the stone slab: an arm rests on it or passes outside its edge, never through it
      const tr = Math.hypot(px, pz) - TABLE_R, ty = Math.abs(py - (TABLE_Y - 0.02)) - 0.02;
      const dTab = tr > 0 && ty > 0 ? Math.hypot(tr, ty) : Math.max(tr, ty);
      const o = r * 0.9 - dTab;
      if (o > 0) pen += o * o;
    }
    return pen;
  }
  // shoulder joint in torso space; reaching protracts the shoulder blade forward
  shoulderLocal(out, protract = this.protract.x) {
    const a = this.actor;
    return out.set(SHOULDER_L.x * this.s - this.s * 0.012 * protract, SHOULDER_L.y + a.breath * 0.0045 + 0.012 * protract, SHOULDER_L.z + 0.07 * protract);
  }
  shoulder(out) {
    return this.shoulderLocal(out).applyMatrix4(this.actor.torsoMatrix);
  }
  solve(Wt, dt = 0) {
    this.shoulder(this.S);
    // the elbow's preferred direction: in the torso's frame (standing, braced), or in a
    // frame that only turns with the body's yaw (seated, leaning): there the elbow keeps
    // hanging toward the floor however far he leans, instead of riding up with the torso
    if (this.actor.poleFrame === 'yaw') this.pole.copy(this.poleLocal).applyAxisAngle(AXIS_Y, this.actor.yaw);
    else this.pole.copy(this.poleLocal).transformDirection(this.actor.torsoMatrix);
    const L = this.L1 + this.L2;
    const dir = this._dir.subVectors(Wt, this.S);
    const len = Math.max(dir.length(), 1e-6);
    dir.multiplyScalar(1 / len);
    const reach = Math.max(softReach(len, L, this.actor.reachSoft, this.actor.reachMax), Math.abs(this.L1 - this.L2) + 0.02);
    this.W.copy(this.S).addScaledVector(dir, reach);
    const a = (this.L1 * this.L1 - this.L2 * this.L2 + reach * reach) / (2 * reach);
    const h = Math.sqrt(Math.max(this.L1 * this.L1 - a * a, 0));
    if (this.poleOffset) {
      // aim the elbow at the pinned point: the pole runs from the arm's axis out to it
      const o = this.poleOffset, po = this._po.set(this.s * o.x, o.y, o.z);
      if (this.actor.poleFrame === 'yaw') po.applyAxisAngle(AXIS_Y, this.actor.yaw);
      else po.transformDirection(this.actor.torsoMatrix).multiplyScalar(o.length());
      this.poleTarget.copy(this.S).add(po);
      this.pole.copy(this.poleTarget).sub(this.S).addScaledVector(dir, -a).normalize();
    }
    // pole direction: where the elbow wants to point (out and down from the body)
    const pole = this._p.copy(this.pole).addScaledVector(dir, -this.pole.dot(dir));
    if (pole.lengthSq() < 1e-6) pole.set(0, -1, 0).addScaledVector(dir, dir.y);
    pole.normalize();
    this.goal.copy(Wt);
    if (!this.poleOffset) this.poleTarget.copy(this.S).addScaledVector(dir, a).addScaledVector(pole, 0.3);
    // current elbow direction carried along with the arm (parallel transport), so a big
    // change in reach direction rotates the elbow with it instead of re-projecting it
    const cur = this.elbowDir;
    if (!this._hasElbow) { cur.copy(pole); this._prevDir.copy(dir); this._hasElbow = true; }
    // a folded arm's elbow simply stays where it hangs; only an extended arm carries it round
    const extended = smoothstep(0.28, 0.55, len / L);
    this._qPT.setFromUnitVectors(this._prevDir, dir);
    if (extended < 1) this._qPT.slerp(_qIdent, 1 - extended);
    cur.applyQuaternion(this._qPT);
    this._prevDir.copy(dir);
    cur.addScaledVector(dir, -cur.dot(dir));
    if (cur.lengthSq() < 1e-6) cur.copy(pole);
    cur.normalize();
    if (dt > 0) {
      // candidates swing the elbow around the shoulder-wrist axis from where it is now
      const u = cur, w = this._w.crossVectors(dir, cur);
      const best = this._best.copy(cur);
      let bc = Infinity;
      for (let i = -16; i <= 16; i++) {
        const ang = i * 0.1;
        const c = this._cand.copy(u).multiplyScalar(Math.cos(ang)).addScaledVector(w, Math.sin(ang));
        const dev = Math.acos(clamp(c.dot(pole), -1, 1));
        // (elbows hang: one pointing up above the shoulder line costs extra)
        const up = Math.max(0, c.y - 0.1);
        // and the forearm lined up with the hand, so the wrist bends no more than it must
        let wristCost = 0;
        if (this.handY) {
          const ex = dir.x * a + h * c.x, ey = dir.y * a + h * c.y, ez = dir.z * a + h * c.z;
          const fx = this.W.x - this.S.x - ex, fy = this.W.y - this.S.y - ey, fz = this.W.z - this.S.z - ez;
          const al = 1 - (fx * this.handY.x + fy * this.handY.y + fz * this.handY.z) / Math.max(Math.hypot(fx, fy, fz), 1e-6);
          wristCost = al * al * 1.6;
        }
        // (and never below its floor, if it has one)
        let floorCost = 0;
        if (this.elbowFloor !== null) {
          const below = this.elbowFloor - (this.S.y + dir.y * a + h * c.y);
          if (below > 0) floorCost = below * below * 4000;
        }
        const cost = floorCost + this._penetration(dir, a, h, u, w, ang) * 4000 + dev * dev * (this.poleWeight + 0.5 * (1 - extended)) + ang * ang * 0.08 + up * up * 3.0 + wristCost;
        if (cost < bc) { bc = cost; best.copy(c); }
      }
      // ease toward it (time-based, never instantaneous) with a cap on angular speed
      this._prevE.copy(cur);
      cur.lerp(best, 1 - Math.exp(-dt / 0.16)).addScaledVector(dir, -cur.dot(dir)).normalize();
      const turn = Math.acos(clamp(cur.dot(this._prevE), -1, 1));
      const maxTurn = 3.2 * dt;
      // (turn at the capped speed toward the target: the target must be kept aside first,
      // or the elbow lerps to itself and freezes whenever it wants to move quickly)
      if (turn > maxTurn) {
        this._tgt.copy(cur);
        cur.copy(this._prevE).lerp(this._tgt, maxTurn / turn).addScaledVector(dir, -cur.dot(dir)).normalize();
      }
      this.swivel.x = Math.acos(clamp(cur.dot(pole), -1, 1));
      this.elbowSpeed = Math.min(turn, maxTurn) / dt;
      this.bodyPen = Math.sqrt(this._penetration(dir, a, h, cur, this._w.crossVectors(dir, cur), 0));
      this.shortfall = len - reach;
    }
    // a hard floor: swing the elbow (around the shoulder-wrist axis) the least it takes to
    // keep it from hanging below its floor, or as high as it goes if it can't
    if (this.elbowFloor !== null && h > 1e-4) {
      const need = (this.elbowFloor - this.S.y - dir.y * a) / h;
      if (cur.y < need) {
        const w = this._w.crossVectors(dir, cur);
        const R = Math.hypot(cur.y, w.y), top = Math.atan2(w.y, cur.y);
        const th = R * 1.0001 <= need ? top : top - Math.sign(top) * Math.acos(clamp(need / R, -1, 1));
        cur.multiplyScalar(Math.cos(th)).addScaledVector(w, Math.sin(th)).normalize();
      }
    }
    this.E.copy(this.S).addScaledVector(dir, a).addScaledVector(cur, h);
    return len - reach; // > 0 means the hand could not reach
  }
  forearmFrame(dorsal) {
    const y = _v3.subVectors(this.W, this.E).normalize();
    let z = _v2.copy(dorsal).addScaledVector(y, -dorsal.dot(y));
    if (z.lengthSq() < 1e-6) z = _v2.copy(this.pole).negate().addScaledVector(y, this.pole.dot(y));
    quatFromYZ(y, z, this.foreQuat);
    return this.foreQuat;
  }
  updateMeshes(bend = 0) {
    const refUp = _v1.set(0, 0, 1).applyQuaternion(this.foreQuat);
    // cuff: a centimetre up the forearm from the wrist joint; a bent wrist pushes it
    // further back, so the hand never cuts into its edge
    const push = 0.010 + 0.012 * smoothstep(0.5, 1.2, bend);
    // the sleeve grows out of the jacket's shoulder stump (turned with the arm, see
    // shoulderRotation) and ends ~2.5 cm short of the cuff's edge, its opening turned
    // and flattened to sit just around the cuff (the cuff is ~7 cm wide, ~5.4 cm deep)
    const endX = _v3.set(1, 0, 0).applyQuaternion(this.foreQuat);
    this.sleeve.build(this.S, this.E, this.W, refUp, { start: STUMP.sleeveStart, rShoulder: STUMP.r + 0.0015, endBack: push + 0.026, rWrist: 0.0368, endX, endFlat: 0.80 });
    _m1.compose(this.W, this.foreQuat, ONE);
    // the cuff's seam faces the outside of the wrist
    _q1.copy(this.foreQuat);
    if (this.actor.handOuterSign(this) < 0) _q1.multiply(_qFlip);
    _v2.set(0, -push, 0).applyMatrix4(_m1);
    this.cuff.matrix.compose(_v2, _q1, ONE);
    this.cuff.matrixWorldNeedsUpdate = true;
  }
  // The jacket's shoulder cap turns with the upper arm: the rotation (in torso space) from
  // the arm as the jacket was modelled (ARM_REST) to the arm now, as axis & angle.
  shoulderRotation(outRot, outS0, outS1) {
    const a = this.actor;
    const inv = _q2.copy(a.torsoQuat).invert();
    const u = _v1.subVectors(this.E, this.S).normalize().applyQuaternion(inv);
    const r = _v2.set(ARM_REST.x * this.s, ARM_REST.y, ARM_REST.z);
    _q1.setFromUnitVectors(r, u);
    const ang = 2 * Math.acos(clamp(_q1.w, -1, 1));
    const sh = Math.sqrt(Math.max(1 - _q1.w * _q1.w, 0));
    if (sh < 1e-6) outRot.set(1, 0, 0, 0);
    else outRot.set(_q1.x / sh, _q1.y / sh, _q1.z / sh, ang);
    // the joint where the jacket was modelled (the arm's part of it doesn't breathe; the
    // joint's own rise with each breath is in shoulderLocal)
    outS0.set(SHOULDER_L.x * this.s, SHOULDER_L.y, SHOULDER_L.z);
    this.shoulderLocal(outS1);
  }
}
const ONE = new THREE.Vector3(1, 1, 1);

// ------------------------------------------------------------------ hand controller
let _probe = {};
function probe(side) {
  if (!_probe[side]) _probe[side] = new HandRig(side, null);
  return _probe[side];
}
const tcpCache = new Map();
export function tcpLocal(side, pose) {
  const key = side + ':' + Array.from(pose).map((x) => x.toFixed(1)).join(',');
  let v = tcpCache.get(key);
  if (!v) {
    const r = probe(side);
    r.applyPose(pose, new THREE.Quaternion());
    const a = new THREE.Vector3(), b = new THREE.Vector3();
    r.padPoints(a, b);
    v = { tcp: a.clone().add(b).multiplyScalar(0.5), axis: a.clone().sub(b).normalize() };
    tcpCache.set(key, v);
  }
  return v;
}

// the hand's contact spheres in its own frame for a pose (planning where it meets the stone)
const ptsCache = new Map();
export function handPoints(side, pose) {
  const key = side + ':' + Array.from(pose).map((x) => x.toFixed(1)).join(',');
  let v = ptsCache.get(key);
  if (!v) {
    const r = probe(side);
    r.applyPose(pose, new THREE.Quaternion());
    r.group.updateMatrixWorld(true);
    const inv = new THREE.Matrix4().copy(r.group.matrixWorld).invert();
    v = CONTACT_POINTS.map((c) => {
      const p = c.p.clone();
      if (c.bone === B_PALM) p.x *= r.sign;
      return { p: p.applyMatrix4(r.bones[c.bone].matrixWorld).applyMatrix4(inv), r: c.r };
    });
    ptsCache.set(key, v);
  }
  return v;
}

// a point at fraction k (0..1) of arc length along a centripetal-ish Catmull-Rom path
const _c0 = new THREE.Vector3(), _c3 = new THREE.Vector3();
function pathPoint(path, k, out) {
  const { pts, cum } = path;
  const total = cum[cum.length - 1];
  const d = clamp(k, 0, 1) * total;
  let i = 0;
  while (i < pts.length - 2 && cum[i + 1] < d) i++;
  const span = Math.max(cum[i + 1] - cum[i], 1e-6);
  const t = clamp((d - cum[i]) / span, 0, 1);
  const p1 = pts[i], p2 = pts[i + 1];
  const p0 = i > 0 ? pts[i - 1] : _c0.copy(p1).multiplyScalar(2).sub(p2);
  const p3 = i + 2 < pts.length ? pts[i + 2] : _c3.copy(p2).multiplyScalar(2).sub(p1);
  const t2 = t * t, t3 = t2 * t;
  for (const ax of ['x', 'y', 'z']) {
    out[ax] = 0.5 * (2 * p1[ax] + (-p0[ax] + p2[ax]) * t + (2 * p0[ax] - 5 * p1[ax] + 4 * p2[ax] - p3[ax]) * t2 + (-p0[ax] + 3 * p1[ax] - 3 * p2[ax] + p3[ax]) * t3);
  }
  return out;
}

// the point at fraction k of a densely sampled path's true length
function densePoint(dense, k, out) {
  const { pts, cum } = dense;
  const d = clamp(k, 0, 1) * cum[cum.length - 1];
  let lo = 0, hi = cum.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (cum[m] < d) lo = m; else hi = m; }
  const t = (d - cum[lo]) / Math.max(cum[hi] - cum[lo], 1e-9);
  return out.lerpVectors(pts[lo], pts[hi], clamp(t, 0, 1));
}

export class HandController {
  constructor(actor, arm, side, skinMat) {
    this.actor = actor;
    this.arm = arm;
    this.side = side;
    this.rig = new HandRig(side, skinMat);
    actor.scene.add(this.rig.group);
    this.wrist = new THREE.Vector3();
    this.quat = new THREE.Quaternion();
    this.pose = new Float32Array(POSES.relaxed);
    this.basePose = new Float32Array(POSES.relaxed);
    this.fidget = new Float32Array(POSE_SIZE);
    this.seg = null;
    this.queue = [];
    this.held = [];
    this.planted = 1;
    this.plantTarget = 1;
    this.lift = 0;
    this.time = 0;
    this.seed = rand(0, 100);
    this.displayWrist = new THREE.Vector3();
    this.contactWorld = [];
    this.idle = null;
    this.idleT = 0;
    this.restWrist = new THREE.Vector3();
    this.restQuat = new THREE.Quaternion();
    this.restPose = POSES.relaxed;
    this.onTap = null;
    this._W = new THREE.Vector3();
    this.brace = false; // weight-bearing: locked to the stone, no tremor or fidget
    // a braced hand's fingers bend at the knuckle until each pad rests on the stone
    this.settle = new Float32Array(4);
    this.settleW = 0;
    this._dt = 0;
    this.wristBend = 0; // angle between forearm and hand (diagnostics, cuff)
    // body plan for the current move: lean & reach demand eased in step with the hand
    this.plan = { seg: null, lean0: 0, demand0: 0 };
  }

  setRest(wrist, quat, pose) {
    this.restWrist.copy(wrist);
    this.restQuat.copy(quat);
    this.restPose = pose;
  }
  snapToRest() {
    this.wrist.copy(this.restWrist);
    this.quat.copy(this.restQuat);
    this.basePose.set(this.restPose);
    this.planted = this.plantTarget = 1;
  }

  // world-space TCP for the given wrist/quat/pose
  tcpWorld(pose, out = new THREE.Vector3(), wrist = this.wrist, quat = this.quat) {
    return out.copy(tcpLocal(this.side, pose).tcp).applyQuaternion(quat).add(wrist);
  }
  wristForTcp(tcp, quat, pose, out = new THREE.Vector3()) {
    return out.copy(tcpLocal(this.side, pose).tcp).applyQuaternion(quat).negate().add(tcp);
  }

  /**
   * Queue a motion. Target given either as {wrist, quat} or {tcp, quat}.
   * pose: target finger pose; poseWin: [start,end] fraction of the move for the fingers.
   */
  moveTo(o) {
    return new Promise((resolve) => {
      this.queue.push({ ...o, resolve });
      if (!this.seg) this._next();
    });
  }
  _next() {
    const o = this.queue.shift();
    if (!o) { this.seg = null; return; }
    const pose = o.pose || this.basePose;
    const quat = o.quat ? o.quat.clone() : this.quat.clone();
    const to = o.tcp ? this.wristForTcp(o.tcp, quat, pose) : (o.wrist ? o.wrist.clone() : this.wrist.clone());
    const from = this.wrist.clone();
    // optional via points: one continuous motion through them (no stop at each)
    let path = null, dist = from.distanceTo(to);
    if (o.via && o.via.length) {
      const pts = [from, ...o.via.map((v) => v.clone()), to];
      const cum = [0];
      for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + pts[i].distanceTo(pts[i - 1]));
      path = { pts, cum };
      // the spline sampled densely and measured along its true length, so the hand moves at
      // the speed the timing asks for everywhere (timed by the chords between points, it
      // dawdled through tight turns and then shot away from them)
      const N = 160, dp = [], dc = [0];
      for (let i = 0; i <= N; i++) dp.push(pathPoint(path, i / N, new THREE.Vector3()));
      for (let i = 1; i <= N; i++) dc.push(dc[i - 1] + dp[i].distanceTo(dp[i - 1]));
      path.dense = { pts: dp, cum: dc };
      dist = dc[N];
    }
    const dur = o.dur ?? clamp(0.28 + dist * 1.25, 0.25, path ? 1.5 : 1.1) * (o.speed ?? 1);
    this.seg = {
      t: 0,
      dur,
      from,
      to,
      path,
      fromQ: this.quat.clone(),
      toQ: quat,
      // optional orientation held up to the first via point, turning only after it
      viaQ: o.viaQuat && path ? o.viaQuat.clone() : null,
      fromPose: new Float32Array(this.basePose),
      toPose: new Float32Array(pose),
      arc: o.arc ?? (path ? 0 : Math.min(0.04, dist * 0.3)),
      poseWin: o.poseWin ?? [0.15, 0.85],
      plant: o.plant ?? 0,
      ease: o.ease || minJerk, // progress along the path for a fraction of the time
      onUpdate: o.onUpdate,
      resolve: o.resolve,
      lateral: path ? 0 : (rand() - 0.5) * dist * 0.08,
    };
    this.plantTarget = this.seg.plant;
  }
  busy() {
    return !!this.seg || this.queue.length > 0;
  }
  finalTarget() {
    if (this.queue.length) {
      const o = this.queue[this.queue.length - 1];
      if (o.wrist) return o.wrist;
      if (o.tcp) return this.wristForTcp(o.tcp, o.quat || this.quat, o.pose || this.basePose, _v3.clone());
    }
    return this.seg ? this.seg.to : this.wrist;
  }

  // An orientation that grasps a match lying along `axis` from the given approach side.
  graspQuat(matchAxis, approachDir, pitch = 52 * DEG, pose = POSES.pinch) {
    const loc = tcpLocal(this.side, pose);
    const aL = loc.axis.clone();
    const fL = new THREE.Vector3(0, 1, 0).addScaledVector(aL, -aL.y).normalize();
    // world: pinch axis horizontal & perpendicular to the match
    const m = matchAxis.clone().setY(0).normalize();
    let fwd = m.clone();
    const ap = approachDir.clone().setY(0).normalize();
    if (fwd.dot(ap) < 0) fwd.negate();
    // allow the hand to come in partly along the natural reach direction
    fwd.lerp(ap, 0.55).normalize();
    const aW = new THREE.Vector3().crossVectors(UP, fwd).normalize();
    const build = (aw) => {
      const F = fwd.clone().multiplyScalar(Math.cos(pitch)).addScaledVector(UP, -Math.sin(pitch));
      const Fw = F.addScaledVector(aw, -F.dot(aw)).normalize();
      const L = new THREE.Matrix4().makeBasis(aL, fL, new THREE.Vector3().crossVectors(aL, fL));
      const W = new THREE.Matrix4().makeBasis(aw, Fw, new THREE.Vector3().crossVectors(aw, Fw));
      return new THREE.Quaternion().setFromRotationMatrix(W.multiply(L.transpose()));
    };
    let q = build(aW);
    // dorsum must face up
    if (new THREE.Vector3(0, 0, 1).applyQuaternion(q).y < 0) q = build(aW.negate());
    return q;
  }

  // attach a match to the pinch, easing it into the bundle
  grab(match, ease = 0.16) {
    const rel = this._relTransform(match);
    match.state = 'held';
    match.anim = null;
    const k = this.held.length;
    this.held.push({ m: match, relP: rel.p, relQ: rel.q, t: 0, k, ease });
  }
  _relTransform(match) {
    const inv = _q1.copy(this.quat).invert();
    const p = match.pos.clone().sub(this.displayWrist).applyQuaternion(inv);
    const q = inv.clone().multiply(match.quat);
    return { p, q };
  }
  // where the middle fingertip is now (world)
  fingertip(out) {
    return out.set(0, FINGERS[1].len[2], 0).applyMatrix4(this.rig.bones[FINGER_BONES[1][2]].matrixWorld);
  }
  // world transform of a held match
  heldWorld(h, outP, outQ) {
    outP.copy(h.relP).applyQuaternion(this.quat).add(this.displayWrist);
    outQ.copy(this.quat).multiply(h.relQ);
  }
  release(list = this.held.map((h) => h.m)) {
    const out = [];
    this.held = this.held.filter((h) => {
      if (list.includes(h.m)) { out.push(h.m); return false; }
      return true;
    });
    this.held.forEach((h, i) => (h.k = i));
    return out;
  }

  update(dt, time) {
    this.time += dt;
    const a = this.actor;
    // ---- motion segment
    let airborne = 0;
    if (this.seg) {
      const s = this.seg;
      s.t += dt;
      const tau = clamp(s.t / s.dur, 0, 1);
      const k = s.ease(tau);
      if (s.path) densePoint(s.path.dense, k, this.wrist);
      else this.wrist.lerpVectors(s.from, s.to, k);
      const bell = Math.sin(Math.PI * k);
      this.wrist.y += s.arc * bell;
      _v1.subVectors(s.to, s.from).setY(0);
      if (_v1.lengthSq() > 1e-8) {
        _v1.normalize();
        this.wrist.x += -_v1.z * s.lateral * bell;
        this.wrist.z += _v1.x * s.lateral * bell;
      }
      if (s.viaQ) {
        const kv = s.path.cum[1] / s.path.cum[s.path.cum.length - 1];
        if (k < kv) this.quat.slerpQuaternions(s.fromQ, s.viaQ, smoothstep(0, 1, k / Math.max(kv * 0.5, 1e-3)));
        else this.quat.slerpQuaternions(s.viaQ, s.toQ, smoothstep(0, 1, (k - kv) / Math.max(1 - kv, 1e-3)));
      } else this.quat.slerpQuaternions(s.fromQ, s.toQ, minJerk(clamp(tau * 1.18, 0, 1)));
      const pk = smoothstep(s.poseWin[0], s.poseWin[1], tau);
      lerpPose(s.fromPose, s.toPose, pk, this.basePose);
      airborne = bell;
      if (s.onUpdate) s.onUpdate(tau);
      if (tau >= 1) {
        const r = s.resolve;
        this.seg = null;
        this._next();
        r();
      }
    }
    // a hanging arm hangs from wherever the shoulder is (lean in, and it swings along)
    if (this.hang && !this.seg && this.arm.S.lengthSq() > 0) {
      const S = this.arm.S, y = a.yaw, h = this.hang, o = h.out * this.arm.s;
      _v1.set(S.x + Math.cos(y) * o + Math.sin(y) * h.fwd, S.y - h.down, S.z - Math.sin(y) * o + Math.cos(y) * h.fwd);
      this.wrist.lerp(_v1, 1 - Math.exp(-dt / 0.25));
    }
    this.planted += (this.plantTarget - this.planted) * Math.min(1, dt * 6);

    // ---- idle life
    const tn = this.time + this.seed;
    this.fidget.fill(0);
    const fid = this.brace && !this.seg ? 0.15 : 1;
    for (let f = 0; f < 4; f++) {
      const n = fnoise(tn * 0.23 + f * 3.1, 2) * fid;
      this.fidget[f * 4] = n * 3.2;
      this.fidget[f * 4 + 1] = n * 2.6 + noise1(tn * 0.7 + f) * 0.8 * fid;
      this.fidget[f * 4 + 2] = n * 1.5;
    }
    this.fidget[16] = fnoise(tn * 0.19 + 9, 2) * 3 * fid;
    this.fidget[19] = fnoise(tn * 0.21 + 4, 2) * 3 * fid;
    if (this.idle && !this.seg) this.idle(dt, this.fidget);
    for (let i = 0; i < POSE_SIZE; i++) this.pose[i] = this.basePose[i] + this.fidget[i];
    if (this.settleW > 1e-3) {
      for (let f = 0; f < 4; f++) {
        this.pose[f * 4] += this.settle[f] * this.settleW * 0.7;
        this.pose[f * 4 + 1] += this.settle[f] * this.settleW * 0.3;
      }
    }

    // ---- tremor & breathing coupling
    const trem = this.brace && !this.seg ? 0 : 0.00035 * (0.25 + airborne) * (1 - this.planted * 0.85);
    this._dt = dt;
    const W = this._W.copy(this.wrist);
    W.x += noise1(tn * 2.1) * trem;
    W.y += noise1(tn * 2.3 + 7) * trem + this.planted * -0.004; // planted hands press into contact
    W.z += noise1(tn * 1.9 + 3) * trem;

    // ---- the hand keeps clear of its own owner's face
    const sp = a.headSpheres;
    if (sp && sp.length) {
      for (const b of sp) {
        const dx = W.x - b.x, dy = W.y - b.y, dz = W.z - b.z;
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz), min = b.r + 0.05;
        if (d < min && d > 1e-5) { const s = min / d; W.x = b.x + dx * s; W.y = b.y + dy * s; W.z = b.z + dz * s; }
      }
    }
    this._pose(W);
    // ---- table contact (never penetrate; planted hands settle onto it)
    const pen = this._penetration();
    if (pen > 0) {
      W.y += pen;
      this._pose(W, true);
    }
    this.displayWrist.copy(this.arm.W);
    this.lift = pen;
    if (this.brace) {
      this.settleW += ((this.seg ? 0 : this.planted) - this.settleW) * Math.min(1, dt * 4);
      this._settleFingers();
    }
    if (this.lapRest && this.rig.mesh) {
      const below = this.displayWrist.y < TABLE_Y - 0.04;
      if (below !== this._below) {
        this._below = below;
        this.rig.mesh.layers.set(below ? L_MAIN_ONLY : 0);
      }
    }

    // ---- held matches follow the pinch
    for (const h of this.held) {
      h.t = Math.min(1, h.t + dt / (h.ease || 0.16));
      const slot = this._bundleSlot(h.k, this.held.length);
      const e = smoothstep(0, 1, h.t);
      h.relP.lerp(slot.p, e * 0.35 + (h.t >= 1 ? 1 : 0) * 0.65);
      h.relQ.slerp(slot.q, e * 0.35 + (h.t >= 1 ? 1 : 0) * 0.65);
      this.heldWorld(h, h.m.pos, h.m.quat);
    }
    // how far the wrist is bent (forearm axis vs the hand's long axis)
    _v1.set(0, 1, 0).applyQuaternion(this.arm.foreQuat);
    _v2.set(0, 1, 0).applyQuaternion(this.quat);
    this.wristBend = Math.acos(clamp(_v1.dot(_v2), -1, 1));
    this.arm.updateMeshes(this.wristBend);
    if (DIAG.on) DIAG.sample(this, this.arm, a, dt);
  }

  _bundleSlot(k, n) {
    const loc = tcpLocal(this.side, n > 1 ? POSES.holdWide : POSES.hold);
    const first = this.held[0];
    const q = first ? first.relQ.clone() : new THREE.Quaternion();
    // stack across the pinch axis, second layer slightly back
    const layer = Math.floor(k / 3);
    const idx = k % 3;
    const cnt = Math.min(3, n - layer * 3);
    const across = (idx - (cnt - 1) / 2) * 0.0024;
    const p = loc.tcp.clone().addScaledVector(loc.axis, across);
    p.addScaledVector(new THREE.Vector3(0, 0, 1), -0.0018 * layer);
    p.addScaledVector(new THREE.Vector3(0, 1, 0), 0.0012 * layer);
    return { p, q };
  }

  _pose(W, second = false) {
    const arm = this.arm;
    arm.handY = (arm._hy || (arm._hy = new THREE.Vector3())).set(0, 1, 0).applyQuaternion(this.quat);
    arm.solve(W, second ? 0 : this._dt);
    const D = _v2.set(0, 0, 1).applyQuaternion(this.quat);
    const fq = arm.forearmFrame(D);
    const g = this.rig.group;
    g.position.copy(arm.W);
    g.quaternion.copy(fq);
    _q2.copy(fq).invert().multiply(this.quat);
    this.rig.applyPose(this.pose, _q2);
    g.updateMatrixWorld(true);
  }

  // Each finger's lowest point (pad or tip) against the stone; bend its knuckle a little
  // toward closing the gap. Integrated frame to frame, it settles with every pad resting
  // just above the contact limit, so it never lifts the hand.
  _settleFingers() {
    const B = this.rig.bones;
    for (let f = 0; f < 4; f++) {
      const F = FINGERS[f], ids = FINGER_BONES[f];
      let gap = Infinity;
      for (const [k, t, r] of [[1, 1.0, F.rad[2]], [2, 0.5, (F.rad[2] + F.rad[3]) * 0.5], [2, 1.0, F.rad[3]]]) {
        _v1.set(0, F.len[k] * t, 0).applyMatrix4(B[ids[k]].matrixWorld);
        gap = Math.min(gap, _v1.y - r * 0.96 - TABLE_Y);
      }
      _v2.setFromMatrixPosition(B[ids[0]].matrixWorld);
      const L = Math.max(0.03, _v1.distanceTo(_v2));
      this.settle[f] = clamp(this.settle[f] + (clamp(gap / L, -0.15, 0.15) / DEG) * 0.5, -10, 28);
    }
  }

  _penetration() {
    let worst = 0;
    const B = this.rig.bones;
    const s = this.rig.sign;
    this.contactWorld.length = 0;
    for (const c of CONTACT_POINTS) {
      _v1.copy(c.p);
      if (c.bone === B_PALM) _v1.x *= s;
      _v1.applyMatrix4(B[c.bone].matrixWorld);
      this.contactWorld.push({ x: _v1.x, y: _v1.y, z: _v1.z, r: c.r });
      if (_v1.x * _v1.x + _v1.z * _v1.z > (TABLE_R + 0.01) ** 2) continue;
      const d = TABLE_Y + c.r * 0.92 - _v1.y;
      if (d > 0.08) continue; // well below the stone: under it (a hanging hand), not in it
      if (d > worst) worst = d;
    }
    return worst;
  }

  // a few spheres for the table's contact occlusion
  occluders(out) {
    const B = this.rig.bones;
    const pts = [
      [FINGER_BONES[0][2], 0.02, 0.008], [FINGER_BONES[1][2], 0.02, 0.008], [FINGER_BONES[2][2], 0.02, 0.0078],
      [FINGER_BONES[3][2], 0.018, 0.007], [THUMB_BONES[2], 0.026, 0.009],
    ];
    for (const [b, y, r] of pts) {
      _v1.set(0, y, 0).applyMatrix4(B[b].matrixWorld);
      out.push([_v1.x, _v1.y, _v1.z, _v1.x, _v1.y, _v1.z, r * 1.2, 1.0]);
    }
    _v1.set(0, 0.05, -0.012 * 0).applyMatrix4(B[B_PALM].matrixWorld);
    out.push([_v1.x, _v1.y, _v1.z, _v1.x, _v1.y, _v1.z, 0.03, 0.9]);
  }
}

// ------------------------------------------------------------------ actor (body + head + arms)
export class Actor {
  constructor(scene, cfg, mats) {
    this.scene = scene;
    this.name = cfg.name;
    this.hip = cfg.hip.clone();
    this.yaw = cfg.yaw;
    this.baseLean = cfg.lean;
    this.armLen = cfg.armLen || [0.305, 0.275];
    this.pole = cfg.pole || null;
    this.poles = cfg.poles || null; // per arm, overriding pole
    this.poleWeights = cfg.poleWeights || null; // per arm, how hard the elbow follows it
    this.elbowFloors = cfg.elbowFloors || null; // per arm, the lowest the elbow may hang
    this.poleOffsets = cfg.poleOffsets || null; // per arm, a point beside the shoulder the elbow aims at
    this.lean = new Spring(cfg.lean, 0.16);
    this.leanAcc = 0;
    this._leanV = 0;
    this.poleFrame = cfg.poleFrame || 'torso';
    this.twist = new Spring(0, 0.4);
    this.roll = new Spring(0, 0.6);
    this.breath = 0;
    this.breathPhase = rand(0, 6);
    this.breathRate = cfg.breathRate || 0.24;
    this.breathDepth = 1;
    this.sigh = 0;
    this.torsoMatrix = new THREE.Matrix4();
    this.torsoQuat = new THREE.Quaternion();
    this.headYaw = new Spring(0, 0.32);
    this.headPitch = new Spring(0, 0.32);
    this.lookTarget = new THREE.Vector3(0, TABLE_Y, 0);
    this.lookWeight = cfg.lookWeight ?? 0.7;
    this.seed = rand(0, 50);
    this.time = 0;
    this.extraLean = 0;
    this.maxExtraLean = cfg.maxExtraLean ?? 0.45;
    this.twistGain = cfg.twistGain ?? 0.34;
    // how far the arm straightens before the body leans in (fractions of the arm's length)
    this.reachSoft = cfg.reachSoft ?? REACH_SOFT;
    this.reachMax = cfg.reachMax ?? REACH_MAX;
    this.reachSlide = cfg.reachSlide ?? 0;
    // posture: 0 = the authored stance, 1 = bent low over the board (hips down, deeper lean)
    this.postureBase = cfg.posture ?? 0;
    this.posture = new Spring(cfg.posture ?? 0, 1.1);
    this.postureTarget = cfg.posture ?? 0;
    this.crouch = cfg.crouch || { drop: 0, fwd: 0, lean: 0 };
    // volumes the arms keep out of, fitted to the jacket and head (torso / head space)
    this._sphDef = [
      ['t', -0.068, 0.35, 0.004, 0.105], ['t', 0.068, 0.35, 0.004, 0.105], // chest
      ['t', 0, 0.17, 0.0, 0.105],                                          // belly
      ['t', 0, 0.47, -0.016, 0.092],                                       // upper chest & shoulder line
      ['t', 0, 0.62, -0.014, 0.058],                                     // neck
      ['h', 0, 0.09, 0.012, 0.098],                                      // skull
      ['h', 0, 0.025, 0.055, 0.058],                                     // jaw & chin
      ['h', 0, 0.07, 0.085, 0.05],                                       // nose & mouth
    ];
    this._sph = this._sphDef.map(() => ({ x: 0, y: 0, z: 0, r: 0 }));
    this.bodySpheres = this._sph;
    this.headSpheres = [this._sph[5], this._sph[7]];

    this.clothMat = mats.jacket;
    this.torso = new THREE.Mesh(torsoGeometry(), mats.jacket);
    this.torso.matrixAutoUpdate = false;
    this.torso.frustumCulled = false;
    // the seated player sits outside the lamp's pool: his body needs no shadow pass
    const bodyLayer = cfg.castsBody === false ? L_MAIN_ONLY : cfg.mirrorBody ? L_NO_SHADOW : L_NO_MIRROR;
    this.torso.layers.set(bodyLayer);
    scene.add(this.torso);
    this.headMat = mats.head;
    this.head = new THREE.Mesh(headGeometry(cfg.headCell), mats.head);
    this.head.frustumCulled = false;
    this.head.matrixAutoUpdate = false;
    this.head.layers.set(bodyLayer);
    scene.add(this.head);
    this.collar = new THREE.Mesh(collarGeometry(), mats.shirt);
    this.collar.matrixAutoUpdate = false;
    this.collar.layers.set(cfg.mirrorBody ? L_NO_SHADOW : L_NO_MIRROR);
    scene.add(this.collar);
    // trouser legs: two-bone IK from the (moving) hips to feet planted on the floor
    this.seated = !!cfg.seated;
    this.legs = [-1, 1].map((s) => {
      const tube = new Sleeve(mats.sleeve, s > 0 ? 11 : 13);
      tube.mesh.layers.set(L_MAIN_ONLY);
      scene.add(tube.mesh);
      const f = new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw));
      const left = new THREE.Vector3(0, 1, 0).cross(f);
      const ankle = this.hip.clone().addScaledVector(left, s * 0.105).addScaledVector(f, this.seated ? 0.46 : 0.03);
      ankle.y = 0.085;
      return { s, tube, ankle, H: new THREE.Vector3(), K: new THREE.Vector3(), A: new THREE.Vector3(), f, left };
    });

    this.arms = {};
    this.hands = {};
    for (const side of ['left', 'right']) {
      const arm = new Arm(this, side, mats, side === 'left' ? 3 : 7);
      this.arms[side] = arm;
      if (cfg.hands.includes(side)) this.hands[side] = new HandController(this, arm, side, mats.skin);
    }
    this.restArm = cfg.restArm || null; // for an arm without a hand
    this.neckMat = new THREE.Matrix4();
    this.headWorld = new THREE.Matrix4();
  }

  handOuterSign(arm) {
    // the cuff's seam sits on the thumb side
    return arm.side === 'left' ? 1 : -1;
  }

  computeTorso(lean, twist, roll, out = this.torsoMatrix) {
    // yaw (whole body) -> lean (hips) -> twist about the leaning spine -> roll
    const q = this.torsoQuat;
    q.setFromAxisAngle(AXIS_Y, this.yaw);
    q.multiply(_qT.setFromAxisAngle(AXIS_X, lean));
    q.multiply(_qT.setFromAxisAngle(AXIS_Y, twist));
    q.multiply(_qT.setFromAxisAngle(AXIS_Z, roll));
    const hip = _v1.copy(this.hip);
    const pk = this.posture.x;
    if (this.reachSlide) {
      // a seated reach slides forward on the chair as the lean runs out
      const over = clamp((lean - this.baseLean - this.maxExtraLean * 0.45) / (this.maxExtraLean * 0.55), 0, 1);
      hip.x += Math.sin(this.yaw) * this.reachSlide * over;
      hip.z += Math.cos(this.yaw) * this.reachSlide * over;
    }
    hip.y -= this.crouch.drop * pk;
    _v2.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    hip.addScaledVector(_v2, this.crouch.fwd * pk);
    hip.x += fnoise(this.time * 0.05 + this.seed, 2) * 0.006;
    hip.z += fnoise(this.time * 0.04 + this.seed + 5, 2) * 0.004;
    return out.compose(hip, this.torsoQuat, ONE);
  }

  // smallest lean that lets `arm` reach the wrist target (with protraction & twist)
  // (continuous: bisection on the shoulder-to-target distance, so it never steps)
  requiredLean(arm, Wt, twist, protract, minLean = this.baseLean) {
    const reach = (arm.L1 + arm.L2) * (this.reachSoft - 0.01);
    const tmp = this._tmpM || (this._tmpM = new THREE.Matrix4());
    const S = this._tmpS || (this._tmpS = new THREE.Vector3());
    const over = (l) => {
      this.computeTorso(l, twist, 0, tmp);
      arm.shoulderLocal(S, protract).applyMatrix4(tmp);
      return S.distanceTo(Wt) - reach;
    };
    const max = minLean + this.maxExtraLean;
    if (over(minLean) <= 0) return minLean;
    if (over(max) > 0) return max;
    let lo = minLean, hi = max;
    for (let i = 0; i < 14; i++) {
      const mid = (lo + hi) * 0.5;
      if (over(mid) > 0) lo = mid; else hi = mid;
    }
    return hi;
  }

  update(dt, time) {
    this.time += dt;
    const t = this.time;
    // ---- breathing: irregular rate, inhale quicker than exhale, the odd sigh
    const rate = this.breathRate * (1 + 0.12 * fnoise(t * 0.05 + this.seed, 2));
    this.breathPhase += dt * rate * Math.PI * 2;
    const ph = this.breathPhase;
    const shaped = 0.5 - 0.5 * Math.cos(ph + 0.35 * Math.sin(ph));
    this.sigh = Math.max(0, this.sigh - dt * 0.35);
    this.breath = shaped * this.breathDepth * (1 + this.sigh * 1.6);
    this.clothMat.uniforms.uBreath.value = this.breath;

    // ---- posture
    this.posture.update(this.postureTarget, dt);
    const base = this.baseLean + this.crouch.lean * this.posture.x;

    // ---- reaching: shoulder protraction first, then torso twist, then lean.
    // Each move carries a body plan: the lean and reach demand it needs at its end,
    // eased from where the body was when it started, in step with the hand (the body
    // leads a touch). No snapping to catch the hand: the plan is smooth by construction.
    let lean = base + this.extraLean - this.breath * 0.006;
    let twist = fnoise(t * 0.03 + this.seed, 2) * 0.02;
    for (const side in this.hands) {
      const h = this.hands[side];
      if (h.hang && !h.seg) continue; // a hanging arm asks nothing of the body
      const arm = h.arm;
      const target = h.finalTarget();
      const S = arm.S;
      const far = Math.hypot(target.x - S.x, target.z - S.z);
      const demandEnd = smoothstep(0.30, 0.62, far) * (1 - h.plantTarget * 0.6);
      const twEnd = -arm.s * this.twistGain * demandEnd;
      const leanEnd = this.requiredLean(arm, target, twEnd, demandEnd, base);
      const pl = h.plan;
      let k = 1;
      if (h.seg) {
        if (pl.seg !== h.seg) { pl.seg = h.seg; pl.lean0 = Math.max(this.lean.x, base); pl.demand0 = arm.protractTarget; }
        k = minJerk(clamp((h.seg.t / h.seg.dur) * 1.12 + 0.02, 0, 1));
      } else pl.seg = null;
      const demand = h.seg ? lerp(pl.demand0, demandEnd, k) : demandEnd;
      arm.protractTarget = demand;
      twist += -arm.s * this.twistGain * demand;
      const leanPlan = h.seg ? lerp(pl.lean0, leanEnd, k) : leanEnd;
      // never less than what the hand needs right where it is now (smooth: the hand moves smoothly)
      // (with a little slack: the soft reach limit absorbs a centimetre or two)
      const leanHere = this.requiredLean(arm, h.wrist, this.twist.x, arm.protract.x, base) - 0.025;
      lean = Math.max(lean, leanPlan, leanHere);
    }
    for (const side in this.arms) {
      const arm = this.arms[side];
      arm.protract.update(arm.protractTarget, dt, 0.14);
    }
    const v0 = this.lean.v;
    this.lean.update(lean, dt);
    this.leanAcc = dt > 0 ? (this.lean.v - v0) / dt : 0;
    this.twist.update(twist, dt, 0.22);
    this.roll.update(fnoise(t * 0.04 + this.seed + 2, 2) * 0.015 - this.twist.x * 0.15, dt);
    this.computeTorso(this.lean.x, this.twist.x, this.roll.x);
    this.torso.matrix.copy(this.torsoMatrix);
    this.torso.matrixWorldNeedsUpdate = true;

    // ---- collar & head
    _v1.set(0, 0.600 + this.breath * 0.004, -0.028).applyMatrix4(this.torsoMatrix);
    this.collar.matrix.compose(_v1, this.torsoQuat, ONE);
    this.collar.matrixWorldNeedsUpdate = true;

    _v1.set(NECK_PIVOT.x, NECK_PIVOT.y + this.breath * 0.004, NECK_PIVOT.z).applyMatrix4(this.torsoMatrix);
    // neck leans back a little against the torso lean so the face stays toward the table
    _q1.setFromAxisAngle(new THREE.Vector3(1, 0, 0), -this.lean.x * 0.35);
    _q2.copy(this.torsoQuat).multiply(_q1);
    this.neckMat.compose(_v1, _q2, ONE);
    const inv = _m1.copy(this.neckMat).invert();
    const d = _v2.copy(this.lookTarget).applyMatrix4(inv);
    let yaw = Math.atan2(d.x, d.z);
    let pitch = Math.atan2(-d.y, Math.hypot(d.x, d.z));
    yaw = clamp(yaw * this.lookWeight, -0.9, 0.9);
    pitch = clamp(pitch * this.lookWeight + 0.08, -0.4, 0.75);
    yaw += fnoise(t * 0.17 + this.seed, 3) * 0.018;
    pitch += fnoise(t * 0.15 + this.seed + 9, 3) * 0.014 + (this.breath - 0.5) * 0.012;
    this.headYaw.update(yaw, dt);
    this.headPitch.update(pitch, dt);
    const hq = new THREE.Quaternion().setFromEuler(new THREE.Euler(this.headPitch.x, this.headYaw.x, fnoise(t * 0.08 + this.seed, 2) * 0.03, 'YXZ'));
    this.headWorld.compose(_v1, _q2.clone().multiply(hq), ONE);
    this.headMat.uniforms.uNeckMat.value.copy(this.neckMat);
    this.headMat.uniforms.uHeadMat.value.copy(this.headWorld);

    // ---- volumes the arms must stay out of: chest, upper chest, neck, head
    const sp = this._sph;
    this._sphDef.forEach(([space, x, y, z, r], i) => {
      _v3.set(x, y, z).applyMatrix4(space === 't' ? this.torsoMatrix : this.headWorld);
      sp[i].x = _v3.x; sp[i].y = _v3.y; sp[i].z = _v3.z; sp[i].r = r;
    });

    // ---- legs follow the hips; knees bend forward, feet stay put
    const hipNow = _v3.setFromMatrixPosition(this.torsoMatrix);
    for (const leg of this.legs) {
      leg.H.copy(hipNow).addScaledVector(leg.left, leg.s * 0.088);
      leg.H.y -= 0.03;
      const pole = _v2.copy(leg.f).multiplyScalar(1).add(_v1.set(0, this.seated ? 0.6 : 0.15, 0)).normalize();
      solveTwoBone(leg.H, leg.ankle, 0.455, 0.445, pole, leg.K, leg.A);
      (leg.poleTarget || (leg.poleTarget = new THREE.Vector3())).copy(leg.H).lerp(leg.ankle, 0.5).addScaledVector(pole, 0.3);
      leg.tube.build(leg.H, leg.K, leg.A, leg.f, { rShoulder: 0.078, rElbow: 0.058, rWrist: 0.047, endBack: -0.02 });
    }

    // ---- arms & hands
    for (const side of ['left', 'right']) {
      const h = this.hands[side];
      if (h) h.update(dt, time);
      else {
        const arm = this.arms[side];
        const W = this._restW || (this._restW = new THREE.Vector3());
        W.copy(this.restArm.wrist).applyMatrix4(this.torsoMatrix);
        arm.solve(W, dt);
        arm.forearmFrame(_v2.set(0, 1, 0));
        arm.updateMeshes();
      }
    }
    // ---- the jacket's shoulders follow the upper arms
    const U = this.clothMat.uniforms;
    this.arms.left.shoulderRotation(U.uShRot.value[0], U.uShS0.value[0], U.uShS1.value[0]);
    this.arms.right.shoulderRotation(U.uShRot.value[1], U.uShS0.value[1], U.uShS1.value[1]);
  }

  headPosition(out = new THREE.Vector3()) {
    return out.set(0, 0.1, 0.02).applyMatrix4(this.headWorld);
  }
}
