#!/bin/sh
# Bundle CodeMirror 6 for the playground: ../codemirror.min.js and ../LICENSE-codemirror.txt.
# Versions are exact (package.json, package-lock.json); the install happens in a temporary directory, so
# no node_modules lands in the site. Run once after changing a version: sh playground/vendor/build/build.sh
set -eu
here=$(cd "$(dirname "$0")" && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
cp "$here/package.json" "$here/entry.mjs" "$work/"
[ -f "$here/package-lock.json" ] && cp "$here/package-lock.json" "$work/"
cd "$work"
if [ -f package-lock.json ]; then npm ci --no-audit --no-fund; else npm install --no-audit --no-fund; cp package-lock.json "$here/"; fi
./node_modules/.bin/esbuild entry.mjs --bundle --minify --format=esm --target=es2020 --legal-comments=none \
  --outfile="$here/../codemirror.min.js"
{
  echo "CodeMirror 6 and Lezer (bundled into codemirror.min.js), MIT license:"
  echo
  cat node_modules/@codemirror/view/LICENSE
} > "$here/../LICENSE-codemirror.txt"
echo "bundled: $(wc -c < "$here/../codemirror.min.js") bytes"
