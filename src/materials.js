// Every material in the scene: hand-written shaders on top of glsl.js.
import * as THREE from 'three';
import { COMMON, VERT, FRAG_HEAD, FRAG_PROLOGUE } from './glsl.js';

export const OCC_N = 34;

// Uniforms shared (by reference) across every material.
export const G = {
  uPass: { value: 0 },
  uTime: { value: 0 },
  uTableY: { value: 0.74 },
  uTableR: { value: 0.43 },
  uKeyPos: { value: new THREE.Vector3() },
  uKeyDir: { value: new THREE.Vector3(0, -1, 0) },
  uKeyColor: { value: new THREE.Vector3(1, 1, 1) },
  uKeyCone: { value: new THREE.Vector2(0.8, 0.95) },
  uKeySize: { value: 0.12 },
  uShadowMap: { value: null },
  uShadowMatrix: { value: new THREE.Matrix4() },
  uShadowParams: { value: new THREE.Vector4() },
  uFillDir: { value: new THREE.Vector3(0, 1, 0) },
  uFillColor: { value: new THREE.Vector3() },
  uRimDir: { value: new THREE.Vector3(0, 1, 0) },
  uRimColor: { value: new THREE.Vector3() },
  uAmbTop: { value: new THREE.Vector3() },
  uAmbBot: { value: new THREE.Vector3() },
  uEnvGain: { value: 1 },
};

let SHADOW_TAPS = 12;
export function setQuality({ shadowTaps }) {
  SHADOW_TAPS = shadowTaps;
}

function make({ frag, vert = VERT, uniforms = {}, defines = {}, side = THREE.FrontSide, name }) {
  const m = new THREE.ShaderMaterial({
    name,
    uniforms: { ...G, ...uniforms },
    defines: { SHADOW_TAPS, ...defines },
    vertexShader: vert,
    fragmentShader: COMMON + FRAG_HEAD + frag,
    side,
  });
  return m;
}

// --------------------------------------------------------------------- skin (hands)
const SKIN_DETAIL = /* glsl */ `
// Skin micro-relief: pores, knuckle creases, palmar folds, dorsal veins, nails.
float skinHeight(vec3 pl, vec3 pw, float nail, float jAx, float dorsal, float fp, out float nailEdge) {
  float h = 0.0;
  float dmask = smoothstep(0.15, 0.6, dorsal);
  float pmask = smoothstep(-0.2, -0.6, dorsal);
  // concentric knuckle wrinkles over the joints
  float env = exp(-(jAx * jAx) / (0.0042 * 0.0042));
  h -= 0.00011 * env * dmask * (0.5 + 0.5 * sin(jAx * TAU / 0.00125 + vnoise(pl * 900.0) * 2.0)) * detail(0.00125, fp);
  // deep palmar flexion creases
  h -= 0.00035 * exp(-(jAx * jAx) / (0.0008 * 0.0008)) * pmask;
  // pores & fine texture
  h += (vnoise(pl * 2600.0) - 0.5) * 0.000028 * detail(0.0004, fp) * (1.0 - nail);
  h += (vnoise(pl * 700.0) - 0.5) * 0.00005 * detail(0.0014, fp) * (1.0 - nail);
  // veins on the back of the hand (bind space)
  float dz = smoothstep(0.004, 0.012, pl.z) * smoothstep(-0.01, 0.015, pl.y) * (1.0 - smoothstep(0.06, 0.085, pl.y));
  float vein1 = abs(sin(pl.x * 140.0 + sin(pl.y * 55.0) * 1.3 + 0.6));
  float vein2 = abs(sin(pl.x * 95.0 - pl.y * 70.0 + sin(pl.y * 41.0)));
  h += (smoothstep(0.16, 0.0, vein1) * 0.7 + smoothstep(0.12, 0.0, vein2) * 0.5) * 0.00032 * dz * detail(0.004, fp);
  // nail: smooth plate with faint longitudinal ridges, slight step at its border
  h += nail * 0.00018 + nail * (vnoise(vec3(pl.x * 3000.0, pl.y * 120.0, pl.z * 3000.0)) - 0.5) * 0.00001 * detail(0.0005, fp);
  nailEdge = smoothstep(0.25, 0.5, nail) * (1.0 - smoothstep(0.5, 0.9, nail));
  return h;
}
`;

