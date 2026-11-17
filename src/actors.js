// Bodies, arms and hands: everything that moves procedurally.
import * as THREE from 'three';
import { HandRig, POSES, CONTACT_POINTS, lerpPose, POSE_SIZE, B_PALM, FINGER_BONES, THUMB_BONES } from './handModel.js';
import { Sleeve, torsoGeometry, headGeometry, collarGeometry, cuffGeometry, cufflinkGeometry, legsGeometry, SHOULDER_L, NECK_PIVOT } from './bodyModel.js';
import { clamp, lerp, smoothstep, minJerk, noise1, fnoise, Spring, DEG, quatFromYZ, rand } from './util.js';
import { TABLE_Y, TABLE_R, L_NO_MIRROR, L_MAIN_ONLY } from './world.js';

const UP = new THREE.Vector3(0, 1, 0);
const AXIS_X = new THREE.Vector3(1, 0, 0), AXIS_Y = new THREE.Vector3(0, 1, 0), AXIS_Z = new THREE.Vector3(0, 0, 1);
const _qT = new THREE.Quaternion();
const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3();
const _q1 = new THREE.Quaternion(), _q2 = new THREE.Quaternion();
const _m1 = new THREE.Matrix4();

// ------------------------------------------------------------------ two-bone IK
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
    this.link = new THREE.Mesh(cufflinkGeometry(), mats.metal);
    this.link.matrixAutoUpdate = false;
    actor.scene.add(this.link);
    this.S = new THREE.Vector3();
    this.E = new THREE.Vector3();
    this.W = new THREE.Vector3();
    this.foreQuat = new THREE.Quaternion();
    const pl = actor.pole || [0.75, -0.45, -0.55];
    this.poleLocal = new THREE.Vector3(this.s * pl[0], pl[1], pl[2]).normalize();
    this.pole = new THREE.Vector3();
    this.protract = new Spring(0, 0.3);
    this.protractTarget = 0;
  }
  // shoulder joint in torso space; reaching protracts the shoulder blade forward
  shoulderLocal(out, protract = this.protract.x) {
    const a = this.actor;
    return out.set(SHOULDER_L.x * this.s - this.s * 0.012 * protract, SHOULDER_L.y + a.breath * 0.0045 + 0.012 * protract, SHOULDER_L.z + 0.07 * protract);
  }
  shoulder(out) {
    return this.shoulderLocal(out).applyMatrix4(this.actor.torsoMatrix);
  }
  solve(Wt) {
    this.shoulder(this.S);
    this.pole.copy(this.poleLocal).transformDirection(this.actor.torsoMatrix);
    return solveTwoBone(this.S, Wt, this.L1, this.L2, this.pole, this.E, this.W);
  }
  forearmFrame(dorsal) {
    const y = _v3.subVectors(this.W, this.E).normalize();
    let z = _v2.copy(dorsal).addScaledVector(y, -dorsal.dot(y));
    if (z.lengthSq() < 1e-6) z = _v2.copy(this.pole).negate().addScaledVector(y, this.pole.dot(y));
    quatFromYZ(y, z, this.foreQuat);
    return this.foreQuat;
  }
  updateMeshes() {
    const refUp = _v1.set(0, 0, 1).applyQuaternion(this.foreQuat);
    this.sleeve.build(this.S, this.E, this.W, refUp, { endBack: 0.034 });
    // cuff sits just behind the wrist joint, a cufflink on the outer side
    _m1.compose(this.W, this.foreQuat, ONE);
    _v2.set(0, -0.0035, 0).applyMatrix4(_m1);
    this.cuff.matrix.compose(_v2, this.foreQuat, ONE);
    this.cuff.matrixWorldNeedsUpdate = true;
    const outward = this.actor.handOuterSign(this);
    _v2.set(outward * 0.0312, -0.025, 0.0).applyMatrix4(_m1);
    this.link.matrix.compose(_v2, this.foreQuat, ONE);
    this.link.matrixWorldNeedsUpdate = true;
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
    const dist = from.distanceTo(to);
    const dur = o.dur ?? clamp(0.28 + dist * 1.25, 0.25, 1.1) * (o.speed ?? 1);
    this.seg = {
      t: 0,
      dur,
      from,
      to,
      fromQ: this.quat.clone(),
      toQ: quat,
      fromPose: new Float32Array(this.basePose),
      toPose: new Float32Array(pose),
      arc: o.arc ?? Math.min(0.06, dist * 0.35),
      poseWin: o.poseWin ?? [0.15, 0.85],
      plant: o.plant ?? 0,
      onUpdate: o.onUpdate,
      resolve: o.resolve,
      lateral: (rand() - 0.5) * dist * 0.08,
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
    fwd.lerp(ap, 0.35).normalize();
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
      const k = minJerk(tau);
      this.wrist.lerpVectors(s.from, s.to, k);
      const bell = Math.sin(Math.PI * k);
      this.wrist.y += s.arc * bell;
      _v1.subVectors(s.to, s.from).setY(0);
      if (_v1.lengthSq() > 1e-8) {
        _v1.normalize();
        this.wrist.x += -_v1.z * s.lateral * bell;
        this.wrist.z += _v1.x * s.lateral * bell;
      }
      this.quat.slerpQuaternions(s.fromQ, s.toQ, minJerk(clamp(tau * 1.18, 0, 1)));
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
    this.planted += (this.plantTarget - this.planted) * Math.min(1, dt * 6);

    // ---- idle life
    const tn = this.time + this.seed;
    this.fidget.fill(0);
    for (let f = 0; f < 4; f++) {
      const n = fnoise(tn * 0.23 + f * 3.1, 2);
      this.fidget[f * 4] = n * 3.2;
      this.fidget[f * 4 + 1] = n * 2.6 + noise1(tn * 0.7 + f) * 0.8;
      this.fidget[f * 4 + 2] = n * 1.5;
    }
    this.fidget[16] = fnoise(tn * 0.19 + 9, 2) * 3;
    this.fidget[19] = fnoise(tn * 0.21 + 4, 2) * 3;
    if (this.idle && !this.seg) this.idle(dt, this.fidget);
    for (let i = 0; i < POSE_SIZE; i++) this.pose[i] = this.basePose[i] + this.fidget[i];

    // ---- tremor & breathing coupling
    const trem = 0.00035 * (0.25 + airborne) * (1 - this.planted * 0.85);
    const W = this._W.copy(this.wrist);
    W.x += noise1(tn * 2.1) * trem;
    W.y += noise1(tn * 2.3 + 7) * trem + this.planted * -0.004; // planted hands press into contact
    W.z += noise1(tn * 1.9 + 3) * trem;

    this._pose(W);
    // ---- table contact (never penetrate; planted hands settle onto it)
    const pen = this._penetration();
    if (pen > 0) {
      W.y += pen;
      this._pose(W);
    }
    this.displayWrist.copy(this.arm.W);
    this.lift = pen;

    // ---- held matches follow the pinch
    for (const h of this.held) {
      h.t = Math.min(1, h.t + dt / (h.ease || 0.16));
      const slot = this._bundleSlot(h.k, this.held.length);
      const e = smoothstep(0, 1, h.t);
      h.relP.lerp(slot.p, e * 0.35 + (h.t >= 1 ? 1 : 0) * 0.65);
      h.relQ.slerp(slot.q, e * 0.35 + (h.t >= 1 ? 1 : 0) * 0.65);
      this.heldWorld(h, h.m.pos, h.m.quat);
    }
    this.arm.updateMeshes();
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

  _pose(W) {
    const arm = this.arm;
    arm.solve(W);
    const D = _v2.set(0, 0, 1).applyQuaternion(this.quat);
    const fq = arm.forearmFrame(D);
    const g = this.rig.group;
    g.position.copy(arm.W);
    g.quaternion.copy(fq);
    _q2.copy(fq).invert().multiply(this.quat);
    this.rig.applyPose(this.pose, _q2);
    g.updateMatrixWorld(true);
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
    this.lean = new Spring(cfg.lean, 0.35);
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

    this.clothMat = mats.jacket;
    this.torso = new THREE.Mesh(torsoGeometry(), mats.jacket);
    this.torso.matrixAutoUpdate = false;
    this.torso.frustumCulled = false;
    this.torso.layers.set(L_NO_MIRROR);
    scene.add(this.torso);
    this.headMat = mats.head;
    this.head = new THREE.Mesh(headGeometry(), mats.head);
    this.head.frustumCulled = false;
    this.head.matrixAutoUpdate = false;
    this.head.layers.set(L_NO_MIRROR);
    scene.add(this.head);
    this.collar = new THREE.Mesh(collarGeometry(), mats.shirt);
    this.collar.matrixAutoUpdate = false;
    this.collar.layers.set(L_NO_MIRROR);
    scene.add(this.collar);
    this.legs = new THREE.Mesh(legsGeometry(!!cfg.seated), mats.sleeve);
    this.legs.position.copy(this.hip);
    this.legs.rotation.y = this.yaw;
    this.legs.updateMatrix();
    this.legs.matrixAutoUpdate = false;
    this.legs.layers.set(L_MAIN_ONLY);
    scene.add(this.legs);

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
    // cufflink sits on the thumb side of the cuff
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
    hip.x += fnoise(this.time * 0.05 + this.seed, 2) * 0.006;
    hip.z += fnoise(this.time * 0.04 + this.seed + 5, 2) * 0.004;
    return out.compose(hip, this.torsoQuat, ONE);
  }

  // smallest lean that lets `arm` reach the wrist target (with protraction & twist)
  requiredLean(arm, Wt, twist, protract) {
    const reach = (arm.L1 + arm.L2) * 0.975;
    const tmp = this._tmpM || (this._tmpM = new THREE.Matrix4());
    const S = this._tmpS || (this._tmpS = new THREE.Vector3());
    const max = this.baseLean + this.maxExtraLean;
    for (let l = this.baseLean; l < max; l += 0.015) {
      this.computeTorso(l, twist, 0, tmp);
      arm.shoulderLocal(S, protract).applyMatrix4(tmp);
      if (S.distanceTo(Wt) <= reach) return l;
    }
    return max;
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

    // ---- reaching: shoulder protraction first, then torso twist, then lean
    let lean = this.baseLean + this.extraLean - this.breath * 0.006;
    let twist = fnoise(t * 0.03 + this.seed, 2) * 0.02;
    for (const side in this.hands) {
      const h = this.hands[side];
      const arm = h.arm;
      const target = h.finalTarget();
      const S = arm.S;
      const far = Math.max(Math.hypot(target.x - S.x, target.z - S.z), Math.hypot(h.wrist.x - S.x, h.wrist.z - S.z));
      const demand = smoothstep(0.30, 0.62, far) * (1 - h.planted * 0.6);
      arm.protractTarget = demand;
      const tw = -arm.s * this.twistGain * demand;
      twist += tw;
      lean = Math.max(lean, this.requiredLean(arm, target, this.twist.x * 0.5 + tw * 0.5, demand));
      lean = Math.max(lean, this.requiredLean(arm, h.wrist, this.twist.x, arm.protract.x));
    }
    for (const side in this.arms) {
      const arm = this.arms[side];
      arm.protract.update(arm.protractTarget, dt);
    }
    this.lean.update(lean, dt);
    if (this.lean.x < lean - 0.1) this.lean.x = lean - 0.1;
    this.twist.update(twist, dt);
    this.roll.update(fnoise(t * 0.04 + this.seed + 2, 2) * 0.015 - this.twist.x * 0.15, dt);
    this.computeTorso(this.lean.x, this.twist.x, this.roll.x);
    this.torso.matrix.copy(this.torsoMatrix);
    this.torso.matrixWorldNeedsUpdate = true;

    // ---- collar & head
    _v1.set(0, 0.574 + this.breath * 0.004, -0.024).applyMatrix4(this.torsoMatrix);
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

    // ---- arms & hands
    for (const side of ['left', 'right']) {
      const h = this.hands[side];
      if (h) h.update(dt, time);
      else {
        const arm = this.arms[side];
        const W = _v3.copy(this.restArm.wrist).applyMatrix4(this.torsoMatrix);
        arm.solve(W);
        arm.forearmFrame(_v2.set(0, 1, 0));
        arm.updateMeshes();
      }
    }
  }

  headPosition(out = new THREE.Vector3()) {
    return out.set(0, 0.1, 0.02).applyMatrix4(this.headWorld);
  }
}
