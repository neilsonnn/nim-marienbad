// Every material in the scene: hand-written shaders on top of glsl.js.
import * as THREE from 'three';
import { COMMON, NOISE, VERT, FRAG_HEAD, FRAG_PROLOGUE } from './glsl.js';

export const OCC_N = 40;

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
  uFacePos: { value: new THREE.Vector3(0, 10, 0) },
  uFaceDir: { value: new THREE.Vector3(0, -1, 0) },
  uFaceCone: { value: new THREE.Vector2(0.99, 0.999) },
  uFaceColor: { value: new THREE.Vector3() },
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
// Skin micro-relief: pores, knuckle creases, palmar folds, nails.
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
  vec3 Ng = N;
  float curv = curvature(Ng, vW);
  float h = skinHeight(vL, vW, nail, jAx, dorsal, fp, nailEdge);
  N = bumpNormal(vW, N, h);
  float mott = fbm3(vL * 160.0);
  float knuckle = exp(-(jAx * jAx) / (0.006 * 0.006)) * smoothstep(0.1, 0.6, dorsal);
  // skin colour kept in RGB so the scattering stays physical before the B&W print
  vec3 alb = vec3(1.0, 0.72, 0.60) * (uSkinTone / 0.778) * (0.88 + 0.22 * mott);
  alb.gb *= 1.0 - 0.16 * knuckle;                         // flushed knuckles
  alb *= 1.0 - 0.10 * smoothstep(0.2, -0.8, dorsal);      // palms a touch ruddier
  alb = mix(alb, vec3(1.0, 0.86, 0.82) * uSkinTone * 1.42, nail);
  float thin = clamp(1.6 - thick, 0.0, 1.0);
  float ao = 1.0 - 0.25 * smoothstep(0.0, -0.9, dorsal) * (1.0 - smoothstep(0.0, 0.01, abs(jAx)));
  float rough = mix(0.56 - 0.08 * knuckle, 0.28, nail);
  vec3 col = shadeSkin(vW, N, Ng, V, alb, rough, thin * 0.85, curv, ao, mix(0.10, 0.55, nail));
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
  float earThin = vAux.z;
  vec3 Ns = bumpNormal(vW, N, h);
  vec3 alb = vec3(1.0, 0.72, 0.60) * (uSkinTone / 0.778) * (0.88 + 0.22 * fbm3(vL * 90.0));
  alb.gb *= 1.0 - 0.12 * earThin;   // ears are thin: they glow when light passes through
  vec3 skinCol = shadeSkin(vW, Ns, N, V, alb, 0.5, earThin, curvature(N, vW), 1.0, 0.18);

  // --- hair: dark, slicked with pomade (Kajiya-Kay, two shifted lobes)
  vec3 T = normalize(vAux3 - N * dot(vAux3, N));
  float strand = vnoise(vec3(vL.x * 1800.0, vL.y * 1800.0 + vL.z * 300.0, vL.z * 1800.0));
  float clump = vnoise(vL * 260.0);
  // combed furrows: stretched along the comb direction (y/z), tight across (x)
  float comb = vnoise(vec3(vL.x * 420.0 + vnoise(vL * 90.0) * 2.5, vL.y * 38.0, vL.z * 38.0));
  float comb2 = vnoise(vec3(vL.x * 160.0, vL.y * 22.0 + 3.0, vL.z * 22.0));
  float shiftN = (strand - 0.5) * 0.22 * detail(0.0006, fp) + (comb - 0.5) * 0.30 * detail(0.0025, fp) + (comb2 - 0.5) * 0.2;
  vec3 hn = bumpNormal(vW, N, (comb - 0.5) * 0.00018 * detail(0.0025, fp) + (comb2 - 0.5) * 0.0003);
  vec3 halb = vec3(0.022 + 0.014 * comb * comb2);
  vec3 L; float dist;
  vec3 E = keyLight(vW, L, dist);
  float sh = E.x > 1e-5 ? shadowPCSS(vW, N, 1.5, 0.04) : 0.0;
  vec3 hairCol = hairLight(vW, hn, V, T, L, E, sh, shiftN, halb);
  float pool = lightPool(vW);
  hairCol += hairLight(vW, hn, V, T, uFillDir, uFillColor * pool, 1.0, shiftN, halb);
  hairCol += hairLight(vW, hn, V, T, uRimDir, uRimColor * pool, 1.0, shiftN, halb);
  vec3 Lb; vec3 Eb = tableBounce(vW, Lb);
  hairCol += hairLight(vW, hn, V, T, Lb, Eb, 1.0, shiftN, halb);
  vec3 Lf; vec3 Ef = faceLight(vW, Lf);
  hairCol += hairLight(vW, hn, V, T, Lf, Ef, 1.0, shiftN, halb);
  hairCol += ambientDiffuse(hn) * halb + envRadiance(reflect(-V, hn), 0.6) * 0.012;
  vec3 col = mix(skinCol, hairCol, smoothstep(0.05, 0.95, hair));
  gl_FragColor = finalColor(col, vW);
}`,
  });
}

// --------------------------------------------------------------------- cloth
const CLOTH_FRAG = /* glsl */ `
uniform float uFabric;      // base albedo of the suit
uniform float uShirtFront;  // 1 for torsos (shirt V, tie, lapels)
uniform float uSheen;       // wool sheen strength
uniform float uKeySheen;    // how much of it the hanging lamp raises
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
  s.sheen = uSheen;
  s.sheenRough = 0.45;
  s.keySheen = uKeySheen;
  s.wrap = 0.35;
  s.f0 = 0.03;
  s.shadowSoft = 1.6;
  s.thick = 0.06;
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
  const defines = torso ? { TORSO: 1, BREATH: 1, SHOULDERS: 1 } : { HAS_AUX3: 1 };
  const shoulders = torso ? {
    uShRot: { value: [new THREE.Vector4(1, 0, 0, 0), new THREE.Vector4(1, 0, 0, 0)] },
    uShS0: { value: [new THREE.Vector3(), new THREE.Vector3()] },
    uShS1: { value: [new THREE.Vector3(), new THREE.Vector3()] },
  } : {};
  return make({
    name: torso ? 'jacket' : 'sleeve',
    defines,
    side,
    uniforms: { uFabric: { value: fabric }, uShirtFront: { value: 1 }, uBreath: { value: 0 }, uSheen: { value: 0.55 }, uKeySheen: { value: 0.25 }, ...shoulders },
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
  s.albedo = vec3(0.86) * (0.95 + 0.05 * vnoise(vL * 300.0));
  s.rough = 0.78;
  s.sheen = 0.25;
  s.sheenRough = 0.5;
  s.wrap = 0.5;
  s.shadowSoft = 1.4;
  s.thick = 0.035;
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
  s.thick = 0.003;
  // phosphorus glints
  s.spec2 = head * step(0.82, grit) * 2.0;
  vec3 col = shade(s);
  col *= 1.0 + 0.6 * uHighlight + 1.1 * uSelect;
  col += vec3(0.05) * uSelect * (1.0 - head) + vec3(0.012) * uHighlight;
  gl_FragColor = finalColor(col, vW);
}`,
  });
}

// --------------------------------------------------------------------- distant lit strip (mirror only)
export function makeGlowMaterial() {
  return make({
    name: 'glow',
    side: THREE.DoubleSide,
    frag: /* glsl */ `
void main() {
${FRAG_PROLOGUE}
  // soft-edged bright strip: a hot core, a glowing falloff, a little unevenness down its length
  float u = vL.x / 0.13, v = vL.y / 1.2;
  float core = exp(-u * u * 7.0) + 0.22 * exp(-u * u * 1.6);
  float along = 0.85 + 0.15 * sin(v * 5.0 + 0.7) + 0.08 * (vnoise(vec3(0.0, v * 9.0, 1.0)) - 0.5);
  float ends = smoothstep(1.0, 0.75, abs(v));
  gl_FragColor = finalColor(vec3(2.1 * core * along * ends), vW);
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
      uStoneA: { value: null },
      uStoneB: { value: null },
      uStoneHalf: { value: STONE_HALF },
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
  vW = wp.xyz;
  vN = normalize(mat3(modelMatrix) * normal);
  vL = position; vLN = normal;
  vRefl = uReflMatrix * wp;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`,
    frag: /* glsl */ `
uniform sampler2D uReflTex;
uniform float uReflScale;
uniform float uReflGain;
uniform vec4 uOcc[OCC_N * 2];
uniform sampler2D uStoneA;   // sqrt(albedo / 0.05), haze, smudge, fine clouding
uniform sampler2D uStoneB;   // relief slope x, z (±0.03), slab undulation noise
uniform float uStoneHalf;
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
    float l2 = max(dot(d, d), 1e-8);
    float r = A.w;
    float nd = sat(d.y * inversesqrt(l2));
    occ += nd * min(r * r / l2, 1.0) * B.w;
  }
  return 1.0 - clamp(occ, 0.0, 0.92);
}