export function makeSkinMaterial() {
  return make({
    name: 'skin',
    defines: { HAS_AUX: 1 },
    frag: SKIN_DETAIL + /* glsl */ `
uniform float uSkinTone;
void main() {
${FRAG_PROLOGUE}
  float nail = vAux.x, jAx = vAux.y, dorsal = vAux.z, thick = vAux.w;
  float nailEdge;
  float h = skinHeight(vL, vW, nail, jAx, dorsal, fp, nailEdge);
  N = bumpNormal(vW, N, h);
  Surface s = surf(vW, N, V);
  float mott = fbm3(vL * 160.0);
  float knuckle = exp(-(jAx * jAx) / (0.006 * 0.006)) * smoothstep(0.1, 0.6, dorsal);
  vec3 alb = vec3(uSkinTone) * (0.86 + 0.24 * mott) * (1.0 - 0.10 * knuckle);
  alb = mix(alb, vec3(uSkinTone * 1.28), nail);
  // free edge of the nail is whiter
  float tipW = smoothstep(0.85, 1.0, nail) * smoothstep(0.0, 0.004, -jAx) * 0.0;
  alb += tipW;
  s.albedo = alb;
  s.rough = mix(0.50 - 0.08 * knuckle, 0.26, nail);
  s.f0 = 0.028;
  s.spec2 = mix(0.18, 0.6, nail);
  s.wrap = 0.42;
  s.shadowSoft = 1.8;
  s.trans = clamp(1.6 - thick, 0.0, 1.0) * 0.7;
  s.ao = 1.0 - 0.25 * smoothstep(0.0, -0.9, dorsal) * (1.0 - smoothstep(0.0, 0.01, abs(jAx)));
  vec3 col = shade(s);
  gl_FragColor = finalColor(col, vW);
}`,
    uniforms: { uSkinTone: { value: 0.30 } },
  });
}

// --------------------------------------------------------------------- head (skin + hair)
const HEAD_VERT = /* glsl */ `
uniform mat4 uNeckMat;
uniform mat4 uHeadMat;
attribute vec4 aAux;
attribute vec3 aAux3;
varying vec3 vW;
varying vec3 vN;
varying vec3 vL;
varying vec3 vLN;
varying vec4 vAux;
varying vec3 vAux3;
void main() {
  // two-joint blend: the neck follows the torso, the skull follows the look-at
  float w = smoothstep(-0.075, 0.035, position.y);
  vec4 p = vec4(position, 1.0);
  vec4 wp = mix(uNeckMat * p, uHeadMat * p, w);
  vN = normalize(mix(mat3(uNeckMat) * normal, mat3(uHeadMat) * normal, w));
  vAux3 = normalize(mix(mat3(uNeckMat) * aAux3, mat3(uHeadMat) * aAux3, w));
  vW = wp.xyz;
  vL = position;
  vLN = normal;
  vAux = aAux;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

export function makeHeadMaterial() {
  return make({
    name: 'head',
    vert: HEAD_VERT,
    defines: { HAS_AUX: 1, HAS_AUX3: 1 },
    uniforms: {
      uNeckMat: { value: new THREE.Matrix4() },
      uHeadMat: { value: new THREE.Matrix4() },
      uSkinTone: { value: 0.40 },
    },
    frag: /* glsl */ `
