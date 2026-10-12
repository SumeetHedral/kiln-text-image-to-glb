// Renderer engine: WebGL2 + WebGPU on separate canvases, orbit controls, detailed frame metrics
// (CPU submit, GPU timer queries, p95, triangles, draws) and a back-to-back benchmark.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { WebGPURenderer } from 'three/webgpu';

export const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
export const pct = (a, p) => (a.length ? [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))] : 0);
export const fmt = (n, d = 1) => (n == null || Number.isNaN(n) ? 'n/a' : n.toFixed(d));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const BENCH_WARMUP_MS = 1000;
const BENCH_SAMPLE_MS = 3000;

export function createEngine({ stage, canvasGL, canvasGPU, metricsEl, onStatus = () => {} }) {
  const glRenderer = new THREE.WebGLRenderer({ canvas: canvasGL, antialias: true });
  let gpuRenderer = null;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(matchMedia('(prefers-color-scheme: light)').matches ? 0xffffff : 0x181b22);
  const camera = new THREE.PerspectiveCamera(35, 1, 0.01, 500);
  camera.position.set(0, 0, 3);
  const orbit = new OrbitControls(camera, canvasGL);
  orbit.enableDamping = true;
  orbit.autoRotateSpeed = 1.2;
  scene.add(new THREE.HemisphereLight(0xffffff, 0x445066, 1.6));
  const key = new THREE.DirectionalLight(0xffffff, 2.4);
  key.position.set(2, 3, 4);
  scene.add(key);
  const holder = new THREE.Group();
  scene.add(holder);

  let active = glRenderer;
  let mode = 'webgl';
  const state = { autoRotate: true, extraLine: () => '', showMetrics: true };

  function resize() {
    const { clientWidth: w, clientHeight: h } = stage;
    for (const r of [glRenderer, gpuRenderer]) {
      if (!r) continue;
      r.setPixelRatio(Math.min(devicePixelRatio, 2));
      r.setSize(w, h, false);
    }
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  new ResizeObserver(resize).observe(stage);
  resize();

  // ---------- GPU timing ----------
  // WebGL: EXT_disjoint_timer_query_webgl2 around render(). WebGPU: timestamp-query through three.
  const gl2 = glRenderer.getContext();
  const timerExt = gl2.getExtension('EXT_disjoint_timer_query_webgl2');
  const pendingQueries = [];
  let glGpuMs = null;
  let gpuGpuMs = null;
  let resolving = false;

  function glTimerBegin() {
    if (!timerExt || pendingQueries.length > 4) return null;
    const q = gl2.createQuery();
    gl2.beginQuery(timerExt.TIME_ELAPSED_EXT, q);
    return q;
  }
  function glTimerEnd(q) {
    if (!q) return;
    gl2.endQuery(timerExt.TIME_ELAPSED_EXT);
    pendingQueries.push(q);
  }
  function glTimerPoll() {
    if (!timerExt) return;
    const disjoint = gl2.getParameter(timerExt.GPU_DISJOINT_EXT);
    while (pendingQueries.length && gl2.getQueryParameter(pendingQueries[0], gl2.QUERY_RESULT_AVAILABLE)) {
      const q = pendingQueries.shift();
      if (!disjoint) glGpuMs = gl2.getQueryParameter(q, gl2.QUERY_RESULT) / 1e6;
      gl2.deleteQuery(q);
    }
  }
  function gpuTimerResolve(renderer) {
    if (resolving) return;
    resolving = true;
    renderer
      .resolveTimestampsAsync('render')
      .then(() => {
        const t = renderer.info.render.timestamp;
        if (t > 0) gpuGpuMs = t;
      })
      .catch(() => {})
      .finally(() => (resolving = false));
  }
  const gpuMsNow = () => (mode === 'webgpu' ? gpuGpuMs : glGpuMs);

  // ---------- metrics ----------
  const win = { start: performance.now(), frames: 0, dt: [], cpu: [] };
  let lastNow = 0;
  let recording = null;
  let frameDraws = 0; // WebGPU's info.render.calls is cumulative; drawCalls is per frame

  function backendLabel() {
    if (mode === 'webgpu') {
      const info = gpuRenderer?.backend?.adapter?.info;
      const name = info?.description || info?.device;
      return `WebGPU${name ? ` · ${name}` : ''}`;
    }
    const dbg = gl2.getExtension('WEBGL_debug_renderer_info');
    // "ANGLE (Apple, ANGLE Metal Renderer: Apple M4 Pro, Unspecified Version)" -> "Apple M4 Pro"
    const raw = dbg ? String(gl2.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : '';
    const name = raw.replace(/^ANGLE \([^,]*,\s*(ANGLE )?/, '').replace(/^[^:]*Renderer:\s*/, '').replace(/,?\s*Unspecified Version\)?$/, '').replace(/\)$/, '');
    return `WebGL2${name ? ` · ${name}` : ''}`;
  }

  function updateMetricsDom(elapsed) {
    if (metricsEl.hidden) return;
    const r = active.info.render;
    const gpu = gpuMsNow();
    metricsEl.textContent =
      `${backendLabel()}\n` +
      `FPS        ${fmt((win.frames * 1000) / elapsed)}   (vsync-capped)\n` +
      `Frame      ${fmt(avg(win.dt), 2)} ms  p95 ${fmt(pct(win.dt, 0.95), 2)}\n` +
      `CPU submit ${fmt(avg(win.cpu), 2)} ms\n` +
      `GPU time   ${gpu == null ? 'n/a (timer query unsupported)' : `${fmt(gpu, 2)} ms`}\n` +
      `Triangles  ${r.triangles.toLocaleString()}   Draws ${frameDraws}\n` +
      `Geometries ${active.info.memory.geometries}   Textures ${active.info.memory.textures}` +
      state.extraLine();
  }

  function recordFrame(now, cpuMs) {
    if (lastNow) {
      const dt = now - lastNow;
      win.dt.push(dt);
      recording?.dt.push(dt);
    }
    lastNow = now;
    win.cpu.push(cpuMs);
    recording?.cpu.push(cpuMs);
    const g = gpuMsNow();
    if (g != null) recording?.gpu.push(g);
    win.frames++;
    const elapsed = now - win.start;
    if (elapsed >= 500) {
      updateMetricsDom(elapsed);
      Object.assign(win, { start: now, frames: 0, dt: [], cpu: [] });
    }
  }

  function loop(now) {
    orbit.autoRotate = state.autoRotate;
    orbit.update();
    const t0 = performance.now();
    const q = mode === 'webgl' ? glTimerBegin() : null;
    active.render(scene, camera);
    if (mode === 'webgl') {
      glTimerEnd(q);
      glTimerPoll();
    } else {
      gpuTimerResolve(active);
    }
    frameDraws = mode === 'webgpu' ? active.info.render.drawCalls : active.info.render.calls;
    recordFrame(now ?? performance.now(), performance.now() - t0);
  }
  glRenderer.setAnimationLoop(loop);

  // ---------- renderer switching ----------
  const gpuAvailable = !!navigator.gpu;

  async function setMode(next) {
    if (next === mode) return true;
    try {
      if (next === 'webgpu') {
        if (!gpuRenderer) {
          gpuRenderer = new WebGPURenderer({ canvas: canvasGPU, antialias: true, trackTimestamp: true });
          await gpuRenderer.init();
        }
        glRenderer.setAnimationLoop(null);
        active = gpuRenderer;
      } else {
        gpuRenderer?.setAnimationLoop(null);
        active = glRenderer;
      }
      const [on, off] = next === 'webgpu' ? [canvasGPU, canvasGL] : [canvasGL, canvasGPU];
      on.hidden = false;
      off.hidden = true;
      orbit.disconnect();
      orbit.connect(on);
      resize();
      mode = next;
      lastNow = 0;
      Object.assign(win, { start: performance.now(), frames: 0, dt: [], cpu: [] });
      active.setAnimationLoop(loop);
      return true;
    } catch (err) {
      console.error(err);
      onStatus(`Could not start ${next}: ${err.message}`);
      return false;
    }
  }

  // ---------- benchmark ----------
  async function sampleBackend(which) {
    if (!(await setMode(which)) || mode !== which) return null;
    await sleep(BENCH_WARMUP_MS);
    recording = { dt: [], cpu: [], gpu: [] };
    await sleep(BENCH_SAMPLE_MS);
    const rec = recording;
    recording = null;
    return {
      backend: which === 'webgl' ? 'WebGL2' : 'WebGPU',
      frames: rec.dt.length,
      fps: rec.dt.length ? 1000 / avg(rec.dt) : null,
      frameMs: avg(rec.dt),
      p95: pct(rec.dt, 0.95),
      cpu: avg(rec.cpu),
      gpu: rec.gpu.length ? avg(rec.gpu) : null,
      tris: active.info.render.triangles,
      draws: frameDraws,
    };
  }

  async function benchmark() {
    const start = mode;
    const results = [];
    try {
      for (const which of ['webgl', 'webgpu']) {
        onStatus(`Benchmarking ${which === 'webgl' ? 'WebGL2' : 'WebGPU'}… keep this tab visible`);
        const r = await sampleBackend(which);
        if (r) results.push(r);
      }
    } finally {
      await setMode(start);
      onStatus('');
    }
    return results;
  }

  return {
    THREE,
    scene,
    camera,
    orbit,
    holder,
    state,
    glRenderer,
    gpuAvailable,
    get mode() {
      return mode;
    },
    get active() {
      return active;
    },
    setMode,
    benchmark,
  };
}
