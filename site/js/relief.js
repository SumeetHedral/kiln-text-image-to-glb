// Depth map -> displaced grid mesh at several densities (used for Auto-LOD and density tests).
// Optional "solid" mode adds a mirrored back shell and wall triangles along every open edge, so the
// result is a closed, watertight mesh instead of a paper-thin sheet. The back is inferred, not seen.
import * as THREE from 'three';

const STRETCH_LIMIT = 0.3; // drop triangles spanning a depth cliff (normalised depth)

export function createRelief(texCanvas, depthImg, maxAnisotropy = 1) {
  const { width: dw, height: dh, data } = depthImg;
  const channels = data.length / (dw * dh);
  const depth = new Float32Array(dw * dh);
  for (let i = 0; i < depth.length; i++) depth[i] = data[i * channels];
  // Robust normalisation: 2nd..98th percentile, shared by every density level.
  const sorted = Float32Array.from(depth).sort();
  const lo = sorted[Math.floor(sorted.length * 0.02)];
  const hi = sorted[Math.floor(sorted.length * 0.98)];
  for (let i = 0; i < depth.length; i++) depth[i] = THREE.MathUtils.clamp((depth[i] - lo) / (hi - lo || 1), 0, 1);

  const aspect = texCanvas.width / texCanvas.height;
  const map = new THREE.CanvasTexture(texCanvas);
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = maxAnisotropy;
  const width = aspect >= 1 ? 1.6 : 1.6 * aspect;
  const height = aspect >= 1 ? 1.6 / aspect : 1.6;
  const material = new THREE.MeshStandardMaterial({ map, side: THREE.DoubleSide, roughness: 0.85, metalness: 0 });
  let params = { strength: 0.6, cut: 0, smooth: 1, solid: false, thickness: 0.15 };
  const levels = new Map();

  function gridSize(grid) {
    return {
      cols: aspect >= 1 ? grid : Math.max(8, Math.round(grid * aspect)),
      rows: aspect >= 1 ? Math.max(8, Math.round(grid / aspect)) : grid,
    };
  }

  function getLevel(grid) {
    let lv = levels.get(grid);
    if (lv) return lv;
    const { cols, rows } = gridSize(grid);
    const stride = cols + 1;
    const N = stride * (rows + 1);
    const raw = new Float32Array(N);
    for (let j = 0; j <= rows; j++) {
      const fy = (j / rows) * (dh - 1);
      const y0 = Math.floor(fy), y1 = Math.min(dh - 1, y0 + 1), ty = fy - y0;
      for (let i = 0; i <= cols; i++) {
        const fx = (i / cols) * (dw - 1);
        const x0 = Math.floor(fx), x1 = Math.min(dw - 1, x0 + 1), tx = fx - x0;
        raw[j * stride + i] =
          (depth[y0 * dw + x0] * (1 - tx) + depth[y0 * dw + x1] * tx) * (1 - ty) +
          (depth[y1 * dw + x0] * (1 - tx) + depth[y1 * dw + x1] * tx) * ty;
      }
    }
    // Vertices 0..N-1 are the front shell, N..2N-1 the back shell (same x, y, uv; unused unless solid).
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(2 * N * 3);
    const uv = new Float32Array(2 * N * 2);
    for (let j = 0; j <= rows; j++) {
      for (let i = 0; i <= cols; i++) {
        const k = j * stride + i;
        const x = (i / cols - 0.5) * width;
        const y = (0.5 - j / rows) * height;
        const u = i / cols;
        const v = 1 - j / rows;
        for (const o of [k, N + k]) {
          pos[o * 3] = x;
          pos[o * 3 + 1] = y;
          uv[o * 2] = u;
          uv[o * 2 + 1] = v;
        }
      }
    }
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setIndex(new THREE.BufferAttribute(new Uint32Array(cols * rows * 6), 1));
    lv = { grid, cols, rows, N, raw, geo, front: new Uint32Array(cols * rows * 6), triangles: 0 };
    levels.set(grid, lv);
    updateLevel(lv);
    return lv;
  }

  function blur(src, cols, rows, passes) {
    let a = src;
    const stride = cols + 1;
    for (let p = 0; p < passes; p++) {
      const b = new Float32Array(a.length);
      for (let j = 0; j <= rows; j++) {
        for (let i = 0; i <= cols; i++) {
          let sum = 0, n = 0;
          for (let dj = -1; dj <= 1; dj++) {
            const y = j + dj;
            if (y < 0 || y > rows) continue;
            for (let di = -1; di <= 1; di++) {
              const x = i + di;
              if (x < 0 || x > cols) continue;
              sum += a[y * stride + x];
              n++;
            }
          }
          b[j * stride + i] = sum / n;
        }
      }
      a = b;
    }
    return a;
  }

  // Undirected grid edge -> slot. Horizontal and vertical edges and the shared diagonal each get
  // their own N-sized block, indexed by the lower vertex.
  function edgeKey(u, v, stride, N) {
    const p = Math.min(u, v);
    const diff = Math.abs(u - v);
    return (diff === 1 ? 0 : diff === stride ? 1 : 2) * N + p;
  }

  function updateLevel(lv) {
    const { cols, rows, N, raw, geo, front } = lv;
    const stride = cols + 1;
    const d = blur(raw, cols, rows, params.smooth);
    const pos = geo.attributes.position;
    const solid = params.solid;
    for (let k = 0; k < N; k++) {
      if (solid) {
        const h = 0.5 * (params.thickness + d[k] * params.strength);
        pos.setZ(k, h);
        pos.setZ(N + k, -h);
      } else {
        pos.setZ(k, (d[k] - 0.5) * params.strength);
      }
    }
    pos.needsUpdate = true;

    // Front shell: skip background (below `cut`) and stretched walls across depth cliffs.
    let nf = 0;
    const keep = (a, b, c) => {
      const mn = Math.min(d[a], d[b], d[c]);
      const mx = Math.max(d[a], d[b], d[c]);
      return mn >= params.cut && mx - mn <= STRETCH_LIMIT;
    };
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const a = j * stride + i, b = a + 1, c = a + stride, e = c + 1;
        if (keep(a, c, b)) { front[nf++] = a; front[nf++] = c; front[nf++] = b; }
        if (keep(b, c, e)) { front[nf++] = b; front[nf++] = c; front[nf++] = e; }
      }
    }

    // Edges used by exactly one kept triangle are the open boundary that walls must close.
    let walls = 0;
    if (solid) {
      if (!lv.edgeCount) {
        lv.edgeCount = new Uint8Array(3 * N);
        lv.edgeU = new Int32Array(3 * N);
        lv.edgeV = new Int32Array(3 * N);
      }
      lv.edgeCount.fill(0);
      for (let t = 0; t < nf; t += 3) {
        for (let s = 0; s < 3; s++) {
          const u = front[t + s], v = front[t + ((s + 1) % 3)];
          const key = edgeKey(u, v, stride, N);
          lv.edgeCount[key]++;
          lv.edgeU[key] = u;
          lv.edgeV[key] = v;
        }
      }
      for (let k = 0; k < 3 * N; k++) if (lv.edgeCount[k] === 1) walls++;
    }

    const needed = solid ? nf * 2 + walls * 6 : nf;
    let idx = geo.index.array;
    if (idx.length < needed) {
      idx = new Uint32Array(Math.ceil(needed * 1.25));
      geo.setIndex(new THREE.BufferAttribute(idx, 1));
    }
    idx.set(front.subarray(0, nf), 0);
    let n = nf;
    if (solid) {
      for (let t = 0; t < nf; t += 3) {
        // Back shell: same triangles, flipped winding, back vertices.
        idx[n++] = N + front[t];
        idx[n++] = N + front[t + 2];
        idx[n++] = N + front[t + 1];
      }
      for (let k = 0; k < 3 * N; k++) {
        if (lv.edgeCount[k] !== 1) continue;
        const u = lv.edgeU[k], v = lv.edgeV[k];
        // Directed edge u->v has the kept triangle on its left, so the outward side is its right.
        idx[n++] = u; idx[n++] = N + v; idx[n++] = v;
        idx[n++] = u; idx[n++] = N + u; idx[n++] = N + v;
      }
    }
    idx.fill(0, n); // stale slots would otherwise leak into computed normals
    geo.index.needsUpdate = true;
    geo.setDrawRange(0, n);
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    lv.triangles = n / 3;
    lv.walls = walls;
  }

  return {
    aspect,
    width,
    height,
    material,
    gridSize,
    getLevel,
    setParams(p) {
      params = { ...params, ...p };
      for (const lv of levels.values()) updateLevel(lv);
    },
    // A compact copy for export: only the vertices in use and the drawn index range.
    exportGeometry(grid) {
      const lv = getLevel(grid);
      const nv = (params.solid ? 2 : 1) * lv.N;
      const count = lv.geo.drawRange.count;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(lv.geo.attributes.position.array.slice(0, nv * 3), 3));
      g.setAttribute('normal', new THREE.BufferAttribute(lv.geo.attributes.normal.array.slice(0, nv * 3), 3));
      g.setAttribute('uv', new THREE.BufferAttribute(lv.geo.attributes.uv.array.slice(0, nv * 2), 2));
      g.setIndex(new THREE.BufferAttribute(lv.geo.index.array.slice(0, count), 1));
      return g;
    },
    // Drop cached levels that are not in `keepGrids`.
    prune(keepGrids) {
      for (const [g, lv] of levels) {
        if (!keepGrids.includes(g)) {
          lv.geo.dispose();
          levels.delete(g);
        }
      }
    },
    dispose() {
      for (const lv of levels.values()) lv.geo.dispose();
      levels.clear();
      map.dispose();
      material.dispose();
    },
  };
}
