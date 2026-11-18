// GLSL library: all lighting, BRDFs, noise and shadowing are written here from scratch.

const N_DISK = 16;
const disk = [];
for (let i = 0; i < N_DISK; i++) {
  const r = Math.sqrt((i + 0.5) / N_DISK);
  const a = i * 2.399963229728653;
  disk.push(`vec2(${(r * Math.cos(a)).toFixed(5)}, ${(r * Math.sin(a)).toFixed(5)})`);
}

export const COMMON = /* glsl */ `
#define PI 3.14159265359
#define TAU 6.28318530718
uniform int uPass;            // 0 = beauty, 1 = mirror (table reflection), 2 = shadow depth
uniform float uTime;
uniform float uTableY;
uniform float uTableR;
uniform vec3 uKeyPos;
uniform vec3 uKeyDir;
uniform vec3 uKeyColor;
uniform vec2 uKeyCone;        // cos(outer), cos(inner)
uniform float uKeySize;       // emitter radius (m)
uniform sampler2D uShadowMap;
uniform mat4 uShadowMatrix;
uniform vec4 uShadowParams;   // texel, near, far, penumbra scale
uniform vec3 uFillDir;
uniform vec3 uFillColor;
uniform vec3 uRimDir;
uniform vec3 uRimColor;
uniform vec3 uFacePos;     // narrow follow-spot on the opponent's face (an eye light)
uniform vec3 uFaceDir;
uniform vec2 uFaceCone;
uniform vec3 uFaceColor;
uniform vec3 uAmbTop;
uniform vec3 uAmbBot;
uniform float uEnvGain;

float sat(float x) { return clamp(x, 0.0, 1.0); }
vec3 sat3(vec3 x) { return clamp(x, 0.0, 1.0); }
float pow5(float x) { float x2 = x * x; return x2 * x2 * x; }
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }

float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float hash13(vec3 p3) { p3 = fract(p3 * 0.1031); p3 += dot(p3, p3.zyx + 31.32); return fract((p3.x + p3.y) * p3.z); }

float vnoise(vec3 p) {
  vec3 i = floor(p); vec3 f = fract(p); vec3 u = f * f * (3.0 - 2.0 * f);
  float a = hash13(i), b = hash13(i + vec3(1, 0, 0)), c = hash13(i + vec3(0, 1, 0)), d = hash13(i + vec3(1, 1, 0));
  float e = hash13(i + vec3(0, 0, 1)), f1 = hash13(i + vec3(1, 0, 1)), g = hash13(i + vec3(0, 1, 1)), h = hash13(i + vec3(1, 1, 1));
  return mix(mix(mix(a, b, u.x), mix(c, d, u.x), u.y), mix(mix(e, f1, u.x), mix(g, h, u.x), u.y), u.z);
}
float vnoise2(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1, 0)), u.x), mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), u.x), u.y);
}
float fbm3(vec3 p) { float s = 0.0, a = 0.5; for (int i = 0; i < 4; i++) { s += a * vnoise(p); p = p * 2.07 + 13.7; a *= 0.5; } return s / 0.9375; }
float fbm2(vec2 p) { float s = 0.0, a = 0.5; for (int i = 0; i < 4; i++) { s += a * vnoise2(p); p = p * 2.11 + 7.3; a *= 0.5; } return s / 0.9375; }

// How much of a procedural feature of world period 'period' survives the pixel footprint.
float detail(float period, float footprint) { return 1.0 - smoothstep(0.18, 0.55, footprint / period); }

// Bump mapping on arbitrary surfaces (Mikkelsen 2010) from a scalar height field.
vec3 bumpNormal(vec3 pos, vec3 n, float h) {
  vec3 dpx = dFdx(pos), dpy = dFdy(pos);
  vec3 r1 = cross(dpy, n), r2 = cross(n, dpx);
  float det = dot(dpx, r1);
  float dhx = dFdx(h), dhy = dFdy(h);
  vec3 grad = sign(det) * (dhx * r1 + dhy * r2);
  vec3 r = abs(det) * n - grad;
  return dot(r, r) > 1e-24 ? normalize(r) : n;
}

// ---------------------------------------------------------------- BRDFs
float D_GGX(float NoH, float a) { float a2 = a * a; float f = (NoH * a2 - NoH) * NoH + 1.0; return a2 / (PI * f * f + 1e-7); }
float V_SmithGGX(float NoV, float NoL, float a) {
  float a2 = a * a;
  float gv = NoL * sqrt(NoV * NoV * (1.0 - a2) + a2);
  float gl = NoV * sqrt(NoL * NoL * (1.0 - a2) + a2);
  return 0.5 / (gv + gl + 1e-5);
}
vec3 F_Schlick(vec3 f0, float VoH) { return f0 + (1.0 - f0) * pow5(1.0 - VoH); }
// Charlie sheen (Estevez & Kulla) for cloth fibres
float D_Charlie(float NoH, float r) { float inv = 1.0 / max(r, 0.07); float s2 = max(1.0 - NoH * NoH, 1e-4); return (2.0 + inv) * pow(s2, inv * 0.5) / TAU; }
float V_Neubelt(float NoV, float NoL) { return 1.0 / (4.0 * (NoL + NoV - NoL * NoV) + 1e-4); }
// analytic split-sum (Karis, mobile)
vec2 envBRDF(float NoV, float r) {
  const vec4 c0 = vec4(-1.0, -0.0275, -0.572, 0.022);
  const vec4 c1 = vec4(1.0, 0.0425, 1.04, -0.04);
  vec4 q = r * c0 + c1;
  float a004 = min(q.x * q.x, exp2(-9.28 * NoV)) * q.x + q.y;
  return vec2(-1.04, 1.04) * a004 + q.zw;
}

// ---------------------------------------------------------------- environment
// A dark salon: one hanging lamp above the table, faint high windows, black walls.
vec3 envRadiance(vec3 R, float rough) {
  vec3 toLamp = normalize(uKeyPos - vec3(0.0, uTableY, 0.0));
  float sharp = mix(900.0, 2.5, sqrt(rough));
  float lamp = pow(max(dot(R, toLamp), 0.0), sharp) * (sharp + 2.0) / TAU;
  lamp *= 0.0035;
  float sky = 0.010 * smoothstep(-0.15, 0.9, R.y) + 0.003;
  vec3 w1 = normalize(vec3(-0.85, 0.30, -0.45));
  vec3 w2 = normalize(vec3(0.9, 0.22, -0.35));
  float ws = mix(80.0, 3.0, sqrt(rough));
  float win = (pow(max(dot(R, w1), 0.0), ws) + 0.6 * pow(max(dot(R, w2), 0.0), ws)) * mix(0.10, 0.012, sqrt(rough));
  float glow = smoothstep(0.30, 0.92, R.y) * mix(0.42, 0.035, sqrt(rough)) * (0.7 + 0.3 * smoothstep(-0.5, 0.8, R.z));
  return vec3(lamp + sky + win + glow) * uEnvGain;
}
vec3 ambientDiffuse(vec3 N) { return mix(uAmbBot, uAmbTop, N.y * 0.5 + 0.5); }
// fills pool around the table (lamp bounce); bodies further away sink into the dark
float lightPool(vec3 P) { vec3 d = P - vec3(0.0, uTableY + 0.1, 0.0); return exp(-dot(d, d) / (0.62 * 0.62)); }

// ---------------------------------------------------------------- shadows (PCSS-lite)
const vec2 DISK[${N_DISK}] = vec2[${N_DISK}](${disk.join(', ')});
float linShadow(float d) { float n = uShadowParams.y, f = uShadowParams.z; float z = d * 2.0 - 1.0; return 2.0 * n * f / (f + n - z * (f - n)); }
float shadowPCSS(vec3 P, vec3 N, float soft) {
  vec3 L = normalize(uKeyPos - P);
  float NoL = dot(N, L);
  vec3 offP = P + N * (0.0010 + 0.0025 * (1.0 - abs(NoL)));
  vec4 sc = uShadowMatrix * vec4(offP, 1.0);
  if (sc.w <= 0.0) return 1.0;
  vec2 uv = sc.xy / sc.w * 0.5 + 0.5;
  if (uv.x <= 0.002 || uv.x >= 0.998 || uv.y <= 0.002 || uv.y >= 0.998) return 1.0;
  float dR = sc.w;
  float ang = ign(gl_FragCoord.xy) * TAU;
  float ca = cos(ang), sa = sin(ang);
  mat2 rot = mat2(ca, sa, -sa, ca);
  float tex = uShadowParams.x;
  float bias = 0.0007 + 0.0016 * (1.0 - sat(NoL));
  // blocker search
  float sumB = 0.0, nB = 0.0;
  for (int i = 0; i < 6; i++) {
    vec2 o = rot * DISK[i * 2 + 1] * tex * 14.0;
    float d = linShadow(texture2D(uShadowMap, uv + o).r);
    if (d < dR - bias) { sumB += d; nB += 1.0; }
  }
  if (nB < 0.5) return 1.0;
  float dB = sumB / nB;
  float pen = (dR - dB) / dB * uShadowParams.w / dR;
  pen = clamp(pen * soft, tex * 1.5, tex * 18.0); // never a hard one-texel edge
  float lit = 0.0;
  for (int i = 0; i < SHADOW_TAPS; i++) {
    vec2 o = rot * DISK[i * (${N_DISK} / SHADOW_TAPS)] * pen;
    float d = linShadow(texture2D(uShadowMap, uv + o).r);
    lit += step(dR - bias, d);
  }
  return lit / float(SHADOW_TAPS);
}

// narrow, shadowless follow-spot from in front, aimed at the opponent's face
vec3 faceLight(vec3 P, out vec3 L) {
  vec3 d = uFacePos - P;
  float d2 = dot(d, d);
  L = d * inversesqrt(d2);
  float spot = smoothstep(uFaceCone.x, uFaceCone.y, dot(-L, uFaceDir));
  return uFaceColor * spot * spot / d2;
}

// ---------------------------------------------------------------- the stone as a mirror for the lamp
// The polished table throws the lamp back up: a virtual lamp mirrored below the stone
// lights chins, palms and the undersides of fingers, gated by whether the bounce point
// on the stone is itself lit (one hard shadow tap) and by the stone's Fresnel.
float shadowHard(vec3 P) {
  vec4 sc = uShadowMatrix * vec4(P + vec3(0.0, 0.0015, 0.0), 1.0);
  if (sc.w <= 0.0) return 1.0;
  vec2 uv = sc.xy / sc.w * 0.5 + 0.5;
  if (uv.x <= 0.0 || uv.x >= 1.0 || uv.y <= 0.0 || uv.y >= 1.0) return 1.0;
  return step(sc.w - 0.003, linShadow(texture2D(uShadowMap, uv).r));
}
vec3 keyLight(vec3 P, out vec3 L, out float dist);
vec3 tableBounce(vec3 P, out vec3 Lb) {
  Lb = vec3(0.0, -1.0, 0.0);
  if (P.y < uTableY + 0.001) return vec3(0.0);
  vec3 Lm = vec3(uKeyPos.x, 2.0 * uTableY - uKeyPos.y, uKeyPos.z);
  vec3 d = P - Lm;
  vec3 Q = Lm + d * ((uTableY - Lm.y) / d.y);
  float onTable = smoothstep(uTableR, uTableR - 0.03, length(Q.xz));
  if (onTable <= 0.0) return vec3(0.0);
  vec3 Lq; float dq;
  vec3 Eq = keyLight(Q, Lq, dq);
  float d2 = dot(d, d);
  float cosI = abs(d.y) * inversesqrt(d2);
  float F = 0.045 + 0.955 * pow5(1.0 - cosI);
  Lb = -d * inversesqrt(d2);
  return Eq * (dq * dq / d2) * F * 3.0 * onTable * shadowHard(Q);
}

// ---------------------------------------------------------------- key light
vec3 keyLight(vec3 P, out vec3 L, out float dist) {
  vec3 d = uKeyPos - P;
  dist = length(d);
  L = d / dist;
  float cd = dot(-L, uKeyDir);
  float spot = smoothstep(uKeyCone.x, uKeyCone.y, cd);
  spot *= spot;
  return uKeyColor * spot / (dist * dist);
}

struct Surface {
  vec3 P; vec3 N; vec3 V;
  vec3 albedo;
  float rough;
  float metal;
  float f0;
  float wrap;        // diffuse wrap (subsurface softness)
  float sheen;       // cloth sheen strength
  float sheenRough;
  float ao;
  float shadowSoft;
  float trans;       // thin-part transmission
  float specMul;
  float spec2;       // second, sharper specular lobe weight (skin oil, lacquer)
};

Surface surf(vec3 P, vec3 N, vec3 V) {
  Surface s;
  s.P = P; s.N = N; s.V = V;
  s.albedo = vec3(0.5); s.rough = 0.5; s.metal = 0.0; s.f0 = 0.04;
  s.wrap = 0.0; s.sheen = 0.0; s.sheenRough = 0.5; s.ao = 1.0;
  s.shadowSoft = 1.0; s.trans = 0.0; s.specMul = 1.0; s.spec2 = 0.0;
  return s;
}

vec3 directLobe(Surface s, vec3 L, vec3 E, float shadow, float areaR) {
  float NoL = dot(s.N, L);
  float NoV = max(dot(s.N, s.V), 1e-3);
  vec3 H = normalize(L + s.V);
  float NoH = sat(dot(s.N, H)), VoH = sat(dot(s.V, H));
  float NoLc = sat(NoL);
  float a = max(s.rough * s.rough, 0.0025);
  float aL = sat(a + areaR);
  vec3 F0 = mix(vec3(s.f0), s.albedo, s.metal);
  vec3 F = F_Schlick(F0, VoH);
  vec3 spec = D_GGX(NoH, aL) * V_SmithGGX(NoV, NoLc, aL) * F * (a * a) / (aL * aL);
  if (s.spec2 > 0.0) {
    float a2 = max(a * 0.45, 0.002);
    float a2L = sat(a2 + areaR);
    spec += s.spec2 * D_GGX(NoH, a2L) * V_SmithGGX(NoV, NoLc, a2L) * F * (a2 * a2) / (a2L * a2L);
  }
  float w = s.wrap;
  float diffTerm = sat((NoL + w) / (1.0 + w)) / (1.0 + w);
  vec3 diff = s.albedo * (1.0 - s.metal) * (1.0 - F) * diffTerm / PI;
  vec3 sh = vec3(s.sheen * D_Charlie(NoH, s.sheenRough) * V_Neubelt(NoV, NoLc));
  float tr = s.trans * pow(sat(dot(s.V, -L) * 0.5 + 0.5), 6.0) * 0.6;
  return (diff + spec * NoLc * s.specMul + sh * NoLc + s.albedo * tr / PI) * E * shadow;
}

vec3 shade(Surface s) {
  vec3 L; float dist;
  vec3 E = keyLight(s.P, L, dist);
  float shadow = 1.0;
  if (E.x > 1e-5 && dot(s.N, L) > -0.35) shadow = shadowPCSS(s.P, s.N, s.shadowSoft);
  else if (E.x <= 1e-5) shadow = 0.0;
  // skin & cloth: the shadow terminator wraps softly instead of a hard edge
  float areaR = uKeySize / (2.0 * dist);
  vec3 col = directLobe(s, L, E, shadow, areaR);
  // soft fills (no shadows), pooled around the table like the bounce from the stone & lamp
  float pool = lightPool(s.P);
  col += directLobe(s, uFillDir, uFillColor * pool, 1.0, 0.25);
  col += directLobe(s, uRimDir, uRimColor * pool, 1.0, 0.15);
  vec3 Lb; vec3 Eb = tableBounce(s.P, Lb);
  col += directLobe(s, Lb, Eb, 1.0, 0.1);
  vec3 Lf; vec3 Ef = faceLight(s.P, Lf);
  if (Ef.x > 1e-5) col += directLobe(s, Lf, Ef, 1.0, 0.2);
  // ambient
  float NoV = max(dot(s.N, s.V), 1e-3);
  vec2 ab = envBRDF(NoV, s.rough);
  vec3 F0 = mix(vec3(s.f0), s.albedo, s.metal);
  vec3 R = reflect(-s.V, s.N);
  col += ambientDiffuse(s.N) * s.albedo * (1.0 - s.metal) * s.ao * (0.35 + 0.65 * pool);
  col += envRadiance(R, s.rough) * (F0 * ab.x + ab.y) * s.ao * s.specMul;
  return col;
}

// ---------------------------------------------------------------- skin
// Subsurface approximation in the spirit of pre-integrated skin: light wraps
// further for longer wavelengths and on tighter curvature, the penumbra bleeds,
// thin parts (fingers, ear rims) transmit, and a vellus-hair rim softens the
// silhouette. Diffusion also blurs the micro-normal per channel.
vec3 wrapDiffuse(vec3 NoL3, vec3 w) { return sat3((NoL3 + w) / (1.0 + w)) / (1.0 + w); }
vec3 shadeSkin(vec3 P, vec3 N, vec3 Ng, vec3 V, vec3 alb, float rough, float thin, float curv, float ao, float oil) {
  vec3 L; float dist;
  vec3 E = keyLight(P, L, dist);
  float sh = 0.0;
  if (E.x > 1e-5 && dot(Ng, L) > -0.6) sh = shadowPCSS(P, Ng, 2.4);
  // scattered light reaches into the shadow edge: red the furthest
  vec3 shC = max(vec3(sh), pow(vec3(sh), vec3(0.45, 0.7, 0.9)) * vec3(1.0, 0.97, 0.95));
  vec3 wrapC = vec3(0.62, 0.27, 0.15) * (0.5 + 1.1 * curv);
  vec3 Nr = normalize(mix(N, Ng, 0.8)), Nm = normalize(mix(N, Ng, 0.45));
  vec3 NoL3 = vec3(dot(Nr, L), dot(Nm, L), dot(N, L));
  vec3 col = alb * wrapDiffuse(NoL3, wrapC) / PI * E * shC;
  // translucency of thin parts
  float back = pow(sat(dot(V, -L) * 0.5 + 0.5), 4.0) + 0.3 * sat(0.3 - dot(Ng, L));
  col += alb * vec3(1.0, 0.5, 0.3) * thin * back * E * (0.15 + 0.85 * shC.r) * 0.32;
  // two specular lobes: dull epidermis + thin oily film
  vec3 H = normalize(L + V);
  float NoV = max(dot(N, V), 1e-3);
  float NoH = sat(dot(N, H)), VoH = sat(dot(V, H)), NoL = sat(dot(N, L));
  float aL = uKeySize / (2.0 * dist);
  float a1 = max(rough * rough, 0.02), a2 = max(a1 * 0.35, 0.008);
  float b1 = sat(a1 + aL), b2 = sat(a2 + aL);
  float F = 0.028 + 0.972 * pow5(1.0 - VoH);
  float spec = 0.9 * D_GGX(NoH, b1) * V_SmithGGX(NoV, NoL, b1) * (a1 * a1) / (b1 * b1)
             + oil * D_GGX(NoH, b2) * V_SmithGGX(NoV, NoL, b2) * (a2 * a2) / (b2 * b2);
  col += vec3(spec * F * NoL) * E * sh;
  // vellus hair / peach fuzz
  col += alb * pow(1.0 - NoV, 3.0) * 0.16 * E * shC.g * sat(dot(Ng, L) + 0.35);
  // pooled fills, wrapped as well
  float pool = lightPool(P);
  col += alb * wrapDiffuse(vec3(dot(Nr, uFillDir), dot(Nm, uFillDir), dot(N, uFillDir)), wrapC) / PI * uFillColor * pool;
  col += alb * wrapDiffuse(vec3(dot(Nr, uRimDir), dot(Nm, uRimDir), dot(N, uRimDir)), wrapC) / PI * uRimColor * pool;
  col += alb * vec3(1.0, 0.5, 0.3) * thin * pow(sat(dot(V, -uRimDir)), 3.0) * uRimColor * pool * 0.3;
  vec3 Lb; vec3 Eb = tableBounce(P, Lb);
  col += alb * wrapDiffuse(vec3(dot(Nr, Lb), dot(Nm, Lb), dot(N, Lb)), wrapC) / PI * Eb;
  vec3 Lf; vec3 Ef = faceLight(P, Lf);
  if (Ef.x > 1e-5) {
    col += alb * wrapDiffuse(vec3(dot(Nr, Lf), dot(Nm, Lf), dot(N, Lf)), wrapC) / PI * Ef;
    vec3 Hf = normalize(Lf + V);
    float bf = sat(a2 + 0.02);
    col += vec3(oil * D_GGX(sat(dot(N, Hf)), bf) * V_SmithGGX(NoV, sat(dot(N, Lf)), bf) * (0.028 + 0.972 * pow5(1.0 - sat(dot(V, Hf)))) * sat(dot(N, Lf))) * Ef;
  }
  col += ambientDiffuse(Nr) * alb * ao * (0.35 + 0.65 * pool);
  vec2 ab = envBRDF(NoV, rough);
  col += envRadiance(reflect(-V, N), rough) * (0.028 * ab.x + ab.y) * ao * 0.7;
  return col;
}
// screen-space curvature (1/m), normalised to roughly [0,1] for finger-sized features
float curvature(vec3 Ng, vec3 P) { return clamp(length(fwidth(Ng)) / (length(fwidth(P)) + 1e-6) * 0.0045, 0.0, 1.0); }

// Fragment output convention shared by every material.
// alpha: height above the stone in the mirror pass, camera distance in the beauty pass (for depth of field)
vec4 finalColor(vec3 col, vec3 P) {
  // never let a degenerate pixel poison the blur passes
  if (any(isnan(col)) || any(isinf(col))) col = vec3(0.0);
  col = clamp(col, 0.0, 64.0);
  return vec4(col, uPass == 1 ? max(P.y - uTableY, 0.0) : (uPass == 0 ? distance(P, cameraPosition) : 1.0));
}
`;

