// The page's side of the two wasm modules. The compiler (okkama-wasm) is fetched once with progress, compiled once,
// and serves every call from one worker; a trap or a call that runs too long ends that worker, and the next one
// starts from the compiled module and gets the page's files again. The runtime (sparrow-wasm) is fetched after the
// compiler, and every run gets a worker of its own, thrown away with the program's heap when the run ends, when the
// reader stops it, or when the watchdog does. Workers start from blob URLs, so after loading nothing needs the network
// (the CLDR tables, fetched for the programs that read them, stay cached in the page).

const WASM = new URL('./pkg/okkama_wasm_bg.wasm', import.meta.url);
const WORKER = new URL('./worker.js', import.meta.url);
const GLUE = new URL('./pkg/okkama_wasm.js', import.meta.url);
const RUNTIME_WASM = new URL('./pkg/sparrow_wasm_bg.wasm', import.meta.url);
const RUN_WORKER = new URL('./run-worker.js', import.meta.url);
const RUNTIME_GLUE = new URL('./pkg/sparrow_wasm.js', import.meta.url);
const MANIFEST = new URL('./pkg/manifest.json', import.meta.url);
const TIMEOUT_MS = 30000;
/** Real time a run may compute before the page ends it (the design's 15 s; steps and memory are the runtime's). */
export const WATCHDOG_MS = 15000;

let manifest = null;
function loadManifest() {
  manifest ??= fetch(MANIFEST).then(response => (response.ok ? response.json() : {})).catch(() => ({}));
  return manifest;
}

/** The bytes at `url`, reporting {loaded, total} as they come; `total` from the manifest when the server compresses. */
async function fetchBytes(url, total, progress) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`could not load ${url.pathname} (${response.status} ${response.statusText})`);
  // Content-Length is the compressed size when the server compresses; the stream gives the raw bytes.
  if (!total && !response.headers.get('Content-Encoding')) total = Number(response.headers.get('Content-Length')) || 0;
  if (!response.body || !response.body.getReader) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    progress({ loaded: bytes.length, total: bytes.length });
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    progress({ loaded, total: Math.max(total, loaded) });
  }
  const bytes = new Uint8Array(loaded);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  return bytes;
}

/** A worker and its wasm-bindgen glue as blob URLs: starting another needs no network. */
async function blobWorker(workerUrl, glueUrl, specifier) {
  const [worker, glue] = await Promise.all([workerUrl, glueUrl].map(async url => {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`could not load ${url.pathname} (${response.status})`);
    return response.text();
  }));
  const glueBlob = URL.createObjectURL(new Blob([glue], { type: 'text/javascript' }));
  const source = worker.replace(`'${specifier}'`, JSON.stringify(glueBlob));
  if (source === worker) throw new Error(`${workerUrl.pathname} does not import ${specifier}`);
  return URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
}

export class Engine extends EventTarget {
  constructor() {
    super();
    this.module = null;
    this.worker = null;
    this.ready = null;
    this.version = null;
    this.pending = new Map();
    this.nextId = 1;
    this.files = null;
    this.restarts = 0;
    this.workerUrl = null;
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  /** Fetch and compile the wasm, then start the worker. Emits `progress` {loaded, total}. */
  async load() {
    const known = await loadManifest();
    const workerUrl = blobWorker(WORKER, GLUE, './pkg/okkama_wasm.js');
    workerUrl.catch(() => {});
    const bytes = await fetchBytes(WASM, known.wasmBytes || 0, detail => this.emit('progress', detail));
    this.emit('compiling', { bytes: bytes.length });
    this.module = await WebAssembly.compile(bytes);
    this.workerUrl = await workerUrl;
    await this.start();
    return this.version;
  }

  start() {
    const worker = new Worker(this.workerUrl, { type: 'module' });
    this.worker = worker;
    this.ready = new Promise((resolve, reject) => {
      const first = ({ data }) => {
        if (data.type === 'ready') {
          worker.removeEventListener('message', first);
          this.version = data.version;
          worker.addEventListener('message', event => this.answer(worker, event.data));
          resolve(data.version);
        } else if (data.type === 'failed') {
          reject(new Error(data.message));
        }
      };
      worker.addEventListener('message', first);
      worker.addEventListener('error', event => {
        event.preventDefault();
        reject(new Error(event.message || 'the compiler worker failed to start'));
        this.lost(worker, `the compiler worker stopped (${event.message || 'error'})`);
      });
    });
    worker.postMessage({ type: 'init', module: this.module });
    return this.ready.then(version => {
      if (this.files) this.send('setFiles', this.files);
      return version;
    });
  }

  answer(worker, data) {
    const call = this.pending.get(data.id);
    if (!call) return;
    this.pending.delete(data.id);
    clearTimeout(call.timer);
    if (data.trap) {
      call.reject(Object.assign(new Error(data.trap), { trap: true }));
      this.lost(worker, data.trap);
    } else call.resolve(data.spb ? Object.assign(data.response, { spb: data.spb }) : data.response);
  }

  /** The worker trapped or hung: fail what it still had, and start a fresh one. */
  lost(worker, reason) {
    if (worker !== this.worker) return;
    worker.terminate();
    this.worker = null;
    for (const [id, call] of this.pending) {
      clearTimeout(call.timer);
      call.reject(Object.assign(new Error(reason), { trap: true }));
      this.pending.delete(id);
    }
    this.restarts++;
    this.emit('restart', { reason });
    this.start().catch(error => this.emit('fatal', { message: String(error.message || error) }));
  }

  send(fn, request) {
    const worker = this.worker;
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.lost(worker, `the compiler took longer than ${TIMEOUT_MS / 1000} s`);
      }, TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      worker.postMessage({ id, fn, request });
    });
  }

  /** Run `fn` (check, fmt, …) on `request`; resolves to the JSON response. */
  async call(fn, request) {
    if (!this.ready) throw new Error('the compiler is not loaded');
    await this.ready;
    if (!this.worker) await this.ready;
    return this.send(fn, request);
  }

  /** The page's own files besides the buffer (importable modules); kept for a restarted worker. */
  async setFiles(files) {
    this.files = { files };
    return this.call('setFiles', this.files);
  }
}

