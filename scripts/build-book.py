#!/usr/bin/env python3
"""Build static book pages from a clean, tagged checkout of Okkama. Requires Pandoc."""
import argparse
import json
from html import escape
from pathlib import Path
import posixpath
import subprocess
from urllib.parse import quote, urlsplit

ORIGIN = 'https://github.com/Okkama-lang/okkama'
ROOT = Path(__file__).resolve().parents[1]
BOOKS = [
    ('book', 'en', 'The Okkama Book', 'OkkamaBook.md', 'Table of Contents'),
    ('book-ru', 'ru', 'Книга Okkama', 'OkkamaBook-RU.md', 'Оглавление'),
]

def command(*args, **kwargs):
    return subprocess.check_output(args, text=True, **kwargs)

def nodes(value):
    if isinstance(value, dict):
        if 't' in value:
            yield value
        for child in value.values():
            yield from nodes(child)
    elif isinstance(value, list):
        for child in value:
            yield from nodes(child)

def doc(text, version):
    return f'''<!doctype html>
<html lang="{text['lang']}"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="description" content="{escape(text['description'])}">
<title>{escape(text['title'])} · Okkama</title>
<link rel="icon" href="/assets/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/styles.css">
<link rel="stylesheet" href="/docs/reader.css">
<script defer src="/app.js"></script>
<script defer src="/docs/reader.js"></script>
</head><body class="docs-body">
<a class="skip-link" href="#content">Skip to content</a>
<header class="header"><div class="shell header-inner">
<a class="brand" href="/" aria-label="Okkama, home"><span class="brand-mark" aria-hidden="true">0&lt;</span><span>okkama<span class="brand-dot">.</span></span></a>
<button class="menu-toggle" type="button" aria-expanded="false" aria-controls="navigation" aria-label="Open menu"><span></span><span></span></button>
<nav class="nav" id="navigation" aria-label="Main navigation"><a href="/start/">Try Okkama</a><a href="/playground/">Playground</a><a href="/tutorial/">Tutorial</a><a href="/docs/" aria-current="page">Docs</a><a href="/man/">Standard library</a><a class="nav-github" href="https://github.com/Okkama-lang/okkama">GitHub</a></nav>
</div></header>
{text['body']}
<footer class="docs-footer"><a href="/">Okkama</a><span>Documentation · {escape(version)}</span><a href="/docs/">Documentation home</a></footer>
</body></html>
'''

