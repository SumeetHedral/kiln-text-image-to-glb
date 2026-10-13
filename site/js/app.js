import { AutoTokenizer, pipeline } from 'transformers';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { createEngine, fmt } from './engine.js';
import { createRelief } from './relief.js';
import { createTextToImage, checkSupport, DOWNLOAD_MB } from './txt2img.js';

const $ = (id) => document.getElementById(id);
const DEPTH_MODEL = 'onnx-community/depth-anything-v2-small';
const MAX_TEX = 1024;
const MAX_SCENE_TRIS = 25e6;
const LOD_DISTANCES = [0, 1.4, 2.2, 3.2]; // multiples of the single-object framing distance
const PROMPT_SUFFIX = ', single object, centered, plain background, studio lighting, product photo';

// ---------- engine ----------
const setStatus = (t) => {
  $('status').hidden = !t;
  $('status').textContent = t || '';
};
const engine = createEngine({
  stage: $('stage'),
  canvasGL: $('gl'),
  canvasGPU: $('gpu'),
  metricsEl: $('metrics'),
  onStatus: setStatus,
});
const { THREE, holder, camera, orbit } = engine;

// ---------- content ----------
let content = null; // { kind: 'glb', template, size, tris } | { kind: 'relief', relief }
let lods = [];
let frameDist = 3;

engine.state.extraLine = () => {
  if (!content) return '';
  const copies = `\nCopies     ${$('copies').value}`;
  if (!lods.length) return copies;
  const counts = {};
  for (const l of lods) counts[l.getCurrentLevel()] = (counts[l.getCurrentLevel()] ?? 0) + 1;
  return `${copies}\nLOD        ${Object.keys(counts).sort().map((k) => `L${k}×${counts[k]}`).join(' ')}`;
};

function clearHolder() {
  holder.clear();
  lods = [];
}
function clearContent() {
  clearHolder();
  if (content?.kind === 'relief') content.relief.dispose();
  content = null;
}