/** Sparrow for runs: one compiled module, a worker per run. */
export class Runtime extends EventTarget {
  constructor() {
    super();
    this.module = null;
    this.workerUrl = null;
    this.version = null;
    this.loading = null;
    this.data = new Map();
    this.watchdogMs = WATCHDOG_MS;
    this.spare = null;
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  /** Fetch and compile sparrow-wasm once (emits `progress`); the same promise for every caller. */
  load() {
    this.loading ??= (async () => {
      const known = await loadManifest();
      const workerUrl = blobWorker(RUN_WORKER, RUNTIME_GLUE, './pkg/sparrow_wasm.js');
      workerUrl.catch(() => {});
      const bytes = await fetchBytes(RUNTIME_WASM, known.runtimeBytes || 0, detail => this.emit('progress', detail));
      this.module = await WebAssembly.compile(bytes);
      this.workerUrl = await workerUrl;
      this.prepare();
      return this;
    })();
    this.loading.catch(() => { this.loading = null; });
    return this.loading;
  }

  /** A data file the runtime asks for (the CLDR tables), fetched once from pkg/. */
  dataFile(name) {
    if (!/^[a-z0-9-]+\.dat$/.test(name)) return Promise.reject(new Error(`unexpected data file ${name}`));
    if (!this.data.has(name)) {
      const loading = fetchBytes(new URL(`./pkg/${name}`, import.meta.url), 0, () => {});
      loading.catch(() => this.data.delete(name));
      this.data.set(name, loading);
    }
    return this.data.get(name);
  }

  /** A fresh worker with Sparrow instantiated: {worker, ready}. */
  spawn() {
    const worker = new Worker(this.workerUrl, { type: 'module' });
    const ready = new Promise((resolve, reject) => {
      const first = ({ data }) => {
        if (data.type === 'ready') {
          this.version = data.version;
          resolve();
        } else if (data.type === 'trap') reject(new Error(data.message));
        else return;
        worker.removeEventListener('message', first);
      };
      worker.addEventListener('message', first);
      worker.addEventListener('error', event => {
        event.preventDefault();
        reject(new Error(event.message || 'the run worker did not start'));
      }, { once: true });
    });
    ready.catch(() => {});
    worker.postMessage({ type: 'init', module: this.module });
    return { worker, ready };
  }

  /** Start the next run's worker ahead, so a run starts at once (and with no network at all once loaded). */
  prepare() {
    if (this.spare || !this.module) return;
    try {
      this.spare = this.spawn();
      this.spare.ready.catch(() => { this.spare = null; });
    } catch {
      this.spare = null;
    }
  }

  /**
   * Run `spb` with `stdin` in a worker of its own. `onRequirements({refused, files})` hears what the program needs
   * before it runs. Returns {done, stop}: `done` resolves to {result, elapsed, requirements} | {interrupted:
   * 'stop' | 'watchdog'} | {trap} | {error}; `stop()` ends the run.
   */
  run(spb, { stdin = '', onRequirements = () => {} } = {}) {
    const { worker, ready } = this.spare || this.spawn();
    this.spare = null;
    let finish;
    const done = new Promise(resolve => { finish = resolve; });
    let timer = null;
    let requirements = null;
    let over = false;
    const end = outcome => {
      if (over) return;
      over = true;
      clearTimeout(timer);
      worker.terminate();
      finish({ requirements, ...outcome });
      this.prepare();
    };
    worker.addEventListener('message', async ({ data }) => {
      if (data.type === 'requirements') {
        requirements = data.result;
        if (requirements.error) return end({ error: requirements.error });
        onRequirements(requirements);
        let files;
        try {
          files = await Promise.all((requirements.files || []).map(async name => ({ name, bytes: await this.dataFile(name) })));
        } catch (error) {
          return end({ error: `the data this program needs did not load: ${error.message || error}` });
        }
        if (over) return undefined;
        timer = setTimeout(() => end({ interrupted: 'watchdog' }), this.watchdogMs);
        worker.postMessage({ type: 'run', spb, stdin, files });
      } else if (data.type === 'done') {
        if (data.result.error) end({ error: data.result.error });
        else end({ result: data.result, elapsed: data.elapsed });
      } else if (data.type === 'trap') {
        end({ trap: data.message });
      }
      return undefined;
    });
    ready.then(() => {
      if (over) return;
      worker.addEventListener('error', event => {
        event.preventDefault();
        end({ trap: event.message || 'the run worker stopped' });
      });
      worker.postMessage({ type: 'requirements', spb });
    }, error => end({ error: `the run could not start: ${error.message || error}` }));
    return { done, stop: () => end({ interrupted: 'stop' }) };
  }
}
