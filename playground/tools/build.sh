#!/bin/sh
# Rebuild the playground's compiler and examples from an Okkama checkout (on every release, as /man/ is):
#
#     sh playground/tools/build.sh OKKAMA_CHECKOUT [WASM_BINDGEN]
#
# builds okkama-wasm for wasm32-unknown-unknown, runs wasm-bindgen --target web into playground/pkg/, writes
# pkg/manifest.json (version, wasm size, commit) and playground/examples.json (the Bible's examples).
# wasm-bindgen must be the version okkama-rs/Cargo.lock pins (cargo install wasm-bindgen-cli --version X).
set -eu
checkout=$(cd "$1" && pwd)
bindgen=${2:-wasm-bindgen}
here=$(cd "$(dirname "$0")/.." && pwd)
target=${CARGO_TARGET_DIR:-$checkout/okkama-rs/target}
(cd "$checkout/okkama-rs" && CARGO_TARGET_DIR="$target" cargo build --release --locked -p okkama-wasm --target wasm32-unknown-unknown)
rm -rf "$here/pkg"
"$bindgen" --target web --remove-name-section --remove-producers-section --out-dir "$here/pkg" \
  "$target/wasm32-unknown-unknown/release/okkama_wasm.wasm"
rm -f "$here/pkg/.gitignore" "$here/pkg/package.json"
bytes=$(wc -c < "$here/pkg/okkama_wasm_bg.wasm" | tr -d ' ')
version=$(sed -n 's/^version = "\(.*\)"/\1/p' "$checkout/okkama-rs/Cargo.toml" | head -1)
commit=$(git -C "$checkout" rev-parse --short=9 HEAD)
printf '{"version":"%s","commit":"%s","wasmBytes":%s}\n' "$version" "$commit" "$bytes" > "$here/pkg/manifest.json"
python3 "$here/tools/examples.py" "$checkout"
echo "playground: okkama $version ($commit), wasm $bytes bytes, $(gzip -9c "$here/pkg/okkama_wasm_bg.wasm" | wc -c | tr -d ' ') gzip"
