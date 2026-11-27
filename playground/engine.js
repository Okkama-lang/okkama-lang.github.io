// The page's side of the compiler: fetch the wasm once (with progress), compile it once, and run it in a
// worker. A trap or a call that runs too long ends the worker; the next one starts from the compiled module,
// gets the page's files again, and the page shows a short error.

const WASM = new URL('./pkg/okkama_wasm_bg.wasm', import.meta.url);
const WORKER = new URL('./worker.js', import.meta.url);
const GLUE = new URL('./pkg/okkama_wasm.js', import.meta.url);
const MANIFEST = new URL('./pkg/manifest.json', import.meta.url);
const TIMEOUT_MS = 30000;

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

  /** The worker and the wasm-bindgen glue as blob URLs: a restart then needs no network (offline after load). */
  async workerSource() {
    const [worker, glue] = await Promise.all([WORKER, GLUE].map(async url => {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`could not load ${url.pathname} (${response.status})`);
      return response.text();
    }));
    const glueUrl = URL.createObjectURL(new Blob([glue], { type: 'text/javascript' }));
    const source = worker.replace("'./pkg/okkama_wasm.js'", JSON.stringify(glueUrl));
    if (source === worker) throw new Error('the worker does not import the compiler glue');
    return URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  /** Fetch and compile the wasm, then start the worker. Emits `progress` {loaded, total}. */
  async load() {
    let total = 0;
    try {
      const manifest = await fetch(MANIFEST).then(response => (response.ok ? response.json() : null));
      total = manifest && manifest.wasmBytes || 0;
    } catch { /* the size is only for the progress bar */ }
    const workerUrl = this.workerSource();
    workerUrl.catch(() => {});
    const response = await fetch(WASM);
    if (!response.ok) throw new Error(`could not load the compiler (${response.status} ${response.statusText})`);
    // Content-Length is the compressed size when the server compresses; the stream gives the raw bytes.
    const encoded = response.headers.get('Content-Encoding');
    const length = Number(response.headers.get('Content-Length')) || 0;
    if (!total && !encoded) total = length;
    let bytes;
    if (response.body && response.body.getReader) {
      const reader = response.body.getReader();
      const chunks = [];
      let loaded = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        loaded += value.length;
        this.emit('progress', { loaded, total: Math.max(total, loaded) });
      }
      bytes = new Uint8Array(loaded);
      let at = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, at);
        at += chunk.length;
      }
    } else {
      bytes = new Uint8Array(await response.arrayBuffer());
      this.emit('progress', { loaded: bytes.length, total: bytes.length });
    }
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
    } else call.resolve(data.response);
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
