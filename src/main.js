// Nim — boot, render passes, camera framing, input, adaptive quality.
import * as THREE from 'three';
import { G, OCC_N, setQuality, makeSkinMaterial, makeHeadMaterial, makeClothMaterial, makeShirtMaterial, makeMetalMaterial, bakeStone } from './materials.js';
import { buildTable, MatchSet, TABLE_Y, TABLE_R, L_TABLE, L_MAIN_ONLY, L_NO_MIRROR, L_NO_SHADOW, L_MIRROR_ONLY, ROW_X0, ROW_DX, ROW_Z } from './world.js';
import { initPoses, POSES } from './handModel.js';
import { Actor } from './actors.js';
import { IKDebug } from './ikDebug.js';
import { Director } from './director.js';
import { Post } from './post.js';
import { Foley } from './audio.js';
import { UI } from './ui.js';
import { Scheduler, Spring, DEG, quatFromYZ, clamp, fnoise } from './util.js';

const params = new URLSearchParams(location.search);
// ?lean=1 bends the opponent low over the board (his face then shows in the stone)
const LEAN_IN = params.get('lean') === '1';
if (params.has('clean')) document.body.classList.add('clean');
const canvas = document.getElementById('c');
const isTouch = matchMedia('(pointer: coarse)').matches;
const isMobile = isTouch || /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);

let renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', stencil: false, alpha: false });
} catch (e) {
  const err = document.getElementById('err');
  err.style.display = 'grid';
  err.textContent = 'This needs WebGL 2, which this browser could not provide.';
  throw e;
}
renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
renderer.setClearColor(0x000000, 1);

setQuality({ shadowTaps: isMobile ? 8 : 12 });

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(20, 1, 0.08, 20);
camera.layers.enable(L_TABLE);
camera.layers.enable(L_MAIN_ONLY);
camera.layers.enable(L_NO_MIRROR);
camera.layers.enable(L_NO_SHADOW);
const mirrorCam = new THREE.PerspectiveCamera();
mirrorCam.layers.set(0);
mirrorCam.layers.enable(L_NO_SHADOW);
mirrorCam.layers.enable(L_MIRROR_ONLY);
// near plane close to the lamp so nothing between it and the bodies is ever clipped
const lightCam = new THREE.PerspectiveCamera(58, 1, 0.05, 3.4);
lightCam.layers.set(0);
lightCam.layers.enable(L_TABLE); // the stone casts the lamp's shadow
lightCam.layers.enable(L_NO_MIRROR);

// ------------------------------------------------------------------ lighting rig
const KEY = { pos: new THREE.Vector3(0.06, 2.42, 0.16), target: new THREE.Vector3(0.0, TABLE_Y, -0.06), outer: 30, inner: 11, intensity: 9.5, size: 0.14 };
function applyLights() {
  G.uKeyPos.value.copy(KEY.pos);
  G.uKeyDir.value.subVectors(KEY.target, KEY.pos).normalize();
  G.uKeyColor.value.setScalar(KEY.intensity);
  G.uKeyCone.value.set(Math.cos(KEY.outer * DEG), Math.cos(KEY.inner * DEG));
  G.uKeySize.value = KEY.size;
  G.uFillDir.value.set(0.25, 0.55, 1.0).normalize();
  G.uFillColor.value.setScalar(0.07);
  G.uRimDir.value.set(-0.35, 0.55, -1.0).normalize();
  G.uRimColor.value.setScalar(0.10);
  G.uAmbTop.value.setScalar(0.016);
  G.uAmbBot.value.setScalar(0.004);
  G.uEnvGain.value = 1.0;
  G.uTableY.value = TABLE_Y;
  G.uTableR.value = TABLE_R;
  lightCam.position.copy(KEY.pos);
  lightCam.lookAt(KEY.target);
  lightCam.updateMatrixWorld();
  lightCam.updateProjectionMatrix();
}

