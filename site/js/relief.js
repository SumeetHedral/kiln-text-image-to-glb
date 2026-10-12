// Depth map -> displaced grid mesh at several densities (used for Auto-LOD and density tests).
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
  let params = { strength: 0.6, cut: 0, smooth: 1 };
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
    const raw = new Float32Array(stride * (rows + 1));
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
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(raw.length * 3);
    const uv = new Float32Array(raw.length * 2);
    for (let j = 0; j <= rows; j++) {
      for (let i = 0; i <= cols; i++) {
        const k = j * stride + i;
        pos[k * 3] = (i / cols - 0.5) * width;
        pos[k * 3 + 1] = (0.5 - j / rows) * height;
        uv[k * 2] = i / cols;
        uv[k * 2 + 1] = 1 - j / rows;
      }
    }
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setIndex(new THREE.BufferAttribute(new Uint32Array(cols * rows * 6), 1));
    lv = { grid, cols, rows, raw, geo, triangles: 0 };
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

  function updateLevel(lv) {
    const { cols, rows, raw, geo } = lv;
    const d = blur(raw, cols, rows, params.smooth);
    const pos = geo.attributes.position;
    for (let k = 0; k < d.length; k++) pos.setZ(k, (d[k] - 0.5) * params.strength);
    pos.needsUpdate = true;
    const stride = cols + 1;
    const idx = geo.index.array;
    let n = 0;
    const keep = (a, b, c) => {
      const mn = Math.min(d[a], d[b], d[c]);
      const mx = Math.max(d[a], d[b], d[c]);
      return mn >= params.cut && mx - mn <= STRETCH_LIMIT;
    };
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const a = j * stride + i, b = a + 1, c = a + stride, e = c + 1;
        if (keep(a, c, b)) { idx[n++] = a; idx[n++] = c; idx[n++] = b; }
        if (keep(b, c, e)) { idx[n++] = b; idx[n++] = c; idx[n++] = e; }
      }
    }
    geo.index.needsUpdate = true;
    geo.setDrawRange(0, n);
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    lv.triangles = n / 3;
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
