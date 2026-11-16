(() => {
  const api = window.anotch;
  const root = document.documentElement;
  const surface = document.getElementById('notchSurface');
  const band = document.getElementById('notchBand');
  const panel = document.getElementById('panel');
  const peek = document.getElementById('notchPeek');
  const status = document.getElementById('notchStatusText');
  const preview = document.getElementById('notchPreviewText');
  const sizeButton = document.getElementById('workspaceSize');
  const composer = document.querySelector('.composer');
  let current;
  let frameRequest;
  let outlineMotion;
  let controlMotions = [];

  function stopPaint() {
    cancelAnimationFrame(frameRequest);
    frameRequest = undefined;
    outlineMotion?.cancel();
    outlineMotion = undefined;
    controlMotions.forEach(animation => animation.cancel());
    controlMotions = [];
  }

  function finishPaint() {
    stopPaint();
    root.removeAttribute('data-notch-moving');
    if (current.mode !== 'compact' && current.mode !== 'workspace') panel.hidden = true;
    if (current.mode !== 'peek') peek.hidden = true;
  }

  function followPaint(motion, renderedAt) {
    // Confirm the previous frame before the native window accepts clicks in newly revealed areas.
    frameRequest = requestAnimationFrame(() => {
      api.notchPainted(motion.id, renderedAt);
      if (renderedAt < motion.started + motion.duration) followPaint(motion, Date.now());
      else finishPaint();
    });
  }

  function paint(previousButton) {
    const { canvasWidth, motion } = current;
    const outline = notchOutline(motion?.to || current, canvasWidth);
    surface.style.clipPath = outline;
    if (!motion) { finishPaint(); return; }
    const startTime = performance.now() - (Date.now() - motion.started);
    const timing = { duration: motion.duration, easing: NOTCH_EASING, fill: 'backwards' };
    outlineMotion = surface.animate([{ clipPath: notchOutline(motion.from, canvasWidth) }, { clipPath: outline }], timing);
    outlineMotion.startTime = startTime;
    if (previousButton) {
      // The resize button tracks the moving edge while the composer fits its new layout.
      const nextButton = sizeButton.getBoundingClientRect();
      const x = previousButton.left - nextButton.left, y = previousButton.top - nextButton.top;
      controlMotions = [
        sizeButton.animate([{ transform: `translate3d(${x}px, ${y}px, 0)` }, { transform: 'none' }], timing),
        composer.animate([{ opacity: 0.64 }, { opacity: 1 }], { ...timing, duration: 115 })
      ];
      controlMotions.forEach(animation => { animation.startTime = startTime; });
    }
    followPaint(motion, Date.now());
  }

  function present(state) {
    if (!state) return;
    const expanded = state.mode === 'compact' || state.mode === 'workspace';
    const modeChanged = state.mode !== current?.mode || state.docked !== current?.docked;
    const target = state.motion?.to || state;
    const previousTarget = current?.motion?.to || current;
    const layoutChanged = modeChanged || target.width !== previousTarget?.width || target.height !== previousTarget?.height ||
      state.notchHeight !== current?.notchHeight || state.cameraWidth !== current?.cameraWidth || state.bandWidth !== current?.bandWidth;
    const shapeChanged = layoutChanged || state.canvasWidth !== current?.canvasWidth ||
      state.motion?.id !== current?.motion?.id;
    const resize = modeChanged && expanded && state.motion && current?.docked &&
      (current.mode === 'compact' || current.mode === 'workspace');
    const previousButton = resize ? sizeButton.getBoundingClientRect() : undefined;
    if (shapeChanged) stopPaint();
    root.toggleAttribute('data-docked', state.docked);
    root.toggleAttribute('data-native-glass', state.nativeGlass);
    root.dataset.notchMode = state.mode;
    band.hidden = !state.docked;
    if (state.docked) {
      const { bandWidth, cameraWidth, notchHeight } = state;
      if (layoutChanged) {
        root.style.setProperty('--notch-band-height', `${notchHeight}px`);
        root.style.setProperty('--notch-band-width', `${bandWidth}px`);
        root.style.setProperty('--notch-camera-width', `${cameraWidth}px`);
        if (expanded) {
          root.style.setProperty('--notch-panel-width', `${target.width}px`);
          root.style.setProperty('--notch-panel-height', `${target.height - notchHeight}px`);
        }
        if (state.mode === 'peek') {
          root.style.setProperty('--notch-peek-width', `${target.width}px`);
          root.style.setProperty('--notch-peek-height', `${target.height - notchHeight}px`);
        }
      }
      root.dataset.notchStatus = state.status;
      if (status.textContent !== state.status) status.textContent = state.status;
      if (state.mode === 'peek') {
        if (preview.textContent !== state.preview) preview.textContent = state.preview;
        peek.toggleAttribute('data-has-answer', Boolean(state.preview));
        peek.toggleAttribute('data-choice-answer', isChoiceAnswer(state.preview));
        peek.setAttribute('aria-label', state.preview ? 'Open answer' : 'Open Anotch');
      }
      panel.hidden = !expanded && (!state.motion || panel.hidden);
      panel.inert = !expanded;
      peek.hidden = state.mode !== 'peek' && (!state.motion || peek.hidden);
      peek.inert = state.mode !== 'peek';
      if (modeChanged && !expanded) document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close());
      if (modeChanged || state.pinned !== current?.pinned) {
        band.setAttribute('aria-expanded', String(state.mode !== 'closed'));
        band.setAttribute('aria-label', expanded ? (state.pinned ? 'Collapse Anotch' : 'Pin Anotch open') : 'Open Anotch');
      }
    } else {
      panel.hidden = false;
      panel.inert = false;
      peek.hidden = true;
    }
    current = state;
    if (shapeChanged) {
      if (state.docked) {
        root.toggleAttribute('data-notch-moving', Boolean(state.motion));
        paint(previousButton);
      } else {
        surface.style.clipPath = '';
        root.removeAttribute('data-notch-moving');
      }
    }
    root.setAttribute('data-notch-ready', '');
  }

  function toggle() { void api.toggleNotch().catch(() => {}); }

  band.addEventListener('click', toggle);
  peek.addEventListener('click', toggle);
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing || !current?.docked || current.mode === 'closed') return;
    if (document.querySelector('dialog[open]')) return;
    event.preventDefault();
    void api.minimize().catch(() => {});
  });

  api.onNotchState(present);
  matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', ({ matches }) => {
    void api.workspaceReady(matches).catch(() => {});
  });
  void api.getNotchState().then((state) => { if (!current) present(state); }).catch(() => { root.setAttribute('data-notch-ready', ''); });
})();
