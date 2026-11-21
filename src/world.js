// Table, chrome band, matchbox, and the sixteen matches.
import * as THREE from 'three';
import { mulberry32 } from './util.js';
import { makeTableMaterial, makeMetalMaterial, makePaperMaterial, makeMatchMaterial, makeGlowMaterial } from './materials.js';

export const TABLE_Y = 0.74;
export const TABLE_R = 0.37;

// Layers: 0 = casts shadows & appears in the mirror, 1 = table top, 2 = main view only
export const L_MAIN_ONLY = 2;
export const L_NO_MIRROR = 3; // main + shadow, not reflected (bodies: their reflections are invisible)
export const L_NO_SHADOW = 4; // main + mirror, casts no shadow
export const L_TABLE = 1;
export const L_MIRROR_ONLY = 5; // seen only in the stone's reflection

export function buildTable(scene) {
  const R = TABLE_R;
  // The stone slab: flat top, a small rounded arris dropping into the metal band.
  // (lathe profiles run bottom to top along the outside, so their faces point out)
  const stone = [[0.0004, 0], [R - 0.0055, 0]];
  for (let i = 1; i <= 6; i++) {
    const a = (i / 6) * Math.PI * 0.5;
    stone.push([R - 0.0055 + Math.sin(a) * 0.0012, -0.0012 + Math.cos(a) * 0.0012]);
  }
  stone.push([R - 0.0043, -0.012], [R - 0.007, -0.0125]);
  const top = new THREE.Mesh(new THREE.LatheGeometry(stone.reverse().map(([r, y]) => new THREE.Vector2(r, y)), 224), makeTableMaterial());
  top.position.y = TABLE_Y;
  top.layers.set(L_TABLE);
  top.name = 'tabletop';
  scene.add(top);

  // The polished metal siding the slab sits in (as in the shot: a bright convex band
  // all round the edge). Its lip stands a millimetre proud of the stone with a fine
  // dark seam; the convex face catches the lamp along its length.
  const band = [[R - 0.020, -0.0315], [R - 0.0045, -0.0315]];
  const cx = R - 0.0005, cy = -0.0153, rx = 0.0060, ry = 0.0163;
  for (let i = 0; i <= 24; i++) {
    const t = -Math.PI / 2 + (i / 24) * Math.PI;
    band.push([cx + Math.cos(t) * rx, cy + Math.sin(t) * ry]);
  }
  band.push([R - 0.0028, 0.0009], [R - 0.0039, 0.0004], [R - 0.0042, -0.0025]);
  const rim = new THREE.Mesh(new THREE.LatheGeometry(band.map(([r, y]) => new THREE.Vector2(r, y)), 256), makeMetalMaterial({ albedo: 0.86, rough: 0.045, aniso: 0, strip: 0.75 }));
  rim.position.y = TABLE_Y;
  rim.layers.set(L_MAIN_ONLY);
  rim.name = 'siding';
  scene.add(rim);

  // underside (no pedestal, foot or floor: the top floats in the dark)
  const under = new THREE.Mesh(new THREE.CircleGeometry(R, 64).rotateX(Math.PI / 2), makeMetalMaterial({ albedo: 0.05, rough: 0.6 }));
  under.position.y = TABLE_Y - 0.0315;
  under.layers.set(L_MAIN_ONLY);
  scene.add(under);

  // matchbox at the right edge of the table, its drawer pushed half open, as in the shot
  const box = buildMatchbox();
  box.position.set(0.300, TABLE_Y, 0.078);
  box.rotation.y = Math.PI - 0.30; // drawer toward the board, so the frame edge does not cut it
  scene.add(box);

  // A tall bright strip somewhere behind the opponent (a lit doorway, out of frame).
  // It never shows directly: only its reflection, a wavering streak down the right
  // side of the stone that his arm slightly cuts into, as in the shot.
  const glow = new THREE.Mesh(new THREE.PlaneGeometry(0.26, 2.4), makeGlowMaterial());
  glow.position.set(0.585, 2.15, -2.4);
  glow.rotation.z = -0.1; // leans so its reflection runs straight down the frame
  glow.layers.set(L_MIRROR_ONLY);
  glow.frustumCulled = false;
  scene.add(glow);

  return { top, rim, box, glow };
}

