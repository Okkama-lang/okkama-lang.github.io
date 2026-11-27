#!/usr/bin/env python3
"""Index the Okkama Bible's examples for the playground: playground/examples.json.

    python3 playground/tools/examples.py OKKAMA_CHECKOUT

Reads OKKAMA_CHECKOUT/docs/OkkamaBible/examples (every NAME.ok, its NAME.expected, and the modules the
examples import from subdirectories, such as shop/money.ok) and the chapter titles from
docs/OkkamaBible/chapters/en. An example opens at /playground/?example=NAME.
"""
import json
import os
import re
import sys


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__.strip())
    bible = os.path.join(sys.argv[1], "docs", "OkkamaBible")
    root = os.path.join(bible, "examples")
    chapters = {}
    for name in sorted(os.listdir(os.path.join(bible, "chapters", "en"))):
        number = re.match(r"(\d\d)-", name)
        if not number:
            continue
        text = open(os.path.join(bible, "chapters", "en", name), encoding="utf-8").read()
        heading = re.search(r"^# Chapter \d+\. (.+)$", text, re.M) or re.search(r"^# (.+)$", text, re.M)
        chapters[number.group(1)] = heading.group(1).strip() if heading else name
    examples, files = [], {}
    for directory, _, names in sorted(os.walk(root)):
        for name in sorted(names):
            path = os.path.join(directory, name)
            relative = os.path.relpath(path, root).replace(os.sep, "/")
            if directory != root:
                # A module the examples import ("shop/money"), or a data file one reads.
                files[relative] = open(path, encoding="utf-8").read()
                continue
            if not name.endswith(".ok"):
                continue
            stem = name[:-3]
            expected = os.path.join(root, stem + ".expected")
            chapter = stem[:2] if re.match(r"\d\d-", stem) else ""
            examples.append({
                "name": stem,
                "chapter": chapter,
                "source": open(path, encoding="utf-8").read(),
                "expected": open(expected, encoding="utf-8").read() if os.path.exists(expected) else None,
                # As the Bible's check runs them: NAME-rejected shows the compiler's diagnostic, NAME-tests runs
                # as a test suite (-t).
                "rejected": stem.endswith("-rejected"),
                "tests": stem.endswith("-tests"),
            })
    used = {chapter for chapter in (example["chapter"] for example in examples) if chapter}
    out = {
        "chapters": {key: title for key, title in chapters.items() if key in used},
        "examples": examples,
        "files": files,
    }
    target = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "examples.json")
    with open(target, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
        f.write("\n")
    print(f"{target}: {len(examples)} examples, {len(files)} module files, {os.path.getsize(target)} bytes")


if __name__ == "__main__":
    main()