uniform float uSkinTone;
vec3 hairLight(vec3 P, vec3 N, vec3 V, vec3 T, vec3 L, vec3 E, float shadow, float shiftN, vec3 alb) {
  vec3 H = normalize(L + V);
  vec3 T1 = normalize(T + N * (-0.10 + shiftN));
  vec3 T2 = normalize(T + N * (0.14 + shiftN));
  float d1 = dot(T1, H), d2 = dot(T2, H);
  float s1 = pow(sqrt(max(0.0, 1.0 - d1 * d1)), 140.0);
  float s2 = pow(sqrt(max(0.0, 1.0 - d2 * d2)), 26.0);
  float TL = dot(T, L);
  float kd = sqrt(max(0.0, 1.0 - TL * TL));
  float NoL = sat(dot(N, L) * 0.7 + 0.3);
  vec3 c = alb * kd * NoL / PI + vec3(s1 * 0.16 + s2 * 0.045) * NoL;
  return c * E * shadow;
}
void main() {
${FRAG_PROLOGUE}
  float hair = vAux.x;
  // --- skin
  float h = (vnoise(vL * 2400.0) - 0.5) * 0.00003 * detail(0.0005, fp) + (vnoise(vL * 500.0) - 0.5) * 0.00006 * detail(0.002, fp);
  // brows & lids (only really seen on the far player in portrait)
  float brow = smoothstep(0.012, 0.0, abs(vL.y - 0.118 + 0.25 * vL.x * vL.x)) * step(0.06, vL.z) * smoothstep(0.052, 0.012, abs(vL.x) - 0.0) * step(0.008, abs(vL.x));
  vec3 Ns = bumpNormal(vW, N, h);
  Surface s = surf(vW, Ns, V);
  s.albedo = vec3(uSkinTone) * (0.88 + 0.22 * fbm3(vL * 90.0)) * (1.0 - 0.75 * brow);
  // eyes sit in shadowed sockets
  float socket = smoothstep(0.022, 0.010, length(vec2(abs(vL.x) - 0.031, vL.y - 0.096))) * step(0.06, vL.z);
  s.albedo *= 1.0 - 0.55 * socket;
  float lip = smoothstep(0.004, 0.0, abs(vL.y - 0.034)) * smoothstep(0.022, 0.012, abs(vL.x)) * step(0.08, vL.z);
  s.albedo *= 1.0 - 0.5 * lip;
  s.rough = 0.48; s.f0 = 0.028; s.spec2 = 0.22; s.wrap = 0.45; s.shadowSoft = 1.8;
  vec3 skinCol = shade(s);

  // --- hair: dark, slicked with pomade (Kajiya-Kay, two shifted lobes)
  vec3 T = normalize(vAux3 - N * dot(vAux3, N));
  float strand = vnoise(vec3(vL.x * 1800.0, vL.y * 1800.0 + vL.z * 300.0, vL.z * 1800.0));
  float clump = vnoise(vL * 260.0);
  // combed furrows: stretched along the comb direction (y/z), tight across (x)
  float comb = vnoise(vec3(vL.x * 420.0 + vnoise(vL * 90.0) * 2.5, vL.y * 38.0, vL.z * 38.0));
  float comb2 = vnoise(vec3(vL.x * 160.0, vL.y * 22.0 + 3.0, vL.z * 22.0));
  float shiftN = (strand - 0.5) * 0.22 * detail(0.0006, fp) + (comb - 0.5) * 0.30 * detail(0.0025, fp) + (comb2 - 0.5) * 0.2;
  vec3 hn = bumpNormal(vW, N, (comb - 0.5) * 0.00018 * detail(0.0025, fp) + (comb2 - 0.5) * 0.0003);
  vec3 alb = vec3(0.022 + 0.014 * comb * comb2);
  vec3 L; float dist;
  vec3 E = keyLight(vW, L, dist);
  float sh = E.x > 1e-5 ? shadowPCSS(vW, N, 1.5) : 0.0;
  vec3 hairCol = hairLight(vW, hn, V, T, L, E, sh, shiftN, alb);
  float pool = lightPool(vW);
  hairCol += hairLight(vW, hn, V, T, uFillDir, uFillColor * pool, 1.0, shiftN, alb);
  hairCol += hairLight(vW, hn, V, T, uRimDir, uRimColor * pool, 1.0, shiftN, alb);
  hairCol += ambientDiffuse(hn) * alb + envRadiance(reflect(-V, hn), 0.6) * 0.012;
  vec3 col = mix(skinCol, hairCol, smoothstep(0.05, 0.95, hair));
  gl_FragColor = finalColor(col, vW);
}`,
  });
}

// --------------------------------------------------------------------- cloth
const CLOTH_FRAG = /* glsl */ `
uniform float uFabric;      // base albedo of the suit
uniform float uShirtFront;  // 1 for torsos (shirt V, tie, lapels)
void main() {
${FRAG_PROLOGUE}
  vec3 cl = vL;
#ifdef HAS_AUX3
  cl = vAux3;
#endif
  // twill weave + slub + seams
  float tw = sin((cl.x * 0.7 + cl.y + cl.z * 0.7) * TAU / 0.0016);
  float h = tw * 0.000035 * detail(0.0016, fp);
  h += (vnoise(cl * 420.0) - 0.5) * 0.00012 * detail(0.0025, fp);
  float shirt = 0.0, tie = 0.0, lapel = 0.0, pocket = 0.0, button = 0.0;
#ifdef TORSO
  float front = smoothstep(0.02, 0.07, vL.z);
  float vee = (0.575 - vL.y) * 0.40;            // half-width of the jacket opening
  float inV = step(0.235, vL.y) * step(abs(vL.x), vee) * front;
  shirt = inV;
  float tw2 = 0.016 + (0.53 - vL.y) * 0.035;
  tie = inV * step(abs(vL.x), tw2) * step(vL.y, 0.548);
  float edge = abs(abs(vL.x) - vee);
  lapel = front * step(0.25, vL.y) * smoothstep(0.03, 0.0, edge) * (1.0 - inV);
  h += lapel * 0.0012 * smoothstep(0.0, 0.03, edge);
  h -= front * smoothstep(0.003, 0.0, edge) * 0.0006 * step(0.24, vL.y);
  // breast pocket square
  vec2 pq = vec2(vL.x - 0.095, vL.y - 0.405);
  pocket = front * step(abs(pq.x), 0.032) * step(0.0, pq.y) * step(pq.y, 0.016 - abs(pq.x) * 0.25);
  // buttons
  button = front * (smoothstep(0.009, 0.006, length(vec2(vL.x, vL.y - 0.205))) + smoothstep(0.009, 0.006, length(vec2(vL.x, vL.y - 0.125))));
  // centre back seam & shoulder seams
  float back = smoothstep(-0.02, -0.07, vL.z);
  h -= back * smoothstep(0.0025, 0.0, abs(vL.x)) * 0.0004;
  h -= smoothstep(0.003, 0.0, abs(vL.y - 0.535 + 0.06 * abs(vL.x))) * smoothstep(0.12, 0.17, abs(vL.x)) * 0.0004;
  h *= (1.0 - shirt);
  h += shirt * (1.0 - tie) * sin(vL.y * TAU / 0.0009) * 0.00001 * detail(0.0009, fp);
  h += tie * sin((vL.x + vL.y) * TAU / 0.004) * 0.00008 * detail(0.004, fp);
#endif
  N = bumpNormal(vW, N, h);
  Surface s = surf(vW, N, V);
  float slub = fbm3(cl * 40.0);
  s.albedo = vec3(uFabric * (0.85 + 0.3 * slub));
  s.rough = 0.88;
  s.sheen = 0.55;
  s.sheenRough = 0.45;
  s.wrap = 0.35;
  s.f0 = 0.03;
  s.shadowSoft = 1.6;
  s.albedo = mix(s.albedo, vec3(0.70), max(shirt * (1.0 - tie), pocket));
  s.albedo = mix(s.albedo, vec3(0.025), tie);
  s.albedo = mix(s.albedo, vec3(0.012), button);
  s.rough = mix(s.rough, 0.6, tie);
  s.sheen *= 1.0 - shirt * (1.0 - tie) * 0.8;
  if (!gl_FrontFacing) { s.albedo *= 0.35; s.sheen = 0.0; }
  vec3 col = shade(s);
  gl_FragColor = finalColor(col, vW);
}`;

export function makeClothMaterial({ torso = false, fabric = 0.038, side = THREE.FrontSide } = {}) {
  const defines = torso ? { TORSO: 1, BREATH: 1 } : { HAS_AUX3: 1 };
  return make({
    name: torso ? 'jacket' : 'sleeve',
    defines,
    side,
    uniforms: { uFabric: { value: fabric }, uShirtFront: { value: 1 }, uBreath: { value: 0 } },
    frag: CLOTH_FRAG,
  });
}

export function makeShirtMaterial() {
  return make({
    name: 'shirt',
    side: THREE.DoubleSide,
    frag: /* glsl */ `
