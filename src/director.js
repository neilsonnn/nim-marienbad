// Game flow and choreography: who moves, what the hands do, where the heads look.
import * as THREE from 'three';
import { POSES, lerpPose } from './handModel.js';
import { TABLE_Y, TABLE_R, ROWS, ROW_Z, ROW_X0, ROW_DX, Pile, tableQuat, MATCH_R, MATCH_LEN } from './world.js';
import { chooseMove } from './nim.js';
import { DIAG, handPoints, tcpLocal } from './actors.js';
import { clamp, lerp, smoothstep, DEG, rand, rng, mulberry32, easeOutCubic, quatFromYZ } from './util.js';

const UP = new THREE.Vector3(0, 1, 0);
const WORDS = ['none', 'one', 'two', 'three', 'four', 'five', 'six', 'seven'];

// Timing for a strike: a wind-up that eases into a harder, faster stroke without stopping
// at the top. Speed is two overlapping humps (the lift, then the strike); the result maps a
// fraction of the time to a fraction of the path, the lift covering `split` of it.
function slapEase(split) {
  const N = 240, bump = (t, a, b) => (t <= a || t >= b ? 0 : Math.sin((Math.PI * (t - a)) / (b - a)) ** 2);
  const v1 = (t) => bump(t, 0, 0.5), v2 = (t) => bump(t, 0.43, 1.0);
  let i1 = 0, i2 = 0;
  for (let i = 0; i < N; i++) { const t = (i + 0.5) / N; i1 += v1(t); i2 += v2(t); }
  const a1 = split / i1, a2 = (1 - split) / i2;
  const s = new Float32Array(N + 1);
  for (let i = 0; i < N; i++) { const t = (i + 0.5) / N; s[i + 1] = s[i] + a1 * v1(t) + a2 * v2(t); }
  return (tau) => { const x = clamp(tau, 0, 1) * N, i = Math.min(N - 1, Math.floor(x)); return clamp(s[i] + (s[i + 1] - s[i]) * (x - i), 0, 1); };
}

export class Director {
  constructor(ctx) {
    Object.assign(this, ctx); // sched, matches, player, opponent, ui, foley, camera
    this.pHandL = this.player.hands.left;   // the hand in the shot: left and centre of the board
    this.pHandR = this.player.hands.right;  // rests on his thigh, comes up for the right side
    this.pHand = this.pHandL;               // whichever is working (look-at & focus follow it)
    this.oHand = this.opponent.hands.right;
    this.oSupport = this.opponent.hands.left;
    this.oActive = null; // the opponent's hand at work when it isn't his right
    const pr = mulberry32(99);
    this.piles = {
      player: new Pile(new THREE.Vector3(0.078, TABLE_Y, 0.262), { x: 0.03, z: 0.018 }, pr),
      playerL: new Pile(new THREE.Vector3(-0.268, TABLE_Y, 0.158), { x: 0.02, z: 0.016 }, pr),
      opponent: new Pile(new THREE.Vector3(-0.055, TABLE_Y, -0.29), { x: 0.03, z: 0.016 }, pr),
    };
    // two people at one screen: player one plays this side (over the shoulder), player
    // two the man across the table; each picks matches with the same click & drag
    this.twoPlayer = false;
    this.selector = 'player'; // whose selection is open
    const load = (key) => {
      try {
        const s = JSON.parse(localStorage.getItem(key) || 'null');
        if (s && typeof s.player === 'number') return s;
      } catch (e) { /* storage unavailable */ }
      return { player: 0, opponent: 0 };
    };
    this.scores = { ai: load('nim-score'), two: load('nim-score-2p') };
    this.mode = 'intro';
    this.hover = null;
    this.selection = [];
    this.selRow = -1;
    this.starter = 'player';
    this.games = 0;
    POSES.holdOpen = lerpPose(POSES.holdWide, POSES.reach, 0.55);
    // the matchbox: where it rests, and the hand holding it (if any)
    this.boxRest = { pos: this.box.position.clone(), quat: this.box.quaternion.clone() };
    this.boxHeld = null;
    this.drawerOut = 0; // how much further than at rest the drawer is pulled out
    this.drawerTarget = 0;
    this.installIdles();
  }

  // ---------------------------------------------------------------- idle behaviours
  installIdles() {
    // player's loose fist: thumb slowly rubs the side of the index finger now and then
    let rub = 0, rubNext = 4;
    this.pHand.idle = (dt, f) => {
      rubNext -= dt;
      if (rubNext <= 0 && rub <= 0) { rub = 1.8; rubNext = 6 + rand(0, 8); }
      if (rub > 0) {
        rub -= dt;
        const k = Math.sin((1.8 - rub) / 1.8 * Math.PI);
        f[16] += Math.sin((1.8 - rub) * 9) * 5 * k;
        f[19] += k * 6;
        f[20] += Math.sin((1.8 - rub) * 9 + 1) * 6 * k;
      }
    };
    // opponent's support hand carries his weight: braced flat on the stone, no fidgeting
    this.oSupport.idle = null;
    // opponent's active hand: fingers resettle once in a while
    this.oHand.idle = (dt, f) => {
      const t = this.oHand.time;
      const s = Math.max(0, Math.sin(t * 0.37)) ** 8;
      f[8] += s * 8; f[12] += s * 10; f[9] += s * 6;
    };
  }

  get score() { return this.twoPlayer ? this.scores.two : this.scores.ai; }
  saveScore() {
    try { localStorage.setItem(this.twoPlayer ? 'nim-score-2p' : 'nim-score', JSON.stringify(this.score)); } catch (e) { /* ignore */ }
  }
  // how the subtitles name each side
  who(side) {
    if (this.twoPlayer) return side === 'player' ? 'Player one' : 'Player two';
    return side === 'player' ? 'You' : 'He';
  }

  // ---------------------------------------------------------------- helpers
  reachPitch(hand, target) {
    const S = hand.arm.S;
    const d = Math.hypot(target.x - S.x, target.z - S.z);
    // the seated player's shoulders are low over the stone: a flatter hand spares his wrist
    const near = hand.actor === this.player ? 38 : 44;
    return lerp(near, 32, smoothstep(0.2, 0.8, d)) * DEG;
  }
  approachDir(hand, target) {
    return new THREE.Vector3(target.x - hand.arm.S.x, 0, target.z - hand.arm.S.z).normalize();
  }
  pan(p) {
    return clamp(p.x * 2.5, -0.8, 0.8);
  }
  orderByPath(hand, list) {
    const out = [];
    const rest = list.slice();
    const cur = hand.tcpWorld(POSES.pinch);
    while (rest.length) {
      let bi = 0, bd = Infinity;
      rest.forEach((m, i) => { const d = m.pos.distanceTo(cur); if (d < bd) { bd = d; bi = i; } });
      const m = rest.splice(bi, 1)[0];
      out.push(m);
      cur.copy(m.pos);
    }
    return out;
  }

