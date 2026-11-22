// ?ik: every IK target drawn over the finished frame, through the bodies. For each arm:
// the wrist goal asked of it, where the wrist actually got to, the elbow, and the pole
// target the elbow is pulled toward; for each leg the knee and its pole; each head's
// look target; and where the hand's current move is headed.
import * as THREE from 'three';

const COL = {
  goal: 0xffd400, // wrist goal (what the hand asked for)
  wrist: 0x00e5ff, // solved wrist
  elbow: 0xff2bd6, // elbow, and the pole target it is pulled toward
  joint: 0xffffff, // shoulders, hips, the bones between them
  knee: 0x6bff4a, // knees and their poles
  look: 0xff8a00, // head look target
};

// (colors kept as written: the renderer outputs linear values straight to the screen)
const raw = (c) => new THREE.Color().setHex(c, THREE.LinearSRGBColorSpace);
const mat = (color, wire = false) => new THREE.MeshBasicMaterial({ color: raw(color), wireframe: wire, depthTest: false, depthWrite: false, transparent: true, opacity: 0.95 });
const lineMat = (color, opacity = 0.9) => new THREE.LineBasicMaterial({ color: raw(color), depthTest: false, depthWrite: false, transparent: true, opacity });

export class IKDebug {
  constructor(actors) {
    this.actors = actors;
    this.scene = new THREE.Scene();
    const ball = new THREE.SphereGeometry(1, 14, 10);
    const diamond = new THREE.OctahedronGeometry(1);
    this.dots = [];
    const dot = (geo, color, r, get, wire = false) => {
      const m = new THREE.Mesh(geo, mat(color, wire));
      m.scale.setScalar(r);
      m.renderOrder = 10;
      this.scene.add(m);
      this.dots.push({ m, get });
    };
    // lines, rebuilt every frame: [color] -> list of point pairs
    this.lines = {};
    for (const [k, c, o] of [['bone', COL.joint, 0.75], ['pole', COL.elbow, 0.9], ['reach', COL.goal, 0.9], ['knee', COL.knee, 0.8], ['look', COL.look, 0.55]]) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(64 * 6), 3));
      const l = new THREE.LineSegments(g, lineMat(c, o));
      l.frustumCulled = false;
      l.renderOrder = 9;
      this.scene.add(l);
      this.lines[k] = { l, pairs: [] };
    }
    this.pairs = [];
    for (const a of actors) {
      for (const side of ['left', 'right']) {
        const arm = a.arms[side], hand = a.hands[side];
        dot(ball, COL.joint, 0.011, () => arm.S);
        dot(ball, COL.elbow, 0.016, () => arm.E);
        dot(diamond, COL.elbow, 0.024, () => arm.poleTarget);
        dot(ball, COL.wrist, 0.013, () => arm.W);
        dot(ball, COL.goal, 0.019, () => arm.goal, true);
        if (hand) dot(diamond, COL.goal, 0.014, () => (hand.seg ? hand.seg.to : null), true);
        this.pairs.push(['bone', () => arm.S, () => arm.E], ['bone', () => arm.E, () => arm.W]);
        this.pairs.push(['pole', () => arm.E, () => arm.poleTarget]);
        this.pairs.push(['reach', () => arm.W, () => arm.goal]);
        if (hand) this.pairs.push(['reach', () => arm.goal, () => (hand.seg ? hand.seg.to : null)]);
      }
      for (const leg of a.legs) {
        dot(ball, COL.joint, 0.011, () => leg.H);
        dot(ball, COL.knee, 0.016, () => leg.K);
        dot(diamond, COL.knee, 0.022, () => leg.poleTarget);
        dot(ball, COL.goal, 0.017, () => leg.ankle, true);
        this.pairs.push(['bone', () => leg.H, () => leg.K], ['bone', () => leg.K, () => leg.A]);
        this.pairs.push(['knee', () => leg.K, () => leg.poleTarget]);
      }
      const head = new THREE.Vector3();
      dot(ball, COL.look, 0.02, () => a.lookTarget, true);
      this.pairs.push(['look', () => a.headPosition(head), () => a.lookTarget]);
    }
    this._legend();
    // sliders for every elbow target pinned beside a shoulder
    for (const a of actors) for (const side of ['left', 'right']) if (a.arms[side].poleOffset) this._elbowPanel(a, side);
  }

  // live sliders for one elbow's pinned target, and a copy button for the config line
  _elbowPanel(actor, side) {
    const arm = actor.arms[side], o = arm.poleOffset;
    const el = document.createElement('div');
    el.style.cssText = 'position:fixed;right:10px;top:10px;z-index:60;font:11px/1.4 ui-monospace,Menlo,monospace;color:#ddd;background:rgba(0,0,0,.72);padding:8px 10px;border-radius:8px;width:260px';
    const rows = [
      ['out to his side', () => o.x, (v) => (o.x = v), -0.5, 3],
      ['up (− is down)', () => o.y, (v) => (o.y = v), -2.5, 1.5],
      ['forward', () => o.z, (v) => (o.z = v), -2, 2],
      ['pull strength', () => arm.poleWeight, (v) => (arm.poleWeight = v), 0, 4],
    ];
    const head = document.createElement('div');
    head.textContent = `${actor.name} ${side} elbow target (m from shoulder)`;
    head.style.cssText = 'color:#ff2bd6;margin-bottom:6px';
    el.appendChild(head);
    const out = document.createElement('pre');
    out.style.cssText = 'margin:6px 0 0;white-space:pre-wrap;color:#aaa;font:inherit';
    const line = () => {
      const f = (v) => +v.toFixed(2);
      return `poleOffsets: { ${side}: [${f(o.x)}, ${f(o.y)}, ${f(o.z)}] },\npoleWeights: { ${side}: ${f(arm.poleWeight)} },`;
    };
    for (const [label, get, set, lo, hi] of rows) {
      const r = document.createElement('label');
      r.style.cssText = 'display:grid;grid-template-columns:96px 1fr 38px;gap:6px;align-items:center';
      const name = document.createElement('span');
      name.textContent = label;
      const input = document.createElement('input');
      Object.assign(input, { type: 'range', min: lo, max: hi, step: 0.01, value: get() });
      input.style.cssText = 'width:100%;accent-color:#ff2bd6';
      const val = document.createElement('span');
      val.style.textAlign = 'right';
      val.textContent = get().toFixed(2);
      input.addEventListener('input', () => { set(+input.value); val.textContent = (+input.value).toFixed(2); out.textContent = line(); });
      r.append(name, input, val);
      el.appendChild(r);
    }
    out.textContent = line();
    const btn = document.createElement('button');
    btn.textContent = 'copy';
    btn.style.cssText = 'margin-top:6px;font:inherit;color:#111;background:#ddd;border:0;border-radius:4px;padding:2px 10px;cursor:pointer';
    btn.addEventListener('click', async () => {
      const text = line();
      try { await navigator.clipboard.writeText(text); }
      catch {
        const ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
      }
      btn.textContent = 'copied';
      setTimeout(() => (btn.textContent = 'copy'), 1200);
    });
    el.append(out, btn);
    document.body.appendChild(el);
  }

  update() {
    for (const { m, get } of this.dots) {
      const p = get();
      m.visible = !!p;
      if (p) m.position.copy(p);
    }
    for (const k in this.lines) this.lines[k].n = 0;
    for (const [k, ga, gb] of this.pairs) {
      const a = ga(), b = gb();
      if (!a || !b) continue;
      const L = this.lines[k], arr = L.l.geometry.attributes.position.array, i = L.n * 6;
      if (i + 6 > arr.length) continue;
      arr[i] = a.x; arr[i + 1] = a.y; arr[i + 2] = a.z;
      arr[i + 3] = b.x; arr[i + 4] = b.y; arr[i + 5] = b.z;
      L.n++;
    }
    for (const k in this.lines) {
      const L = this.lines[k];
      L.l.geometry.setDrawRange(0, L.n * 2);
      L.l.geometry.attributes.position.needsUpdate = true;
    }
  }

  render(renderer, camera) {
    this.update();
    const ac = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setRenderTarget(null);
    renderer.render(this.scene, camera);
    renderer.autoClear = ac;
  }

  _legend() {
    const el = document.createElement('div');
    el.style.cssText = 'position:fixed;left:10px;bottom:10px;z-index:50;font:11px/1.5 ui-monospace,Menlo,monospace;color:#ddd;background:rgba(0,0,0,.6);padding:6px 9px;border-radius:6px;pointer-events:none';
    const hex = (c) => '#' + c.toString(16).padStart(6, '0');
    el.innerHTML = [
      [COL.goal, '○ wrist goal  ◇ where the move is headed'],
      [COL.wrist, '● solved wrist'],
      [COL.elbow, '● elbow  ◆ elbow pole target'],
      [COL.knee, '● knee  ◆ knee pole target'],
      [COL.joint, '● shoulder / hip, bones'],
      [COL.look, '○ look target'],
    ].map(([c, t]) => `<div><span style="color:${hex(c)}">■</span> ${t}</div>`).join('');
    document.body.appendChild(el);
  }
}
