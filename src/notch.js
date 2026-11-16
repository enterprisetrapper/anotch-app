const path = require('node:path');
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const { answerPresentation, plainAnswer, NOTCH_SHOULDER, NOTCH_EASE, notchShape, notchFrame, notchContainsPoint } = require('./shared');

const COMPACT = { width: 414, height: 434 };
const DOCKED_COMPACT = { width: 392, height: 368 };
const WORKSPACE = { width: 590, height: 657 };
const PEEK_BODY = 64;
const ANSWER_PEEK_BODY = 110;
const SHOULDERS = NOTCH_SHOULDER * 2;
const HOVER_DELAY = 84;
const DISMISS_DELAY = 138;
const DURATION = { closed: 170, peek: 145, compact: 188, workspace: 210 };
const POINTER_MOVEMENT = new Set(['mouseMove', 'mouseEnter', 'mouseLeave']);

function createNotch({ app, screen, publish }) {
  const executable = app.isPackaged ? path.join(process.resourcesPath, 'anotch-notch')
    : path.join(app.getAppPath(), '.build', 'anotch-notch');
  const logoPath = app.isPackaged ? path.join(process.resourcesPath, 'anotch-logo.png')
    : path.join(app.getAppPath(), 'src', 'renderer', 'logo.png');
  const glassPath = app.isPackaged ? path.join(process.resourcesPath, 'anotch-glass.node')
    : path.join(app.getAppPath(), '.build', 'anotch-glass.node');
  let drawGlass;
  try { drawGlass = require(glassPath); } catch {}
  let nativeGlass = false;
  let reportLayout;
  const firstLayout = new Promise(resolve => { reportLayout = resolve; });
  let child, layout, stage, panel, floatingBounds;
  let enabled = false;
  let floating = true;
  let starting = true;
  let concealed = false;
  let paused = false;
  let reduceMotion = false;
  let passThrough = false;
  let mode = 'compact';
  let pinned = false;
  let frame = notchShape(COMPACT.width, COMPACT.height);
  let paintedFrame = frame;
  let motion, timer, timerDeadline, hoveredAt, leftAt;
  let motionId = 0;
  let holdClosed = false;
  let recording = false;
  let watching = false;
  let watchPhase;
  let answerReady = false;
  let preview = '';

  function status() {
    if (answerReady) return 'Answer';
    if (recording && watching) return 'Live';
    if (recording) return 'Listening';
    if (watching && watchPhase === 'waiting') return 'Waiting';
    if (watching && watchPhase === 'answering') return 'Thinking';
    return watching ? 'Watching' : 'Ready';
  }

  function snapshot() {
    return {
      docked: Boolean(stage), mode, pinned, ...(motion ? notchFrame(motion, Date.now()) : frame), motion,
      nativeGlass: Boolean(stage && nativeGlass),
      canvasWidth: stage?.width || 0, bandWidth: stage ? targetSize('closed').width + SHOULDERS : 0,
      notchHeight: stage?.top || 0, cameraWidth: stage?.cameraWidth || 0,
      status: status(), preview: mode === 'peek' ? preview : ''
    };
  }

  function broadcast() { publish(snapshot()); }

  function syncGlass() {
    if (!drawGlass || !panel || panel.isDestroyed()) return;
    const band = stage?.top || 0;
    const { width, height, top, bottom } = frame;
    const from = motion?.from;
    nativeGlass = drawGlass(panel.getNativeWindowHandle(), band, NOTCH_SHOULDER,
      [width, stage && !concealed ? height : 0, top, bottom],
      from && [from.width, from.height, from.top, from.bottom],
      motion?.duration || 0, motion ? Math.max(0, Date.now() - motion.started) : 0, NOTCH_EASE);
  }

  function targetSize(nextMode) {
    if (!stage) {
      const { width, height } = nextMode === 'workspace' ? WORKSPACE : COMPACT;
      return notchShape(width, height);
    }
    const label = status();
    const wings = label === 'Ready' ? 68 : 2 * Math.max(37, label.length * 6 + 17);
    const closedWidth = stage.cameraWidth + wings;
    const width = nextMode === 'closed' ? closedWidth : nextMode === 'peek' ? Math.max(DOCKED_COMPACT.width, closedWidth)
      : nextMode === 'workspace' ? WORKSPACE.width : DOCKED_COMPACT.width;
    const peekBody = preview.length > 1 ? ANSWER_PEEK_BODY : PEEK_BODY;
    const body = nextMode === 'closed' ? 0 : nextMode === 'peek' ? peekBody
      : nextMode === 'workspace' ? WORKSPACE.height : DOCKED_COMPACT.height;
    return notchShape(Math.min(stage.width - SHOULDERS, width), Math.min(stage.height, body + stage.top));
  }

  function ignoreMouse(ignore) {
    if (!panel || panel.isDestroyed() || passThrough === ignore) return;
    passThrough = ignore;
    panel.setIgnoreMouseEvents(ignore, ignore ? { forward: true } : undefined);
  }

  function pointerInside(now) {
    const { x, y } = screen.getCursorScreenPoint();
    const outline = motion ? notchFrame(motion, now) : frame;
    const horizontal = x - stage.x - stage.width / 2;
    const vertical = y - stage.y;
    return notchContainsPoint(outline, horizontal, vertical) && notchContainsPoint(paintedFrame, horizontal, vertical);
  }

  function visibleDock() {
    return stage && !concealed && panel && !panel.isDestroyed() && panel.isVisible() && !panel.isMinimized();
  }

  function schedule() {
    if (paused || !visibleDock()) return;
    const now = Date.now();
    const deadline = Math.min(now + 32, hoveredAt === undefined ? Infinity : hoveredAt + HOVER_DELAY,
      leftAt === undefined ? Infinity : leftAt + DISMISS_DELAY);
    if (timer && timerDeadline <= deadline) return;
    clearTimeout(timer);
    timerDeadline = deadline;
    timer = setTimeout(tick, Math.max(1, deadline - now));
    timer.unref();
  }

  function tick() {
    timer = undefined;
    if (visibleDock() && !paused) samplePointer(Date.now());
  }

  function moving(now) { return motion && now < motion.started + motion.duration; }

  function samplePointer(now) {
    const inside = pointerInside(now);
    ignoreMouse(!inside);
    if (inside) {
      leftAt = undefined;
      if (mode === 'closed' && !holdClosed) {
        hoveredAt ??= now;
        if (now - hoveredAt >= HOVER_DELAY) changeMode('peek', false);
      }
    } else {
      hoveredAt = undefined;
      holdClosed = false;
      if (!pinned && mode !== 'closed') {
        leftAt ??= now;
        if (now - leftAt >= DISMISS_DELAY) changeMode('closed', false);
      }
    }
    schedule();
  }

  function stopTimer(settle = false) {
    clearTimeout(timer);
    const wasMoving = Boolean(motion);
    timer = motion = hoveredAt = leftAt = undefined;
    paintedFrame = frame;
    syncGlass();
    if (settle && wasMoving) broadcast();
  }

  function changeMode(next, lock, immediate = false) {
    if (!immediate && next === mode && lock === pinned) return;
    mode = next;
    pinned = lock;
    leftAt = hoveredAt = undefined;
    if (mode === 'compact' || mode === 'workspace') answerReady = false;
    resizeFrame(targetSize(next), immediate);
  }

  function resizeFrame(target, immediate = false) {
    const now = Date.now();
    const from = paintedFrame;
    frame = target;
    motion = stage && !immediate && !reduceMotion && (frame.width !== from.width || frame.height !== from.height)
      ? { id: ++motionId, from, to: frame, started: now, duration: DURATION[mode] } : undefined;
    if (!motion) paintedFrame = frame;
    syncGlass();
    broadcast();
    schedule();
  }

  function updateStatus() {
    const target = targetSize(mode);
    if (stage && (target.width !== frame.width || target.height !== frame.height)) resizeFrame(target);
    else broadcast();
  }

  function place() {
    if (!panel || panel.isDestroyed()) return;
    const display = layout && screen.getAllDisplays().find(value => value.id === layout.displayID);
    if (!enabled || !display) {
      stopTimer();
      if (stage) {
        stage = undefined;
        ignoreMouse(false);
        panel.setMovable(true);
        panel.setResizable(true);
        panel.setVisibleOnAllWorkspaces(false, { skipTransformProcessType: true });
        panel.setMinimumSize(382, 392);
        restoreFloatingBounds();
        changeMode('compact', true, true);
      }
      panel.setAlwaysOnTop(floating, 'floating');
      return;
    }
    const bounds = display.bounds;
    const width = Math.min(bounds.width, WORKSPACE.width + SHOULDERS);
    const height = Math.min(bounds.height, WORKSPACE.height + layout.top);
    const x = Math.round(bounds.x + Math.max(width / 2, Math.min(layout.center, bounds.width - width / 2)) - width / 2);
    const prior = stage;
    const next = { x, y: bounds.y, width, height, top: layout.top, cameraWidth: layout.cameraWidth };
    if (prior && Object.keys(next).every(key => next[key] === prior[key])) return;
    if (!prior) floatingBounds = panel.getBounds();
    stage = next;
    panel.setMinimumSize(1, 1);
    panel.setMovable(false);
    panel.setResizable(false);
    panel.setAlwaysOnTop(true, 'status');
    panel.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
    panel.setBounds({ x, y: stage.y, width, height });
    ignoreMouse(true);
    const folded = starting || concealed || paused;
    changeMode(folded ? 'closed' : mode, !folded && pinned, true);
  }

  function restoreFloatingBounds() {
    if (!floatingBounds) { panel.setSize(COMPACT.width, COMPACT.height); return; }
    const area = screen.getDisplayMatching(floatingBounds).workArea;
    const width = Math.min(floatingBounds.width, area.width);
    const height = Math.min(floatingBounds.height, area.height);
    const x = Math.max(area.x, Math.min(floatingBounds.x, area.x + area.width - width));
    const y = Math.max(area.y, Math.min(floatingBounds.y, area.y + area.height - height));
    panel.setBounds({ x, y, width, height });
  }

  function stopLayout() {
    const process = child;
    child = undefined;
    layout = undefined;
    process?.kill();
    reportLayout();
  }

  function startLayout() {
    if (child) return;
    const process = spawn(executable, [], { stdio: ['pipe', 'pipe', 'ignore'] });
    child = process;
    const lines = createInterface({ input: process.stdout });
    function failed() {
      lines.close();
      if (child !== process) return;
      stopLayout();
      place();
    }
    lines.on('line', (line) => {
      if (child !== process) return;
      let next;
      try { next = JSON.parse(line); } catch { return; }
      if (next?.displayID === null) layout = undefined;
      else if (Number.isInteger(next?.displayID) && Number.isFinite(next.center) && Number.isFinite(next.top) && Number.isFinite(next.cameraWidth) &&
        next.top > 0 && next.top < 100 && next.cameraWidth > 0 && next.cameraWidth < 400) layout = next;
      else return;
      place();
      reportLayout();
    });
    process.once('error', failed);
    process.once('exit', failed);
    process.stdin.on('error', failed);
  }

  function orderWithoutAnimation(action) {
    if (nativeGlass) { action(); return; }
    // Keep the notch flush on builds without the native window animation setting.
    panel.setOpacity(0);
    action();
    panel.setOpacity(1);
  }

  function collapse() {
    if (!stage || concealed) return;
    holdClosed = true;
    changeMode('closed', false);
    orderWithoutAnimation(() => panel.blur());
  }

  function clearAnswer() {
    preview = '';
    answerReady = false;
    updateStatus();
  }

  function show(inactive = false) {
    const orderIn = () => inactive ? panel.showInactive() : panel.show();
    if (stage && !panel.isVisible()) orderWithoutAnimation(orderIn);
    else orderIn();
  }

  return {
    logoPath, snapshot, collapse, clearAnswer, show,
    configure(dock, float) {
      enabled = dock;
      floating = float;
      if (enabled) startLayout();
      else stopLayout();
      place();
    },
    bind(window) {
      panel = window;
      concealed = false;
      passThrough = false;
      mode = 'compact';
      pinned = !starting;
      paintedFrame = frame = notchShape(COMPACT.width, COMPACT.height);
      window.webContents.on('before-mouse-event', (_event, { type }) => {
        if (window === panel && !paused && POINTER_MOVEMENT.has(type) && visibleDock()) samplePointer(Date.now());
      });
      window.on('show', schedule);
      window.on('restore', schedule);
      window.on('hide', () => stopTimer(true));
      window.on('minimize', () => stopTimer(true));
      window.once('closed', () => {
        stopTimer();
        panel = stage = floatingBounds = undefined;
        recording = watching = answerReady = false;
        preview = '';
      });
      place();
    },
    async openOnLaunch(window, open) {
      if (enabled && !layout) await Promise.race([firstLayout, new Promise(resolve => setTimeout(resolve, 900).unref())]);
      starting = false;
      if (window !== panel || window.isDestroyed() || concealed || window.isVisible()) return;
      if (!stage) { open(); return; }
      changeMode('closed', false, true);
      show(true);
      schedule();
    },
    toggle() {
      if (!stage || concealed) return false;
      if (pinned && mode !== 'closed') { collapse(); return false; }
      changeMode('compact', true);
      return true;
    },
    toggleSize() {
      if (stage) { changeMode(mode === 'workspace' ? 'compact' : 'workspace', true); return; }
      const [width, height] = panel.getSize();
      const size = width > 515 && height > 530 ? COMPACT : WORKSPACE;
      panel.setSize(size.width, size.height);
    },
    reveal() {
      concealed = false;
      holdClosed = false;
      changeMode(mode === 'workspace' ? 'workspace' : 'compact', true);
    },
    conceal() {
      concealed = true;
      stopTimer();
      if (stage) ignoreMouse(true);
      preview = '';
      answerReady = false;
      changeMode('closed', false, true);
    },
    dispose() { stopTimer(); stopLayout(); },
    pause(value) {
      paused = value;
      if (paused) holdClosed = true;
      if (paused && stage) {
        stopTimer();
        ignoreMouse(true);
        changeMode('closed', false, true);
      }
      schedule();
    },
    setReducedMotion(value) {
      reduceMotion = value === true;
      if (reduceMotion && motion) { motion = undefined; paintedFrame = frame; syncGlass(); broadcast(); }
    },
    painted(id, drawnAt) {
      if (!motion || motion.id !== id || !Number.isFinite(drawnAt) || drawnAt < motion.started || drawnAt > Date.now()) return;
      paintedFrame = notchFrame(motion, drawnAt);
      if (!moving(drawnAt)) motion = undefined;
      if (!paused && visibleDock()) samplePointer(Date.now());
    },
    available: () => Boolean(stage),
    starting: () => starting,
    recording(value) { recording = value; updateStatus(); },
    watch(state) {
      watching = state.active;
      watchPhase = state.phase;
      if (!watching) answerReady = false;
      updateStatus();
    },
    answer(answer, { cached = false } = {}) {
      if (concealed || (cached && preview)) return;
      const { lead, detail } = answerPresentation(answer);
      const text = plainAnswer(lead || detail).replace(/\s+/g, ' ').trim();
      preview = Array.from(text).slice(0, 512).join('');
      if (!cached) answerReady = mode === 'closed' || mode === 'peek';
      updateStatus();
    }
  };
}

module.exports = { createNotch };
