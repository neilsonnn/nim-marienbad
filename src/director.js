// Game flow and choreography: who moves, what the hands do, where the heads look.
import * as THREE from 'three';
import { POSES, lerpPose } from './handModel.js';
import { TABLE_Y, ROWS, ROW_Z, ROW_X0, ROW_DX, Pile, tableQuat, MATCH_R } from './world.js';
import { chooseMove } from './nim.js';
import { clamp, lerp, smoothstep, DEG, rand, rng, mulberry32, easeOutCubic } from './util.js';

const UP = new THREE.Vector3(0, 1, 0);
const WORDS = ['none', 'one', 'two', 'three', 'four', 'five', 'six', 'seven'];

export class Director {
  constructor(ctx) {
    Object.assign(this, ctx); // sched, matches, player, opponent, ui, foley, camera
    this.pHand = this.player.hands.left;
    this.oHand = this.opponent.hands.right;
    this.oSupport = this.opponent.hands.left;
    const pr = mulberry32(99);
    this.piles = {
      player: new Pile(new THREE.Vector3(0.078, TABLE_Y, 0.262), { x: 0.03, z: 0.018 }, pr),
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
    // opponent's support hand: an occasional double tap of the index finger
    let tap = -1, tapNext = 5, tapFinger = 0;
    this.oSupport.idle = (dt, f) => {
      tapNext -= dt;
      if (tapNext <= 0 && tap < 0) { tap = 0; tapNext = 7 + rand(0, 9); tapFinger = rng() < 0.7 ? 0 : 1; }
      if (tap >= 0) {
        const prev = tap;
        tap += dt;
        const dur = 0.9;
        const k = tap / dur;
        const lift = Math.max(0, Math.sin(k * Math.PI * 2)) * (1 - k);
        f[tapFinger * 4] -= lift * 26;
        f[tapFinger * 4 + 1] -= lift * 6;
        for (const hit of [0.5, 1.0]) if (prev / dur < hit && k >= hit) this.foley.tap(0.35, 0.25);
        if (tap > dur) tap = -1;
      }
    };
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
    return lerp(60, 34, smoothstep(0.2, 0.8, d)) * DEG;
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
      const at = m.pos.clone();
      at.y = m.pos.y + 0.0024;
      const q = hand.graspQuat(m.axis(), this.approachDir(hand, at), this.reachPitch(hand, at));
      const hover = at.clone();
      hover.y += first ? 0.045 : 0.02;
      const open = first ? POSES.reach : POSES.holdOpen;
      const close = hand.held.length >= 1 ? POSES.holdWide : POSES.hold;
      await hand.moveTo({ tcp: hover, quat: q, pose: open, poseWin: [0.05, 0.65], arc: first ? undefined : 0.012, speed: quick ? 0.62 : first ? 1.0 : 0.8 });
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

  async goRest(hand, speed = 1) {
    await hand.moveTo({ wrist: hand.restWrist, quat: hand.restQuat, pose: hand.restPose, plant: 1, poseWin: [0.3, 1.0], speed: 1.1 * speed });
    this.foley.tap(0.45, this.pan(hand.restWrist));
  }

  async takeTurn(hand, list, pile) {
    this.foley.rustle(1, this.pan(hand.wrist));
    for (const m of list) m.state = 'taken';
    await this.gather(hand, list);
    await this.dropOnPile(hand, pile);
    await this.goRest(hand);
  }

  // ---------------------------------------------------------------- rebuild at the end of a game
  async rebuild(hand, pile, slots, reverse) {
    const order = slots.slice().sort((a, b) => (reverse ? b.row - a.row : a.row - b.row) || a.col - b.col);
    while (order.length) {
      const n = Math.min(4, order.length, pile.items.length);
      if (n === 0) break;
      // the top of the heap first, then its nearest neighbours
      const top = pile.topmost(hand.tcpWorld(POSES.pinch));
      const uniq = [top, ...pile.items.filter((m) => m !== top).sort((a, b) => a.pos.distanceTo(top.pos) - b.pos.distanceTo(top.pos)).slice(0, n - 1)];
      for (const m of uniq) m.state = 'taken';
      // one grip into the heap gathers the top few together
      await this.gather(hand, [uniq[0]], { fromPile: pile, quick: true, scoop: uniq.slice(1) });
      // lay each one in its slot
      while (hand.held.length && order.length) {
        const slot = order.shift();
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
      }
    }
    await this.goRest(hand, 0.9);
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
  }

  // ---------------------------------------------------------------- player input
  setHover(m) {
    if (this.hover === m) return;
    if (this.hover) this.hover.highlight = 0;
    this.hover = m;
    if (m) m.highlight = 1;
  }
  toggle(m) {
    if (this.mode !== 'select' || !m || m.state !== 'row') return;
    if (m.row !== this.selRow) this.clearSelection();
    this.selRow = m.row;
    const i = this.selection.indexOf(m);
    if (i >= 0) { this.selection.splice(i, 1); m.select = 0; }
    else { this.selection.push(m); m.select = 1; }
    if (!this.selection.length) this.selRow = -1;
    this.foley.tick(0.15, this.pan(m.pos));
    this.ui.setSelection(this.selection.length);
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
    await this.ui.waitForStart();
    this.foley.unlock();
    await this.sched.wait(0.6);
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
        this.ui.say(this.games === 1 && total === 16 ? 'Choose matches from a single row.' : 'Your move.', 0);
        const list = await this.waitForPlayer();
        this.setHover(null);
        this.ui.say('');
        this.mode = 'player-move';
        await this.takeTurn(this.pHand, list, this.piles.player);
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

  async rebuildBoard() {
    const slots = this.matches.slots();
    // nearer rows to whoever is nearer; counts follow each pile
    const np = this.piles.player.items.length;
    const byNear = slots.slice().sort((a, b) => b.row - a.row || a.col - b.col);
    const mine = byNear.slice(0, np);
    const theirs = byNear.slice(np);
    await Promise.all([
      this.rebuild(this.pHand, this.piles.player, mine, true),
      this.rebuild(this.oHand, this.piles.opponent, theirs, false),
    ]);
  }
}
