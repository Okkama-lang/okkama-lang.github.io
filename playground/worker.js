// The compiler's thread: one instance of the Okkama compiler in WebAssembly (pkg/, wasm-bindgen --target web).
// The page sends {type: 'init', module} once, then {id, fn, request}; the answer is {id, response} or, when
// the call trapped (a compiler panic is a wasm `unreachable`), {id, trap}. A trapped instance is not used again:
// the page ends this worker and starts a fresh one from the same compiled module.

import * as okkama from './pkg/okkama_wasm.js';

const CALLS = new Set(['check', 'fmt', 'tokens', 'ast', 'ir', 'spa', 'hover', 'complete', 'definition', 'signature',
  'setFiles']);
let broken = null;

self.onmessage = ({ data }) => {
  if (data.type === 'init') {
    try {
      okkama.initSync({ module: data.module });
      self.postMessage({ type: 'ready', version: JSON.parse(okkama.version()) });
    } catch (error) {
      self.postMessage({ type: 'failed', message: String(error && error.message || error) });
    }
    return;
  }
  const { id, fn, request } = data;
  if (broken) {
    self.postMessage({ id, trap: broken });
    return;
  }
  if (!CALLS.has(fn) && fn !== '__trap') {
    self.postMessage({ id, response: { ok: false, code: 2, stdout: '', stderr: `unknown call ${fn}\n`, diagnostics: [] } });
    return;
  }
  try {
    // `__trap` stands for a compiler panic, so the page's restart can be tested.
    if (fn === '__trap') throw new WebAssembly.RuntimeError('unreachable');
    const response = JSON.parse(okkama[fn](JSON.stringify(request)));
    self.postMessage({ id, response });
  } catch (error) {
    broken = `${error && error.name || 'Error'}: ${error && error.message || error}`;
    self.postMessage({ id, trap: broken });
  }
};
