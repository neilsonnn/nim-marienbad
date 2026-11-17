// Signed distance primitives + a narrow-band Surface Nets mesher.
// Every organic mesh in the scene (hands, heads, torsos) is grown from an SDF here.

export function smin(a, b, k) {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}
export function smax(a, b, k) {
  return -smin(-a, -b, k);
}

// iq's exact round cone between points a and b with radii r1 (at a) and r2 (at b).
export function sdRoundCone(px, py, pz, ax, ay, az, bx, by, bz, r1, r2) {
  const bax = bx - ax, bay = by - ay, baz = bz - az;
  const l2 = bax * bax + bay * bay + baz * baz;
  const rr = r1 - r2;
  const a2 = l2 - rr * rr;
  const il2 = 1.0 / l2;
  const pax = px - ax, pay = py - ay, paz = pz - az;
  const y = pax * bax + pay * bay + paz * baz;
  const z = y - l2;
  const qx = pax * l2 - bax * y, qy = pay * l2 - bay * y, qz = paz * l2 - baz * y;
  const x2 = qx * qx + qy * qy + qz * qz;
  const y2 = y * y * l2;
  const z2 = z * z * l2;
  const k = Math.sign(rr) * rr * rr * x2;
  if (Math.sign(z) * a2 * z2 > k) return Math.sqrt(x2 + z2) * il2 - r2;
  if (Math.sign(y) * a2 * y2 < k) return Math.sqrt(x2 + y2) * il2 - r1;
  return (Math.sqrt(x2 * a2 * il2) + y * rr) * il2 - r1;
}

export function sdCapsule(px, py, pz, ax, ay, az, bx, by, bz, r) {
  const pax = px - ax, pay = py - ay, paz = pz - az;
  const bax = bx - ax, bay = by - ay, baz = bz - az;
  let h = (pax * bax + pay * bay + paz * baz) / (bax * bax + bay * bay + baz * baz);
  h = h < 0 ? 0 : h > 1 ? 1 : h;
  const dx = pax - bax * h, dy = pay - bay * h, dz = paz - baz * h;
  return Math.sqrt(dx * dx + dy * dy + dz * dz) - r;
}

// Approximate ellipsoid distance (iq), good near the surface.
export function sdEllipsoid(px, py, pz, cx, cy, cz, rx, ry, rz) {
  const x = px - cx, y = py - cy, z = pz - cz;
  const k0 = Math.sqrt((x * x) / (rx * rx) + (y * y) / (ry * ry) + (z * z) / (rz * rz));
  const k1 = Math.sqrt((x * x) / (rx * rx * rx * rx) + (y * y) / (ry * ry * ry * ry) + (z * z) / (rz * rz * rz * rz));
  return (k0 * (k0 - 1.0)) / (k1 + 1e-9);
}

export function sdRoundBox(px, py, pz, bx, by, bz, r) {
  const qx = Math.abs(px) - bx, qy = Math.abs(py) - by, qz = Math.abs(pz) - bz;
  const mx = Math.max(qx, 0), my = Math.max(qy, 0), mz = Math.max(qz, 0);
  return Math.sqrt(mx * mx + my * my + mz * mz) + Math.min(Math.max(qx, Math.max(qy, qz)), 0) - r;
}

export function sdSphere(px, py, pz, cx, cy, cz, r) {
  const x = px - cx, y = py - cy, z = pz - cz;
  return Math.sqrt(x * x + y * y + z * z) - r;
}

// Squared distance from p to segment ab (used for bounding + skin weights).
export function segDist2(px, py, pz, ax, ay, az, bx, by, bz) {
  const pax = px - ax, pay = py - ay, paz = pz - az;
  const bax = bx - ax, bay = by - ay, baz = bz - az;
  const bb = bax * bax + bay * bay + baz * baz;
  let h = bb > 0 ? (pax * bax + pay * bay + paz * baz) / bb : 0;
  h = h < 0 ? 0 : h > 1 ? 1 : h;
  const dx = pax - bax * h, dy = pay - bay * h, dz = paz - baz * h;
  return dx * dx + dy * dy + dz * dz;
}

/**
 * Surface Nets over a regular grid with a coarse narrow-band pre-pass.
 * Vertices are projected onto the zero set with a Newton step and get
 * analytic (finite-difference) SDF normals, so the result shades smoothly.
 */
