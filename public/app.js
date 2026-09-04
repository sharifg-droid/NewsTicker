(() => {
  const root = document.documentElement;
  const button = document.querySelector('[data-theme-toggle]');
  const stored = localStorage.getItem('sgnews-theme');
  const initial = stored || 'dark';
  root.dataset.theme = initial;

  if (button) {
    button.textContent = initial === 'dark' ? 'Light mode' : 'Dark mode';
    button.addEventListener('click', () => {
      const next = root.dataset.theme === 'dark' ? 'light' : 'dark';
      root.dataset.theme = next;
      localStorage.setItem('sgnews-theme', next);
      button.textContent = next === 'dark' ? 'Light mode' : 'Dark mode';
    });
  }
})();