// ------------------------------------------------------------------ camera framing (the shot)
// Reference composition authored for a 1.85:1 frame; other aspects keep the table in view.
const SHOT = {
  pos: new THREE.Vector3(-0.22, 1.53, 1.40), // left of our man, so he sits at the far left
  target: new THREE.Vector3(0, TABLE_Y, 0), // dead centre of the table
  hfov: 30,
  aspect: 1.845,
};
if (params.has('cam')) {
  // ?cam=px,py,pz,tx,ty,tz,hfov for close inspection
  const c = params.get('cam').split(',').map(Number);
  SHOT.pos.set(c[0], c[1], c[2]);
  SHOT.target.set(c[3], c[4], c[5]);
  if (c[6]) SHOT.hfov = c[6];
}
// Narrow frames tighten the lens toward the board (a closer, taller shot).
const PORTRAIT = { hfov: 21.5, target: new THREE.Vector3(0, TABLE_Y, 0) };
const BASE = { pos: new THREE.Vector3(), target: new THREE.Vector3() };
// ?opening freezes the first frame (unstepped, as the page holds it during the crossfade)
// so it can be saved as the opening still with nim.opening(): wide covers 1:1 to 2.4:1,
// portrait 0.4:1 to 1:1 (render it with the window at 1.3:1 and 0.4:1)
const OPENING = params.has('opening');
const OPENING_BOX = { wide: [1.3, 1], portrait: [1, 2.5] };
// ------------------------------------------------------------------ the viewer's nudge
// The mouse wheel / pinch dollies toward the shot's own aim point (so it never re-aims), right-drag
// turns the camera a few degrees around it. Each control keeps a raw value; what is shown
// is a soft clamp whose slope falls off as a Gaussian (an erf curve), so it eases to a
// stop at the edge instead of hitting a wall. The camera then glides toward it.
const VIEW = {
  zoomLo: Math.log(0.42), zoomHi: Math.log(1.32), // dolly distance as a factor of the shot's
  yawMax: 14 * DEG, pitchMax: 9 * DEG,
  // optional turn of the camera where it stands (none: it looks straight at the table's centre)
  turnRight: 0, tiltDown: 0,
  // how far the viewer may slide the camera sideways (metres)
  panMax: 0.3,
};
// The resting view, lined up by hand with ?camdebug: swung round the table (yaw0), raised
// or lowered (pitch0), slid sideways (pan0, metres, + is screen-right) and dollied (zoom,
// a factor of the shot's distance). Portrait screens get their own.
const RESTS = {
  wide: { yaw0: 31.6, pitch0: 5.7, pan0: -0.089, zoom: 0.912 },
  portrait: { yaw0: 15.1, pitch0: 6.8, pan0: -0.089, zoom: 0.912 },
};
let rest = null;
function useRest(name) {
  if (rest === name) return;
  rest = name;
  const r = RESTS[name];
  Object.assign(VIEW, { yaw0: r.yaw0 * DEG, pitch0: r.pitch0 * DEG, pan0: r.pan0 });
  view.zRaw = view.z = Math.log(r.zoom);
}
// camdebug (?camdebug, or the debug button): free the limits, show the live view and copy
// it (paste the line back to Claude)
let camDebug = false;
const VIEW_LIMITS = { zoomLo: VIEW.zoomLo, zoomHi: VIEW.zoomHi, yawMax: VIEW.yawMax, pitchMax: VIEW.pitchMax, panMax: VIEW.panMax };
const VIEW_FREE = { zoomLo: Math.log(0.02), zoomHi: Math.log(50), yawMax: 80 * DEG, pitchMax: 35 * DEG, panMax: 1.5 };
const view = { zRaw: 0, yawRaw: 0, pitchRaw: 0, panRaw: 0, z: 0, yaw: 0, pitch: 0, pan: 0 };
useRest(window.innerWidth < window.innerHeight ? 'portrait' : 'wide');
// erf (Abramowitz & Stegun 7.1.26, |error| < 1.5e-7)
function erf(x) {
  const s = Math.sign(x), a = Math.abs(x), t = 1 / (1 + 0.3275911 * a);
  return s * (1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a));
}
// identity through the middle; within a band w of each limit the slope falls off as a
// Gaussian, exp(-pi/4 (d/w)^2), so it eases toward the limit and never quite reaches it
const SOFT = Math.sqrt(Math.PI) / 2;
function softClamp(x, lo, hi, band = 0.5) {
  const w = ((hi - lo) / 2) * band;
  if (x > hi - w) return hi - w + w * erf((SOFT * (x - (hi - w))) / w);
  if (x < lo + w) return lo + w + w * erf((SOFT * (x - (lo + w))) / w);
  return x;
}
// raw values stop a little past where the curve has flattened, so coming back responds at once
function rawClamp(x, lo, hi, band = 0.5) {
  const w = ((hi - lo) / 2) * band;
  return clamp(x, lo - 1.2 * w, hi + 1.2 * w);
}
const ZB = 0.3; // zoom: the soft band is the outer 30% of each half of the range
view.z = softClamp(view.zRaw, VIEW.zoomLo, VIEW.zoomHi, ZB);
// Zoom (scroll wheel, pinch) is the lens, not the camera: it narrows on the middle of the
// frame, and can open a little wider than the shot. lens.z is log(magnification).
const LENS_MAX = Math.log(4), LENS_MIN = -Math.log(1.3);
let LENS_HI = LENS_MAX, LENS_LO = LENS_MIN; // (camdebug: no zoom limits to speak of)
const lens = { z: 0, zRaw: 0 };
function nudgeLens(d) { lens.zRaw = clamp(lens.zRaw + d, LENS_LO, LENS_HI); }
function applyLens() {
  const s = Math.exp(lens.z), w = canvas.clientWidth, h = canvas.clientHeight;
  if (Math.abs(s - 1) < 5e-4) { if (camera.view && camera.view.enabled) camera.clearViewOffset(); }
  else camera.setViewOffset(w, h, ((1 - 1 / s) / 2) * w, ((1 - 1 / s) / 2) * h, w / s, h / s);
  table.top.material.uniforms.uReflScale.value = (reflRT.height * s) / (2 * Math.tan((camera.fov * DEG) / 2));
  computePickScale(w, h); // matches grow as the lens narrows
}
// the lens's vertical field of view once zoomed (depth of field scales with it)
const lensFov = () => (2 * Math.atan(Math.tan((camera.fov * DEG) / 2) / Math.exp(lens.z))) / DEG;
function nudgePan(d) { view.panRaw = rawClamp(view.panRaw + d, -VIEW.panMax, VIEW.panMax); }
function nudgeOrbit(dx, dy) {
  view.yawRaw = rawClamp(view.yawRaw + dx, -VIEW.yawMax, VIEW.yawMax);
  view.pitchRaw = rawClamp(view.pitchRaw - dy, -VIEW.pitchMax, VIEW.pitchMax);
}
const _vd = new THREE.Vector3(), _vr = new THREE.Vector3(), _vt = new THREE.Vector3(), _UPV = new THREE.Vector3(0, 1, 0);
function applyView() {
  // orbit (right-drag) around the shot's aim point at the reference distance...
  _vd.subVectors(BASE.pos, BASE.target);
  _vr.crossVectors(_UPV, _vd).normalize();
  _vd.applyAxisAngle(_vr, -(view.pitch + VIEW.pitch0)).applyAxisAngle(_UPV, view.yaw + VIEW.yaw0);
  const dist = _vd.length();
  camera.position.copy(BASE.target).add(_vd);
  // ...turn the camera where it stands (right, then down)...
  _vd.negate().applyAxisAngle(_UPV, -VIEW.turnRight);
  _vr.crossVectors(_vd, _UPV).normalize();
  _vd.applyAxisAngle(_vr, -VIEW.tiltDown).setLength(dist);
  _vt.copy(camera.position).add(_vd); // where it looks
  // ...slide it sideways (truck) without turning...
  const pan = VIEW.pan0 + view.pan;
  camera.position.addScaledVector(_vr, pan);
  _vt.addScaledVector(_vr, pan);
  // ...then zoom is a pure dolly along the line of sight: closer or further, never turning
  camera.position.copy(_vt).addScaledVector(_vd, -Math.exp(view.z));
  camera.lookAt(_vt);
  camera.updateMatrixWorld();
}
function updateView(dt) {
  if (orbit.on) return;
  const k = 1 - Math.exp(-dt * 9);
  const tz = softClamp(view.zRaw, VIEW.zoomLo, VIEW.zoomHi, ZB);
  const ty = softClamp(view.yawRaw, -VIEW.yawMax, VIEW.yawMax);
  const tp = softClamp(view.pitchRaw, -VIEW.pitchMax, VIEW.pitchMax);
  const tx = softClamp(view.panRaw, -VIEW.panMax, VIEW.panMax);
  if (Math.abs(lens.zRaw - lens.z) > 1e-6) { lens.z += (lens.zRaw - lens.z) * k; applyLens(); }
  if (Math.abs(tz - view.z) + Math.abs(ty - view.yaw) + Math.abs(tp - view.pitch) + Math.abs(tx - view.pan) < 1e-6) return;
  view.pan += (tx - view.pan) * k;
  view.z += (tz - view.z) * k;
  view.yaw += (ty - view.yaw) * k;
  view.pitch += (tp - view.pitch) * k;
  applyView();
  if (camDebug) showCamDebug();
}
let camDbgEl = null;
function camLine() {
  const f = (x) => +(x / DEG).toFixed(1);
  return `camera: yaw0 ${f(VIEW.yaw0 + view.yaw)}°, pitch0 ${f(VIEW.pitch0 + view.pitch)}°, pan0 ${(VIEW.pan0 + view.pan).toFixed(3)} m, zoom ${Math.exp(view.z).toFixed(3)}`;
}
function showCamDebug() {
  if (!camDbgEl) {
    camDbgEl = document.createElement('div');
    camDbgEl.style.cssText = 'position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:5;display:flex;gap:10px;align-items:center;font:12px/1.4 ui-monospace,Menlo,monospace;color:#ece9e2;background:rgba(0,0,0,0.6);padding:6px 10px;border:1px solid rgba(236,233,226,0.3);border-radius:4px;pointer-events:auto';
    const t = document.createElement('span');
    const b = document.createElement('button');
    b.textContent = 'copy';
    b.style.cssText = 'opacity:1;pointer-events:auto;font:inherit;padding:2px 8px;border:1px solid rgba(236,233,226,0.5);letter-spacing:0';
    b.addEventListener('click', async (e) => {
      e.stopPropagation();
      try { await navigator.clipboard.writeText(camLine()); b.textContent = 'copied'; }
      catch (err) { const r = document.createRange(); r.selectNodeContents(t); getSelection().removeAllRanges(); getSelection().addRange(r); b.textContent = 'select + copy'; }
      setTimeout(() => (b.textContent = 'copy'), 1500);
    });
    camDbgEl.append(t, b);
    document.body.append(camDbgEl);
  }
  camDbgEl.style.display = '';
  camDbgEl.firstChild.textContent = camLine();
}
function setCamDebug(on) {
  camDebug = on;
  Object.assign(VIEW, on ? VIEW_FREE : VIEW_LIMITS);
  LENS_HI = on ? Math.log(60) : LENS_MAX;
  LENS_LO = on ? -Math.log(20) : LENS_MIN;
  if (!on) {
    // back inside the usual limits (the soft clamp eases the view there)
    lens.zRaw = clamp(lens.zRaw, LENS_LO, LENS_HI);
    view.zRaw = rawClamp(view.zRaw, VIEW.zoomLo, VIEW.zoomHi, ZB);
    view.yawRaw = rawClamp(view.yawRaw, -VIEW.yawMax, VIEW.yawMax);
    view.pitchRaw = rawClamp(view.pitchRaw, -VIEW.pitchMax, VIEW.pitchMax);
    view.panRaw = rawClamp(view.panRaw, -VIEW.panMax, VIEW.panMax);
  }
  if (on) showCamDebug();
  else if (camDbgEl) camDbgEl.style.display = 'none';
}
function frameCamera(w, h) {
  const aspect = w / h;
  const wide = aspect >= 1;
  useRest(wide ? 'wide' : 'portrait');
  // one lens for landscape screens and one for portrait, each keeping its width (and its
  // height past 1.845:1), so every screen of a kind sees a crop of the same picture and
  // the opening still in index.html can sit exactly under it
  const k = wide ? 1 : 0;
  const hfov = params.has('cam') ? SHOT.hfov : PORTRAIT.hfov + (SHOT.hfov - PORTRAIT.hfov) * k;
  const tH = Math.tan((hfov * DEG) / 2);
  let tanV = aspect >= SHOT.aspect ? tH / SHOT.aspect : tH / aspect;
  // ?opening renders the still a little larger than any screen shows: OPENING_BOX is its
  // half-size in units of the lens's half-width (the same numbers are in index.html)
  if (OPENING) tanV = tH * OPENING_BOX[wide ? 'wide' : 'portrait'][1];
  camera.aspect = aspect;
  camera.fov = (2 * Math.atan(tanV)) / DEG;
  camera.position.copy(SHOT.pos);
  const tgt = params.has('cam') ? SHOT.target.clone() : PORTRAIT.target.clone().lerp(SHOT.target, k);
  camera.lookAt(tgt);
  camera.updateProjectionMatrix();
  BASE.pos.copy(SHOT.pos);
  BASE.target.copy(tgt);
  if (orbit.on) applyOrbit();
  else applyView();
}
// size & place the canvas: always the full page
function layoutCanvas() {
  const vw = window.innerWidth, vh = window.innerHeight;
  // always the whole page, phones included (tall screens just see more above and below)
  const cw = vw, ch = vh, top = 0;
  canvas.style.width = cw + 'px';
  canvas.style.height = ch + 'px';
  canvas.style.top = top + 'px';
  document.documentElement.style.setProperty('--frame-bottom', `${vh - top - ch}px`);
  return { cw, ch };
}

