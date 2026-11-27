#!/bin/sh
# Rebuild the playground's compiler, runtime and examples from an Okkama checkout (on every release, as /man/ is):
#
#     sh playground/tools/build.sh OKKAMA_CHECKOUT [WASM_BINDGEN]
#
# builds okkama-wasm (the compiler) and sparrow-wasm (the runtime) for wasm32-unknown-unknown, runs wasm-bindgen
# --target web on each into playground/pkg/, copies the CLDR tables the runtime fetches on demand
# (okkama-runtime-core/data/cldr-*.dat, the files sparrow-wasm's `requirements` names), writes pkg/manifest.json
# (version, commit, sizes) and playground/examples.json (the Bible's examples), and marks the examples that run
# in the playground (tools/runnable.mjs: built and run on the two modules under Node, compared with the Bible).
# wasm-bindgen must be the version okkama-rs/Cargo.lock pins (cargo install wasm-bindgen-cli --version X).
set -eu
checkout=$(cd "$1" && pwd)
bindgen=${2:-wasm-bindgen}
here=$(cd "$(dirname "$0")/.." && pwd)
target=${CARGO_TARGET_DIR:-$checkout/okkama-rs/target}
(cd "$checkout/okkama-rs" && CARGO_TARGET_DIR="$target" cargo build --release --locked -p okkama-wasm -p sparrow-wasm --target wasm32-unknown-unknown)
rm -rf "$here/pkg"
for crate in okkama_wasm sparrow_wasm; do
  "$bindgen" --target web --remove-name-section --remove-producers-section --out-dir "$here/pkg" \
    "$target/wasm32-unknown-unknown/release/$crate.wasm"
done
rm -f "$here/pkg/.gitignore" "$here/pkg/package.json"
data="$checkout/okkama-rs/crates/okkama-runtime-core/data"
for family in numbers dates zones currencies locales; do
  cp "$data/cldr-$family.dat" "$here/pkg/"
done
size() { wc -c < "$1" | tr -d ' '; }
gz() { gzip -9c "$1" | wc -c | tr -d ' '; }
compiler=$(size "$here/pkg/okkama_wasm_bg.wasm")
runtime=$(size "$here/pkg/sparrow_wasm_bg.wasm")
version=$(sed -n 's/^version = "\(.*\)"/\1/p' "$checkout/okkama-rs/Cargo.toml" | head -1)
commit=$(git -C "$checkout" rev-parse --short=9 HEAD)
printf '{"version":"%s","commit":"%s","wasmBytes":%s,"runtimeBytes":%s}\n' "$version" "$commit" "$compiler" "$runtime" \
  > "$here/pkg/manifest.json"
python3 "$here/tools/examples.py" "$checkout"
node "$here/tools/runnable.mjs"
echo "playground: okkama $version ($commit); compiler $compiler bytes, $(gz "$here/pkg/okkama_wasm_bg.wasm") gzip;" \
  "runtime $runtime bytes, $(gz "$here/pkg/sparrow_wasm_bg.wasm") gzip"