function countTris(obj) {
  let t = 0;
  obj.traverse((o) => {
    if (o.isMesh) t += (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3;
  });
  return t;
}

function frameTo(root, dir, singleRadius) {
  const box = new THREE.Box3().setFromObject(root);
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  const fovV = THREE.MathUtils.degToRad(camera.fov);
  const fovH = 2 * Math.atan(Math.tan(fovV / 2) * camera.aspect);
  const fit = (r) => (r / Math.sin(Math.min(fovV, fovH) / 2)) * 1.45;
  frameDist = fit(singleRadius ?? sphere.radius);
  camera.position.copy(sphere.center).addScaledVector(dir.clone().normalize(), fit(sphere.radius));
  orbit.target.copy(sphere.center);
  orbit.update();
}

function layout(count, gap, plane) {
  const side = Math.ceil(Math.sqrt(count));
  return Array.from({ length: count }, (_, n) => {
    const x = ((n % side) - (side - 1) / 2) * gap;
    const y = ((side - 1) / 2 - Math.floor(n / side)) * gap;
    return plane === 'xz' ? [x, 0, -y] : [x, y, 0];
  });
}

function clampCopies(perCopyTris) {
  let copies = +$('copies').value;
  const max = Math.max(1, Math.floor(MAX_SCENE_TRIS / Math.max(1, perCopyTris)));
  if (copies > max) {
    const allowed = [...document.querySelectorAll('#copies option')].map((o) => +o.value).filter((c) => c <= max).pop() ?? 1;
    setStatus(`${copies} copies would exceed ${MAX_SCENE_TRIS / 1e6}M triangles; using ${allowed}.`);
    setTimeout(() => setStatus(''), 4000);
    copies = allowed;
    $('copies').value = String(allowed);
  }
  return copies;
}

function rebuild() {
  if (!content) return;
  clearHolder();
  if (content.kind === 'glb') {
    const copies = clampCopies(content.tris);
    const gap = Math.max(content.size.x, content.size.z) * 1.35;
    for (const p of layout(copies, gap, 'xz')) {
      const c = content.template.clone(true); // shares geometry and materials
      c.position.set(...p);
      holder.add(c);
    }
    holder.updateMatrixWorld(true);
    const single = new THREE.Box3().setFromObject(content.template).getBoundingSphere(new THREE.Sphere()).radius;
    frameTo(holder, new THREE.Vector3(0.45, 0.3, 1), single);
  } else {
    const { relief } = content;
    const base = +$('density').value;
    const useLod = $('lod').checked;
    const { cols, rows } = relief.gridSize(base);
    const copies = clampCopies(cols * rows * 2);
    const grids = useLod ? [base, base / 2, base / 4, base / 8].map((g) => Math.max(24, Math.round(g))) : [base];
    const levels = grids.map((g) => relief.getLevel(g));
    const gap = Math.max(relief.width, relief.height) * 1.15;
    // Frame first so LOD thresholds use the single-object distance.
    const probe = new THREE.Mesh(levels[0].geo, relief.material);
    holder.add(probe);
    frameTo(holder, new THREE.Vector3(0, 0, 1));
    holder.remove(probe);
    for (const p of layout(copies, gap, 'xy')) {
      let obj;
      if (useLod) {
        obj = new THREE.LOD();
        levels.forEach((lv, i) => obj.addLevel(new THREE.Mesh(lv.geo, relief.material), LOD_DISTANCES[i] * frameDist));
        lods.push(obj);
      } else {
        obj = new THREE.Mesh(levels[0].geo, relief.material);
      }
      obj.position.set(...p);
      holder.add(obj);
    }
    relief.prune(grids);
    holder.updateMatrixWorld(true);
    frameTo(holder, new THREE.Vector3(0, 0, 1), relief.width / 2 + 0.1);
    frameDist = Math.max(frameDist, 0.1);
  }
  applyWire();
}

function applyWire() {
  const wire = $('wire').checked;
  holder.traverse((o) => {
    if (!o.isMesh) return;
    for (const m of [].concat(o.material)) m.wireframe = wire;
  });
}

function setKind(kind) {
  $('copies').value = '1'; // new content starts light; raise it to stress-test
  $('benchResults').hidden = true;
  for (const el of document.querySelectorAll('[data-kind]')) el.hidden = el.dataset.kind !== kind;
  $('controls').hidden = false;
}

// ---------- gallery assets (GLB) ----------
const gltfLoader = new GLTFLoader();
async function showAsset(a) {
  setStatus(`Loading ${a.name}…`);
  const gltf = await gltfLoader.loadAsync(`assets/${a.glb}`);
  clearContent();
  const root = gltf.scene;
  const box = new THREE.Box3().setFromObject(root);
  root.position.sub(box.getCenter(new THREE.Vector3()));
  const wrapper = new THREE.Group();
  wrapper.add(root);
  const size = box.getSize(new THREE.Vector3());
  content = { kind: 'glb', template: wrapper, size, tris: countTris(wrapper) };
  setKind('glb');
  $('brief').textContent = a.brief;
  $('dl').hidden = $('src').hidden = false;
  $('dl').href = `assets/${a.glb}`;
  $('src').href = `assets/${a.source}`;
  $('sheet').src = `assets/${a.preview}`;
  $('info').hidden = false;
  for (const b of $('list').children) b.classList.toggle('on', b.dataset.id === a.id);
  setStatus('');
  rebuild();
}

// ---------- image -> relief ----------
let depthModel;
function loadDepthModel() {
  depthModel ??= (async () => {
    const progress_callback = (p) => {
      if (p.status === 'progress') setStatus(`Downloading depth model… ${Math.round(p.progress)}% (cached after first visit)`);
    };
    try {
      if (!navigator.gpu) throw new Error('no webgpu');
      return await pipeline('depth-estimation', DEPTH_MODEL, { device: 'webgpu', progress_callback });
    } catch {
      return await pipeline('depth-estimation', DEPTH_MODEL, { device: 'wasm', progress_callback });
    }
  })();
  return depthModel;
}

async function canvasToRelief(texCanvas, label) {
  const model = await loadDepthModel();
  setStatus('Estimating depth…');
  const blob = await new Promise((r) => texCanvas.toBlob(r, 'image/png'));
  const url = URL.createObjectURL(blob);
  const { depth } = await model(url);
  URL.revokeObjectURL(url);
  clearContent();
  const relief = createRelief(texCanvas, depth, engine.glRenderer.capabilities.getMaxAnisotropy());
  content = { kind: 'relief', relief };
  applyReliefParams();
  setKind('relief');
  $('brief').textContent = label;
  $('dl').hidden = $('src').hidden = true;
  $('sheet').src = texCanvas.toDataURL('image/png');
  $('info').hidden = false;
  for (const b of $('list').children) b.classList.remove('on');
  setStatus('');
  rebuild();
}

async function handleFile(file) {
  if (!file?.type.startsWith('image/')) return setStatus('That file is not an image.');
  try {
    setStatus('Reading image…');
    const bmp = await createImageBitmap(file);
    const s = Math.min(1, MAX_TEX / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * s);
    c.height = Math.round(bmp.height * s);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    await canvasToRelief(c, `Image: ${file.name}`);
  } catch (err) {
    console.error(err);
    setStatus(`Something went wrong: ${err.message}`);
  }
}

// ---------- text -> image -> relief ----------
const t2i = createTextToImage({ AutoTokenizer, onStatus: (t) => ($('genStatus').textContent = t) });
$('dlsize').textContent = `${(DOWNLOAD_MB / 1000).toFixed(1)} GB`;

async function handleGenerate() {
  const prompt = $('prompt').value.trim();
  if (!prompt) return;
  const btn = $('gen');
  btn.disabled = true;
  try {
    const support = await checkSupport();
    if (!support.ok) throw new Error(support.reason);
    const { canvas: img, timings: tm } = await t2i.generate(prompt + PROMPT_SUFFIX);
    const imgPart = `${tm.loadMs ? `model load ${(tm.loadMs / 1000).toFixed(1)} s · ` : ''}text encoder ${tm.encodeMs.toFixed(0)} ms · UNet ${tm.unetMs.toFixed(0)} ms · VAE ${tm.vaeMs.toFixed(0)} ms`;
    $('genStatus').textContent = `Image made (${imgPart}). Building 3D…`;
    const t1 = performance.now();
    await canvasToRelief(img, `Prompt: ${prompt}`);
    $('genStatus').textContent = `Done. ${imgPart} · depth + mesh ${((performance.now() - t1) / 1000).toFixed(1)} s (includes the depth model load on first use).`;
  } catch (err) {
    console.error(err);
    $('genStatus').textContent = `Could not generate: ${err.message}`;
  } finally {
    btn.disabled = false;
  }
}
checkSupport().then((s) => {
  if (!s.ok) {
    $('gen').disabled = true;
    $('gen').title = s.reason;
    $('genStatus').textContent = `Text to 3D is unavailable here: ${s.reason} Image upload still works.`;
  }
});

// ---------- relief params ----------
function applyReliefParams() {
  if (content?.kind !== 'relief') return;
  content.relief.setParams({
    strength: +$('depth').value,
    cut: +$('cut').value,
    smooth: +$('smooth').value,
    solid: $('solid').checked,
    thickness: +$('thickness').value,
  });
}
let paramRaf = 0;
function scheduleParams() {
  cancelAnimationFrame(paramRaf);
  paramRaf = requestAnimationFrame(applyReliefParams);
}

// ---------- benchmark ----------
async function runBenchmark() {
  if (!content) return;
  $('bench').disabled = true;
  let results = [];
  try {
    results = await engine.benchmark();
  } finally {
    $('bench').disabled = !engine.gpuAvailable;
  }
  showBenchmark(results);
}

function showBenchmark(results) {
  const el = $('benchResults');
  const best = (key, low = true) => {
    const vals = results.map((r) => r[key]).filter((v) => v != null);
    return vals.length < 2 ? null : low ? Math.min(...vals) : Math.max(...vals);
  };
  const cell = (r, key, d, low = true) => {
    const b = best(key, low);
    return `<td class="${b != null && r[key] === b ? 'win' : ''}">${fmt(r[key], d)}</td>`;
  };
  const copies = $('copies').value;
  const cfg =
    content.kind === 'relief'
      ? `${$('density').selectedOptions[0].textContent} · ${$('lod').checked ? 'auto-LOD' : 'fixed'} · ${copies} cop${copies === '1' ? 'y' : 'ies'}`
      : `GLB · ${copies} cop${copies === '1' ? 'y' : 'ies'}`;
  el.innerHTML =
    `<h2>Benchmark <small>${cfg}</small></h2>` +
    `<table><thead><tr><th>Backend</th><th>FPS</th><th>Frame ms</th><th>p95 ms</th><th>CPU submit ms</th><th>GPU ms</th><th>Tris</th><th>Draws</th></tr></thead><tbody>` +
    results
      .map(
        (r) =>
          `<tr><th>${r.backend}</th>${cell(r, 'fps', 1, false)}${cell(r, 'frameMs', 2)}${cell(r, 'p95', 2)}${cell(r, 'cpu', 2)}${cell(r, 'gpu', 2)}<td>${r.tris.toLocaleString()}</td><td>${r.draws}</td></tr>`,
      )
      .join('') +
    `</tbody></table>` +
    (results.some((r) => r.frames === 0) ? `<p class="warn">No frames were rendered for at least one backend. Browsers pause rendering in hidden tabs, so keep this tab in front and run it again.</p>` : '') +
    `<p>Browsers cap frames at the display refresh rate, so FPS ties until the scene is heavy. Raise Copies${content.kind === 'relief' ? ' and Density' : ''}, and compare CPU submit and GPU time, which stay meaningful under the cap. GPU time shows n/a when the browser blocks timer queries. Green marks the better value.</p>`;
  el.hidden = false;
}

// ---------- UI wiring ----------
const modeBtn = { webgl: $('m-gl'), webgpu: $('m-gpu') };
async function switchMode(next) {
  if (await engine.setMode(next)) for (const [k, b] of Object.entries(modeBtn)) b.classList.toggle('on', k === engine.mode);
}
modeBtn.webgl.onclick = () => switchMode('webgl');
modeBtn.webgpu.onclick = () => switchMode('webgpu');
if (!engine.gpuAvailable) {
  modeBtn.webgpu.disabled = true;
  modeBtn.webgpu.title = 'WebGPU is not available in this browser';
  $('bench').disabled = true;
  $('bench').title = 'WebGPU is not available, so there is nothing to compare';
}

for (const id of ['depth', 'cut', 'smooth', 'thickness']) $(id).addEventListener('input', scheduleParams);
$('solid').addEventListener('change', applyReliefParams);
for (const id of ['density', 'lod', 'copies']) $(id).addEventListener('change', () => setTimeout(rebuild, 0));
$('wire').addEventListener('change', applyWire);
$('spin').addEventListener('change', () => (engine.state.autoRotate = $('spin').checked));
$('showMetrics').addEventListener('change', () => ($('metrics').hidden = !$('showMetrics').checked));
$('bench').addEventListener('click', runBenchmark);
$('gen').addEventListener('click', handleGenerate);
$('prompt').addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') handleGenerate();
});
$('file').addEventListener('change', (e) => handleFile(e.target.files[0]));
addEventListener('dragover', (e) => {
  e.preventDefault();
  $('drop').classList.add('over');
});
addEventListener('dragleave', () => $('drop').classList.remove('over'));
addEventListener('drop', (e) => {
  e.preventDefault();
  $('drop').classList.remove('over');
  handleFile(e.dataTransfer.files[0]);
});
addEventListener('paste', (e) => {
  const f = [...(e.clipboardData?.files ?? [])].find((x) => x.type.startsWith('image/'));
  if (f) handleFile(f);
});

$('export').addEventListener('click', () => {
  if (content?.kind !== 'relief') return;
  // One clean mesh at the chosen density (only the vertices in use, no LOD copies).
  const geo = content.relief.exportGeometry(+$('density').value);
  new GLTFExporter().parse(
    new THREE.Mesh(geo, content.relief.material),
    (glb) => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([glb], { type: 'model/gltf-binary' }));
      a.download = 'generated-relief.glb';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      geo.dispose();
    },
    (err) => setStatus(`Export failed: ${err.message}`),
    { binary: true },
  );
});

// ---------- boot ----------
const manifest = await (await fetch('assets/manifest.json')).json();
for (const a of manifest) {
  const b = document.createElement('button');
  b.dataset.id = a.id;
  b.innerHTML = `${a.name}<small>${a.id}</small>`;
  b.onclick = () => showAsset(a);
  $('list').append(b);
}
if (manifest[0]) showAsset(manifest[0]);