// ------------------------------------------------------------------ the matchbox
// Sleeve (printed, striker strips, one end open) with the drawer slid out of that end,
// a layer of matches lying in it heads-first. Origin: centre of the sleeve's base.
function buildMatchbox() {
  const g = new THREE.Group();
  g.name = 'matchbox';
  const L = 0.053, H = 0.015, Wd = 0.036;
  // sleeve: a box without its +x end (the drawer comes out there)
  const sg = new THREE.BoxGeometry(L, H, Wd, 2, 1, 2);
  const keep = [];
  const idx = sg.index.array;
  for (const grp of sg.groups) if (grp.materialIndex !== 0) for (let i = grp.start; i < grp.start + grp.count; i++) keep.push(idx[i]);
  sg.setIndex(keep);
  sg.clearGroups();
  const sleeve = new THREE.Mesh(sg, makePaperMaterial());
  sleeve.position.y = H / 2;
  g.add(sleeve);
  // drawer: an open-topped tray of thin board
  const t = 0.0007, tl = L - 0.002, th = H - 0.0018, tw = Wd - 0.0018;
  const parts = [
    [tl, t, tw, 0, t / 2, 0],
    [tl, th, t, 0, th / 2, tw / 2 - t / 2], [tl, th, t, 0, th / 2, -tw / 2 + t / 2],
    [t, th, tw - 2 * t, tl / 2 - t / 2, th / 2, 0], [t, th, tw - 2 * t, -tl / 2 + t / 2, th / 2, 0],
  ].map(([x, y, z, px, py, pz]) => new THREE.BoxGeometry(x, y, z).translate(px, py, pz));
  const tray = new THREE.Mesh(mergeGeometries(parts), makePaperMaterial({ plain: true }));
  const out = 0.021; // how far the drawer stands out of the sleeve
  tray.position.set(out, 0.0009, 0);
  g.add(tray);
  // matches in the drawer: one layer side by side, a few more on top, heads to the open end
  const mg = matchGeometry();
  const mm = makeMatchMaterial();
  mm.uniforms.uSeed.value = 3.7;
  const rnd = mulberry32(11);
  const n = Math.floor((tw - 2 * t) / (MATCH_R * 2.15));
  const lay = (k, layer) => {
    const m = new THREE.Mesh(mg, mm);
    const z = -tw / 2 + t + MATCH_R * 1.1 + k * MATCH_R * 2.15 + (layer ? MATCH_R * 1.07 : 0);
    m.position.set(out + 0.0005 + (rnd() - 0.5) * 0.0016, 0.0009 + t + MATCH_R * (1 + layer * 1.85), z);
    m.rotation.set((rnd() - 0.5) * 0.04, Math.PI / 2 + (rnd() - 0.5) * 0.05, 0);
    g.add(m);
  };
  for (let k = 0; k < n; k++) lay(k, 0);
  for (let k = 1; k < n - 2; k += 2) lay(k, 1);
  return g;
}
function mergeGeometries(list) {
  let vc = 0, ic = 0;
  for (const gg of list) { vc += gg.attributes.position.count; ic += gg.index.count; }
  const pos = new Float32Array(vc * 3), nor = new Float32Array(vc * 3), idx = new Uint32Array(ic);
  let vo = 0, io = 0;
  for (const gg of list) {
    pos.set(gg.attributes.position.array, vo * 3);
    nor.set(gg.attributes.normal.array, vo * 3);
    for (let i = 0; i < gg.index.count; i++) idx[io + i] = gg.index.array[i] + vo;
    vo += gg.attributes.position.count;
    io += gg.index.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  return out;
}

// ------------------------------------------------------------------ matches
export const MATCH_LEN = 0.046;
export const MATCH_R = 0.00125;
export const HEAD_R = 0.0019;

function matchGeometry() {
  const stick = new THREE.BoxGeometry(MATCH_R * 2, MATCH_R * 2, MATCH_LEN - 0.002, 1, 1, 8);
  const head = new THREE.SphereGeometry(1, 14, 10);
  head.scale(HEAD_R, HEAD_R * 0.95, 0.0029);
  head.translate(0, 0, MATCH_LEN / 2 - 0.0022);
  const parts = [[stick, 0], [head, 1]];
  let vcount = 0, icount = 0;
  for (const [g] of parts) { vcount += g.attributes.position.count; icount += g.index.count; }
  const pos = new Float32Array(vcount * 3), nor = new Float32Array(vcount * 3), aux = new Float32Array(vcount * 4);
  const idx = new Uint16Array(icount);
  let vo = 0, io = 0;
  for (const [g, part] of parts) {
    pos.set(g.attributes.position.array, vo * 3);
    nor.set(g.attributes.normal.array, vo * 3);
    for (let i = 0; i < g.attributes.position.count; i++) aux[(vo + i) * 4] = part;
    for (let i = 0; i < g.index.count; i++) idx[io + i] = g.index.array[i] + vo;
    vo += g.attributes.position.count;
    io += g.index.count;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('aAux', new THREE.BufferAttribute(aux, 4));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.computeBoundingSphere();
  return g;
}

export const ROWS = [7, 5, 3, 1];             // far (opponent) -> near (player)
export const ROW_Z = [-0.125, -0.041, 0.043, 0.127];
export const ROW_X0 = -0.012;
export const ROW_DX = 0.049;
export const ROW_YAW = Math.PI - 0.32; // heads lean toward the far right, like the shot

// a match lying on the table rests on its head and its tail: tiny pitch
const REST_TILT = Math.atan2(HEAD_R - MATCH_R, MATCH_LEN - 0.004);

const _e = new THREE.Euler();
export function tableQuat(yaw, out = new THREE.Quaternion(), pitch = 0) {
  // yaw: direction of the head on the table plane; pitch>0 lifts the head end
  _e.set(-pitch, yaw, 0, 'YXZ');
  return out.setFromEuler(_e);
}

export class Match {
  constructor(id, mesh) {
    this.id = id;
    this.mesh = mesh;
    this.pos = new THREE.Vector3();
    this.quat = new THREE.Quaternion();
    this.state = 'row'; // row | held | falling | pile | moving
    this.row = -1;
    this.col = -1;
    this.highlight = 0;
    this.select = 0;
    this.hoverT = 0;
    this.selT = 0;
    this.pile = null;
    this.line = null; // pile rest line {a:{x,z}, b:{x,z}, y0, y1}
    this.anim = null;
    this.lift = 0; // visual lift while selected
  }
  axis(out = new THREE.Vector3()) {
    return out.set(0, 0, 1).applyQuaternion(this.quat);
  }
  sync() {
    _lp.copy(this.pos);
    _lp.y += this.lift;
    this.mesh.matrix.compose(_lp, this.quat, ONE);
    this.mesh.matrixWorldNeedsUpdate = true;
  }
}
const ONE = new THREE.Vector3(1, 1, 1);
const _lp = new THREE.Vector3();

export class MatchSet {
  constructor(scene) {
    this.geo = matchGeometry();
    this.list = [];
    this.rand = mulberry32(4242);
    for (let i = 0; i < 16; i++) {
      const mat = makeMatchMaterial();
      mat.uniforms.uSeed.value = i * 0.173;
      const mesh = new THREE.Mesh(this.geo, mat);
      mesh.matrixAutoUpdate = false;
      mesh.frustumCulled = false;
      scene.add(mesh);
      this.list.push(new Match(i, mesh));
    }
    this.layout();
  }

  // ideal row slot pose (with a little hand-placed irregularity)
  slotPose(row, col, jitter = true) {
    const n = ROWS[row];
    const x = ROW_X0 + (col - (n - 1) / 2) * ROW_DX;
    const z = ROW_Z[row];
    const r = this.rand;
    const jx = jitter ? (r() - 0.5) * 0.004 : 0;
    const jz = jitter ? (r() - 0.5) * 0.005 : 0;
    const yaw = ROW_YAW + (jitter ? (r() - 0.5) * 0.07 : 0);
    const pos = new THREE.Vector3(x + jx, TABLE_Y + MATCH_R + 0.0001, z + jz);
    // centre sits slightly higher toward the head end because the head props it up
    const quat = tableQuat(yaw, new THREE.Quaternion(), REST_TILT);
    pos.y += (HEAD_R - MATCH_R) * 0.5;
    return { pos, quat, yaw };
  }

  slots() {
    const s = [];
    for (let r = 0; r < ROWS.length; r++) for (let c = 0; c < ROWS[r]; c++) s.push({ row: r, col: c });
    return s;
  }

  layout() {
    let i = 0;
    for (let r = 0; r < ROWS.length; r++)
      for (let c = 0; c < ROWS[r]; c++) {
        const m = this.list[i++];
        const p = this.slotPose(r, c);
        m.pos.copy(p.pos);
        m.quat.copy(p.quat);
        m.state = 'row';
        m.row = r;
        m.col = c;
        m.pile = null;
        m.sync();
      }
  }

  inRow(row) {
    return this.list.filter((m) => m.state === 'row' && m.row === row).sort((a, b) => a.col - b.col);
  }
  counts() {
    return ROWS.map((_, r) => this.list.filter((m) => m.state === 'row' && m.row === r).length);
  }

  update(dt, time) {
    for (const m of this.list) {
      m.hoverT += (m.highlight - m.hoverT) * Math.min(1, dt * 14);
      m.selT += (m.select - m.selT) * Math.min(1, dt * 12);
      const liftT = m.state === 'row' ? m.selT * 0.0042 + m.hoverT * 0.001 : 0;
      m.lift += (liftT - m.lift) * Math.min(1, dt * (m.state === 'row' ? 16 : 9));
      const u = m.mesh.material.uniforms;
      u.uHighlight.value = m.hoverT;
      u.uSelect.value = m.selT;
      if (m.anim) {
        const done = m.anim(dt, time);
        if (done) m.anim = null;
      }
      m.sync();
    }
  }
}

// ------------------------------------------------------------------ piles
// Matches dropped on a pile come to rest on the table and on each other:
// each new match rests on the upper convex hull of its supports.
function segIntersect(a, b, c, d) {
  const r = { x: b.x - a.x, z: b.z - a.z }, s = { x: d.x - c.x, z: d.z - c.z };
  const den = r.x * s.z - r.z * s.x;
  if (Math.abs(den) < 1e-9) return null;
  const qp = { x: c.x - a.x, z: c.z - a.z };
  const t = (qp.x * s.z - qp.z * s.x) / den;
  const u = (qp.x * r.z - qp.z * r.x) / den;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { t, u };
}

export class Pile {
  constructor(center, spread, rand) {
    this.center = center; // Vector3 on table plane
    this.spread = spread; // {x, z} half extents
    this.items = [];
    this.rand = rand;
  }
  // compute a resting pose for a match dropped near (cx, cz) with yaw ψ
  restPose(cx, cz, yaw) {
    const L = MATCH_LEN / 2 - 0.0005;
    const ax = Math.sin(yaw), az = Math.cos(yaw);
    const a = { x: cx - ax * L, z: cz - az * L };
    const b = { x: cx + ax * L, z: cz + az * L };
    const base = TABLE_Y + MATCH_R;
    const pts = [{ t: 0, h: base }, { t: 1, h: base }];
    for (const it of this.items) {
      const l = it.line;
      const hit = segIntersect(a, b, l.a, l.b);
      if (!hit) continue;
      const hy = l.y0 + (l.y1 - l.y0) * hit.u + MATCH_R * 2;
      pts.push({ t: hit.t, h: hy });
    }
    pts.sort((p, q) => p.t - q.t);
    // upper hull
    const hull = [];
    for (const p of pts) {
      while (hull.length >= 2) {
        const p1 = hull[hull.length - 2], p2 = hull[hull.length - 1];
        const cross = (p2.t - p1.t) * (p.h - p1.h) - (p2.h - p1.h) * (p.t - p1.t);
        if (cross >= 0) hull.pop();
        else break;
      }
      hull.push(p);
    }
    let e0 = hull[0], e1 = hull[hull.length - 1];
    for (let i = 0; i < hull.length - 1; i++) if (hull[i].t <= 0.5 && hull[i + 1].t >= 0.5) { e0 = hull[i]; e1 = hull[i + 1]; break; }
    const slope = (e1.h - e0.h) / Math.max(1e-6, e1.t - e0.t);
    const y0 = e0.h - slope * e0.t;
    const y1 = y0 + slope;
    const pitch = Math.atan2(y1 - y0, 2 * L);
    const pos = new THREE.Vector3(cx, (y0 + y1) / 2, cz);
    const quat = tableQuat(yaw, new THREE.Quaternion(), pitch);
    return { pos, quat, line: { a, b, y0, y1 } };
  }
  chooseSpot(yawHint) {
    const r = this.rand;
    const ang = r() * Math.PI * 2;
    const rad = Math.sqrt(r());
    const cx = this.center.x + Math.cos(ang) * rad * this.spread.x;
    const cz = this.center.z + Math.sin(ang) * rad * this.spread.z;
    const yaw = yawHint + (r() - 0.5) * 0.9;
    return { cx, cz, yaw };
  }
  add(m, line) {
    m.pile = this;
    m.line = line;
    this.items.push(m);
  }
  remove(m) {
    this.items = this.items.filter((x) => x !== m);
    m.pile = null;
    m.line = null;
  }
  // the match safest to lift next: highest resting point
  topmost(near) {
    let best = null, bs = -Infinity;
    for (const m of this.items) {
      const h = Math.max(m.line.y0, m.line.y1) * 100 - (near ? m.pos.distanceTo(near) * 0.5 : 0);
      if (h > bs) { bs = h; best = m; }
    }
    return best;
  }
}
