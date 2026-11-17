// Nim — boot, render passes, camera framing, input, adaptive quality.
import * as THREE from 'three';
import { G, OCC_N, setQuality, makeSkinMaterial, makeHeadMaterial, makeClothMaterial, makeShirtMaterial, makeMetalMaterial } from './materials.js';
import { buildTable, MatchSet, TABLE_Y, TABLE_R, L_TABLE, L_MAIN_ONLY, L_NO_MIRROR, ROW_X0, ROW_DX, ROW_Z } from './world.js';
import { initPoses, POSES } from './handModel.js';
import { Actor } from './actors.js';
import { Director } from './director.js';
import { Post } from './post.js';
import { Foley } from './audio.js';
import { UI } from './ui.js';
import { Scheduler, DEG, quatFromYZ, clamp, smoothstep, fnoise } from './util.js';

const params = new URLSearchParams(location.search);
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
const mirrorCam = new THREE.PerspectiveCamera();
mirrorCam.layers.set(0);
const lightCam = new THREE.PerspectiveCamera(58, 1, 0.7, 3.4);
lightCam.layers.set(0);
lightCam.layers.enable(L_TABLE); // the stone shades the floor & pedestal
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
  pos: new THREE.Vector3(0.0, 1.53, 1.425),
  target: new THREE.Vector3(-0.10, 0.765, 0.0),
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
const PORTRAIT = { hfov: 21.5, target: new THREE.Vector3(-0.005, 0.758, -0.02) };
const MIN_ASPECT = 0.78; // narrower screens get a letterboxed 0.78 frame
function frameCamera(w, h) {
  const aspect = w / h;
  // blend between the portrait and the reference composition
  const k = smoothstep(MIN_ASPECT, 1.35, aspect);
  const hfov = params.has('cam') ? SHOT.hfov : PORTRAIT.hfov + (SHOT.hfov - PORTRAIT.hfov) * k;
  const tH = Math.tan((hfov * DEG) / 2);
  const tanV = aspect >= SHOT.aspect ? tH / SHOT.aspect : tH / aspect;
  camera.aspect = aspect;
  camera.fov = (2 * Math.atan(tanV)) / DEG;
  camera.position.copy(SHOT.pos);
  const tgt = params.has('cam') ? SHOT.target.clone() : PORTRAIT.target.clone().lerp(SHOT.target, k);
  camera.lookAt(tgt);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();
}
// size & place the canvas: full screen, or a letterboxed frame on tall phones
function layoutCanvas() {
  const vw = window.innerWidth, vh = window.innerHeight;
  let cw = vw, ch = vh, top = 0;
  if (vw / vh < MIN_ASPECT) {
    ch = Math.round(vw / MIN_ASPECT);
    top = Math.round((vh - ch) * 0.42);
  }
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
let post, matches, table, player, opponent, director;
let quality = isMobile ? 0.8 : 1.0;
let W = 0, H = 0;

function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const { cw, ch } = layoutCanvas();
  const scale = dpr * quality;
  W = Math.max(2, Math.round(cw * scale));
  H = Math.max(2, Math.round(ch * scale));
  renderer.setPixelRatio(1);
  renderer.setSize(W, H, false);
  mainRT.setSize(W, H);
  const rs = isMobile ? 0.45 : 0.55;
  reflRT.setSize(Math.max(2, Math.round(W * rs)), Math.max(2, Math.round(H * rs)));
  post.setSize(W, H);
  frameCamera(cw, ch);
  table.top.material.uniforms.uReflScale.value = reflRT.height / (2 * Math.tan((camera.fov * DEG) / 2));
  computePickScale(cw, ch);
}