export function surfaceNets(sdf, min, max, cell) {
  const nx = Math.ceil((max[0] - min[0]) / cell);
  const ny = Math.ceil((max[1] - min[1]) / cell);
  const nz = Math.ceil((max[2] - min[2]) / cell);
  const sx = nx + 1, sy = ny + 1, sz = nz + 1;
  const field = new Float32Array(sx * sy * sz);

  // coarse pass
  const C = 4;
  const cx = Math.ceil(nx / C) + 1, cy = Math.ceil(ny / C) + 1, cz = Math.ceil(nz / C) + 1;
  const coarse = new Float32Array(cx * cy * cz);
  for (let k = 0; k < cz; k++)
    for (let j = 0; j < cy; j++)
      for (let i = 0; i < cx; i++)
        coarse[i + cx * (j + cy * k)] = sdf(min[0] + i * C * cell, min[1] + j * C * cell, min[2] + k * C * cell);
  const band = C * cell * 1.8;

  for (let k = 0; k < sz; k++) {
    const ck = Math.min(Math.floor(k / C), cz - 2), fk = k / C - ck;
    for (let j = 0; j < sy; j++) {
      const cj = Math.min(Math.floor(j / C), cy - 2), fj = j / C - cj;
      for (let i = 0; i < sx; i++) {
        const ci = Math.min(Math.floor(i / C), cx - 2), fi = i / C - ci;
        const i000 = ci + cx * (cj + cy * ck);
        const c000 = coarse[i000], c100 = coarse[i000 + 1];
        const c010 = coarse[i000 + cx], c110 = coarse[i000 + cx + 1];
        const c001 = coarse[i000 + cx * cy], c101 = coarse[i000 + cx * cy + 1];
        const c011 = coarse[i000 + cx * cy + cx], c111 = coarse[i000 + cx * cy + cx + 1];
        const mn = Math.min(c000, c100, c010, c110, c001, c101, c011, c111);
        const mx = Math.max(c000, c100, c010, c110, c001, c101, c011, c111);
        let v;
        if (mn > band || mx < -band) {
          const a = c000 + (c100 - c000) * fi, b = c010 + (c110 - c010) * fi;
          const c = c001 + (c101 - c001) * fi, d = c011 + (c111 - c011) * fi;
          const e = a + (b - a) * fj, f = c + (d - c) * fj;
          v = e + (f - e) * fk;
        } else {
          v = sdf(min[0] + i * cell, min[1] + j * cell, min[2] + k * cell);
        }
        field[i + sx * (j + sy * k)] = v;
      }
    }
  }

  const cellVert = new Int32Array(nx * ny * nz).fill(-1);
  const pos = [];
  const corner = new Float32Array(8);
  const EDGES = [
    [0, 1], [2, 3], [4, 5], [6, 7],
    [0, 2], [1, 3], [4, 6], [5, 7],
    [0, 4], [1, 5], [2, 6], [3, 7],
  ];
  const OFF = [
    [0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0],
    [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1],
  ];
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        let mask = 0;
        for (let c = 0; c < 8; c++) {
          const o = OFF[c];
          const v = field[i + o[0] + sx * (j + o[1] + sy * (k + o[2]))];
          corner[c] = v;
          if (v < 0) mask |= 1 << c;
        }
        if (mask === 0 || mask === 255) continue;
        let ax = 0, ay = 0, az = 0, n = 0;
        for (const [e0, e1] of EDGES) {
          const v0 = corner[e0], v1 = corner[e1];
          if (v0 < 0 === v1 < 0) continue;
          const t = v0 / (v0 - v1);
          const o0 = OFF[e0], o1 = OFF[e1];
          ax += o0[0] + (o1[0] - o0[0]) * t;
          ay += o0[1] + (o1[1] - o0[1]) * t;
          az += o0[2] + (o1[2] - o0[2]) * t;
          n++;
        }
        cellVert[i + nx * (j + ny * k)] = pos.length / 3;
        pos.push(min[0] + (i + ax / n) * cell, min[1] + (j + ay / n) * cell, min[2] + (k + az / n) * cell);
      }

  const idx = [];
  const P = pos;
  const quad = (a, b, c, d) => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    // split along the shorter diagonal
    const dac = (P[a * 3] - P[c * 3]) ** 2 + (P[a * 3 + 1] - P[c * 3 + 1]) ** 2 + (P[a * 3 + 2] - P[c * 3 + 2]) ** 2;
    const dbd = (P[b * 3] - P[d * 3]) ** 2 + (P[b * 3 + 1] - P[d * 3 + 1]) ** 2 + (P[b * 3 + 2] - P[d * 3 + 2]) ** 2;
    if (dac < dbd) idx.push(a, b, c, a, c, d);
    else idx.push(a, b, d, b, c, d);
  };
  const cv = (i, j, k) => cellVert[i + nx * (j + ny * k)];
  for (let k = 1; k < nz; k++)
    for (let j = 1; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const v0 = field[i + sx * (j + sy * k)];
        const v1 = field[i + 1 + sx * (j + sy * k)];
        if (v0 < 0 === v1 < 0) continue;
        const c0 = cv(i, j - 1, k - 1), c1 = cv(i, j, k - 1), c2 = cv(i, j, k), c3 = cv(i, j - 1, k);
        if (v0 < 0) quad(c0, c1, c2, c3);
        else quad(c0, c3, c2, c1);
      }
  for (let k = 1; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 1; i < nx; i++) {
        const v0 = field[i + sx * (j + sy * k)];
        const v1 = field[i + sx * (j + 1 + sy * k)];
        if (v0 < 0 === v1 < 0) continue;
        const c0 = cv(i - 1, j, k - 1), c1 = cv(i - 1, j, k), c2 = cv(i, j, k), c3 = cv(i, j, k - 1);
        if (v0 < 0) quad(c0, c1, c2, c3);
        else quad(c0, c3, c2, c1);
      }
  for (let k = 0; k < nz; k++)
    for (let j = 1; j < ny; j++)
      for (let i = 1; i < nx; i++) {
        const v0 = field[i + sx * (j + sy * k)];
        const v1 = field[i + sx * (j + sy * (k + 1))];
        if (v0 < 0 === v1 < 0) continue;
        const c0 = cv(i - 1, j - 1, k), c1 = cv(i, j - 1, k), c2 = cv(i, j, k), c3 = cv(i - 1, j, k);
        if (v0 < 0) quad(c0, c1, c2, c3);
        else quad(c0, c3, c2, c1);
      }

  // Newton projection onto the surface + gradient normals.
  const vcount = pos.length / 3;
  const positions = new Float32Array(pos);
  const normals = new Float32Array(vcount * 3);
  const e = cell * 0.35;
  for (let v = 0; v < vcount; v++) {
    let x = positions[v * 3], y = positions[v * 3 + 1], z = positions[v * 3 + 2];
    let gx = 0, gy = 0, gz = 1;
    for (let it = 0; it < 2; it++) {
      const d = sdf(x, y, z);
      gx = sdf(x + e, y, z) - sdf(x - e, y, z);
      gy = sdf(x, y + e, z) - sdf(x, y - e, z);
      gz = sdf(x, y, z + e) - sdf(x, y, z - e);
      const gl = Math.sqrt(gx * gx + gy * gy + gz * gz) / (2 * e);
      if (gl < 1e-6) break;
      gx /= 2 * e; gy /= 2 * e; gz /= 2 * e;
      const step = d / (gl * gl);
      // clamp the step so vertices never jump out of their cell neighbourhood
      const s = Math.max(-cell * 0.75, Math.min(cell * 0.75, step * gl)) / gl;
      x -= gx * s; y -= gy * s; z -= gz * s;
    }
    const L = Math.hypot(gx, gy, gz) || 1;
    positions[v * 3] = x; positions[v * 3 + 1] = y; positions[v * 3 + 2] = z;
    normals[v * 3] = gx / L; normals[v * 3 + 1] = gy / L; normals[v * 3 + 2] = gz / L;
  }
  return { positions, normals, indices: vcount > 65535 ? new Uint32Array(idx) : new Uint16Array(idx) };
}

