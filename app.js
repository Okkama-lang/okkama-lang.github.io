(() => {
  'use strict';

  const toast = document.getElementById('toast');
  let toastTimer;
  function notify(message) {
    if (!toast) return;
    clearTimeout(toastTimer);
    toast.textContent = message;
    toast.classList.add('visible');
    toastTimer = setTimeout(() => toast.classList.remove('visible'), 4000);
  }
  async function copyText(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
      } else {
        const active = document.activeElement;
        const field = document.createElement('textarea');
        field.value = text;
        field.setAttribute('readonly', '');
        field.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
        document.body.appendChild(field);
        field.select();
        const copied = document.execCommand('copy');
        field.remove();
        if (active instanceof HTMLElement) active.focus();
        if (!copied) throw new Error('Clipboard unavailable');
      }
      notify('Copied. Ready to paste.');
    } catch {
      notify('Could not copy. Select the text manually or use the download link.');
    }
  }
  document.querySelectorAll('[data-copy]').forEach(button => {
    button.addEventListener('click', () => {
      const source = document.querySelector(button.dataset.copy);
      if (source) copyText(source.textContent);
    });
  });

  // The source and links are real HTML. Tabs only shorten the page.
  const tabs = [...document.querySelectorAll('[data-example]')];
  const panels = [...document.querySelectorAll('[data-example-panel]')];
  function chooseExample(key) {
    const panel = panels.find(item => item.dataset.examplePanel === key);
    if (!panel) return;
    tabs.forEach(tab => {
      const selected = tab.dataset.example === key;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
    });
    panels.forEach(item => { item.hidden = item !== panel; });
    for (const field of ['kicker', 'title', 'description']) {
      const target = document.getElementById('example-' + field);
      if (target) target.textContent = panel.dataset[field];
    }
  }
  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => chooseExample(tab.dataset.example));
    tab.addEventListener('keydown', event => {
      let next;
      if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
      else if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = tabs.length - 1;
      else return;
      event.preventDefault();
      chooseExample(tabs[next].dataset.example);
      tabs[next].focus();
    });
  });
  if (tabs.length) chooseExample(tabs[0].dataset.example);

  const demo = document.querySelector('.state-demo');
  const run = document.getElementById('run-demo');
  const demoMessage = document.getElementById('demo-message');
  if (demo && run && demoMessage) {
    demo.dataset.enhanced = 'true';
    demo.dataset.opened = 'false';
    demo.querySelector('.successor').setAttribute('aria-hidden', 'true');
    run.addEventListener('click', () => {
      const opened = demo.dataset.opened !== 'true';
      demo.dataset.opened = String(opened);
      demo.querySelector('.successor').setAttribute('aria-hidden', String(!opened));
      run.textContent = opened ? 'Reset illustration' : 'Create successor';
      demoMessage.textContent = opened
        ? 'Successor created: opened is true. The original bottle is still false.'
        : 'Illustration only. The original object stays unchanged.';
    });
  }

  const menu = document.querySelector('.menu-toggle');
  const navigation = document.getElementById('navigation');
  if (menu && navigation) {
    function closeMenu() {
      menu.setAttribute('aria-expanded', 'false');
      menu.setAttribute('aria-label', 'Open menu');
      navigation.classList.remove('open');
    }
    menu.addEventListener('click', () => {
      const open = menu.getAttribute('aria-expanded') !== 'true';
      menu.setAttribute('aria-expanded', String(open));
      menu.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
      navigation.classList.toggle('open', open);
    });
    navigation.querySelectorAll('a').forEach(link => link.addEventListener('click', closeMenu));
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && menu.getAttribute('aria-expanded') === 'true') {
        closeMenu();
        menu.focus();
      }
    });
    document.addEventListener('click', event => {
      if (!navigation.contains(event.target) && !menu.contains(event.target)) closeMenu();
    });
    window.matchMedia('(min-width: 641px)').addEventListener('change', event => {
      if (event.matches) closeMenu();
    });
  }
  document.documentElement.classList.add('enhanced');
})();