// ------------------------------------------------------------------ render targets
let mainRT, reflRT, shadowRT;
const SHADOW_SIZE = isMobile ? 1024 : 2048;
function makeTargets() {
  shadowRT = new THREE.WebGLRenderTarget(SHADOW_SIZE, SHADOW_SIZE, { depthBuffer: true, type: THREE.UnsignedByteType, format: THREE.RedFormat });
  shadowRT.depthTexture = new THREE.DepthTexture(SHADOW_SIZE, SHADOW_SIZE, THREE.UnsignedIntType);
  shadowRT.depthTexture.minFilter = THREE.NearestFilter;
  shadowRT.depthTexture.magFilter = THREE.NearestFilter;
  mainRT = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, samples: 4, depthBuffer: true });
  reflRT = new THREE.WebGLRenderTarget(4, 4, {
    type: THREE.HalfFloatType, depthBuffer: true, generateMipmaps: true,
    minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter,
  });
  G.uShadowMap.value = shadowRT.depthTexture;
}

// ------------------------------------------------------------------ boot
const sched = new Scheduler();
const foley = new Foley();
const ui = new UI(foley);
let post, matches, table, player, opponent, director, ikDebug = null;
let quality = 1.0;
let W = 0, H = 0;
// Render scale: the device pixel ratio, capped by a pixel budget, then trimmed by the
// adaptive `quality` below. Nearly every cost here is per pixel (4x MSAA half-float
// targets, the stone, the skin), while film grain and depth of field hide the
// difference between 1.5x and 2x density.
const PIXEL_BUDGET = Number(params.get('budget')) * 1e6 || (isMobile ? 1.5e6 : 3.6e6);
let renderScale = 1;

