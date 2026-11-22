# Okkama website

The source for [okkama-lang.github.io](https://okkama-lang.github.io/). GitHub Pages publishes the static files from the root of `develop`. No JavaScript build is needed. The standard-library reference at `/man/` is published separately.

## Preview

```sh
python3 -m http.server 8000
```

Open `http://localhost:8000/`. The site-wide stylesheet, Quickstart, Tutorial, and Docs work from the root of this preview. `/man/` is only available at the deployed origin.

## Update the language book

The English and Russian books are generated from a named release of the language repository. Edit the upstream Markdown, not the generated HTML. With Python 3, Git, and Pandoc installed:

```sh
git clone --depth 1 --branch v0.6.2 https://github.com/Okkama-lang/okkama.git ../okkama-book-source
python3 scripts/build-book.py ../okkama-book-source --tag v0.6.2
```

When moving to a new release, update the Quickstart links and version labels, rebuild the book, and verify each downloadable example against the new tagged release. The prepared examples are under `examples/quickstart/`. The working example must print all three states; the two intentionally rejected examples must exit non-zero and report the documented diagnostic.
