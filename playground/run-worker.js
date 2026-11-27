// One run's thread: a fresh Sparrow (sparrow-wasm, pkg/, wasm-bindgen --target web) for one program, thrown
// away with its heap when the run ends, is stopped or trips the watchdog (the page ends the worker).
//
//   page → {type: 'init', module}                      worker → {type: 'ready', version}
//   page → {type: 'requirements', spb}                 worker → {type: 'requirements', result: {refused, files}}
//   page → {type: 'run', mode: 'run' | 'test', spb, stdin, files: [{name, bytes}]}
//                                                      worker → {type: 'chunks', chunks} while it runs,
//                                                               then {type: 'done', result, elapsed}
//   any failure of the instance                        worker → {type: 'trap', message}
//
// Every write reaches the page while the program runs (sparrow-wasm's output sink, #1134): a chunk {stream, text, t},
// `t` in nanoseconds on the run's virtual timeline (a sleep moves it without waiting). The worker posts each as it
// comes (the page batches its drawing per frame), so a run the page stops keeps what it printed. `result` is
// sparrow-wasm's run: {exit, output: [] (streamed), report, uncaught}, or with mode 'test' its test (#1127): {exit:
// 0 | 1 | 4, output: [], report: `okkama: …` with 4}; `elapsed` the real milliseconds the run took.

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
      // Each write goes to the page at once: a run is one synchronous call, so a chunk held back for a batch would
      // wait for the next write, which a program that prints and then computes (or is stopped) never makes.
      const sink = text => self.postMessage({ type: 'chunks', chunks: [JSON.parse(text)] });
      const started = performance.now();
      // `okkama run -t`: the module's tests (an SPB built with tests), the report streamed a line at a time.
      const call = data.mode === 'test' ? sparrow.test : sparrow.run;
      const result = JSON.parse(call(data.spb, JSON.stringify({ stdin: data.stdin || '' }), sink));
      self.postMessage({ type: 'done', result, elapsed: performance.now() - started });
    }
  } catch (error) {
    trap(error);
  }
};