  // pick up a list of matches lying on the table / pile
  async gather(hand, list, { fromPile = null, quick = false, scoop = [] } = {}) {
    const ordered = this.orderByPath(hand, list);
    for (let i = 0; i < ordered.length; i++) {
      const m = ordered[i];
      const first = hand.held.length === 0;
      // a hand resting in the lap comes up past the table edge in one fluid motion
      const via = i === 0 ? this.liftPath(hand) : null;
      const at = m.pos.clone();
      at.y = m.pos.y + 0.0024;
      const q = hand.graspQuat(m.axis(), this.approachDir(hand, at), this.reachPitch(hand, at));
      const hover = at.clone();
      hover.y += first ? 0.045 : 0.02;
      const open = first ? POSES.reach : POSES.holdOpen;
      const close = hand.held.length >= 1 ? POSES.holdWide : POSES.hold;
      await hand.moveTo({ tcp: hover, quat: q, pose: open, poseWin: via ? [0.4, 0.9] : [0.05, 0.65], arc: first ? undefined : 0.012, speed: quick ? 0.62 : first ? 1.0 : 0.8, via });
      await hand.moveTo({ tcp: at, quat: q, pose: open, dur: quick ? 0.12 : first ? 0.2 : 0.15, arc: 0, poseWin: [0, 1] });
      await hand.moveTo({ tcp: at, quat: q, pose: close, dur: quick ? 0.1 : 0.13, arc: 0, poseWin: [0, 1] });
      if (fromPile) fromPile.remove(m);
      hand.grab(m);
      this.foley.pick(this.pan(m.pos));
      // sweeping up a loose heap: the neighbours come along in the same grip
      for (const x of scoop) {
        if (fromPile) fromPile.remove(x);
        hand.grab(x, 0.32);
      }
      await hand.moveTo({ tcp: at.clone().setY(at.y + 0.018), quat: q, pose: close, dur: quick ? 0.11 : 0.15, arc: 0 });
    }
  }

  async dropOnPile(hand, pile) {
    const yawHint = Math.atan2(hand.held[0].m.axis().x, hand.held[0].m.axis().z);
    const spot = pile.chooseSpot(yawHint);
    let top = TABLE_Y;
    for (const it of pile.items) top = Math.max(top, it.line.y0, it.line.y1);
    const tcp = new THREE.Vector3(spot.cx, top + 0.03, spot.cz);
    const axis = new THREE.Vector3(Math.sin(spot.yaw), 0, Math.cos(spot.yaw));
    const q = hand.graspQuat(axis, this.approachDir(hand, tcp), this.reachPitch(hand, tcp) * 0.85);
    const holdPose = hand.held.length > 1 ? POSES.holdWide : POSES.hold;
    await hand.moveTo({ tcp, quat: q, pose: holdPose, poseWin: [0, 1] });
    let dropped = false;
    await hand.moveTo({
      tcp: tcp.clone().setY(tcp.y - 0.006), quat: q, pose: POSES.release, dur: 0.24, arc: 0, poseWin: [0.0, 0.8],
      onUpdate: (tau) => {
        if (!dropped && tau > 0.28) {
          dropped = true;
          const ms = hand.release();
          ms.forEach((m, i) => this.fall(m, pile, i * 0.035 + rand(0, 0.02)));
        }
      },
    });
  }

  fall(m, pile, delay) {
    const ax = m.axis();
    const yaw = Math.atan2(ax.x, ax.z) + (rng() - 0.5) * 0.5;
    const cx = m.pos.x + (rng() - 0.5) * 0.012, cz = m.pos.z + (rng() - 0.5) * 0.012;
    const rest = pile.restPose(cx, cz, yaw);
    pile.add(m, rest.line);
    m.state = 'falling';
    const p0 = m.pos.clone(), q0 = m.quat.clone();
    let t = -delay, landed = false;
    const wob = new THREE.Quaternion();
    const wAxis = new THREE.Vector3(rng() - 0.5, 0, rng() - 0.5).normalize();
    m.anim = (dt) => {
      t += dt;
      if (t < 0) return false;
      const h = Math.max(0.001, p0.y - rest.pos.y);
      const tf = Math.sqrt((2 * h) / 9.81) * 1.45;
      if (t < tf) {
        const k = t / tf;
        m.pos.x = lerp(p0.x, rest.pos.x, k);
        m.pos.z = lerp(p0.z, rest.pos.z, k);
        m.pos.y = p0.y - h * k * k;
        m.quat.slerpQuaternions(q0, rest.quat, Math.min(1, k * 1.15));
      } else {
        if (!landed) { landed = true; this.foley.tick(0.6 + rng() * 0.4, this.pan(rest.pos)); }
        const tb = t - tf;
        const env = Math.exp(-tb * 16);
        m.pos.copy(rest.pos);
        m.pos.y += 0.0016 * env * Math.abs(Math.sin(tb * 36));
        wob.setFromAxisAngle(wAxis, env * 0.07 * Math.sin(tb * 42));
        m.quat.copy(rest.quat).premultiply(wob);
        if (tb > 0.4) {
          m.pos.copy(rest.pos);
          m.quat.copy(rest.quat);
          m.state = 'pile';
          return true;
        }
      }
      return false;
    };
  }

  // A hand resting below the stone (on the thigh) must clear the table edge first.
  // It comes up in front of its own shoulder, a little to that side, and passes just
  // over the edge: the elbow stays back and low instead of winging up beside the body.
  edgePoint(hand) {
    const a = hand.actor, S = hand.arm.S;
    const f = new THREE.Vector3(Math.sin(a.yaw), 0, Math.cos(a.yaw));
    const side = new THREE.Vector3(0, 1, 0).cross(f).multiplyScalar(hand.arm.s); // toward that arm's side
    const p = S.clone().addScaledVector(side, 0.10).addScaledVector(f, 0.30);
    p.y = TABLE_Y + 0.075;
    const r = Math.hypot(p.x, p.z);
    const rMin = TABLE_R + 0.045;
    if (r < rMin) { p.x *= rMin / r; p.z *= rMin / r; }
    return p;
  }
  // beside the thigh, clear of the leaning shoulder that hangs over the lap
  sidePoint(hand) {
    const a = hand.actor;
    const f = new THREE.Vector3(Math.sin(a.yaw), 0, Math.cos(a.yaw));
    const side = new THREE.Vector3(0, 1, 0).cross(f).multiplyScalar(hand.arm.s);
    const p = hand.restWrist.clone().addScaledVector(side, 0.15).addScaledVector(f, 0.02);
    p.y += 0.045;
    return p;
  }
  // via points for a hand leaving the lap (null when it's already up at the table)
  liftPath(hand) {
    if (!hand.lapRest || hand.wrist.y > TABLE_Y + 0.05) return null;
    return [this.sidePoint(hand), this.edgePoint(hand)];
  }
  async goRest(hand, speed = 1) {
    if (hand.lapRest) {
      // back over the edge and down to the thigh, one continuous motion
      await hand.moveTo({ wrist: hand.restWrist, quat: hand.restQuat, pose: hand.restPose, plant: 1, poseWin: [0.1, 0.8], speed: 1.05 * speed, via: [this.edgePoint(hand), this.sidePoint(hand)] });
      return;
    }
    await hand.moveTo({ wrist: hand.restWrist, quat: hand.restQuat, pose: hand.restPose, plant: 1, poseWin: [0.3, 1.0], speed: 1.1 * speed });
    this.foley.tap(0.45, this.pan(hand.restWrist));
  }