/** One pass of Laplacian-ish smoothing that keeps vertices on the SDF surface. */
export function relaxOnSurface(mesh, sdf, iterations = 1, amount = 0.5) {
  const { positions, normals, indices } = mesh;
  const n = positions.length / 3;
  const acc = new Float32Array(n * 3);
  const cnt = new Uint16Array(n);
  for (let it = 0; it < iterations; it++) {
    acc.fill(0);
    cnt.fill(0);
    for (let t = 0; t < indices.length; t += 3) {
      const a = indices[t], b = indices[t + 1], c = indices[t + 2];
      const pairs = [[a, b], [b, c], [c, a]];
      for (const [u, w] of pairs) {
        acc[u * 3] += positions[w * 3]; acc[u * 3 + 1] += positions[w * 3 + 1]; acc[u * 3 + 2] += positions[w * 3 + 2]; cnt[u]++;
        acc[w * 3] += positions[u * 3]; acc[w * 3 + 1] += positions[u * 3 + 1]; acc[w * 3 + 2] += positions[u * 3 + 2]; cnt[w]++;
      }
    }
    for (let v = 0; v < n; v++) {
      if (!cnt[v]) continue;
      let x = positions[v * 3] + (acc[v * 3] / cnt[v] - positions[v * 3]) * amount;
      let y = positions[v * 3 + 1] + (acc[v * 3 + 1] / cnt[v] - positions[v * 3 + 1]) * amount;
      let z = positions[v * 3 + 2] + (acc[v * 3 + 2] / cnt[v] - positions[v * 3 + 2]) * amount;
      // re-project
      const e = 0.0004;
      const d = sdf(x, y, z);
      let gx = (sdf(x + e, y, z) - sdf(x - e, y, z)) / (2 * e);
      let gy = (sdf(x, y + e, z) - sdf(x, y - e, z)) / (2 * e);
      let gz = (sdf(x, y, z + e) - sdf(x, y, z - e)) / (2 * e);
      const g2 = gx * gx + gy * gy + gz * gz;
      if (g2 > 1e-8) { x -= (gx * d) / g2; y -= (gy * d) / g2; z -= (gz * d) / g2; }
      const L = Math.sqrt(g2) || 1;
      positions[v * 3] = x; positions[v * 3 + 1] = y; positions[v * 3 + 2] = z;
      normals[v * 3] = gx / L; normals[v * 3 + 1] = gy / L; normals[v * 3 + 2] = gz / L;
    }
  }
  return mesh;
}