void main() {
${FRAG_PROLOGUE}
  float weave = sin(vL.x * TAU / 0.0007) * sin(vL.y * TAU / 0.0007) + sin(vL.z * TAU / 0.0007);
  float h = weave * 0.000008 * detail(0.0007, fp) + (vnoise(vL * 600.0) - 0.5) * 0.00003 * detail(0.002, fp);
  // stitch line near the cuff/collar edge (local y)
  h -= smoothstep(0.0006, 0.0, abs(fract(vL.y / 0.0028) - 0.5) * 0.0028) * 0.00002 * detail(0.0028, fp) * step(-0.008, vL.y);
  N = bumpNormal(vW, N, h);
  Surface s = surf(vW, N, V);
  s.albedo = vec3(0.80) * (0.95 + 0.05 * vnoise(vL * 300.0));
  s.rough = 0.78;
  s.sheen = 0.25;
  s.sheenRough = 0.5;
  s.wrap = 0.5;
  s.shadowSoft = 1.4;
  if (!gl_FrontFacing) s.albedo *= 0.55;
  vec3 col = shade(s);
  gl_FragColor = finalColor(col, vW);
}`,
  });
}

// --------------------------------------------------------------------- matches
export function makeMatchMaterial() {
  return make({
    name: 'match',
    defines: { HAS_AUX: 1 },
    uniforms: { uHighlight: { value: 0 }, uSelect: { value: 0 }, uSeed: { value: 0 } },
    frag: /* glsl */ `