  // How much extra lean a hand needs to work at these table points (its wrist sits behind the fingers).
  handCost(hand, pts) {
    const a = hand.actor, arm = hand.arm;
    const base = a.baseLean + a.crouch.lean * a.posture.x;
    let worst = 0;
    for (const p of pts) {
      const back = new THREE.Vector3(p.x - arm.S.x, 0, p.z - arm.S.z).normalize();
      const w = p.clone().addScaledVector(back, -0.1);
      w.y = TABLE_Y + 0.085;
      worst = Math.max(worst, a.requiredLean(arm, w, a.twist.x, 1, base) - base);
    }
    return worst;
  }
  // The player uses the hand that can do the job with the least strain; the shot's left hand wins ties.
  choosePlayerHand(pts) {
    const cl = this.handCost(this.pHandL, [...pts, this.piles.playerL.center]);
    const cr = this.handCost(this.pHandR, [...pts, this.piles.player.center]);
    return cl <= cr + 0.06 ? this.pHandL : this.pHandR;
  }
  pileFor(hand) {
    if (hand === this.pHandL) return this.piles.playerL;
    if (hand === this.pHandR) return this.piles.player;
    return this.piles.opponent;
  }

  async takeTurn(hand, list, pile) {
    this.foley.rustle(1, this.pan(hand.wrist));
    const sweep = this.canSweep(list);
    for (const m of list) m.state = 'taken';
    if (sweep) await this.sweep(hand, list, pile);
    else {
      await this.gather(hand, list);
      await this.dropOnPile(hand, pile);
    }
    await this.goRest(hand);
  }

  // a whole row of three or more is raked in in one stroke instead of picked match by match
  canSweep(list) {
    if (list.length < 3) return false;
    const row = list[0].row;
    return list.every((m) => m.state === 'row' && m.row === row) && this.matches.inRow(row).every((m) => list.includes(m));
  }

  // The hand comes down past the far end of the row, pointing forward as it always does,
  // palm down, middle, ring and little fingers hooked onto the stone just beyond the matches
  // (the index lifted), and draws them along the row and round into its pile without
  // turning: the matches gather against those fingertips and come to rest on the heap.
  // (Not a simulation: they follow the fingertips.)
  async sweep(hand, list, pile) {
    const a = hand.actor;
    const fwd = new THREE.Vector3(Math.sin(a.yaw), 0, Math.cos(a.yaw)); // away from him
    const mean = list.reduce((v, m) => v.add(m.pos), new THREE.Vector3()).multiplyScalar(1 / list.length);
    // along the row toward the pile's side (each hand's pile lies on its own side)
    const dir = new THREE.Vector3(Math.sign(pile.center.x - mean.x) || 1, 0, 0);
    const along = (p) => p.x * dir.x + p.z * dir.z;
    const order = list.slice().sort((m1, m2) => along(m1.pos) - along(m2.pos));
    const first = order[0], last = order[order.length - 1];
    // pointing forward (a touch toward the reach), fingers hooked down onto the stone
    const S = hand.arm.S;
    const reach = new THREE.Vector3(mean.x - S.x, 0, mean.z - S.z).normalize();
    const point = fwd.clone().lerp(reach, 0.35).normalize();
    const q = quatFromYZ(point.clone().multiplyScalar(Math.cos(0.45)).setY(-Math.sin(0.45)), UP);
    // where the three hooked fingertips sit, for that orientation (hand frame -> world offset)
    const TIPS = [13, 20, 27]; // CONTACT_POINTS: middle, ring and little fingertips
    const pts = handPoints(hand.side, POSES.rake);
    let low = Infinity;
    const tip = new THREE.Vector3();
    for (const c of pts) low = Math.min(low, c.p.clone().applyQuaternion(q).y - c.r);
    for (const i of TIPS) tip.add(pts[i].p.clone().applyQuaternion(q));
    tip.multiplyScalar(1 / TIPS.length);
    // wrist that puts the fingertips' middle at a point on the stone
    const wristFor = (P) => P.clone().sub(tip).setY(TABLE_Y - low - 0.002);
    const half = 0.5 * MATCH_LEN;
    const beyond = (x) => new THREE.Vector3(x, TABLE_Y, mean.z).addScaledVector(fwd, half + 0.012);
    const P0 = beyond(first.pos.x - dir.x * 0.03);
    const P1 = beyond(last.pos.x + dir.x * 0.015);
    const P2 = pile.center.clone().addScaledVector(fwd, 0.012).setY(TABLE_Y);
    const W0 = wristFor(P0), W1 = wristFor(P1), W2 = wristFor(P2);
    // in: over the far end of the row, then the fingertips down onto the stone
    const hover = W0.clone();
    hover.y += 0.05;
    await hand.moveTo({ wrist: hover, quat: q, pose: POSES.rake, poseWin: [0.15, 0.8], via: this.liftPath(hand) });
    await hand.moveTo({ wrist: W0, quat: q, pose: POSES.rake, dur: 0.24, arc: 0, plant: 1, poseWin: [0, 1] });
    this.foley.tap(0.25, this.pan(P0));
    // the drag: matches the hand reaches gather against the three fingertips, on his side
    // of them, spread across their width
    const bunch = [];
    const qT = new THREE.Quaternion();
    const lateral = new THREE.Vector3().crossVectors(UP, fwd);
    const C = new THREE.Vector3();
    const measure = () => {
      C.set(0, 0, 0);
      for (const i of TIPS) { const c = hand.contactWorld[i]; if (c) C.x += c.x / TIPS.length, C.z += c.z / TIPS.length; }
    };
    const catchMatch = (mt) => {
      const k = bunch.length;
      bunch.push(mt);
      mt.state = 'swept';
      const jit = (rng() - 0.5) * 0.35;
      const side = (((k * 0.618) % 1) - 0.5) * 0.034;
      const back = 0.006 + half * 0.6 + (k % 3) * 0.003;
      const baseY = mt.pos.y;
      this.foley.tick(0.16 + rng() * 0.12, this.pan(mt.pos));
      mt.anim = (dt) => {
        if (mt.state !== 'swept') return true;
        const tx = C.x - fwd.x * back + lateral.x * side, tz = C.z - fwd.z * back + lateral.z * side;
        const e = 1 - Math.exp(-dt / 0.06);
        mt.pos.x += (tx - mt.pos.x) * e;
        mt.pos.z += (tz - mt.pos.z) * e;
        mt.pos.y = baseY;
        tableQuat(Math.atan2(fwd.x, fwd.z) + jit, qT, 0.02);
        mt.quat.slerp(qT, 1 - Math.exp(-dt / 0.3));
        return false;
      };
    };
    const waiting = order.slice();
    const len = W0.distanceTo(W1) + W1.distanceTo(W2);
    await hand.moveTo({
      wrist: W2, quat: q, via: [W1], pose: POSES.rake, dur: 0.6 + len * 2.2, arc: 0, plant: 1, poseWin: [0, 1],
      onUpdate: () => {
        measure();
        // reached once the fingertips' middle has come level with it along the row
        while (waiting.length && (along(waiting[0].pos) - (C.x * dir.x + C.z * dir.z)) <= 0.02) catchMatch(waiting.shift());
      },
    });
    while (waiting.length) catchMatch(waiting.shift());
    // the bunch comes to rest on the heap; the fingers lift off it
    bunch.forEach((mt, i) => this.settleOnPile(mt, pile, i * 0.02));
    const lift = hand.wrist.clone();
    lift.y += 0.045;
    await hand.moveTo({ wrist: lift, quat: q, pose: POSES.relaxed, dur: 0.3, arc: 0, poseWin: [0, 1] });
  }
  // a raked match slides up onto the pile (it rests on the heap like a dropped one)
  settleOnPile(m, pile, delay) {
    const ax = m.axis();
    const yaw = Math.atan2(ax.x, ax.z) + (rng() - 0.5) * 0.3;
    const cx = lerp(m.pos.x, pile.center.x, 0.5) + (rng() - 0.5) * 0.01, cz = lerp(m.pos.z, pile.center.z, 0.5) + (rng() - 0.5) * 0.01;
    const rest = pile.restPose(cx, cz, yaw);
    pile.add(m, rest.line);
    m.state = 'falling';
    const p0 = m.pos.clone(), q0 = m.quat.clone();
    let t = -delay;
    m.anim = (dt) => {
      t += dt;
      if (t < 0) return false;
      const k = smoothstep(0, 0.22, t);
      m.pos.lerpVectors(p0, rest.pos, k);
      m.pos.y += Math.sin(k * Math.PI) * 0.003;
      m.quat.slerpQuaternions(q0, rest.quat, k);
      if (t >= 0.22) {
        m.pos.copy(rest.pos);
        m.quat.copy(rest.quat);
        m.state = 'pile';
        this.foley.tick(0.3 + rng() * 0.3, this.pan(rest.pos));
        return true;
      }
      return false;
    };
  }

