(() => {
  const menu = document.querySelector('.docs-side');
  if (menu) {
    if (matchMedia('(max-width: 780px)').matches && !location.hash) menu.open = false;
    const chapters = [...menu.querySelectorAll('li')];
    const input = menu.querySelector('input');
    input.closest('label').hidden = false;
    input.addEventListener('input', () => {
      const query = input.value.trim().toLocaleLowerCase();
      chapters.forEach(chapter => { chapter.hidden = !chapter.textContent.toLocaleLowerCase().includes(query); });
      menu.querySelector('[data-no-chapters]').hidden = chapters.some(chapter => !chapter.hidden);
    });
    const activeChapter = () => chapters.forEach(chapter => {
      const link = chapter.firstElementChild;
      if (link.hash === location.hash) link.setAttribute('aria-current', 'location');
      else link.removeAttribute('aria-current');
    });
    window.addEventListener('hashchange', activeChapter);
    activeChapter();
  }

  const pattern = /\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\b(?:module|import|take|as|object|role|enum|is|does|has|hidden|let|memo|self|match|case|if|else|for|in|loop|next|last|try|catch|throw|panic|confirm|defer|destroy|native|await|spawn|test|throws)\b|\b(?:int|float|rat|byte|string|char|bool|any|Maybe|Presence|true|false)\b|\b[0-9]+(?:\.[0-9]+)?\b|\^/gu;
  const types = /^(?:int|float|rat|byte|string|char|bool|any|Maybe|Presence|true|false)$/u;
  for (const code of document.querySelectorAll('.docs-prose pre > code')) {
    const snippet = code.textContent;
    if (code.classList.contains('language-okkama') || code.parentElement.classList.contains('okkama')) {
      const tokens = document.createDocumentFragment();
      let end = 0;
      for (const match of snippet.matchAll(pattern)) {
        const word = match[0];
        const token = document.createElement('span');
        const kind = word.startsWith('/') ? 'comment' : /^['"]/.test(word) ? 'string'
          : /^\d/.test(word) ? 'number' : word === '^' ? 'successor' : types.test(word) ? 'type' : 'keyword';
        token.className = 'token-' + kind;
        token.textContent = word;
        tokens.append(snippet.slice(end, match.index), token);
        end = match.index + word.length;
      }
      tokens.append(snippet.slice(end));
      code.replaceChildren(tokens);
    }
    if (!navigator.clipboard?.writeText) continue;
    const copy = document.createElement('button');
    copy.type = 'button';
    const russian = document.documentElement.lang === 'ru';
    const label = russian ? 'Копировать' : 'Copy';
    copy.textContent = label;
    copy.setAttribute('aria-live','polite');
    let reset;
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(snippet);
        copy.textContent = russian ? 'Скопировано' : 'Copied';
      } catch {
        copy.textContent = russian ? 'Выделите код' : 'Select the code';
      }
      clearTimeout(reset);
      reset = setTimeout(() => { copy.textContent = label; }, 1600);
    });
    const pre = code.parentElement;
    const wrapper = document.createElement('div');
    wrapper.className = 'docs-code';
    pre.replaceWith(wrapper);
    wrapper.append(pre, copy);
  }
})();