// Voronoi cells of the stone's crystals: F1, F2, and an id for the nearest crystal
vec4 crystals(vec2 g) {
  vec2 gi = floor(g), gf = fract(g);
  float F1 = 9.0, F2 = 9.0, id = 0.0;
  vec2 cell = vec2(0.0);
  for (int j = -1; j <= 1; j++)
    for (int i = -1; i <= 1; i++) {
      vec2 o = vec2(float(i), float(j));
      vec2 h = vec2(hash12(gi + o), hash12(gi + o + 17.31));
      vec2 r = o + h - gf;
      float d = dot(r, r);
      if (d < F1) { F2 = F1; F1 = d; id = hash12(gi + o + 5.17); cell = gi + o; }
      else if (d < F2) F2 = d;
    }
  return vec4(sqrt(F1), sqrt(F2), id, hash12(cell + 91.7));
}

void main() {
${FRAG_PROLOGUE}
  vec3 Ng = N;
  float flatTop = smoothstep(0.985, 0.9995, Ng.y);
  vec2 q = vW.xz;

  // ---- polished black granite. The smooth fields (domain-warped clouding, calcite
  // threads, haze, smudges, relief) never change, so they are baked once at startup
  // (bakeStone); crystals, mica and polishing swirls stay live and sharp.
  vec2 suv = q / (2.0 * uStoneHalf) + 0.5;
  vec4 sA = texture2D(uStoneA, suv);
  vec4 sB = texture2D(uStoneB, suv);
  float cloud2 = sA.a;
  vec4 cr = crystals(q * 480.0);
  float grain = detail(1.0 / 480.0, fp);
  float crystalTone = (cr.z - 0.5) * grain;
  float boundary = smoothstep(0.10, 0.0, cr.y - cr.x) * grain;
  // mica flakes catching the lamp
  float mica = step(0.955, cr.w) * smoothstep(0.42, 0.05, cr.x) * grain;
  float alb = sA.r * sA.r * 0.05 + 0.007 * crystalTone - 0.003 * boundary + 0.015 * mica;

  // ---- the polish: haze, hand-worn smudges, rotary polishing swirls
  float haze = sA.g;
  float wear = exp(-pow(length(q - vec2(-0.16, 0.14)) / 0.11, 2.0)) + exp(-pow(length(q - vec2(0.03, -0.29)) / 0.13, 2.0));
  float smudge = sA.b * (0.3 + wear);
  vec2 sc = q * 7.0;
  vec2 si = floor(sc);
  vec2 ctr = si + vec2(hash12(si + 2.3), hash12(si + 7.9));
  float sr = length(sc - ctr) / 7.0;
  float swirlMask = smoothstep(0.55, 0.85, vnoise2(q * 11.0 + 5.0)) * detail(0.0012, fp);
  float swirl = smoothstep(0.86, 1.0, abs(sin(sr * 2600.0 + hash12(si) * 40.0))) * swirlMask;
  float rough = 0.036 + 0.075 * haze + 0.035 * wear + 0.05 * smudge + 0.02 * cloud2 + 0.05 * swirl;

  // ---- micro-relief: orange peel of the hand-polished slab (baked slope) + swirl furrows
  float h = -swirl * 0.0000025 - boundary * 0.0000015;
  N = bumpNormal(vW, Ng, h);
  N = normalize(N - vec3(sB.r - 0.5, 0.0, sB.g - 0.5) * 0.06);
  float dist = length(cameraPosition - vW);
  float NoV = max(dot(N, V), 1e-3);

  // ---- planar reflection, blurred only by roughness x height above the stone
  vec2 ruv = vRefl.xy / vRefl.w + (N.xz - Ng.xz) * (0.25 / dist);
  // the slab is not perfectly flat: slow undulations a fraction of a degree deep.
  // Invisible in the stone itself, they bend the reflections of distant things
  // (the far lit strip) into wavering streaks while near hands stay crisp.
  float far = clamp(textureLod(uReflTex, ruv, 3.0).a, 0.0, 2.5);
  vec2 wav = vec2(
    sin(q.y * 41.0 + sin(q.x * 23.0 + 1.3) * 1.4) * 0.55 + sin(q.y * 97.0 + q.x * 31.0 + 2.1) * 0.25 + (sB.b - 0.5) * 0.9,
    sin(q.x * 37.0 + q.y * 13.0 + 0.4) * 0.3);
  ruv += wav * far * 0.0075;
  vec4 r0 = textureLod(uReflTex, ruv, 0.0);
  float hgt = min(r0.a, 0.6);
  float blurW = 0.0003 + hgt * (rough * 0.14 + 0.0018);
  float px = blurW * uReflScale / dist;
  float lod = clamp(log2(max(px, 1.0)), 0.0, 5.0);
  vec2 tx = vec2(px) / vec2(textureSize(uReflTex, 0));
  vec3 refl = textureLod(uReflTex, ruv, lod).rgb * 0.4;
  refl += textureLod(uReflTex, ruv + vec2(tx.x, tx.y) * 0.5, lod).rgb * 0.15;
  refl += textureLod(uReflTex, ruv + vec2(-tx.x, tx.y) * 0.5, lod).rgb * 0.15;
  refl += textureLod(uReflTex, ruv + vec2(tx.x, -tx.y) * 0.5, lod).rgb * 0.15;
  refl += textureLod(uReflTex, ruv - vec2(tx.x, tx.y) * 0.5, lod).rgb * 0.15;
  float F = 0.045 + 0.955 * pow5(1.0 - NoV);
  float reflAmt = F * uReflGain * (1.0 - rough * 2.2) * flatTop;

  Surface s = surf(vW, N, V);
  s.albedo = vec3(alb);
  s.rough = rough;
  s.f0 = 0.045;
  s.ao = occlusion(vW);
  s.specMul = 0.6 + 1.3 * haze + 0.6 * smudge;
  vec3 col = shade(s);
  col *= mix(1.0, s.ao, 0.7);
  col += refl * reflAmt;

  // ---- mica glints: each flake is a tiny tilted mirror
  vec3 L; float ld;
  vec3 E = keyLight(vW, L, ld);
  vec3 Nf = normalize(Ng + vec3(hash12(vec2(cr.w, 3.3)) - 0.5, 0.0, hash12(vec2(cr.w, 8.8)) - 0.5) * 0.5);
  float glint = pow(sat(dot(Nf, normalize(L + V))), 900.0) * mica;
  col += vec3(glint * 0.6) * E * s.ao;

  // ---- the bullnose edge mirrors the room (the planar reflection only holds on the flat)
  vec3 R = reflect(-V, N);
  float Fe = 0.045 + 0.955 * pow5(1.0 - NoV);
  col += envRadiance(R, 0.05) * Fe * 2.2 * (1.0 - flatTop);
  gl_FragColor = finalColor(col, vW);
}`,
  });
}

// --------------------------------------------------------------------- the stone's static fields, baked once
// Half-width of the square of stone covered by the bake (the slab plus its bullnose).
export const STONE_HALF = 0.385;
const BAKE_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform float uHalf;
uniform float uSize;
uniform int uOut;
${NOISE}
void main() {
  vec2 q = (vUv * 2.0 - 1.0) * uHalf;
  vec2 warp = vec2(fbm2(q * 3.1 + 1.7), fbm2(q * 3.1 + 9.2));
  float cloud = fbm2(q * 5.5 + warp * 1.8);
  float cloud2 = fbm2(q * 17.0 + warp * 0.6 + 4.0);
  if (uOut == 0) {
    // calcite threads drifting through the stone
    float vf = fbm2(q * 1.6 + warp * 1.2 + 21.0);
    float vein = smoothstep(0.010, 0.0, abs(vf - 0.53)) * 0.7 + smoothstep(0.005, 0.0, abs(fbm2(q * 3.7 + warp + 7.0) - 0.5)) * 0.35;
    vein *= smoothstep(0.35, 0.7, fbm2(q * 2.0 + 3.0));
    float alb = 0.0075 + 0.020 * cloud * cloud + 0.005 * cloud2 + 0.010 * vein;
    float haze = smoothstep(0.35, 0.85, fbm2(q * 6.5 + 2.0));
    float smudge = smoothstep(0.62, 0.78, fbm2(q * 24.0 + warp * 3.0));
    gl_FragColor = vec4(sqrt(clamp(alb / 0.05, 0.0, 1.0)), haze, smudge, cloud2);
  } else {
    // slope of the orange-peel relief (world units), from the texel-to-texel change
    float h = (fbm2(q * 2.7) - 0.5) * 0.0007 + (cloud2 - 0.5) * 0.00004;
    vec2 g = vec2(dFdx(h), dFdy(h)) * uSize / (2.0 * uHalf);
    gl_FragColor = vec4(clamp(0.5 + g / 0.06, 0.0, 1.0), fbm2(q * 9.0 + 3.7), 1.0);
  }
}`;
export function bakeStone(renderer, size) {
  const target = () => {
    const rt = new THREE.WebGLRenderTarget(size, size, {
      depthBuffer: false, generateMipmaps: true,
      minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter,
    });
    rt.texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    return rt;
  };
  const a = target(), b = target();
  const mat = new THREE.ShaderMaterial({
    uniforms: { uHalf: { value: STONE_HALF }, uSize: { value: size }, uOut: { value: 0 } },
    vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: BAKE_FRAG,
    depthTest: false,
    depthWrite: false,
  });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
  quad.frustumCulled = false;
  const scene = new THREE.Scene();
  scene.add(quad);
  const cam = new THREE.Camera();
  const prev = renderer.getRenderTarget();
  renderer.setRenderTarget(a);
  renderer.render(scene, cam);
  mat.uniforms.uOut.value = 1;
  renderer.setRenderTarget(b);
  renderer.render(scene, cam);
  renderer.setRenderTarget(prev);
  mat.dispose();
  quad.geometry.dispose();
  return { a: a.texture, b: b.texture };
}