function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const { cw, ch } = layoutCanvas();
  const maxScale = Math.min(dpr, Math.sqrt(PIXEL_BUDGET / (cw * ch)));
  const scale = maxScale * quality;
  renderScale = scale / dpr;
  W = Math.max(2, Math.round(cw * scale));
  H = Math.max(2, Math.round(ch * scale));
  renderer.setPixelRatio(1);
  renderer.setSize(W, H, false);
  mainRT.setSize(W, H);
  const rs = isMobile ? 0.55 : 0.75;
  reflRT.setSize(Math.max(2, Math.round(W * rs)), Math.max(2, Math.round(H * rs)));
  post.setSize(W, H);
  frameCamera(cw, ch);
  applyLens();
  computePickScale(cw, ch);
}

function build() {
  const t0 = performance.now();
  initPoses();
  makeTargets();
  post = new Post(renderer, { dofTaps: isMobile ? 32 : 48 });
  post.dofEnabled = !params.has('nodof') && !params.has('cam');
  applyLights();
  table = buildTable(scene);
  {
    const stone = bakeStone(renderer, isMobile ? 1024 : 2048);
    table.top.material.uniforms.uStoneA.value = stone.a;
    table.top.material.uniforms.uStoneB.value = stone.b;
  }
  matches = new MatchSet(scene);

  const mats = (fabric) => ({
    skin: makeSkinMaterial(),
    head: makeHeadMaterial(),
    jacket: makeClothMaterial({ torso: true, fabric }),
    sleeve: makeClothMaterial({ torso: false, fabric, side: THREE.DoubleSide }),
    shirt: makeShirtMaterial(),
    metal: makeMetalMaterial({ albedo: 0.7, rough: 0.2 }),
  });

  // the player: seated, leaning in over the table, seen over the right shoulder
  player = new Actor(scene, {
    name: 'player',
    seated: true,
    castsBody: false,
    hip: new THREE.Vector3(-0.282, 0.40, 0.626), // snug up to the table, sitting low
    yaw: Math.atan2(0.06, -1.0),
    lean: 0.45,
    reachSoft: 0.985, // he straightens his arm (to ~20° of bend) before he leans in
    reachMax: 0.998, // and can reach all but straight (~7°)
    maxExtraLean: 0.36,
    reachSlide: 0.06,
    twistGain: 0.26,
    armLen: [0.318, 0.29],
    // elbows carried out to the side, a little down and back, whatever the lean
    pole: [0.88, -0.28, -0.38],
    // the left elbow aims at a point well out to his left ([out, up, forward] from the
    // shoulder; tune it live with ?ik), and follows it hard, even with the arm out straight
    poleOffsets: { left: [1.14, -0.8, -0.15] },
    poleWeights: { left: 1.2 },
    elbowFloors: { left: TABLE_Y }, // but never drops below the stone
    poleFrame: 'yaw',
    hands: ['left', 'right'],
    breathRate: 0.23,
    lookWeight: 0.32,
  }, mats(0.040));
  // the opponent: standing across the table, both hands on the stone
  opponent = new Actor(scene, {
    name: 'opponent',
    hip: new THREE.Vector3(0.03, 0.93, -0.74),
    yaw: 0,
    lean: 0.62,
    hands: ['left', 'right'],
    breathRate: 0.19,
    lookWeight: 0.75,
    armLen: [0.31, 0.28],
    // elbows out and back behind the arms (never folding in toward his belly)
    pole: [0.5, -0.3, -0.8],
    poleFrame: 'yaw',
    maxExtraLean: 0.65,
    // ?lean=1: bent low over the board, his face hangs above the stone and shows in it
    posture: LEAN_IN ? 1 : 0,
    crouch: { drop: 0.27, fwd: -0.15, lean: -0.04 },
    mirrorBody: LEAN_IN,
    headCell: LEAN_IN ? 0.0041 : 0.0052,
  }, mats(0.034));
  opponent.headMat.uniforms.uSkinTone.value = 0.28;

  // resting poses (the shot)
  const pR = player.hands.right; // resting on his right thigh, below the stone and out of shot
  {
    const f = new THREE.Vector3(Math.sin(player.yaw), 0, Math.cos(player.yaw));
    const left = new THREE.Vector3(0, 1, 0).cross(f);
    const w = player.hip.clone().addScaledVector(left, -0.15).addScaledVector(f, 0.24);
    w.y = player.hip.y + 0.118;
    pR.setRest(w, quatFromYZ(f.clone().setY(-0.12), new THREE.Vector3(-left.x * 0.25, 1, -left.z * 0.25)), POSES.relaxed);
    pR.lapRest = true;
    // between moves it hangs at his side, swinging along with his shoulder
    pR.setRest(w.clone().setY(0.3), quatFromYZ(new THREE.Vector3(f.x * 0.15, -1, f.z * 0.15), left.clone().negate()), POSES.relaxed);
    pR.hang = { out: 0.04, down: 0.585, fwd: 0.0 };
    pR.edgeQuat = quatFromYZ(f.clone().setY(-0.35), new THREE.Vector3(0, 1, 0));
    pR.snapToRest();
  }
  const pl = player.hands.left;
  // as in the still: the forearm laid across the stone in front of him, cuff showing, a
  // composed fist lying level, back of the hand straight up, thumb wrapped round the front
  pl.setRest(new THREE.Vector3(-0.24, 0.78, 0.15), quatFromYZ(new THREE.Vector3(1, 0, -0.04), new THREE.Vector3(0, 1, 0)), POSES.fist);
  pl.snapToRest();
  const oR = opponent.hands.right; // screen-left, the one that plays
  oR.setRest(new THREE.Vector3(-0.205, 0.785, -0.398), quatFromYZ(new THREE.Vector3(0.0, -0.34, 1.0), new THREE.Vector3(-0.08, 1.0, 0.34)), POSES.poised);
  oR.snapToRest();
  const oL = opponent.hands.left; // screen-right, splayed support hand
  // braced flat on the stone, fingers splayed toward the board: his weight rests here
  oL.setRest(new THREE.Vector3(0.19, TABLE_Y + 0.012, -0.352), quatFromYZ(new THREE.Vector3(0.42, 0, 1.0), new THREE.Vector3(0, 1, 0)), POSES.brace);
  oL.brace = true;
  oL.snapToRest();

  // ?ik: draw every IK target (wrist goals, elbows and their poles, knees, look targets)
  if (params.has('ik')) ikDebug = new IKDebug([player, opponent], { sliders: true });
  // the debug button (beside the ? while the settings are open): the IK rig and the free
  // camera with its readout, but not the sliders
  ui.setDebug(params.has('ik'));
  ui.onDebug = (on) => {
    if (on && !ikDebug) ikDebug = new IKDebug([player, opponent]);
    if (ikDebug) ikDebug.setOn(on);
    setCamDebug(on);
  };
  director = new Director({ sched, matches, player, opponent, ui, foley, camera, box: table.box });
  director.autoplay = ui.autoplay;
  director.twoPlayer = ui.players === 'two';
  ui.onMode = (mode) => { director.setTwoPlayer(mode === 'two'); director.setAutoplay(mode === 'auto'); };
  director.debugLoop = params.get('debug') === 'loop';
  director.debugPlayer = params.get('debug') === 'player'; // the player's hands, every move, on a loop
  director.debugFirst = params.get('first'); // ?debug=loop&first=opponent
  director.still = params.has('still');
  ui.onConfirm = () => director.confirm();
  ui.onClear = () => director.clearSelection();
  director.prepareOpening();

  if (params.has('gallery')) buildGallery();
  resize();
  // settle the bodies before the first frame is shown
  for (let i = 0; i < 90; i++) step(1 / 60);
  console.info(`[nim] built in ${(performance.now() - t0).toFixed(0)} ms`);
}

