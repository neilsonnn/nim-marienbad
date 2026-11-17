// Film finishing: halation, panchromatic B&W response, toe/shoulder, grain, vignette.
import * as THREE from 'three';

const VS = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const DOWN = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 uTexel;
varying vec2 vUv;
void main() {
  vec3 c = texture2D(tSrc, vUv + uTexel * vec2(-1.0, -1.0)).rgb;
  c += texture2D(tSrc, vUv + uTexel * vec2(1.0, -1.0)).rgb;
  c += texture2D(tSrc, vUv + uTexel * vec2(-1.0, 1.0)).rgb;
  c += texture2D(tSrc, vUv + uTexel * vec2(1.0, 1.0)).rgb;
  c *= 0.25;
  // only the brighter part halates
  float l = dot(c, vec3(0.3, 0.59, 0.11));
  c *= smoothstep(0.08, 0.6, l);
  gl_FragColor = vec4(min(c, vec3(8.0)), 1.0);
}`;

const BLUR = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 uDir;
varying vec2 vUv;
void main() {
  vec3 c = texture2D(tSrc, vUv).rgb * 0.2270270;
  c += texture2D(tSrc, vUv + uDir * 1.3846154).rgb * 0.3162162;
  c += texture2D(tSrc, vUv - uDir * 1.3846154).rgb * 0.3162162;
  c += texture2D(tSrc, vUv + uDir * 3.2307692).rgb * 0.0702703;
  c += texture2D(tSrc, vUv - uDir * 3.2307692).rgb * 0.0702703;
  gl_FragColor = vec4(c, 1.0);
}`;

const COMPOSITE = /* glsl */ `
uniform sampler2D tScene;
uniform sampler2D tBloom;
uniform vec2 uRes;
uniform float uTime;
uniform float uExposure;
uniform float uFade;
uniform float uGrain;
uniform float uFlicker;
uniform float uHalation;
varying vec2 vUv;
float h12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float filmic(float x) {
  // ACES-style toe/shoulder, then a gentle extra S for a lustrous B&W stock
  x = max(x, 0.0);
  float y = (x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14);
  y = clamp(y, 0.0, 1.0);
  return mix(y, y * y * (3.0 - 2.0 * y), 0.22);
}
void main() {
  vec3 c = texture2D(tScene, vUv).rgb;
  vec3 b = texture2D(tBloom, vUv).rgb;
  // panchromatic film weighting (slightly red-insensitive)
  vec3 W = vec3(0.26, 0.62, 0.12);
  float L = dot(c, W) + dot(b, W) * uHalation;
  L *= uExposure * (1.0 + uFlicker);
  float y = filmic(L);
  // vignette (lens + print)
  vec2 q = vUv - 0.5;
  q.x *= uRes.x / uRes.y;
  float r = length(q * vec2(0.78, 1.0));
  y *= mix(0.62, 1.0, smoothstep(0.95, 0.18, r));
  // display encode
  y = y <= 0.0031308 ? y * 12.92 : 1.055 * pow(y, 1.0 / 2.4) - 0.055;
  // grain at 24 fps, stronger in the mid-tones, slightly clumped
  vec2 gp = floor(gl_FragCoord.xy);
  float f = floor(uTime * 24.0);
  float g = h12(gp + f * vec2(37.0, 17.0)) + h12(gp * 1.37 + f * vec2(11.0, 53.0)) - 1.0;
  float g2 = h12(floor(gp * 0.5) + f * vec2(7.0, 3.0)) - 0.5;
  y += (g * 0.8 + g2 * 0.6) * uGrain * (0.35 + 2.4 * y * (1.0 - y));
  // ordered dither against banding in the deep blacks
  y += (h12(gp + 0.5) - 0.5) / 255.0;
  gl_FragColor = vec4(vec3(clamp(y, 0.0, 1.0) * uFade), 1.0);
}`;

export class Post {
  constructor(renderer) {
    this.renderer = renderer;
    this.cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.scene = new THREE.Scene();
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);
    const opts = { type: THREE.HalfFloatType, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter };
    this.a = new THREE.WebGLRenderTarget(4, 4, opts);
    this.b = new THREE.WebGLRenderTarget(4, 4, opts);
    this.down = new THREE.ShaderMaterial({ vertexShader: VS, fragmentShader: DOWN, uniforms: { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() } }, depthTest: false, depthWrite: false });
    this.blur = new THREE.ShaderMaterial({ vertexShader: VS, fragmentShader: BLUR, uniforms: { tSrc: { value: null }, uDir: { value: new THREE.Vector2() } }, depthTest: false, depthWrite: false });
    this.comp = new THREE.ShaderMaterial({
      vertexShader: VS,
      fragmentShader: COMPOSITE,
      uniforms: {
        tScene: { value: null },
        tBloom: { value: this.a.texture },
        uRes: { value: new THREE.Vector2() },
        uTime: { value: 0 },
        uExposure: { value: 1.0 },
        uFade: { value: 0 },
        uGrain: { value: 0.045 },
        uFlicker: { value: 0 },
        uHalation: { value: 0.35 },
      },
      depthTest: false,
      depthWrite: false,
    });
  }
  setSize(w, h) {
    const bw = Math.max(2, Math.floor(w / 4)), bh = Math.max(2, Math.floor(h / 4));
    this.a.setSize(bw, bh);
    this.b.setSize(bw, bh);
    this.comp.uniforms.uRes.value.set(w, h);
    this.fullW = w;
    this.fullH = h;
  }
  pass(mat, target) {
    this.quad.material = mat;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.scene, this.cam);
  }
  render(srcTex, time) {
    const r = this.renderer;
    this.down.uniforms.tSrc.value = srcTex;
    this.down.uniforms.uTexel.value.set(1.5 / this.fullW, 1.5 / this.fullH);
    this.pass(this.down, this.a);
    for (let i = 0; i < 2; i++) {
      this.blur.uniforms.tSrc.value = this.a.texture;
      this.blur.uniforms.uDir.value.set((1 + i) / this.a.width, 0);
      this.pass(this.blur, this.b);
      this.blur.uniforms.tSrc.value = this.b.texture;
      this.blur.uniforms.uDir.value.set(0, (1 + i) / this.a.height);
      this.pass(this.blur, this.a);
    }
    const u = this.comp.uniforms;
    u.tScene.value = srcTex;
    u.uTime.value = time;
    this.pass(this.comp, null);
    r.setRenderTarget(null);
  }
}