// --------------------------------------------------------------------- metals / paper
export function makeMetalMaterial({ albedo = 0.8, rough = 0.12, aniso = 0, strip = 0 } = {}) {
  return make({
    name: 'metal',
    uniforms: { uAlb: { value: albedo }, uRough: { value: rough }, uBrush: { value: aniso }, uStrip: { value: strip } },
    frag: /* glsl */ `
uniform float uAlb;
uniform float uRough;
uniform float uBrush;
uniform float uStrip;   // a soft lit strip in the room behind the camera (the table's siding)
void main() {
${FRAG_PROLOGUE}
  // circumferential brushing on flat faces, beads left polished
  float ang = atan(vW.z, vW.x);
  float face = smoothstep(0.35, 0.1, abs(N.y)) * uBrush;
  float brush = vnoise(vec3(ang * 1400.0, vW.y * 3000.0, 0.0));
  float h = (brush - 0.5) * 0.000006 * face * detail(0.0006, fp);
  N = bumpNormal(vW, N, h);
  Surface s = surf(vW, N, V);
  s.albedo = vec3(uAlb) * (1.0 - 0.06 * face * brush);
  s.metal = 1.0;
  s.rough = uRough + 0.11 * face + 0.03 * vnoise(vW * 200.0) + 0.04 * face * (brush - 0.5);
  s.shadowSoft = 1.0;
  vec3 col = shade(s);
  if (uStrip > 0.0) {
    // The convex siding mirrors a wide, softly lit band of the room behind the camera:
    // a bright line runs along its whole front, as in the shot.
    vec3 R = reflect(-V, s.N);
    float strip = exp(-pow((R.y - 0.28) / 0.24, 2.0)) * smoothstep(-0.5, 0.5, R.z) * (0.75 + 0.25 * vnoise(vec3(atan(R.x, R.z) * 6.0, 0.0, 0.0)));
    col += s.albedo * strip * uStrip * (0.4 + 0.6 * lightPool(vW));
  }
  gl_FragColor = finalColor(col, vW);
}`,
  });
}