// ------------------------------------------------------------------ debug: pose gallery (?gallery)
async function buildGallery() {
  const { HandRig } = await import('./handModel.js');
  const names = (params.get('gallery') || 'flat,relaxed,fist,spread,touch,reach,pinch,hold').split(',');
  const side = params.get('side') || 'right';
  const view = params.get('gview') || 'side';
  const skin = makeSkinMaterial();
  scene.traverse((o) => { if (o.isMesh && o.name !== 'tabletop') o.visible = false; });
  names.forEach((n, i) => {
    const r = new HandRig(side, skin);
    const x = (i - (names.length - 1) / 2) * 0.23;
    r.group.position.set(x - (view === 'side' ? 0.07 : 0), 0.95, view === 'side' ? 0 : 0.08);
    // side: palm down, fingers to +x, seen along the flexion axis. top: fingers away from camera.
    const F = view === 'side' ? new THREE.Vector3(1, 0, 0) : view === 'palm' ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, -1);
    const D = view === 'side' ? new THREE.Vector3(0, 1, 0) : view === 'palm' ? new THREE.Vector3(0, 0, -1) : new THREE.Vector3(0, 1, 0);
    r.group.quaternion.copy(quatFromYZ(F, D));
    // &wrist=deg bends the wrist (positive = extension, back of the hand toward the forearm)
    r.applyPose(POSES[n], new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), (Number(params.get('wrist')) || 0) * DEG));
    r.group.updateMatrixWorld(true);
    scene.add(r.group);
  });
}

