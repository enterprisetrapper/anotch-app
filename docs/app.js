(() => {
  const all = (selector) => [...document.querySelectorAll(selector)];
  const state = { mode: 'closed', level: 'concise', listening: false, nav: false };
  const nextMode = { closed: 'peek', peek: 'open', open: 'closed' };
  let timers = [];
  let hoverOpenedAt = 0;

  function stopDemo() {
    timers.forEach(clearTimeout);
    timers = [];
  }

  function render() {
    all('[data-mode]').forEach((el) => { el.hidden = el.dataset.mode !== state.mode; });

    const status = state.mode === 'peek'
      ? { text: 'Answer', tone: '#A0EFC7', width: '328px', pulse: false }
      : state.listening
        ? { text: 'Listening', tone: '#FF8A80', width: '328px', pulse: true }
        : { text: '', tone: '#A0EFC7', width: '264px', pulse: false };
    all('[data-band]').forEach((band) => { band.style.width = status.width; });
    all('[data-status]').forEach((el) => {
      el.style.color = status.tone;
      el.querySelector('[data-status-text]').textContent = status.text;
      el.querySelector('[data-status-dot]').classList.toggle('an-pulse', status.pulse);
    });

    all('[data-level]').forEach((button) => {
      const attribute = button.getAttribute('role') === 'radio' ? 'aria-checked' : 'aria-pressed';
      button.setAttribute(attribute, String(button.dataset.level === state.level));
    });
    all('[data-detail="concise"]').forEach((el) => { el.hidden = state.level === 'direct'; });
    all('[data-detail="full"]').forEach((el) => { el.hidden = state.level !== 'full'; });
    all('[data-act="listen"]').forEach((button) => button.setAttribute('aria-pressed', String(state.listening)));

    document.querySelector('[data-nav-box]').classList.toggle('is-open', state.nav);
    document.querySelector('[data-nav-panel]').hidden = !state.nav;
    document.querySelector('[data-nav-toggle]').setAttribute('aria-expanded', String(state.nav));
  }

  function set(patch) {
    Object.assign(state, patch);
    render();
  }

  document.addEventListener('click', (event) => {
    const target = event.target.closest('[data-act], [data-level], [data-nav-toggle], [data-nav-close]');
    if (!target) {
      if (state.nav && !event.target.closest('[data-nav-box]')) set({ nav: false });
      return;
    }
    if (target.hasAttribute('data-nav-toggle')) {
      // Hovering the notch has just opened the menu: do not let the same click close it again.
      if (state.nav && Date.now() - hoverOpenedAt < 600) return;
      return set({ nav: !state.nav });
    }
    if (target.hasAttribute('data-nav-close')) return set({ nav: false });
    if (target.dataset.level) return set({ level: target.dataset.level });
    stopDemo();
    if (target.dataset.act === 'band') set({ mode: nextMode[state.mode] });
    if (target.dataset.act === 'open') set({ mode: 'open' });
    if (target.dataset.act === 'close') set({ mode: 'closed' });
    if (target.dataset.act === 'listen') set({ listening: !state.listening });
  });

  const navBox = document.querySelector('[data-nav-box]');
  document.querySelector('[data-nav-hover]').addEventListener('mouseenter', () => {
    if (state.nav) return;
    hoverOpenedAt = Date.now();
    set({ nav: true });
  });
  navBox.addEventListener('mouseleave', () => { if (state.nav) set({ nav: false }); });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && state.nav) {
      set({ nav: false });
      document.querySelector('[data-nav-toggle]').focus();
    }
  });

  render();

  // The hero demo plays once: listening, then the one-line peek, then the open panel.
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    set({ mode: 'open' });
  } else {
    timers = [
      setTimeout(() => set({ listening: true }), 1000),
      setTimeout(() => set({ mode: 'peek', listening: false }), 2800),
      setTimeout(() => set({ mode: 'open' }), 4800),
    ];
  }
})();
