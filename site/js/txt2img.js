// Text -> image in the browser: SD-Turbo (ONNX, fp16) on ONNX Runtime Web WebGPU, single step.
// Adapted from the minimal sd-turbo demo at github.com/guschmue/ort-webgpu. The ~2.4 GB of weights
// (huggingface.co/schmuell/sd-turbo-ort-web, Stability AI terms) are fetched from Hugging Face by the
// visitor's browser and cached locally; nothing is hosted in this repo.
const ORT_URL = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.18.0-dev.20240118-28a16c223c/dist/ort.webgpu.min.js';
const MODEL_BASE = 'https://huggingface.co/schmuell/sd-turbo-ort-web/resolve/main';
const OPFS_DIR = 'kiln-sdturbo-v2';
const SIGMA = 14.6146;
const VAE_SCALE = 0.18215;

const MODELS = {
  unet: {
    url: 'unet/model.onnx',
    mb: 1733,
    opt: { freeDimensionOverrides: { batch_size: 1, num_channels: 4, height: 64, width: 64, sequence_length: 77 } },
  },
  text_encoder: { url: 'text_encoder/model.onnx', mb: 681, opt: { freeDimensionOverrides: { batch_size: 1 } } },
  vae_decoder: {
    url: 'vae_decoder/model.onnx',
    mb: 99,
    opt: { freeDimensionOverrides: { batch_size: 1, num_channels_latent: 4, height_latent: 64, width_latent: 64 } },
  },
};
export const DOWNLOAD_MB = Object.values(MODELS).reduce((s, m) => s + m.mb, 0);

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`Could not load ${src}`));
    document.head.append(s);
  });
}

export async function checkSupport() {
  if (!navigator.gpu) return { ok: false, reason: 'WebGPU is not available in this browser.' };
  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter?.features.has('shader-f16')) {
      return { ok: false, reason: 'This GPU or browser lacks WebGPU shader-f16, which SD-Turbo needs.' };
    }
  } catch {
    return { ok: false, reason: 'Could not get a WebGPU adapter.' };
  }
  return { ok: true };
}