function build() {
  const t0 = performance.now();
  initPoses();
  makeTargets();
  post = new Post(renderer);
  applyLights();
  table = buildTable(scene);
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
    hip: new THREE.Vector3(-0.312, 0.44, 0.858),
    yaw: Math.atan2(0.06, -1.0),
    lean: 0.62,
    maxExtraLean: 0.22,
    twistGain: 0.26,
    armLen: [0.318, 0.29],
    hands: ['left'],
    restArm: { wrist: new THREE.Vector3(-0.10, 0.20, 0.27) },
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
    pole: [-0.15, -0.35, -0.9],
    maxExtraLean: 0.65,
  }, mats(0.034));
  opponent.headMat.uniforms.uSkinTone.value = 0.28;

  // resting poses (the shot)
  const pl = player.hands.left;
  pl.setRest(new THREE.Vector3(-0.235, 0.80, 0.245), quatFromYZ(new THREE.Vector3(0.5, -0.15, -0.85), new THREE.Vector3(-0.768, 0.452, -0.452)), POSES.fist);
  pl.snapToRest();
  const oR = opponent.hands.right; // screen-left, the one that plays
  oR.setRest(new THREE.Vector3(-0.150, 0.808, -0.345), quatFromYZ(new THREE.Vector3(0.08, -0.55, 0.85), new THREE.Vector3(-0.1, 0.85, 0.5)), POSES.poised);
  oR.snapToRest();
  const oL = opponent.hands.left; // screen-right, splayed support hand
  oL.setRest(new THREE.Vector3(0.252, 0.80, -0.36), quatFromYZ(new THREE.Vector3(-0.18, -0.28, 1.0), new THREE.Vector3(0.05, 1.0, 0.25)), POSES.spread);
  oL.snapToRest();

  director = new Director({ sched, matches, player, opponent, ui, foley, camera });
  director.autoplay = params.has('autoplay');
  ui.onConfirm = () => director.confirm();
  ui.onClear = () => director.clearSelection();
  ui.setScore(director.score);

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
    r.applyPose(POSES[n], new THREE.Quaternion());
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
let down = null;
canvas.addEventListener('pointermove', (e) => {
  if (!director || director.mode !== 'select') { canvas.classList.remove('pointing'); return; }
  if (e.pointerType === 'mouse') {
    const m = pickMatch(e.offsetX, e.offsetY);
    director.setHover(m);
    canvas.classList.toggle('pointing', !!m);
  }
});
canvas.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY, t: performance.now() }; });
canvas.addEventListener('pointerup', (e) => {
  if (!down || !director) return;
  const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
  down = null;
  if (moved > 14 || director.mode !== 'select') return;
  const m = pickMatch(e.offsetX, e.offsetY);
  if (m) {
    director.toggle(m);
    if (e.pointerType !== 'mouse') director.setHover(m);
  }
});
canvas.addEventListener('dblclick', () => director && director.confirm());
window.addEventListener('keydown', (e) => {
  if (!director) return;
  if (e.key === 'Enter') director.confirm();
  if (e.key === 'Escape') director.clearSelection();
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
    const ax = m.axis(_v);
    occ.push([m.pos.x - ax.x * 0.021, m.pos.y - ax.y * 0.021, m.pos.z - ax.z * 0.021, m.pos.x + ax.x * 0.021, m.pos.y + ax.y * 0.021, m.pos.z + ax.z * 0.021, 0.0019, 1.0]);
  }
  player.hands.left.occluders(occ);
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

let time = 0;
function step(dt) {
  time += dt;
  G.uTime.value = time;
  sched.update(dt);
  director.updateLooks(dt);
  player.update(dt, time);
  opponent.update(dt, time);
  matches.update(dt, time);
}

let fade = 0;
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
  // 3. beauty
  G.uPass.value = 0;
  table.top.material.uniforms.uReflTex.value = reflRT.texture;
  renderer.setRenderTarget(mainRT);
  renderer.render(scene, camera);
  // 4. film
  post.comp.uniforms.uFade.value = fade;
  post.comp.uniforms.uFlicker.value = fnoise(time * 9.0, 2) * 0.012;
  post.render(mainRT.texture, time);
}

// adaptive resolution
let acc = 0, frames = 0, cooldown = 3;
function adapt(dt) {
  acc += dt;
  frames++;
  cooldown -= dt;
  if (acc < 1.0) return;
  const avg = acc / frames;
  acc = 0;
  frames = 0;
  if (cooldown > 0 || params.has('fixed')) return;
  if (avg > 1 / 42 && quality > 0.5) { quality = Math.max(0.5, quality * 0.85); resize(); cooldown = 2.5; }
  else if (avg < 1 / 58 && quality < 1.0) { quality = Math.min(1.0, quality * 1.08); resize(); cooldown = 4; }
}

// ?speed=N runs the simulation N times faster (testing)
const SPEED = Math.max(1, Math.min(8, Number(params.get('speed')) || 1));
// ?timer drives frames from a timer (for headless/background testing)
const raf = params.has('timer') ? (f) => setTimeout(() => f(performance.now()), 16) : (f) => requestAnimationFrame(f);
let last = performance.now();
function loop(now) {
  const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
  last = now;
  for (let i = 0; i < SPEED; i++) step(dt);
  fade = Math.min(1, fade + dt / 2.5);
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
    ui.ready();
    if (params.has('fade')) fade = 1;
    last = performance.now();
    raf(loop);
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
};