export function makePaperMaterial({ plain = false } = {}) {
  return make({
    name: plain ? 'matchtray' : 'matchbox',
    defines: plain ? { PLAIN: 1 } : {},
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
#ifdef PLAIN
  // the drawer: plain, slightly greyer board, no print and no striker
  ink = 0.0;
  strike = 0.0;
#endif
  float scuff = strike * smoothstep(0.55, 0.9, vnoise(vec3(p.x * 900.0, p.y * 3000.0, 1.0)));
  float h = strike * (grit - 0.5) * 0.00006 * detail(0.0004, fp) + (vnoise(p * 1200.0) - 0.5) * 0.00002 * detail(0.001, fp);
  // drawer seam on the ends
  h -= endc * smoothstep(0.0005, 0.0, abs(p.y + 0.0045)) * 0.0002;
  N = bumpNormal(vW, N, h);
  Surface s = surf(vW, N, V);
  float paper = 0.74 + 0.05 * vnoise(p * 800.0);
#ifdef PLAIN
  paper *= 0.82;
#endif
  s.albedo = vec3(paper * (1.0 - 0.82 * ink));
  s.albedo = mix(s.albedo, vec3(0.08 + 0.05 * grit) + scuff * 0.15, strike);
  s.rough = mix(0.62, 0.95, strike);
  s.wrap = 0.2;
  vec3 col = shade(s);
  gl_FragColor = finalColor(col, vW);
}`,
  });
}