// ------------------------------------------------------------------ picking
let pickRadius = 20;
const _a = new THREE.Vector3(), _b = new THREE.Vector3();
function toScreen(v, out, cw, ch) {
  out.copy(v).project(camera);
  out.x = (out.x * 0.5 + 0.5) * cw;
  out.y = (-out.y * 0.5 + 0.5) * ch;
  return out;
}
function computePickScale(cw, ch) {
  const a = toScreen(new THREE.Vector3(ROW_X0, TABLE_Y, ROW_Z[1]), new THREE.Vector3(), cw, ch);
  const b = toScreen(new THREE.Vector3(ROW_X0 + ROW_DX, TABLE_Y, ROW_Z[1]), new THREE.Vector3(), cw, ch);
  pickRadius = clamp(a.distanceTo(b) * 0.55, isTouch ? 18 : 10, 60);
}
function pickMatch(x, y) {
  const cw = canvas.clientWidth, ch = canvas.clientHeight;
  let best = null, bd = Infinity;
  for (const m of matches.list) {
    if (m.state !== 'row') continue;
    const ax = m.axis(new THREE.Vector3());
    toScreen(_a.copy(m.pos).addScaledVector(ax, -0.021), _a, cw, ch);
    toScreen(_b.copy(m.pos).addScaledVector(ax, 0.021), _b, cw, ch);
    const abx = _b.x - _a.x, aby = _b.y - _a.y;
    let t = ((x - _a.x) * abx + (y - _a.y) * aby) / (abx * abx + aby * aby + 1e-6);
    t = clamp(t, 0, 1);
    const d = Math.hypot(x - (_a.x + abx * t), y - (_a.y + aby * t));
    if (d < bd) { bd = d; best = m; }
  }
  return bd <= pickRadius ? best : null;
}
// Taps and drags paint the selection: the first match touched decides whether the
// stroke selects or deselects, and the stroke stays in that match's row.
// Right-drag or a trackpad two-finger drag nudges the view a few degrees; the mouse wheel
// or a pinch zooms within limits.
let stroke = null;
function paintAt(x, y, type) {
  if (!stroke || !director || director.mode !== 'select') return;
  const m = pickMatch(x, y);
  if (!m || stroke.touched.has(m)) return;
  if (stroke.mode === null) { stroke.mode = m.select ? 'off' : 'on'; stroke.row = m.row; }
  if (m.row !== stroke.row) return;
  stroke.touched.add(m);
  director.setSelected(m, stroke.mode === 'on');
  if (type !== 'mouse') director.setHover(m);
}
// debug free camera (nim.view); orbit.drag is the right-drag in progress
const orbit = { on: false, drag: null, yaw: 0, pitch: 0, dist: 1, target: new THREE.Vector3() };
function applyOrbit() {
  const cp = Math.cos(orbit.pitch);
  camera.position.set(orbit.target.x + orbit.dist * cp * Math.sin(orbit.yaw), orbit.target.y + orbit.dist * Math.sin(orbit.pitch), orbit.target.z + orbit.dist * cp * Math.cos(orbit.yaw));
  camera.lookAt(orbit.target);
  camera.updateMatrixWorld();
}
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
// two fingers on a touch screen pinch to zoom (and stop selecting)
const touches = new Map();
let pinch = null;
const touchSpan = () => { const [p, q] = [...touches.values()]; return Math.hypot(p.x - q.x, p.y - q.y); };
const touchMid = () => { const [p, q] = [...touches.values()]; return { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 }; };
canvas.addEventListener('pointerdown', (e) => {
  if (e.pointerType === 'touch') {
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (touches.size === 2) {
      if (stroke) { stroke = null; }
      pinch = { span: touchSpan(), mid: touchMid() };
      return;
    }
  }
  if (e.button === 2 && e.pointerType === 'mouse') {
    orbit.drag = { id: e.pointerId, x: e.clientX, y: e.clientY };
    try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* not capturable */ }
    return;
  }
  if (e.button !== 0 || pinch) return;
  stroke = { id: e.pointerId, mode: null, row: -1, last: { x: e.offsetX, y: e.offsetY }, touched: new Set() };
  try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* not capturable */ }
  paintAt(e.offsetX, e.offsetY, e.pointerType);
});
canvas.addEventListener('pointermove', (e) => {
  if (touches.has(e.pointerId)) touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pinch && touches.size === 2) {
    const span = touchSpan();
    const mid = touchMid();
    if (span > 1 && pinch.span > 1) nudgeLens(Math.log(span / pinch.span));
    nudgeOrbit(-(mid.x - pinch.mid.x) * ORBIT_PER_PX(), (mid.y - pinch.mid.y) * ORBIT_PER_PX());
    pinch.span = span;
    pinch.mid = mid;
    return;
  }
  if (orbit.drag && e.pointerId === orbit.drag.id) {
    const dx = e.clientX - orbit.drag.x, dy = e.clientY - orbit.drag.y;
    orbit.drag.x = e.clientX; orbit.drag.y = e.clientY;
    // a full-width drag is a couple of times the whole range: a gentle wiggle
    if (e.shiftKey) nudgePan(-dx * PAN_PER_PX());
    else nudgeOrbit(-dx * ORBIT_PER_PX(), dy * ORBIT_PER_PX());
    return;
  }
  if (stroke && e.pointerId === stroke.id) {
    // sample along the drag so a quick swipe doesn't skip matches
    const x0 = stroke.last.x, y0 = stroke.last.y, x1 = e.offsetX, y1 = e.offsetY;
    const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / Math.max(3, pickRadius * 0.4)));
    for (let i = 1; i <= n; i++) paintAt(x0 + (x1 - x0) * (i / n), y0 + (y1 - y0) * (i / n), e.pointerType);
    stroke.last.x = x1; stroke.last.y = y1;
  }
  if (!director || director.mode !== 'select') { canvas.classList.remove('pointing'); return; }
  if (e.pointerType === 'mouse') {
    const m = pickMatch(e.offsetX, e.offsetY);
    director.setHover(m);
    canvas.classList.toggle('pointing', !!m);
  }
});
const endPointer = (e) => {
  touches.delete(e.pointerId);
  if (touches.size < 2) pinch = null;
  if (orbit.drag && e.pointerId === orbit.drag.id) orbit.drag = null;
  if (stroke && e.pointerId === stroke.id) stroke = null;
};
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);
// Scrolling (mouse wheel or trackpad) and pinching zoom; dragging moves the camera
// (right-drag with a mouse, two fingers on a touch screen; shift slides it sideways).
const PAN_PER_PX = () => 0.6 / Math.max(400, canvas.clientWidth); // a full-width drag slides 60 cm
const ORBIT_PER_PX = () => (2.2 * VIEW.yawMax * 2) / Math.max(400, canvas.clientWidth);
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const px = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1);
  // a trackpad pinch arrives as a ctrl-scroll
  nudgeLens(e.ctrlKey ? -px * 0.01 : -Math.sign(px) * Math.min(0.2, 0.004 * Math.abs(px)));
}, { passive: false });
// Safari sends trackpad pinches as gesture events instead
let gestureScale = 1;
canvas.addEventListener('gesturestart', (e) => { e.preventDefault(); gestureScale = 1; });
canvas.addEventListener('gesturechange', (e) => { e.preventDefault(); nudgeLens(Math.log(e.scale / gestureScale)); gestureScale = e.scale; });
canvas.addEventListener('gestureend', (e) => e.preventDefault());
canvas.addEventListener('dblclick', () => director && director.confirm());
window.addEventListener('keydown', (e) => {
  if (!director) return;
  if (e.key === 'Enter') director.confirm();
  if (e.key === 'Escape') director.clearSelection();
  // left / right arrows slide the camera sideways 1 cm a press (shift: 5 cm)
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') nudgePan((e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 0.05 : 0.01));
});
window.addEventListener('resize', () => post && resize());
window.addEventListener('orientationchange', () => setTimeout(() => post && resize(), 200));

