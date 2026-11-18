// Game flow and choreography: who moves, what the hands do, where the heads look.
import * as THREE from 'three';
import { POSES, lerpPose } from './handModel.js';
import { TABLE_Y, TABLE_R, ROWS, ROW_Z, ROW_X0, ROW_DX, Pile, tableQuat, MATCH_R } from './world.js';
import { chooseMove } from './nim.js';
import { DIAG } from './actors.js';
import { clamp, lerp, smoothstep, DEG, rand, rng, mulberry32, easeOutCubic } from './util.js';

const UP = new THREE.Vector3(0, 1, 0);
const WORDS = ['none', 'one', 'two', 'three', 'four', 'five', 'six', 'seven'];

export class Director {
  constructor(ctx) {
    Object.assign(this, ctx); // sched, matches, player, opponent, ui, foley, camera
    this.pHandL = this.player.hands.left;   // the hand in the shot: left and centre of the board
    this.pHandR = this.player.hands.right;  // rests on his thigh, comes up for the right side
    this.pHand = this.pHandL;               // whichever is working (look-at & focus follow it)
    this.oHand = this.opponent.hands.right;
    this.oSupport = this.opponent.hands.left;
    const pr = mulberry32(99);
    this.piles = {
      player: new Pile(new THREE.Vector3(0.078, TABLE_Y, 0.262), { x: 0.03, z: 0.018 }, pr),
      playerL: new Pile(new THREE.Vector3(-0.268, TABLE_Y, 0.158), { x: 0.02, z: 0.016 }, pr),
      opponent: new Pile(new THREE.Vector3(-0.055, TABLE_Y, -0.29), { x: 0.03, z: 0.016 }, pr),
    };
    this.score = { player: 0, opponent: 0 };
    try {
      const s = JSON.parse(localStorage.getItem('nim-score') || 'null');
      if (s && typeof s.player === 'number') this.score = s;
    } catch (e) { /* storage unavailable */ }
    this.mode = 'intro';
    this.hover = null;
    this.selection = [];
    this.selRow = -1;
    this.starter = 'player';
    this.games = 0;
    POSES.holdOpen = lerpPose(POSES.holdWide, POSES.reach, 0.55);
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

  // ---------------------------------------------------------------- helpers
  reachPitch(hand, target) {
    const S = hand.arm.S;
    const d = Math.hypot(target.x - S.x, target.z - S.z);
    // the seated player's shoulders are low over the stone: a flatter hand spares his wrist
    const near = hand.actor === this.player ? 38 : 60;
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
    for (const m of list) m.state = 'taken';
    await this.gather(hand, list);
    await this.dropOnPile(hand, pile);
    await this.goRest(hand);
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
        const h = hand.held[hand.held.length - 1];
        const m = h.m;
        hand.release([m]);
        await this.place(m, sp, slot);
        await hand.moveTo({ tcp: at.clone().setY(at.y + 0.02), quat: q, pose: hand.held.length ? pose : POSES.reach, dur: 0.11, arc: 0, poseWin: [0, 1] });
        if (label) DIAG.end();
      }
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
    if (this.mode === 'select') {
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
    } else if (this.mode === 'ai-move') {
      pl.copy(this.oHand.displayWrist);
      ol.copy(this.oHand.displayWrist);
    } else if (this.mode === 'rebuild') {
      pl.copy(this.pHand.displayWrist);
      ol.copy(this.oHand.displayWrist);
    }
    P.lookTarget.lerp(pl, Math.min(1, dt * 5));
    O.lookTarget.lerp(ol, Math.min(1, dt * 4));
    // the opponent bends lowest while he studies the board
    if (O.postureBase > 0) O.postureTarget = this.mode === 'ai-think' ? 1.0 : this.mode === 'rebuild' ? 0.8 : 0.9;
  }

  // where the lens should be focused: the board, or the hand at work
  focusPoint() {
    const board = this._board || (this._board = new THREE.Vector3(ROW_X0, TABLE_Y, (ROW_Z[0] + ROW_Z[3]) / 2));
    const f = this._focus || (this._focus = new THREE.Vector3());
    if (this.mode === 'select' && this.hover) return f.copy(this.hover.pos);
    // the lens stays on the board, leaning a little toward the working hand
    if (this.mode === 'player-move') return f.copy(board).lerp(this.pHand.displayWrist, 0.35);
    if (this.mode === 'ai-move') return f.copy(board).lerp(this.oHand.displayWrist, 0.35);
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
  waitForPlayer() {
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
      if (this.autoplay) {
        this.sched.wait(0.8).then(() => {
          const counts = this.matches.counts();
          const rows = counts.map((c, i) => (c ? i : -1)).filter((i) => i >= 0);
          const r = rows[Math.floor(rng() * rows.length)];
          const ms = this.matches.inRow(r);
          const k = 1 + Math.floor(rng() * Math.min(3, ms.length));
          ms.slice(0, k).forEach((m) => this.toggle(m));
          this.confirm();
        });
      }
    });
  }

  // ---------------------------------------------------------------- the loop
  async run() {
    if (this.autoplay || this.debugLoop) this.ui.dismissTitle();
    else await this.ui.waitForStart();
    this.foley.unlock();
    await this.sched.wait(0.6);
    if (this.debugLoop) return this.runDebugLoop();
    for (;;) {
      await this.playGame();
      await this.sched.wait(1.6);
      this.ui.say('');
      this.mode = 'rebuild';
      await this.rebuildBoard();
      this.mode = 'idle';
      this.starter = this.starter === 'player' ? 'opponent' : 'player';
      await this.sched.wait(1.2);
    }
  }

  async playGame() {
    this.games++;
    let turn = this.starter;
    this.ui.say(turn === 'player' ? 'You begin.' : 'He begins.', 2.2);
    await this.sched.wait(turn === 'player' ? 0.4 : 1.6);
    for (;;) {
      const counts = this.matches.counts();
      const total = counts.reduce((a, b) => a + b, 0);
      if (total === 0) break;
      if (turn === 'player') {
        this.ui.say(total === 1 ? 'The last match is yours.' : this.games === 1 && total === 16 ? 'Choose matches from a single row.' : 'Your move.', total === 1 ? 2.5 : 0);
        const list = await this.waitForPlayer();
        this.setHover(null);
        this.ui.say('');
        this.mode = 'player-move';
        this.pHand = this.choosePlayerHand(list.map((m) => m.pos));
        await this.takeTurn(this.pHand, list, this.pileFor(this.pHand));
        this.pHand = this.pHandL;
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
        this.mode = 'ai-move';
        this.ui.say(`He takes ${WORDS[mv.take]}.`, 2.4);
        await this.takeTurn(this.oHand, pick, this.piles.opponent);
      }
      const after = this.matches.counts().reduce((a, b) => a + b, 0);
      if (after === 0) {
        const loser = turn;
        if (loser === 'player') this.score.opponent++;
        else this.score.player++;
        try { localStorage.setItem('nim-score', JSON.stringify(this.score)); } catch (e) { /* ignore */ }
        this.ui.setScore(this.score);
        this.mode = 'over';
        this.ui.say(loser === 'player' ? 'You took the last match. He wins.' : 'He took the last match. You win.', 4.5);
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
        this.mode = who === 'player' ? 'player-move' : 'ai-move';
        this.ui.say(`Debug ${cycle}: ${who === 'player' ? 'you take' : 'he takes'} the board apart.`, 2.5);
        const rows = who === 'player' ? [3, 2, 1, 0] : [0, 1, 2, 3];
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
