// One run's thread: a fresh Sparrow (sparrow-wasm, pkg/, wasm-bindgen --target web) for one program, thrown
// away with its heap when the run ends, is stopped or trips the watchdog (the page ends the worker).
//
//   page → {type: 'init', module}                      worker → {type: 'ready', version}
//   page → {type: 'requirements', spb}                 worker → {type: 'requirements', result: {refused, files}}
//   page → {type: 'run', spb, stdin, files: [{name, bytes}]}
//                                                      worker → {type: 'done', result, elapsed}
//   any failure of the instance                        worker → {type: 'trap', message}
//
// `result` is sparrow-wasm's run: {exit, output: [{stream, text, t}], report, uncaught}; `t` is in nanoseconds on
// the run's virtual timeline (a sleep moves it without waiting), `elapsed` the real milliseconds the run took.

import * as sparrow from './pkg/sparrow_wasm.js';

function trap(error) {
  let found = null;
  try {
    found = JSON.parse(sparrow.lastPanic()).panic;
  } catch { /* the instance may not answer */ }
  const text = `${error && error.name || 'Error'}: ${error && error.message || error}`;
  const message = found ? `the runtime panicked${found.location ? ` at ${found.location}` : ''}: ${found.message}\n(${text})` : text;
  self.postMessage({ type: 'trap', message });
}

self.onmessage = ({ data }) => {
  try {
    if (data.type === 'init') {
      sparrow.initSync({ module: data.module });
      self.postMessage({ type: 'ready', version: JSON.parse(sparrow.version()) });
    } else if (data.type === 'requirements') {
      self.postMessage({ type: 'requirements', result: JSON.parse(sparrow.requirements(data.spb)) });
    } else if (data.type === 'run') {
      for (const file of data.files || []) {
        const given = JSON.parse(sparrow.provide(file.name, file.bytes));
        if (given.error) throw new Error(`${file.name}: ${given.error}`);
      }
      const started = performance.now();
      const result = JSON.parse(sparrow.run(data.spb, JSON.stringify({ stdin: data.stdin || '' })));
      self.postMessage({ type: 'done', result, elapsed: performance.now() - started });
    }
  } catch (error) {
    trap(error);
  }
};