// ------------------------------------------------------------------ per-frame
const bias = new THREE.Matrix4().set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);
const _v = new THREE.Vector3(), _u = new THREE.Vector3();
function updateMirror() {
  mirrorCam.position.copy(camera.position);
  mirrorCam.position.y = 2 * TABLE_Y - camera.position.y;
  camera.getWorldDirection(_v);
  _v.y = -_v.y;
  _u.set(0, 1, 0).applyQuaternion(camera.quaternion);
  _u.y = -_u.y;
  mirrorCam.up.copy(_u);
  mirrorCam.lookAt(_v.add(mirrorCam.position));
  mirrorCam.projectionMatrix.copy(camera.projectionMatrix);
  mirrorCam.projectionMatrixInverse.copy(camera.projectionMatrixInverse);
  mirrorCam.updateMatrixWorld();
  table.top.material.uniforms.uReflMatrix.value.copy(bias).multiply(mirrorCam.projectionMatrix).multiply(mirrorCam.matrixWorldInverse);
}

const occ = [];
function updateOccluders() {
  occ.length = 0;
  for (const m of matches.list) {
    if (!m.mesh.visible) continue; // still in the box: no contact shadow on the stone
    const ax = m.axis(_v);
    occ.push([m.pos.x - ax.x * 0.021, m.pos.y - ax.y * 0.021, m.pos.z - ax.z * 0.021, m.pos.x + ax.x * 0.021, m.pos.y + ax.y * 0.021, m.pos.z + ax.z * 0.021, 0.0019, 1.0]);
  }
  player.hands.left.occluders(occ);
  player.hands.right.occluders(occ);
  opponent.hands.right.occluders(occ);
  opponent.hands.left.occluders(occ);
  const u = table.top.material.uniforms.uOcc.value;
  for (let i = 0; i < OCC_N; i++) {
    const o = occ[i];
    if (!o) { u[i * 2].set(0, -10, 0, 0); continue; }
    u[i * 2].set(o[0], o[1], o[2], o[6]);
    u[i * 2 + 1].set(o[3], o[4], o[5], o[7]);
  }
}

// focus pulls gently to whatever is being played on the table
const APERTURE = Number(params.get('aperture')) || 0.0065;
const focusDist = new Spring(1.65, 0.45);
// eye light: follows the opponent's face when he bends to the board (only with the lean-in)
const FACE_LIGHT = new THREE.Vector3(0.28, 1.95, 1.25);
const _face = new THREE.Vector3();
function updateFaceLight() {
  if (!LEAN_IN) { G.uFaceColor.value.setScalar(0); return; }
  _face.set(0, 0.07, 0.07).applyMatrix4(opponent.headWorld);
  G.uFacePos.value.copy(FACE_LIGHT);
  G.uFaceDir.value.subVectors(_face, FACE_LIGHT).normalize();
  G.uFaceCone.value.set(Math.cos(4.6 * DEG), Math.cos(1.8 * DEG));
  G.uFaceColor.value.setScalar(6.5);
}
let time = 0;
function step(dt) {
  time += dt;
  G.uTime.value = time;
  sched.update(dt);
  director.updateLooks(dt);
  focusDist.update(clamp(camera.position.distanceTo(director.focusPoint()), 0.45, 2.4), dt);
  player.update(dt, time);
  opponent.update(dt, time);
  director.lateUpdate(dt);
  matches.update(dt, time);
  updateFaceLight();
}

let fade = 1; // no fade from black: the opening still (index.html) crossfades into the scene
const dummyTex = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
dummyTex.needsUpdate = true;
function render() {
  updateOccluders();
  // 1. shadow depth from the hanging lamp (unbind the map while writing it)
  G.uPass.value = 2;
  G.uShadowMap.value = dummyTex;
  renderer.setRenderTarget(shadowRT);
  renderer.render(scene, lightCam);
  G.uShadowMap.value = shadowRT.depthTexture;
  G.uShadowMatrix.value.multiplyMatrices(lightCam.projectionMatrix, lightCam.matrixWorldInverse);
  G.uShadowParams.value.set(1 / SHADOW_SIZE, lightCam.near, lightCam.far, KEY.size / (2 * Math.tan((lightCam.fov * DEG) / 2)));
  // 2. mirror image for the polished stone
  updateMirror();
  G.uPass.value = 1;
  renderer.setRenderTarget(reflRT);
  renderer.render(scene, mirrorCam);
  // 3. beauty (alpha carries camera distance; the void counts as far away)
  G.uPass.value = 0;
  table.top.material.uniforms.uReflTex.value = reflRT.texture;
  renderer.setClearAlpha(60);
  renderer.setRenderTarget(mainRT);
  renderer.render(scene, camera);
  renderer.setClearAlpha(1);
  post.setLens(focusDist.x, APERTURE, lensFov());
  // 4. film
  post.comp.uniforms.uFade.value = fade;
  post.comp.uniforms.uFlicker.value = fnoise(time * 9.0, 2) * 0.012;
  post.render(mainRT.texture, time);
  if (ikDebug && ikDebug.on) ikDebug.render(renderer, camera);
}