uniform float uHighlight;
uniform float uSelect;
uniform float uSeed;
void main() {
${FRAG_PROLOGUE}
  float head = vAux.x;
  // aspen splint: fibres along the length (local z), a little fuzz and a sawn tail
  vec3 q = vL + uSeed;
  float fib = vnoise(vec3(q.x * 2600.0, q.y * 2600.0, q.z * 90.0));
  float h = (fib - 0.5) * 0.00002 * detail(0.0004, fp) * (1.0 - head);
  float grit = vnoise(q * 3500.0);
  h += head * (grit - 0.5) * 0.00004 * detail(0.0003, fp);
  N = bumpNormal(vW, N, h);
  Surface s = surf(vW, N, V);
  float tone = 0.80 + 0.08 * fib + 0.04 * vnoise(vec3(q.z * 40.0, uSeed, 0.0));
  s.albedo = mix(vec3(tone), vec3(0.13 + 0.05 * grit), head);
  s.rough = mix(0.72, 0.42, head);
  s.f0 = mix(0.03, 0.05, head);
  s.wrap = mix(0.45, 0.1, head);
  s.trans = 0.25 * (1.0 - head);
  s.shadowSoft = 0.6;
  // phosphorus glints
  s.spec2 = head * step(0.82, grit) * 2.0;
  vec3 col = shade(s);
  col *= 1.0 + 0.6 * uHighlight + 1.1 * uSelect;
  col += vec3(0.05) * uSelect * (1.0 - head) + vec3(0.012) * uHighlight;
  gl_FragColor = finalColor(col, vW);
}`,
  });
}

// --------------------------------------------------------------------- table top
export function makeTableMaterial() {
  return make({
    name: 'tabletop',
    defines: { OCC_N },
    uniforms: {
      uReflTex: { value: null },
      uReflMatrix: { value: new THREE.Matrix4() },
      uReflScale: { value: 500 },
      uReflGain: { value: 3.6 },
      uOcc: { value: Array.from({ length: OCC_N * 2 }, () => new THREE.Vector4(0, -10, 0, 0)) },
    },
    vert: /* glsl */ `
uniform mat4 uReflMatrix;
varying vec3 vW;
varying vec3 vN;
varying vec3 vL;
varying vec3 vLN;
varying vec4 vRefl;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vW = wp.xyz; vN = vec3(0.0, 1.0, 0.0); vL = position; vLN = normal;
  vRefl = uReflMatrix * wp;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`,
    frag: /* glsl */ `
uniform sampler2D uReflTex;
uniform float uReflScale;
uniform float uReflGain;
uniform vec4 uOcc[OCC_N * 2];
varying vec4 vRefl;

float occlusion(vec3 P) {
  float occ = 0.0;
  for (int i = 0; i < OCC_N; i++) {
    vec4 A = uOcc[i * 2];
    vec4 B = uOcc[i * 2 + 1];
    if (A.w <= 0.0) continue;
    vec3 ba = B.xyz - A.xyz;
    vec3 pa = P - A.xyz;
    float bb = dot(ba, ba);
    float hh = bb > 0.0 ? clamp(dot(pa, ba) / bb, 0.0, 1.0) : 0.0;
    vec3 d = A.xyz + ba * hh - P;
    float l2 = dot(d, d);
    float r = A.w;
    float nd = sat(d.y * inversesqrt(l2));
    occ += nd * min(r * r / l2, 1.0) * B.w;
  }
  return 1.0 - clamp(occ, 0.0, 0.92);
}

