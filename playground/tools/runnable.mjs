// Mark the Bible's examples that run in the playground: node playground/tools/runnable.mjs
//
// Builds every example of playground/examples.json on the compiler (pkg/okkama_wasm) and asks the runtime
// (pkg/sparrow_wasm) what it needs. An example runs when the playground's profile refuses none of its natives
// and it is not a test suite (`runs`; otherwise `refused` names what it lacks); it is then run with empty standard input, as the Bible's build.py runs
// it, and what it shows (standard output, then "exit N" for a status other than 0) is compared with the Bible's
// expected output (`matches`). Rejected examples and test suites (NAME-tests) do not run. Prints the counts and every mismatch.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const pkg = `${root}pkg/`;
const compiler = await import(`${pkg}okkama_wasm.js`);
const runtime = await import(`${pkg}sparrow_wasm.js`);
compiler.initSync({ module: new WebAssembly.Module(readFileSync(`${pkg}okkama_wasm_bg.wasm`)) });
runtime.initSync({ module: new WebAssembly.Module(readFileSync(`${pkg}sparrow_wasm_bg.wasm`)) });

const index = JSON.parse(readFileSync(`${root}examples.json`, 'utf8'));
const files = Object.fromEntries(Object.entries(index.files).filter(([path]) => path.endsWith('.ok')));
compiler.setFiles(JSON.stringify({ files }));
const provided = new Set();
const counts = { runs: 0, matches: 0, refused: 0, rejected: 0, tests: 0 };
const mismatches = [];

for (const example of index.examples) {
  delete example.runs;
  delete example.refused;
  delete example.matches;
  if (example.rejected) {
    counts.rejected++;
    continue;
  }
  if (example.tests) {
    // A test suite's report (okkama run -t) is not the playground's yet: its runs are programs.
    example.runs = false;
    counts.tests++;
    continue;
  }
  const path = `${example.name}.ok`;
  const built = JSON.parse(compiler.build(JSON.stringify({ source: example.source, path, tests: example.tests })));
  if (!built.ok) {
    example.runs = false;
    mismatches.push(`${example.name}: does not build: ${built.stderr.trim().split('\n')[0]}`);
    continue;
  }
  const spb = compiler.builtSpb();
  const needs = JSON.parse(runtime.requirements(spb));
  if (needs.error || needs.refused.length) {
    example.runs = false;
    example.refused = needs.refused || [];
    counts.refused++;
    continue;
  }
  for (const name of needs.files) {
    if (provided.has(name)) continue;
    const given = JSON.parse(runtime.provide(name, readFileSync(`${pkg}${name}`)));
    if (given.error) throw new Error(`${name}: ${given.error}`);
    provided.add(name);
  }
  const ran = JSON.parse(runtime.run(spb, JSON.stringify({ stdin: '' })));
  const stdout = ran.output.filter(piece => piece.stream === 'stdout').map(piece => piece.text).join('');
  // As build.py compares: the output without its last newlines, by lines.
  const trimmed = stdout.replace(/\n+$/, '');
  const lines = trimmed ? trimmed.split('\n') : [];
  if (ran.exit !== 0) lines.push(`exit ${ran.exit}`);
  const expected = (example.expected || '').replace(/\n+$/, '');
  example.runs = true;
  example.matches = lines.join('\n') === expected;
  counts.runs++;
  if (example.matches) counts.matches++;
  else mismatches.push(`${example.name}: printed ${JSON.stringify(lines.join('\n').slice(0, 160))}, the Bible ${JSON.stringify(expected.slice(0, 160))}`);
}

writeFileSync(`${root}examples.json`, `${JSON.stringify(index)}\n`);
console.log(`examples: ${counts.runs} run (${counts.matches} as the Bible prints), ${counts.refused} need what the playground lacks, ${counts.tests} test suites, ${counts.rejected} rejected`);
for (const line of mismatches) console.log(`  ${line}`);
