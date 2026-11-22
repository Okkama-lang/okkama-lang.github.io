(() => {
  'use strict';
  // Reading and downloads never depend on JavaScript.
  const lessons = [...document.querySelectorAll('.lesson[id]')];
  const links = [...document.querySelectorAll('.guide-toc a')];
  const progress = document.querySelector('.reading-progress');
  if (!lessons.length || !progress) return;
  progress.hidden = false;
  const bar = progress.querySelector('progress');
  const label = progress.querySelector('span');
  let pending = false;
  function update() {
    let current = 0;
    lessons.forEach((section, index) => {
      if (section.getBoundingClientRect().top < window.innerHeight * 0.4) current = index;
    });
    links.forEach(link => {
      if (link.hash === '#' + lessons[current].id) link.setAttribute('aria-current', 'location');
      else link.removeAttribute('aria-current');
    });
    bar.max = lessons.length;
    bar.value = current + 1;
    label.textContent = `Section ${current + 1} of ${lessons.length}`;
    pending = false;
  }
  window.addEventListener('scroll', () => {
    if (!pending) { pending = true; window.requestAnimationFrame(update); }
  }, { passive: true });
  window.addEventListener('resize', update);
  window.addEventListener('hashchange', update);
  update();
})();