// Model files are streamed into the Origin Private File System so later visits skip the download.
// (The Cache API refuses single entries this large in Chromium, so it is not used.)
const canOpfs = !!(navigator.storage?.getDirectory && globalThis.FileSystemFileHandle?.prototype.createWritable);
const opfsDir = async () => (await navigator.storage.getDirectory()).getDirectoryHandle(OPFS_DIR, { create: true });
const fileKey = (url) => url.replace(/^https?:\/\//, '').replace(/[^a-z0-9.]+/gi, '_');

async function readCached(url) {
  if (!canOpfs) return null;
  try {
    const dir = await opfsDir();
    const meta = JSON.parse(await (await (await dir.getFileHandle(`${fileKey(url)}.done`)).getFile()).text());
    const file = await (await dir.getFileHandle(fileKey(url))).getFile();
    return file.size === meta.size ? file : null;
  } catch {
    return null;
  }
}

async function fetchModel(url, onBytes, onCacheFail) {
  const hit = await readCached(url);
  if (hit) return { buf: await hit.arrayBuffer(), cached: true };

  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Download failed (${resp.status}): ${url}`);
  const declared = +resp.headers.get('content-length') || 0;
  let dir = null;
  let writable = null;
  if (canOpfs) {
    try {
      dir = await opfsDir();
      writable = await (await dir.getFileHandle(fileKey(url), { create: true })).createWritable();
    } catch (err) {
      onCacheFail?.(err);
    }
  }
  const reader = resp.body.getReader();
  let bytes = declared ? new Uint8Array(declared) : null; // preallocate: one copy in memory
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (bytes && size + value.length <= bytes.length) bytes.set(value, size);
    else {
      if (bytes) { chunks.push(bytes.subarray(0, size)); bytes = null; }
      chunks.push(value);
    }
    size += value.length;
    onBytes(value.length);
    if (writable) {
      try {
        await writable.write(value);
      } catch (err) {
        onCacheFail?.(err);
        await writable.abort().catch(() => {});
        writable = null;
      }
    }
  }
  if (writable) {
    try {
      await writable.close();
      const done = await (await dir.getFileHandle(`${fileKey(url)}.done`, { create: true })).createWritable();
      await done.write(JSON.stringify({ size }));
      await done.close();
    } catch (err) {
      onCacheFail?.(err);
    }
  }
  const buf = bytes ? bytes.buffer : await new Blob(chunks).arrayBuffer();
  return { buf: size === buf.byteLength ? buf : buf.slice(0, size), cached: false };
}

function randn(size, scale) {
  const data = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    const u = 1 - Math.random(); // avoid log(0)
    const v = Math.random();
    data[i] = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v) * scale;
  }
  return data;
}

export function createTextToImage({ AutoTokenizer, onStatus = () => {} }) {
  let ready = null;
  let sessions = null;
  let tokenizer = null;
  let ort = null;

  let loadMs = 0;
  async function load() {
    const t0 = performance.now();
    await loadScript(ORT_URL);
    ort = window.ort;
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.simd = true;
    const opt = {
      executionProviders: ['webgpu'],
      enableMemPattern: false,
      enableCpuMemArena: false,
      extra: {
        session: {
          disable_prepacking: '1',
          use_device_allocator_for_initializers: '1',
          use_ort_model_bytes_directly: '1',
          use_ort_model_bytes_for_initializers: '1',
        },
      },
      preferredOutputLocation: { last_hidden_state: 'gpu-buffer' },
    };
    let missing = 0;
    for (const m of Object.values(MODELS)) if (!(await readCached(`${MODEL_BASE}/${m.url}`))) missing += m.mb;
    const total = missing * 1e6;
    let got = 0;
    const out = {};
    for (const [name, m] of Object.entries(MODELS)) {
      onStatus(
        missing
          ? `Downloading SD-Turbo ${name} · ${Math.round((got / total) * 100)}% of ${missing} MB (first run only, then cached)`
          : `Loading ${name} from cache…`,
      );
      const { buf } = await fetchModel(
        `${MODEL_BASE}/${m.url}`,
        (n) => {
          got += n;
          if (missing) onStatus(`Downloading SD-Turbo ${name} · ${Math.min(99, Math.round((got / total) * 100))}% of ${missing} MB (first run only, then cached)`);
        },
        (err) => onStatus(`Note: could not cache ${name} (${err.message}); it will download again next visit.`),
      );
      onStatus(`Initialising ${name} on the GPU…`);
      out[name] = await ort.InferenceSession.create(buf, { ...opt, ...m.opt });
    }
    tokenizer = await AutoTokenizer.from_pretrained('Xenova/clip-vit-base-patch16');
    sessions = out;
    loadMs = performance.now() - t0;
  }

  function ensureLoaded() {
    ready ??= load().catch((e) => {
      ready = null; // allow retry
      throw e;
    });
    return ready;
  }

  // Returns { canvas (512x512), timings } with load/encode/unet/vae in ms. loadMs is 0 once warm.
  async function generate(prompt) {
    const wasLoaded = !!sessions;
    await ensureLoaded();
    const timings = { loadMs: wasLoaded ? 0 : loadMs };
    let t = performance.now();
    const lap = (key) => {
      const now = performance.now();
      timings[key] = now - t;
      t = now;
    };
    onStatus('Encoding prompt…');
    const enc = await tokenizer(prompt, { max_length: 77, truncation: true, return_tensor: false });
    const ids = new Int32Array(77); // the model needs exactly 77 tokens; pad id 0 as in the reference demo
    Array.from(enc.input_ids, Number).slice(0, 77).forEach((t, i) => (ids[i] = t));
    const { last_hidden_state } = await sessions.text_encoder.run({ input_ids: new ort.Tensor('int32', ids, [1, ids.length]) });
    lap('encodeMs');

    onStatus('Denoising (1 step)…');
    const shape = [1, 4, 64, 64];
    const latent = new ort.Tensor('float32', randn(shape[0] * shape[1] * shape[2] * shape[3], SIGMA), shape);
    const scaled = new Float32Array(latent.data.length);
    const div = (SIGMA ** 2 + 1) ** 0.5;
    for (let i = 0; i < scaled.length; i++) scaled[i] = latent.data[i] / div;
    const { out_sample } = await sessions.unet.run({
      sample: new ort.Tensor('float32', scaled, shape),
      timestep: new ort.Tensor('int64', [999n], [1]),
      encoder_hidden_states: last_hidden_state,
    });
    last_hidden_state.dispose();
    lap('unetMs');

    // Single Euler step from sigma to 0, then undo the VAE scaling.
    const stepped = new Float32Array(out_sample.data.length);
    for (let i = 0; i < stepped.length; i++) {
      const predOriginal = latent.data[i] - SIGMA * out_sample.data[i];
      const derivative = (latent.data[i] - predOriginal) / SIGMA;
      stepped[i] = (latent.data[i] + derivative * -SIGMA) / VAE_SCALE;
    }

    onStatus('Decoding image…');
    const { sample } = await sessions.vae_decoder.run({ latent_sample: new ort.Tensor('float32', stepped, shape) });
    const pix = sample.data;
    for (let i = 0; i < pix.length; i++) pix[i] = Math.min(1, Math.max(0, pix[i] / 2 + 0.5));
    const imageData = sample.toImageData({ tensorLayout: 'NCWH', format: 'RGB' });
    const canvas = document.createElement('canvas');
    canvas.width = imageData.width;
    canvas.height = imageData.height;
    canvas.getContext('2d').putImageData(imageData, 0, 0);
    lap('vaeMs');
    return { canvas, timings };
  }

  return { generate, ensureLoaded, get loaded() { return !!sessions; } };
}