void main() {
${FRAG_PROLOGUE}
  vec2 q = vW.xz;
  float rr = length(q);
  // black Belgian marble: faint clouds, quartz flecks and the odd fossil vein
  float n1 = fbm2(q * 4.0 + 3.0);
  float n2 = fbm2(q * 19.0 + 11.0);
  float n3 = vnoise2(q * 210.0);
  float fleck = smoothstep(0.80, 0.97, vnoise2(q * 520.0)) * detail(0.004, fp);
  float vf = fbm2(q * 2.3 + vec2(n1, n2) * 0.9);
  float vein = smoothstep(0.03, 0.0, abs(vf - 0.5)) * (0.5 + n2);
  float alb = 0.010 + 0.009 * n2 + 0.012 * n3 * detail(0.006, fp) + 0.008 * fleck + 0.006 * vein * n1;
  // the polish is a little hazier where hands have rested for years
  float wear = exp(-pow(length(q - vec2(-0.16, 0.14)) / 0.11, 2.0)) + exp(-pow(length(q - vec2(0.03, -0.29)) / 0.13, 2.0));
  float haze = smoothstep(0.35, 0.85, fbm2(q * 6.5 + 2.0));
  float rough = 0.05 + 0.07 * haze + 0.035 * wear + 0.02 * n3;
  // slight waviness of the hand-polished slab
  float h = (fbm2(q * 2.7) - 0.5) * 0.0009 + (n2 - 0.5) * 0.00006 + (vnoise2(q * 900.0) - 0.5) * 0.000008 * detail(0.0011, fp);
  N = bumpNormal(vW, vec3(0.0, 1.0, 0.0), h);

  float dist = length(cameraPosition - vW);
  float NoV = max(dot(N, V), 1e-3);

  // ---- planar reflection, blurred by roughness x distance-to-surface
  vec2 ruv = vRefl.xy / vRefl.w;
  ruv += (N.xz - vec2(0.0)) * 0.5 * (1.0 / dist);
  vec4 r0 = textureLod(uReflTex, ruv, 1.0);
  float hgt = min(r0.a, 0.6);
  float blurW = 0.0007 + hgt * (rough * 0.55 + 0.012);
  float px = blurW * uReflScale / dist;
  float lod = clamp(log2(max(px, 1.0)), 0.0, 6.0);
  vec2 tx = vec2(px) / vec2(textureSize(uReflTex, 0));
  vec3 refl = textureLod(uReflTex, ruv, lod).rgb * 0.4;
  refl += textureLod(uReflTex, ruv + vec2(tx.x, 0.0) * 0.6, lod).rgb * 0.15;
  refl += textureLod(uReflTex, ruv - vec2(tx.x, 0.0) * 0.6, lod).rgb * 0.15;
  refl += textureLod(uReflTex, ruv + vec2(0.0, tx.y) * 0.6, lod).rgb * 0.15;
  refl += textureLod(uReflTex, ruv - vec2(0.0, tx.y) * 0.6, lod).rgb * 0.15;
  float F = 0.04 + 0.96 * pow5(1.0 - NoV);
  float reflAmt = F * uReflGain * (1.0 - rough * 2.0);

  Surface s = surf(vW, N, V);
  s.albedo = vec3(alb);
  s.rough = rough;
  s.f0 = 0.045;
  s.shadowSoft = 1.0;
  s.ao = occlusion(vW);
  s.specMul = 0.75 + 0.6 * haze;
  vec3 col = shade(s);
  col *= mix(1.0, s.ao, 0.7);
  col += refl * reflAmt;
  // fade toward the bevel: the chrome band takes over
  gl_FragColor = finalColor(col, vW);
}`,
  });
}

// --------------------------------------------------------------------- metals / paper / floor
export function makeMetalMaterial({ albedo = 0.8, rough = 0.12, aniso = 0 } = {}) {
  return make({
    name: 'metal',
    uniforms: { uAlb: { value: albedo }, uRough: { value: rough }, uBrush: { value: aniso } },
    frag: /* glsl */ `