// FPS counter (F toggles it)
const fpsEl = document.getElementById('fps');
let fpsOn = params.has('fps'); // debug: ?fps shows the frame-rate counter (F toggles it)
if (fpsEl && !fpsOn) fpsEl.classList.add('off');
window.addEventListener('keydown', (e) => {
  if ((e.key === 'f' || e.key === 'F') && params.has('fps') && fpsEl && !e.metaKey && !e.ctrlKey) { fpsOn = !fpsOn; fpsEl.classList.toggle('off', !fpsOn); }
});
let fpsAcc = 0, fpsFrames = 0, fpsWorst = 0;
function updateFps(frameMs) {
  fpsAcc += frameMs;
  fpsFrames++;
  fpsWorst = Math.max(fpsWorst, frameMs);
  if (fpsAcc < 500) return;
  if (fpsEl && fpsOn) {
    const fps = (1000 * fpsFrames) / fpsAcc;
    fpsEl.textContent = `${fps.toFixed(0)} fps  ${(fpsAcc / fpsFrames).toFixed(1)} ms  worst ${fpsWorst.toFixed(0)} ms\n${W}×${H}  ${Math.round(renderScale * 100)}% of display`;
  }
  fpsAcc = 0;
  fpsFrames = 0;
  fpsWorst = 0;
}

// adaptive resolution: hold 60 fps (it steps down below ~54). Frame intervals are rounded up to whole display
// refreshes, so headroom is invisible; instead, a level that proved too slow becomes a
// ceiling for a while, and the scale creeps back up toward it only slowly.
let acc = 0, frames = 0, cooldown = 3, ceiling = 1, ceilingT = 0;
function adapt(dt) {
  acc += dt;
  frames++;
  cooldown -= dt;
  ceilingT -= dt;
  if (ceilingT <= 0) ceiling = 1;
  if (acc < 1.0) return;
  const avg = acc / frames;
  acc = 0;
  frames = 0;
  if (cooldown > 0 || params.has('fixed')) return;
  if (avg > 1 / 54 && quality > 0.5) {
    ceiling = quality * 0.97;
    ceilingT = 40;
    quality = Math.max(0.5, quality * Math.max(0.8, Math.sqrt(1 / 60 / avg)));
    resize();
    cooldown = 2;
  } else if (avg < 1 / 57 && quality < Math.min(1, ceiling) - 0.01) {
    quality = Math.min(1, ceiling, quality * 1.05);
    resize();
    cooldown = 3;
  }
}

// the simulation runs several steps a frame to go faster: the autoplay speed button,
// or ?speed=N (testing)
const SPEED = Math.max(1, Math.min(8, Number(params.get('speed')) || 1));
let paused = false; // (debug: nim.pause() / nim.advance())
// the scene holds its first frame until the opening still has faded into it
let holding = true;
// ?timer drives frames from a timer (for headless/background testing)
const raf = params.has('timer') ? (f) => setTimeout(() => f(performance.now()), 16) : (f) => requestAnimationFrame(f);
let last = performance.now();
function loop(now) {
  const frameMs = Math.max(0, now - last);
  const dt = Math.min(0.05, frameMs / 1000);
  last = now;
  updateFps(frameMs);
  updateView(dt);
  if (!paused && !holding) for (let i = 0, n = Math.max(SPEED, ui.pace); i < n; i++) step(dt);
  render();
  adapt(dt);
  raf(loop);
}

raf(() => {
  setTimeout(() => {
    try {
      build();
    } catch (e) {
      console.error(e);
      const err = document.getElementById('err');
      err.style.display = 'grid';
      err.textContent = 'Something went wrong while building the scene.';
      return;
    }
    if (!OPENING) ui.ready(() => (holding = false));
    last = performance.now();
    raf(loop);
    if (params.has('camdebug')) setCamDebug(true);
    director.run();
  }, 30);
});

// debugging handle
window.nim = {
  THREE, scene, camera, G, KEY, SHOT, renderer, applyLights,
  resize: () => resize(),
  get director() { return director; },
  get player() { return player; },
  get opponent() { return opponent; },
  get matches() { return matches; },
  get post() { return post; },
  get mainRT() { return mainRT; },
  get reflRT() { return reflRT; },
  get shadowRT() { return shadowRT; },
  get fade() { return fade; },
  // frame-by-frame inspection: freeze the simulation, step it by hand, look from anywhere
  pause(on = true) { paused = on; },
  advance(sec, dt = 1 / 60) { for (let t = 0; t < sec - 1e-6; t += dt) step(dt); render(); },
  view(px, py, pz, tx, ty, tz) {
    orbit.target.set(tx, ty, tz);
    const d = new THREE.Vector3(px - tx, py - ty, pz - tz);
    orbit.dist = d.length();
    orbit.yaw = Math.atan2(d.x, d.z);
    orbit.pitch = Math.asin(clamp(d.y / orbit.dist, -1, 1));
    orbit.on = true;
    applyOrbit();
    render();
  },
  shot() { orbit.on = false; resize(); render(); },
  // the current frame as a JPEG (drawn and read in one go, before the buffer is cleared)
  opening(q = 0.9) { render(); return canvas.toDataURL('image/jpeg', q); },
};