// Standard vertex shader: optional GPU skinning, world-space varyings.
export const VERT = /* glsl */ `
#include <skinning_pars_vertex>
#ifdef USE_SKINNING
// Dual-quaternion skinning: blends rigid transforms instead of matrices, so a
// sharply bent wrist or a swung thumb keeps its volume instead of pinching.
vec4 m2q(mat4 m) {
  float t = m[0][0] + m[1][1] + m[2][2];
  if (t > 0.0) {
    float s = sqrt(t + 1.0) * 2.0;
    return vec4((m[1][2] - m[2][1]) / s, (m[2][0] - m[0][2]) / s, (m[0][1] - m[1][0]) / s, 0.25 * s);
  } else if (m[0][0] > m[1][1] && m[0][0] > m[2][2]) {
    float s = sqrt(1.0 + m[0][0] - m[1][1] - m[2][2]) * 2.0;
    return vec4(0.25 * s, (m[1][0] + m[0][1]) / s, (m[2][0] + m[0][2]) / s, (m[1][2] - m[2][1]) / s);
  } else if (m[1][1] > m[2][2]) {
    float s = sqrt(1.0 + m[1][1] - m[0][0] - m[2][2]) * 2.0;
    return vec4((m[1][0] + m[0][1]) / s, 0.25 * s, (m[2][1] + m[1][2]) / s, (m[2][0] - m[0][2]) / s);
  }
  float s = sqrt(1.0 + m[2][2] - m[0][0] - m[1][1]) * 2.0;
  return vec4((m[2][0] + m[0][2]) / s, (m[2][1] + m[1][2]) / s, 0.25 * s, (m[0][1] - m[1][0]) / s);
}
// dual part of a rigid transform: 0.5 * (t, 0) * r
vec4 dualPart(vec4 r, vec3 t) { return 0.5 * vec4(r.w * t + cross(t, r.xyz), -dot(t, r.xyz)); }
void dqAdd(mat4 m, float w, vec4 r0, inout vec4 b0, inout vec4 be) {
  vec4 r = m2q(m);
  float s = dot(r, r0) < 0.0 ? -w : w;
  b0 += r * s;
  be += dualPart(r, m[3].xyz) * s;
}
#endif
varying vec3 vW;
varying vec3 vN;
varying vec3 vL;
varying vec3 vLN;
#ifdef HAS_AUX
attribute vec4 aAux;
varying vec4 vAux;
#endif
#ifdef HAS_AUX3
attribute vec3 aAux3;
varying vec3 vAux3;
#endif
#ifdef BREATH
uniform float uBreath;
#endif
void main() {
  vec3 transformed = position;
  vec3 objectNormal = normal;
#ifdef BREATH
  // chest expands, shoulders rise with each breath
  float chest = smoothstep(0.10, 0.30, position.y) * (1.0 - smoothstep(0.46, 0.58, position.y));
  float front = 0.55 + 0.45 * normal.z;
  transformed += normal * uBreath * 0.0075 * chest * front;
  transformed.y += uBreath * 0.0045 * smoothstep(0.30, 0.52, position.y);
  transformed.z += uBreath * 0.004 * smoothstep(0.15, 0.45, position.y) * smoothstep(0.0, 0.1, position.z);
#endif
#include <skinbase_vertex>
#ifdef USE_SKINNING
  {
    vec4 r0 = m2q(boneMatX);
    vec4 b0 = vec4(0.0), be = vec4(0.0);
    dqAdd(boneMatX, skinWeight.x, r0, b0, be);
    dqAdd(boneMatY, skinWeight.y, r0, b0, be);
    dqAdd(boneMatZ, skinWeight.z, r0, b0, be);
    dqAdd(boneMatW, skinWeight.w, r0, b0, be);
    float len = length(b0);
    b0 /= len; be /= len;
    vec3 p = (bindMatrix * vec4(transformed, 1.0)).xyz;
    p += 2.0 * cross(b0.xyz, cross(b0.xyz, p) + b0.w * p) + 2.0 * (b0.w * be.xyz - be.w * b0.xyz + cross(b0.xyz, be.xyz));
    transformed = (bindMatrixInverse * vec4(p, 1.0)).xyz;
    vec3 n = mat3(bindMatrix) * objectNormal;
    n += 2.0 * cross(b0.xyz, cross(b0.xyz, n) + b0.w * n);
    objectNormal = mat3(bindMatrixInverse) * n;
  }
#endif
  vec4 wp = modelMatrix * vec4(transformed, 1.0);
  vW = wp.xyz;
  vN = normalize(mat3(modelMatrix) * objectNormal);
  vL = position;
  vLN = normal;
#ifdef HAS_AUX
  vAux = aAux;
#endif
#ifdef HAS_AUX3
  vAux3 = aAux3;
#endif
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

export const FRAG_HEAD = /* glsl */ `
varying vec3 vW;
varying vec3 vN;
varying vec3 vL;
varying vec3 vLN;
#ifdef HAS_AUX
varying vec4 vAux;
#endif
#ifdef HAS_AUX3
varying vec3 vAux3;
#endif
`;

// Every fragment shader starts with this: depth-only early out & mirror clipping.
export const FRAG_PROLOGUE = /* glsl */ `
  if (uPass == 2) { gl_FragColor = vec4(1.0); return; }
  if (uPass == 1 && vW.y < uTableY - 0.0004) discard;
  vec3 N = normalize(vN);
  if (!gl_FrontFacing) N = -N;
  vec3 V = normalize(cameraPosition - vW);
  float fp = length(fwidth(vW));
`;