uniform float uAlb;
uniform float uRough;
uniform float uBrush;
void main() {
${FRAG_PROLOGUE}
  // fine circumferential polishing marks
  float ang = atan(vW.z, vW.x);
  float h = (vnoise(vec3(ang * 900.0, vW.y * 40.0, 0.0)) - 0.5) * 0.000012 * uBrush;
  N = bumpNormal(vW, N, h);
  Surface s = surf(vW, N, V);
  s.albedo = vec3(uAlb);
  s.metal = 1.0;
  s.rough = uRough + 0.03 * vnoise(vW * 200.0);
  s.shadowSoft = 1.0;
  vec3 col = shade(s);
  gl_FragColor = finalColor(col, vW);
}`,
  });
}

export function makePaperMaterial() {
  return make({
    name: 'matchbox',
    frag: /* glsl */ `
// Local box: x in [-0.0265,0.0265], y in [-0.0075,0.0075], z in [-0.018,0.018]
void main() {
${FRAG_PROLOGUE}
  vec3 p = vL;
  vec3 an = abs(vLN);
  float top = step(0.5, vLN.y);
  float side = step(0.5, an.z);   // long sides carry the striker strips
  float endc = step(0.5, an.x);
  // printed label on top: border, rule lines, emblem
  vec2 t = p.xz;
  float border = step(abs(t.x), 0.0235) * step(abs(t.y), 0.0155) * (1.0 - step(abs(t.x), 0.0222) * step(abs(t.y), 0.0142));
  float emblem = smoothstep(0.0012, 0.0004, abs(length(t - vec2(-0.008, 0.0)) - 0.0075));
  float star = smoothstep(0.0055, 0.0045, length(t - vec2(-0.008, 0.0)) * (1.0 + 0.35 * sin(atan(t.y, t.x + 0.008) * 5.0)));
  float lines = step(0.004, t.x) * step(t.x, 0.020) * (step(abs(t.y - 0.006), 0.0011) + step(abs(t.y), 0.0016) * 0.8 + step(abs(t.y + 0.0065), 0.0008));
  float ink = top * clamp(border + emblem + star + lines * (0.6 + 0.4 * vnoise2(t * 2000.0)), 0.0, 1.0);
  // striker: dark, gritty, scuffed
  float grit = vnoise(p * 6000.0);
  float strike = side * step(abs(p.y), 0.0058) * step(abs(p.x), 0.024);
  float scuff = strike * smoothstep(0.55, 0.9, vnoise(vec3(p.x * 900.0, p.y * 3000.0, 1.0)));
  float h = strike * (grit - 0.5) * 0.00006 * detail(0.0004, fp) + (vnoise(p * 1200.0) - 0.5) * 0.00002 * detail(0.001, fp);
  // drawer seam on the ends
  h -= endc * smoothstep(0.0005, 0.0, abs(p.y + 0.0045)) * 0.0002;
  N = bumpNormal(vW, N, h);
  Surface s = surf(vW, N, V);
  float paper = 0.74 + 0.05 * vnoise(p * 800.0);
  s.albedo = vec3(paper * (1.0 - 0.82 * ink));
  s.albedo = mix(s.albedo, vec3(0.08 + 0.05 * grit) + scuff * 0.15, strike);
  s.rough = mix(0.62, 0.95, strike);
  s.wrap = 0.2;
  vec3 col = shade(s);
  gl_FragColor = finalColor(col, vW);
}`,
  });
}

export function makeFloorMaterial() {
  return make({
    name: 'floor',
    frag: /* glsl */ `
void main() {
${FRAG_PROLOGUE}
  // herringbone-ish parquet, almost entirely lost in the dark
  vec2 q = vW.xz * 8.0;
  vec2 c = floor(q);
  float pl = mod(c.x + c.y, 2.0);
  float grain = vnoise2(vec2(mix(q.x, q.y, pl) * 30.0, mix(q.y, q.x, pl) * 2.0));
  Surface s = surf(vW, N, V);
  s.albedo = vec3(0.04 + 0.03 * grain);
  s.rough = 0.35;
  vec3 col = shade(s) * exp(-dot(vW.xz, vW.xz) / (1.1 * 1.1));
  gl_FragColor = finalColor(col, vW);
}`,
  });
}
