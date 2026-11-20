// Small math / timing toolkit shared by every module.
import * as THREE from 'three';

export const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
export const DEG = Math.PI / 180;

// Minimum-jerk profile: the velocity curve human reaching movements follow.
export const minJerk = (t) => {
  t = clamp(t, 0, 1);
  return t * t * t * (10 + t * (-15 + 6 * t));
};
export const easeOutCubic = (t) => 1 - Math.pow(1 - clamp(t, 0, 1), 3);

// Deterministic PRNG so every run of the scene is reproducible per seed.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export const rng = mulberry32(0x5eed1961);
export const rand = (a = 0, b = 1) => a + (b - a) * rng();

// 1D gradient noise in [-1, 1], smooth (C2). Used for every organic micro-motion.
const PERM = new Uint8Array(512);
const GRAD = new Float32Array(256);
{
  const r = mulberry32(1337);
  const p = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [p[i], p[j]] = [p[j], p[i]];
  }
  for (let i = 0; i < 512; i++) PERM[i] = p[i & 255];
  for (let i = 0; i < 256; i++) GRAD[i] = r() * 2 - 1;
}
export function noise1(x) {
  const i = Math.floor(x);
  const f = x - i;
  const g0 = GRAD[PERM[i & 255]];
  const g1 = GRAD[PERM[(i + 1) & 255]];
  const u = f * f * f * (f * (f * 6 - 15) + 10);
  return 2.0 * lerp(g0 * f, g1 * (f - 1), u);
}
// fractal 1D noise
export function fnoise(x, oct = 3) {
  let a = 0.5, s = 0, n = 0;
  for (let i = 0; i < oct; i++) {
    s += a * noise1(x + i * 17.31);
    n += a;
    x *= 2.13;
    a *= 0.5;
  }
  return s / n;
}

// Critically damped spring (exact integration) for scalars.
export class Spring {
  constructor(value = 0, halfLife = 0.2) {
    this.x = value;
    this.v = 0;
    this.halfLife = halfLife;
  }
  update(target, dt, halfLife = this.halfLife) {
    const y = (4 * 0.69314718) / (halfLife + 1e-5) / 2;
    const j0 = this.x - target;
    const j1 = this.v + j0 * y;
    const eydt = Math.exp(-y * dt);
    this.x = eydt * (j0 + j1 * dt) + target;
    this.v = eydt * (this.v - j1 * y * dt);
    return this.x;
  }
}

// Frame-driven scheduler: awaitable waits and tweens for choreography.
export class Scheduler {
  constructor() {
    this.time = 0;
    this.timers = [];
    this.tweens = [];
  }
  wait(sec) {
    return new Promise((res) => this.timers.push({ t: this.time + Math.max(0, sec), res }));
  }
  tween(dur, fn) {
    return new Promise((res) => {
      this.tweens.push({ t0: this.time, dur: Math.max(1e-4, dur), fn, res });
      fn(0);
    });
  }
  update(dt) {
    this.time += dt;
    if (this.timers.length) {
      const keep = [];
      for (const tm of this.timers) (this.time >= tm.t ? tm.res() : keep.push(tm));
      this.timers = keep;
    }
    if (this.tweens.length) {
      const keep = [];
      for (const tw of this.tweens) {
        const k = clamp((this.time - tw.t0) / tw.dur, 0, 1);
        tw.fn(k);
        if (k >= 1) tw.res();
        else keep.push(tw);
      }
      this.tweens = keep;
    }
  }
}

// Quaternion from a forward (local +Y) and an up-ish (local +Z) vector.
const _m = new THREE.Matrix4();
const _x = new THREE.Vector3(), _y = new THREE.Vector3(), _z = new THREE.Vector3();
export function quatFromYZ(yDir, zHint, out = new THREE.Quaternion()) {
  _y.copy(yDir).normalize();
  _z.copy(zHint).addScaledVector(_y, -zHint.dot(_y)).normalize();
  _x.crossVectors(_y, _z).normalize();
  _m.makeBasis(_x, _y, _z);
  return out.setFromRotationMatrix(_m);
}