  // ---------------------------------------------------------------- the matchbox
  // after the hands have moved: a held box sits in its hand's grip (easing in as the fingers
  // close on it), a box just set down eases onto its resting place
  lateUpdate(dt) {
    // the drawer slides out while the box is in hand, back in when it is put down
    if (this.drawerOut !== this.drawerTarget) {
      const prevOut = this.drawerOut;
      this.drawerOut += Math.sign(this.drawerTarget - this.drawerOut) * Math.min(Math.abs(this.drawerTarget - this.drawerOut), dt * 0.05);
      for (const c of this.box.children.slice(1)) c.position.x += this.drawerOut - prevOut;
      this.box.updateMatrixWorld(true);
    }
    const h = this.boxHeld;
    if (h) {
      h.t = Math.min(1, h.t + dt / 0.22);
      const k = smoothstep(0, 1, h.t);
      const p = h.relP.clone().applyQuaternion(h.hand.quat).add(h.hand.displayWrist);
      const q = h.hand.quat.clone().multiply(h.relQ);
      this.box.position.lerpVectors(h.p0, p, k);
      this.box.quaternion.slerpQuaternions(h.q0, q, k);
    } else if (this.boxSettle) {
      const b = this.boxSettle;
      b.t = Math.min(1, b.t + dt / 0.16);
      const k = smoothstep(0, 1, b.t);
      this.box.position.lerpVectors(b.p0, this.boxRest.pos, k);
      this.box.quaternion.slerpQuaternions(b.q0, this.boxRest.quat, k);
      if (b.t >= 1) this.boxSettle = null;
    } else return;
    this.box.updateMatrixWorld(true);
  }
  // every match back in the box (hidden), nothing on the table or in the piles
  hideBoard() {
    for (const p of Object.values(this.piles)) p.items = [];
    for (const m of this.matches.list) {
      m.state = 'box';
      m.anim = null;
      m.pile = null;
      m.select = m.highlight = 0;
      m.mesh.visible = false;
    }
  }
  // a point on the box (its own frame: x along it, toward the open drawer) in the world
  boxPoint(x, y, z) {
    this.box.updateMatrixWorld(true);
    return new THREE.Vector3(x, y, z).applyMatrix4(this.box.matrixWorld);
  }
  // His left hand takes up the matchbox between thumb and fingers and holds it out over the
  // board beside his right, the open drawer turned toward it; the right draws the matches
  // from the drawer a few at a time and lays out `slots`, far row first. Then the box goes
  // back where it lay.
  async layOutFromBox(slots = this.matches.slots()) {
    const L = this.oSupport, R = this.oHand;
    this.mode = 'intro';
    this.oActive = R;
    // The grip, built in the hand's own frame: thumb and fingers wrapped round the sleeve's
    // long sides near its closed end, the fingers pitched down and toward the drawer, the back
    // of the hand up. The box's grip point sits between thumb and finger pads, so it is always
    // held, never floating or palmed.
    const restQ = this.boxRest.quat, restP = this.boxRest.pos;
    const grip = POSES.boxGrip;
    const loc = tcpLocal(L.side, grip);
    // the hand in the box's frame: palm over the top, knuckles along its length, fingers
    // pointing across it (away from him) and curling down its far side, thumb on the near side
    const Yh = new THREE.Vector3(0, -0.3, -1).normalize();
    let Xh = new THREE.Vector3(1, 0, 0);
    let Zh = new THREE.Vector3().crossVectors(Xh, Yh);
    if (Zh.y < 0) { Xh.negate(); Zh.negate(); } // back of the hand up
    const handInBox = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(Xh, Yh, Zh));
    const relQ = handInBox.clone().invert(); // box frame -> hand frame
    const G = new THREE.Vector3(-0.014, 0.0075, 0); // the grip point on the box (toward its closed end)
    const relP = loc.tcp.clone().sub(G.clone().applyQuaternion(relQ));
    const relQi = relQ.clone().invert();
    const handFor = (boxQ, boxP) => {
      const q = boxQ.clone().multiply(relQi);
      return { q, w: boxP.clone().sub(relP.clone().applyQuaternion(q)) };
    };
    const atRest = handFor(restQ, restP);
    const qG = atRest.q, wGrip = atRest.w;
    const gripPt = G.clone().applyQuaternion(restQ).add(restP);
    const wAbove = wGrip.clone();
    wAbove.y += 0.05;
    await L.moveTo({ wrist: wAbove, quat: qG, pose: POSES.boxOpen, poseWin: [0.1, 0.8] });
    await L.moveTo({ wrist: wGrip, quat: qG, pose: POSES.boxOpen, dur: 0.24, arc: 0 });
    await L.moveTo({ wrist: wGrip, quat: qG, pose: grip, dur: 0.14, arc: 0, poseWin: [0, 1] });
    this.boxSettle = null;
    this.boxHeld = { hand: L, relP, relQ, t: 0, p0: this.box.position.clone(), q0: this.box.quaternion.clone() };
    this.foley.tick(0.3, this.pan(gripPt));
    // held out over the board beside his right hand: the drawer pushed further out and
    // turned toward it, tipped up a little
    const xb = new THREE.Vector3(-1, 0.16, -0.3).normalize();
    const zb = new THREE.Vector3().crossVectors(xb, UP).normalize();
    const yb = new THREE.Vector3().crossVectors(zb, xb);
    const qBoxHold = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(xb, yb, zb));
    const hold = handFor(qBoxHold, new THREE.Vector3(0.08, TABLE_Y + 0.085, -0.235));
    const qH = hold.q, wHold = hold.w;
    this.drawerTarget = 0.014;
    await L.moveTo({ wrist: wHold, quat: qH, pose: grip, poseWin: [0, 1], speed: 1.15 });
    // the rows, far to near
    const order = slots.slice().sort((s1, s2) => s1.row - s2.row || s1.col - s2.col);
    const inBox = () => this.matches.list.filter((m) => m.state === 'box');
    while (order.length && inBox().length) {
      const k = Math.min(4, order.length, inBox().length);
      const take = inBox().slice(0, k);
      // fingers to the open end of the drawer, from beyond it (never into the box), the
      // matches lifted out between them
      const dx = 0.046 + this.drawerOut;
      const at = this.boxPoint(dx, 0.029, 0);
      const axis = new THREE.Vector3(1, 0, 0).applyQuaternion(this.box.quaternion).setY(0).normalize();
      const q = R.graspQuat(axis, axis.clone().negate(), 58 * DEG);
      await R.moveTo({ tcp: at.clone().setY(at.y + 0.03).addScaledVector(axis, 0.02), quat: q, pose: POSES.reach, poseWin: [0.05, 0.6] });
      const at2 = this.boxPoint(dx, 0.029, 0);
      await R.moveTo({ tcp: at2, quat: q, pose: POSES.reach, dur: 0.16, arc: 0 });
      const mq = this.box.quaternion.clone().multiply(new THREE.Quaternion().setFromAxisAngle(UP, Math.PI / 2));
      take.forEach((m, i) => {
        m.pos.copy(this.boxPoint(dx, 0.02, (i - (k - 1) / 2) * 0.0026));
        m.quat.copy(mq);
        m.mesh.visible = true;
        m.state = 'taken';
      });
      await R.moveTo({ tcp: at2, quat: q, pose: k > 1 ? POSES.holdWide : POSES.hold, dur: 0.13, arc: 0, poseWin: [0, 1] });
      R.grab(take[0]);
      for (const m of take.slice(1)) R.grab(m, 0.3);
      this.foley.pick(this.pan(at2));
      await R.moveTo({ tcp: at2.clone().setY(at2.y + 0.035), quat: q, pose: k > 1 ? POSES.holdWide : POSES.hold, dur: 0.2, arc: 0 });
      await this.placeHeld(R, order);
    }
    // the box back where it lay, the drawer pushed half in again, then his hands to rest
    const back = R.moveTo({ wrist: R.restWrist, quat: R.restQuat, pose: R.restPose, plant: 1, poseWin: [0.3, 1], speed: 1.1 });
    this.drawerTarget = 0;
    await L.moveTo({ wrist: wAbove, quat: qG, pose: grip, poseWin: [0, 1] });
    await L.moveTo({ wrist: wGrip.clone().setY(wGrip.y + 0.001), quat: qG, pose: grip, dur: 0.22, arc: 0 });
    this.boxHeld = null;
    this.boxSettle = { t: 0, p0: this.box.position.clone(), q0: this.box.quaternion.clone() };
    this.foley.tap(0.35, this.pan(gripPt));
    await L.moveTo({ wrist: wGrip, quat: qG, pose: POSES.boxOpen, dur: 0.14, arc: 0, poseWin: [0, 1] });
    await L.moveTo({ wrist: wAbove, quat: qG, pose: POSES.boxOpen, dur: 0.25, arc: 0 });
    await Promise.all([back, this.goRest(L)]);
    this.oActive = null;
    this.mode = 'idle';
  }

  // lay the matches a hand holds into the next slots of `order`, one by one
  async placeHeld(hand, order, label = null) {
    while (hand.held.length && order.length) {
      const slot = order.shift();
      if (label) DIAG.begin(`${label} ${hand.side} place r${slot.row}c${slot.col}`, hand);
      const sp = this.matches.slotPose(slot.row, slot.col);
      const axis = new THREE.Vector3(0, 0, 1).applyQuaternion(sp.quat);
      const at = sp.pos.clone();
      at.y += 0.0026;
      const q = hand.graspQuat(axis, this.approachDir(hand, at), this.reachPitch(hand, at));
      const pose = hand.held.length > 1 ? POSES.holdWide : POSES.hold;
      await hand.moveTo({ tcp: at.clone().setY(at.y + 0.022), quat: q, pose, poseWin: [0, 1], speed: 0.7 });
      await hand.moveTo({ tcp: at, quat: q, pose, dur: 0.12, arc: 0 });
      const m = hand.held[hand.held.length - 1].m;
      hand.release([m]);
      await this.place(m, sp, slot);
      await hand.moveTo({ tcp: at.clone().setY(at.y + 0.02), quat: q, pose: hand.held.length ? pose : POSES.reach, dur: 0.11, arc: 0, poseWin: [0, 1] });
      if (label) DIAG.end();
    }
  }

  // ---------------------------------------------------------------- "Non, c'est impossible"
  // Frustration: his left hand snaps up and back, slams down beside his matches and shoves
  // them hard across to the right, all the way over; they skid and hop off the right-hand
  // edge of the table. He lunges into it, then lets the hand drop back. The opponent lays
  // the board out again: first from his own pile, then the rest fresh from the box.
  async protest() {
    const H = this.pHandL, P = this.player;
    this.mode = 'protest';
    this.pHand = H;
    P.sigh = 1;
    const mine = (m) => m.state !== 'box' && (m.pile === this.piles.player || m.pile === this.piles.playerL || (m.pos.z > 0.1 && m.state !== 'row'));
    const lost = this.matches.list.filter(mine);
    // hand on its edge, palm toward the matches, fingers forward
    const qSlap = quatFromYZ(new THREE.Vector3(0.15, -0.28, -0.95), new THREE.Vector3(-1, 0.3, 0));
    let x0 = Infinity;
    for (const m of lost) x0 = Math.min(x0, m.pos.x);
    if (!isFinite(x0)) x0 = this.piles.playerL.center.x;
    const zc = lost.length ? lost.reduce((s, m) => s + m.pos.z, 0) / lost.length : 0.2;
    // the wrist height at which that hand's edge just skims the stone (the stroke never digs
    // into it: the contact constraint shoving it back up read as a jolt)
    let low = Infinity;
    for (const c of handPoints(H.side, POSES.flat)) low = Math.min(low, c.p.clone().applyQuaternion(qSlap).y - c.r);
    const skim = TABLE_Y - low + 0.004;
    const p0 = new THREE.Vector3(x0 - 0.07, skim, zc + 0.06);
    // One continuous stroke, no stops: up and back, down hard beside his matches, a shove
    // all the way across to the right and an easing follow-through. (Slow at the start and
    // end of the path, fastest through the slam and the shove.)
    const back = p0.clone().add(new THREE.Vector3(-0.05, 0.06, 0.03));
    const mid = p0.clone().add(new THREE.Vector3(0.16, 0, -0.01));
    const end = new THREE.Vector3(Math.max(0.05, p0.x + 0.3), skim + 0.004, zc + 0.025);
    const follow = end.clone().add(new THREE.Vector3(0.04, 0.05, -0.02));
    const pushed = new Set();
    let slammed = false;
    await H.moveTo({
      wrist: follow, quat: qSlap, viaQuat: qSlap, pose: POSES.flat, via: [back, p0, mid, end], dur: 1.0, arc: 0, poseWin: [0, 0.3], ease: slapEase(H.wrist.distanceTo(back) / (H.wrist.distanceTo(back) + back.distanceTo(p0) + p0.distanceTo(mid) + mid.distanceTo(end) + end.distanceTo(follow))),
      onUpdate: (tau) => {
        P.extraLean = 0.05 * Math.sin(Math.PI * clamp((tau - 0.2) / 0.75, 0, 1));
        if (!slammed && tau > 0.25 && H.wrist.y < p0.y + 0.008) { slammed = true; this.foley.tap(1, this.pan(p0)); this.foley.rustle(1, this.pan(p0)); }
        if (!slammed) return;
        const x = H.displayWrist.x + 0.035;
        for (const m of lost) if (!pushed.has(m) && m.pos.x < x) { pushed.add(m); this.slideOff(m, 1.0 + rng() * 0.4); }
      },
    });
    P.extraLean = 0;
    // the rest are knocked on by the ones already skidding into them
    for (const m of lost) if (!pushed.has(m)) this.slideOff(m, 0.9, Math.max(0, m.pos.x - H.displayWrist.x) / 1.8);
    this.piles.player.items = [];
    this.piles.playerL.items = [];
    // the hand hangs a moment, then goes back
    await this.sched.wait(0.45);
    await this.goRest(H, 0.7);
    P.sigh = 0.7;
    // he looks at it, sighs, and lays the board out again
    await this.sched.wait(0.9);
    this.opponent.sigh = 1;
    await this.sched.wait(0.5);
    this.mode = 'rebuild';
    const slots = this.matches.slots().sort((s1, s2) => s1.row - s2.row || s1.col - s2.col);
    const fromPile = slots.slice(0, this.piles.opponent.items.length);
    if (fromPile.length) await this.rebuild(this.oHand, this.piles.opponent, fromPile, false);
    const rest = slots.slice(fromPile.length);
    if (rest.length) await this.layOutFromBox(rest);
  }
  // a match knocked off the table to the right: it skids across the stone (hopping a little
  // at first), slowing and turning, goes over the edge and drops out of the shot
  slideOff(m, power, delay = 0) {
    m.state = 'flying';
    m.pile = null;
    let wait = delay;
    const v = new THREE.Vector3((1.6 + rng() * 0.7) * power, (0.1 + rng() * 0.35) * power, (rng() - 0.5) * 0.35);
    let spin = (rng() - 0.5) * 16;
    const dq = new THREE.Quaternion(), ax = new THREE.Vector3();
    const floor = TABLE_Y + MATCH_R + 0.0002;
    m.anim = (dt) => {
      if (wait > 0) { wait -= dt; return false; }
      const over = Math.hypot(m.pos.x, m.pos.z) < TABLE_R;
      v.y -= 9.81 * dt;
      m.pos.addScaledVector(v, dt);
      if (over && m.pos.y <= floor && v.y < 0) {
        // on the stone: bounce a little, then skid with friction, never stopping short
        m.pos.y = floor;
        v.y = v.y < -0.25 ? -v.y * 0.3 : 0;
        const sp = Math.hypot(v.x, v.z);
        const k = Math.max(0.45, sp - 1.2 * dt) / Math.max(sp, 1e-6);
        v.x *= k; v.z *= k;
        dq.setFromAxisAngle(UP, spin * dt);
        m.quat.premultiply(dq);
        spin *= Math.exp(-dt * 1.5);
      } else {
        // in the air (a hop, or over the edge): tumbling
        ax.set(v.z, 0, -v.x).normalize();
        dq.setFromAxisAngle(ax, (over ? 3 : 7) * dt);
        m.quat.premultiply(dq);
      }
      if (m.pos.y < TABLE_Y - 0.5 || Math.abs(m.pos.x) > 1.2) {
        m.state = 'box';
        m.mesh.visible = false;
        return true;
      }
      return false;
    };
  }

  // ---------------------------------------------------------------- rebuild at the end of a game
  async rebuild(hand, pile, slots, reverse, label = null) {
    const order = slots.slice().sort((a, b) => (reverse ? b.row - a.row : a.row - b.row) || a.col - b.col);
    while (order.length) {
      const n = Math.min(4, order.length, pile.items.length);
      if (n === 0) break;
      // the top of the heap first, then its nearest neighbours
      const top = pile.topmost(hand.tcpWorld(POSES.pinch));
      const uniq = [top, ...pile.items.filter((m) => m !== top).sort((a, b) => a.pos.distanceTo(top.pos) - b.pos.distanceTo(top.pos)).slice(0, n - 1)];
      for (const m of uniq) m.state = 'taken';
      // one grip into the heap gathers the top few together
      if (label) DIAG.begin(`${label} ${hand.side} gather`, hand);
      await this.gather(hand, [uniq[0]], { fromPile: pile, quick: true, scoop: uniq.slice(1) });
      if (label) DIAG.end();
      // lay each one in its slot
      await this.placeHeld(hand, order, label);
    }
    if (slots.length) {
      if (label) DIAG.begin(`${label} ${hand.side} rest`, hand);
      await this.goRest(hand, 0.9);
      if (label) DIAG.end();
    }
  }

  place(m, sp, slot) {
    m.state = 'moving';
    const p0 = m.pos.clone(), q0 = m.quat.clone();
    let t = 0;
    return new Promise((res) => {
      m.anim = (dt) => {
        t += dt;
        const k = smoothstep(0, 0.16, t);
        m.pos.lerpVectors(p0, sp.pos, k);
        m.quat.slerpQuaternions(q0, sp.quat, k);
        if (t >= 0.16) {
          m.pos.copy(sp.pos);
          m.quat.copy(sp.quat);
          m.state = 'row';
          m.row = slot.row;
          m.col = slot.col;
          this.foley.tick(0.45, this.pan(sp.pos));
          res();
          return true;
        }
        return false;
      };
    });
  }

  // ---------------------------------------------------------------- look-at
  updateLooks(dt) {
    const P = this.player, O = this.opponent;
    const center = new THREE.Vector3(ROW_X0, TABLE_Y, ROW_Z[1] + 0.03);
    let pl = center.clone();
    let ol = center.clone();
    if (this.mode === 'select' && this.selector === 'opponent') {
      // player two choosing: the far man studies the matches, the near one watches him
      if (this.hover) ol.copy(this.hover.pos);
      else if (this.selection.length) ol.copy(this.selection[0].pos);
      pl.copy(this.hover ? this.hover.pos : this.oHand.displayWrist);
      pl.lerp(center, 0.3);
    } else if (this.mode === 'select') {
      if (this.hover) pl.copy(this.hover.pos);
      else if (this.selection.length) pl.copy(this.selection[0].pos);
      ol.copy(this.hover ? this.hover.pos : this.pHand.tcpWorld(POSES.fist));
      ol.lerp(center, 0.3);
    } else if (this.mode === 'player-move') {
      pl.copy(this.pHand.displayWrist);
      ol.copy(this.pHand.displayWrist);
    } else if (this.mode === 'ai-think') {
      pl.copy(this.oHand.displayWrist).lerp(center, 0.6);
      ol.copy(this.thinkLook || center);
    } else if (this.mode === 'opponent-move') {
      const h = this.oActive || this.oHand;
      pl.copy(h.displayWrist);
      ol.copy(h.displayWrist);
    } else if (this.mode === 'rebuild') {
      pl.copy(this.pHand.displayWrist);
      ol.copy(this.oHand.displayWrist);
    } else if (this.mode === 'intro') {
      pl.copy(this.oHand.displayWrist).lerp(center, 0.3);
      ol.copy(this.oHand.displayWrist);
    } else if (this.mode === 'protest') {
      pl.copy(this.pHand.displayWrist);
      ol.copy(this.player.headPosition());
    }
    P.lookTarget.lerp(pl, Math.min(1, dt * 5));
    O.lookTarget.lerp(ol, Math.min(1, dt * 4));
    // the opponent bends lowest while he studies the board
    const studying = this.mode === 'ai-think' || (this.mode === 'select' && this.selector === 'opponent');
    if (O.postureBase > 0) O.postureTarget = studying ? 1.0 : this.mode === 'rebuild' ? 0.8 : 0.9;
  }

  // where the lens should be focused: the board, or the hand at work
  focusPoint() {
    const board = this._board || (this._board = new THREE.Vector3(ROW_X0, TABLE_Y, (ROW_Z[0] + ROW_Z[3]) / 2));
    const f = this._focus || (this._focus = new THREE.Vector3());
    if (this.mode === 'select' && this.hover) return f.copy(this.hover.pos);
    // the lens stays on the board, leaning a little toward the working hand
    if (this.mode === 'player-move' || this.mode === 'protest') return f.copy(board).lerp(this.pHand.displayWrist, 0.35);
    if (this.mode === 'opponent-move') return f.copy(board).lerp((this.oActive || this.oHand).displayWrist, 0.35);
    return board;
  }

  // ---------------------------------------------------------------- player input
  setHover(m) {
    if (this.hover === m) return;
    if (this.hover) this.hover.highlight = 0;
    this.hover = m;
    if (m) m.highlight = 1;
  }
  // select or deselect one match; a match in another row starts a new selection
  setSelected(m, on) {
    if (this.mode !== 'select' || !m || m.state !== 'row') return;
    const i = this.selection.indexOf(m);
    if (on) {
      if (i >= 0) return;
      if (m.row !== this.selRow) this.clearSelection();
      this.selRow = m.row;
      this.selection.push(m);
      m.select = 1;
    } else {
      if (i < 0) return;
      this.selection.splice(i, 1);
      m.select = 0;
      if (!this.selection.length) this.selRow = -1;
    }
    this.foley.tick(0.15, this.pan(m.pos));
    this.ui.setSelection(this.selection.length);
  }
  toggle(m) {
    this.setSelected(m, !this.selection.includes(m));
  }
  clearSelection() {
    for (const m of this.selection) m.select = 0;
    this.selection = [];
    this.selRow = -1;
    this.ui.setSelection(0);
  }
  confirm() {
    if (this.mode !== 'select' || !this.selection.length || !this._confirm) return;
    const list = this.selection.slice();
    for (const m of list) { m.select = 0; m.highlight = 0; }
    this.selection = [];
    this.selRow = -1;
    this.ui.setSelection(0);
    const r = this._confirm;
    this._confirm = null;
    r(list);
  }
  // open a selection for one side ('player' or, in a two-player game, 'opponent')
  waitForPlayer(side = 'player') {
    this.selector = side;
    const left = this.matches.list.filter((m) => m.state === 'row');
    if (left.length === 1) {
      // nothing to decide: the last match is his, and he takes it
      this.mode = 'forced';
      const m = left[0];
      return this.sched.wait(0.9).then(() => {
        m.select = 1;
        this.foley.tick(0.15, this.pan(m.pos));
        return this.sched.wait(0.6);
      }).then(() => { m.select = 0; return [m]; });
    }
    this.mode = 'select';
    return new Promise((res) => {
      this._confirm = res;
      if (this.autoplay) this.autoPick();
    });
  }
  // autoplay: a random legal move, now and then a whole row (three or more get raked in)
  autoPick() {
    const token = (this._autoToken = (this._autoToken || 0) + 1);
    this.sched.wait(0.8).then(() => {
      if (token !== this._autoToken || this.mode !== 'select' || !this._confirm || !this.autoplay) return;
      this.clearSelection();
      const counts = this.matches.counts();
      const rows = counts.map((c, i) => (c ? i : -1)).filter((i) => i >= 0);
      const r = rows[Math.floor(rng() * rows.length)];
      const ms = this.matches.inRow(r);
      const k = ms.length >= 3 && rng() < 0.4 ? ms.length : 1 + Math.floor(rng() * Math.min(3, ms.length));
      ms.slice(0, k).forEach((m) => this.toggle(m));
      this.confirm();
    });
  }
  // switched from the settings panel, no reload: takes over a choice already waiting
  setAutoplay(on) {
    this.autoplay = on;
    if (on && this.mode === 'select' && this._confirm) this.autoPick();
  }

  // ---------------------------------------------------------------- the loop
  async run() {
    // ?still: no game at all (debug: drive the hands from the console)
    if (this.still) { this.showBoard(); this.mode = 'idle'; return; }
    if (this.debugLoop) this.showBoard();
    // the opponent lays the first game out of the box
    if (!this.debugLoop) await this.layOutFromBox();
    await this.sched.wait(0.6);
    if (this.debugLoop) return this.runDebugLoop();
    for (;;) {
      await this.playGame();
      await this.sched.wait(1.6);
      // beaten by him: "Non, c'est impossible" sweeps the table clean
      if (!this.twoPlayer && this.loser === 'player' && (await this.ui.offerProtest(7, this.autoplay && rng() < 0.5))) {
        this.ui.say('');
        await this.protest();
      } else {
        this.ui.say('');
        this.mode = 'rebuild';
        await this.rebuildBoard();
      }
      this.mode = 'idle';
      this.starter = this.starter === 'player' ? 'opponent' : 'player';
      await this.sched.wait(1.2);
    }
  }
  showBoard() {
    this.matches.layout();
    for (const m of this.matches.list) m.mesh.visible = true;
  }

  async playGame() {
    this.games++;
    // the players setting (changed in the settings panel) takes effect from a fresh game
    const two = this.ui.players === 'two';
    if (two !== this.twoPlayer) { this.twoPlayer = two; this.starter = 'player'; this._told = false; }
    let turn = this.starter;
    if (this.twoPlayer && !this._told) {
      this._told = true;
      this.ui.say('Player one plays this side, player two the man across the table.', 3.4);
      await this.sched.wait(3.6);
    }
    this.ui.say(`${this.who(turn)} ${this.twoPlayer || turn === 'opponent' ? 'begins' : 'begin'}.`, 2.2);
    await this.sched.wait(turn === 'player' || this.twoPlayer ? 0.4 : 1.6);
    let first = true;
    for (;;) {
      const counts = this.matches.counts();
      const total = counts.reduce((a, b) => a + b, 0);
      if (total === 0) break;
      const human = turn === 'player' || this.twoPlayer;
      if (human) {
        // a person chooses: the near player, or (two players) whichever side's turn it is
        const name = this.who(turn);
        let prompt;
        if (total === 1) prompt = this.twoPlayer ? `The last match is ${name.toLowerCase()}'s.` : 'The last match is yours.';
        else if (this.games === 1 && first) prompt = this.twoPlayer ? `${name}: choose matches from a single row.` : 'Choose matches from a single row.';
        else prompt = this.twoPlayer ? `${name}'s move.` : 'Your move.';
        this.ui.say(prompt, total === 1 ? 2.5 : 0);
        const list = await this.waitForPlayer(turn);
        this.setHover(null);
        this.ui.say('');
        if (turn === 'player') {
          this.mode = 'player-move';
          this.pHand = this.choosePlayerHand(list.map((m) => m.pos));
          await this.takeTurn(this.pHand, list, this.pileFor(this.pHand));
          this.pHand = this.pHandL;
        } else {
          this.mode = 'opponent-move';
          await this.takeTurn(this.oHand, list, this.piles.opponent);
        }
      } else {
        this.mode = 'ai-think';
        this.ui.say('');
        await this.think(counts, total);
        const mv = chooseMove(counts, rng);
        // take contiguous matches from the end of the row nearest his hand
        const hx = this.oHand.displayWrist.x;
        const ordered = this.matches.inRow(mv.row);
        const fromLeft = Math.abs(ordered[0].pos.x - hx) <= Math.abs(ordered[ordered.length - 1].pos.x - hx);
        const pick = (fromLeft ? ordered : ordered.reverse()).slice(0, mv.take);
        this.mode = 'opponent-move';
        this.ui.say(`He takes ${WORDS[mv.take]}.`, 2.4);
        await this.takeTurn(this.oHand, pick, this.piles.opponent);
      }
      first = false;
      const after = this.matches.counts().reduce((a, b) => a + b, 0);
      if (after === 0) {
        const loser = turn;
        this.loser = loser;
        const winner = loser === 'player' ? 'opponent' : 'player';
        this.score[winner]++;
        this.saveScore();
        this.mode = 'over';
        if (this.twoPlayer) this.ui.say(`${this.who(loser)} took the last match. ${this.who(winner)} wins.`, 4.5);
        else this.ui.say(loser === 'player' ? 'You took the last match. He wins.' : 'He took the last match. You win.', 4.5);
        this.opponent.sigh = loser === 'player' ? 0.6 : 1.0;
        this.player.sigh = loser === 'player' ? 1.0 : 0.4;
        break;
      }
      turn = turn === 'player' ? 'opponent' : 'player';
    }
  }

  async think(counts, total) {
    const dur = 0.9 + rand(0, 1.3) + (total > 10 ? 0.8 : 0);
    this.opponent.sigh = 0.5;
    const rowsLeft = counts.map((c, i) => (c ? i : -1)).filter((i) => i >= 0);
    const steps = Math.max(2, Math.round(dur / 0.55));
    for (let s = 0; s < steps; s++) {
      const r = rowsLeft[Math.floor(rng() * rowsLeft.length)];
      const ms = this.matches.inRow(r);
      const m = ms[Math.floor(rng() * ms.length)];
      this.thinkLook = m ? m.pos.clone() : null;
      await this.sched.wait(dur / steps);
    }
  }

  // ---------------------------------------------------------------- debug: ?debug=loop
  // The player takes the whole board apart one match at a time and lays it out again,
  // then the opponent does the same, forever. Every move is measured (see DIAG):
  // failures are logged to the console and kept in window.__diag.
  async runDebugLoop() {
    DIAG.on = true;
    window.__diag = DIAG;
    for (let cycle = 1; ; cycle++) {
      for (const who of this.debugFirst === 'opponent' ? ['opponent', 'player'] : ['player', 'opponent']) {
        this.mode = who === 'player' ? 'player-move' : 'opponent-move';
        this.ui.say(`Debug ${cycle}: ${who === 'player' ? 'you take' : 'he takes'} the board apart.`, 2.5);
        const rows = who === 'player' ? [3, 2, 1, 0] : [0, 1, 2, 3];
        // first he rakes each row of three or more into his pile and lays it out again
        if (who === 'player') {
          for (const r of [2, 1, 0]) {
            const row = this.matches.inRow(r);
            if (row.length < 3) continue;
            const hand = this.choosePlayerHand(row.map((m) => m.pos));
            this.pHand = hand;
            this.mode = 'player-move';
            this.ui.say(`Debug ${cycle}: you rake in row ${r + 1}, then lay it out again.`, 2.5);
            DIAG.begin(`c${cycle} player ${hand.side} rake r${r}`, hand);
            await this.takeTurn(hand, row, this.pileFor(hand));
            DIAG.end();
            this.mode = 'rebuild';
            await this.rebuildBy('player', `c${cycle} player re-lay r${r}`);
            this.pHand = this.pHandL;
          }
          this.mode = 'player-move';
          this.ui.say(`Debug ${cycle}: you take the board apart.`, 2.5);
        }
        for (const r of rows) {
          for (const m of this.matches.inRow(r)) {
            const hand = who === 'player' ? this.choosePlayerHand([m.pos]) : this.oHand;
            if (who === 'player') this.pHand = hand;
            DIAG.begin(`c${cycle} ${who} ${hand.side} take r${m.row}c${m.col}`, hand);
            await this.takeTurn(hand, [m], this.pileFor(hand));
            DIAG.end();
            this.pHand = this.pHandL;
          }
        }
        this.mode = 'rebuild';
        this.ui.say(`Debug ${cycle}: ${who === 'player' ? 'you lay' : 'he lays'} it out again.`, 2.5);
        await this.rebuildBy(who, `c${cycle} ${who}`);
      }
      const sum = DIAG.summary();
      console.info(`[diag] after cycle ${cycle}: ${sum.failing} of ${sum.moves} moves flagged`, sum.fails);
      this.ui.say(`Debug cycle ${cycle}: ${sum.failing} of ${sum.moves} moves flagged.`, 4);
      await this.sched.wait(1);
    }
  }
  // one side lays out every empty slot from its own pile(s)
  async rebuildBy(who, label) {
    const slots = this.matches.slots().filter((sl) => !this.matches.list.some((m) => m.state === 'row' && m.row === sl.row && m.col === sl.col));
    const P = this.piles;
    if (who === 'opponent') return this.rebuild(this.oHand, P.opponent, slots, false, label);
    const { left, right } = this.splitPlayerSlots(slots, P.playerL.items.length);
    this.pHand = this.pHandL;
    await this.rebuild(this.pHandL, P.playerL, left, true, label);
    this.pHand = this.pHandR;
    await this.rebuild(this.pHandR, P.player, right, true, label);
    this.pHand = this.pHandL;
  }
  // the left hand takes the nL slots it reaches most easily (relative to the right hand)
  splitPlayerSlots(slots, nL) {
    const pos = (sl) => this.matches.slotPose(sl.row, sl.col, false).pos;
    const pref = slots.map((sl) => ({ sl, d: this.handCost(this.pHandL, [pos(sl)]) - this.handCost(this.pHandR, [pos(sl)]) - pos(sl).x * 0.05 }));
    pref.sort((a, b) => a.d - b.d);
    return { left: pref.slice(0, nL).map((p) => p.sl), right: pref.slice(nL).map((p) => p.sl) };
  }

  async rebuildBoard() {
    const slots = this.matches.slots();
    const P = this.piles;
    // the player re-lays the rows nearest him, the opponent the far ones; counts follow the piles
    const nL = P.playerL.items.length, nR = P.player.items.length;
    const byNear = slots.slice().sort((a, b) => b.row - a.row || a.col - b.col);
    const mine = byNear.slice(0, nL + nR);
    const theirs = byNear.slice(nL + nR);
    // his left hand takes the slots it reaches most easily, the right hand the rest
    const { left, right } = this.splitPlayerSlots(mine, nL);
    const playerSide = async () => {
      this.pHand = this.pHandL;
      await this.rebuild(this.pHandL, P.playerL, left, true);
      this.pHand = this.pHandR;
      await this.rebuild(this.pHandR, P.player, right, true);
      this.pHand = this.pHandL;
    };
    await Promise.all([playerSide(), this.rebuild(this.oHand, P.opponent, theirs, false)]);
  }
}