def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('checkout', type=Path)
    p.add_argument('--tag', default='v0.6.2')
    args = p.parse_args()
    version = args.tag
    source = args.checkout.resolve()
    commit = command('git', '-C', str(source), 'rev-parse', '--verify', version + '^{commit}').strip()
    tracked = set(command('git', '-C', str(source), 'ls-tree', '-r', '--name-only', commit).splitlines())
    gitbook = f'{ORIGIN}/blob/{quote(version, safe="")}/docs/'
    manual = '''<a class="docs-card" href="/man/"><small>REFERENCE</small><strong>Standard library</strong><p>Search modules, objects and actions in the reference generated from <code>okkama man</code>.</p><span>Browse the reference →</span></a>'''
    cards = f'''<a class="docs-card" href="/start/"><small>01 / GET RUNNING</small><strong>Quickstart</strong><p>Install Okkama and run your first payment example.</p><span>Start here →</span></a>
<a class="docs-card" href="/tutorial/"><small>02 / BUILD A MODEL</small><strong>Hands-on tutorial</strong><p>Use roles and successors to model a payment that cannot be captured before authorization.</p><span>Open the tutorial →</span></a>
<a class="docs-card" href="/docs/book/"><small>03 / GO DEEPER</small><strong>The Okkama Book</strong><p>Read the language guide in your browser, from first principles to objects, roles, and modules.</p><span>Read the book →</span></a>
{manual}
<a class="docs-card docs-card-bible" href="https://github.com/Okkama-lang/okkama/blob/develop/docs/OkkamaBible/OkkamaBible.pdf"><small>DEEP DIVE / PDF · 700+ PAGES</small><strong>The Okkama Bible</strong><p>The full-length guide to Okkama, from language fundamentals to advanced topics.</p><span>Read the Bible →</span></a>'''
    intro = f'''<main class="docs-home" id="content">
<p class="docs-kicker">OKKAMA / DOCUMENTATION</p><h1>Learn Okkama<span class="docs-dot">.</span></h1>
<p class="docs-lead">Get a program running, work through a small domain model, or look up exactly the thing you came for.</p>
<div class="docs-cards">{cards}</div>
<p class="docs-meta"><a href="/docs/book-ru/" lang="ru">Книга на русском →</a> <span>·</span> Book snapshot: <a href="{ORIGIN}/releases/tag/{escape(version)}">{escape(version)}</a> · <a href="/docs/UPSTREAM-LICENSE.txt">Book license</a></p>
</main>'''
    root = ROOT / 'docs'
    root.mkdir(exist_ok=True)
    (root / 'UPSTREAM-LICENSE.txt').write_text(
        command('git', '-C', str(source), 'show', f'{commit}:LICENSE'), encoding='utf8')
    (root / 'index.html').write_text(doc(dict(lang='en', title='Documentation', description='Quickstart, hands-on tutorial, book and standard library reference for Okkama.', body=intro), version), encoding='utf8')

    for slug, lang, title, md_file, old_toc in BOOKS:
        md = command('git', '-C', str(source), 'show', f'{commit}:docs/{md_file}')
        ast = json.loads(command('pandoc', '--from=gfm+footnotes-raw_html', '--to=json', input=md))
        get_text = lambda xs: command('pandoc','--from=json','--to=plain',input=json.dumps({'pandoc-api-version':ast['pandoc-api-version'],'meta':{},'blocks':[{'t':'Plain','c':xs}]})).strip()
        # Replace the source book's hand-maintained table of contents with the actual rendered headings.
        clean = []
        suppress = False
        for block in ast['blocks']:
            if block['t'] == 'Header':
                level, attrs, inlines = block['c']
                if level == 1 and not clean:
                    continue
                if level == 1:
                    level = 2
                    block['c'][0] = 2
                if level <= 2:
                    suppress = level == 2 and get_text(inlines).casefold() in {old_toc.casefold(), 'содержание'}
            if not suppress:
                clean.append(block)
        ast['blocks'] = clean
        headings = {n['c'][1][0] for n in nodes(clean) if n['t'] == 'Header'}
        for n in list(nodes(clean)):
            if n['t'] not in {'Link','Image'}:
                continue
            attrs, label, target = n['c']
            href, tooltip = target
            u = urlsplit(href)
            if u.scheme or u.netloc or href.startswith('/'):
                continue
            if not u.path:
                if u.fragment not in headings:
                    target[0] = gitbook+md_file+href
                continue
            path = posixpath.normpath(posixpath.join('docs', u.path))
            if path in tracked:
                prefix = f'https://raw.githubusercontent.com/Okkama-lang/okkama/{version}/' if n['t']=='Image' else f'{ORIGIN}/blob/{version}/'
                target[0] = prefix+quote(path, safe='/')+('#'+u.fragment if u.fragment else '')
            else:
                n.update(t='Span',c=[attrs,label])

        contents = []
        for block in clean:
            if block['t'] == 'Header' and block['c'][0] == 2:
                _, _, inlines = block['c']
                id_ = block['c'][1][0]
                label = get_text(inlines)
                contents.append(f'<li><a href="#{escape(id_)}">{escape(label)}</a></li>')
        rendered = command('pandoc','--from=json','--to=html5','--no-highlight',input=json.dumps(ast, ensure_ascii=False))
        labels = ('Contents','Filter chapters…','No matching chapters.','View source','Read in Russian','Skip to the tutorial') if lang=='en' else ('Содержание','Найти главу…','Главы не найдены.','Исходный текст','Read in English','Открыть туториал')
        other = 'book-ru' if lang=='en' else 'book'
        note = 'Versioned snapshot of the upstream book. For a short, hands-on path, start with the tutorial.' if lang=='en' else 'Версия книги из репозитория. Если хочется начать с практики, откройте туториал.'
        body = f'''<main id="content" class="docs-reader">
<aside><details class="docs-side" open><summary>{labels[0]}</summary>
<label class="docs-filter" hidden><span>{labels[0]}</span><input type="search" placeholder="{labels[1]}" aria-controls="book-chapters"></label>
<nav aria-label="{labels[0]}"><ol id="book-chapters">{''.join(contents)}</ol></nav>
<p data-no-chapters hidden role="status">{labels[2]}</p></details></aside>
<article class="docs-prose" aria-labelledby="book-title">
<header class="docs-bookhead"><p class="docs-kicker">OKKAMA / {escape(version)}</p><h1 id="book-title">{escape(title)}<span class="docs-dot">.</span></h1>
<p class="docs-lead">{note}</p>
<p class="docs-meta"><a href="/docs/{other}/" lang="{'ru' if lang=='en' else 'en'}">{labels[4]}</a> · <a href="/tutorial/">{labels[5]}</a> · <a href="{gitbook+md_file}">{labels[3]}</a> · <a href="/docs/UPSTREAM-LICENSE.txt">{'License' if lang == 'en' else 'Лицензия'}</a></p></header>
{rendered}
</article></main>'''
        out = root / slug
        out.mkdir(exist_ok=True)
        (out/'index.html').write_text(doc(dict(lang=lang, title=title, description=note, body=body), version), encoding='utf8')

if __name__ == '__main__':
    main()
