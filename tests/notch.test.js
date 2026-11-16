const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { setTimeout: wait } = require('node:timers/promises');
const { test, mock } = require('node:test');
const childProcess = require('node:child_process');

let layoutProcess;
mock.method(childProcess, 'spawn', () => {
  const process = new EventEmitter();
  process.stdout = new PassThrough();
  process.stdin = new PassThrough();
  process.kill = () => { process.stdout.end(); process.stdin.end(); process.emit('exit'); };
  process.report = (value) => process.stdout.write(JSON.stringify(value) + '\n');
  layoutProcess = process;
  return process;
});
const { createNotch } = require('../src/notch');

class Window extends EventEmitter {
  webContents = new EventEmitter();
  bounds = { x: 600, y: 100, width: 414, height: 434 };
  positions = [];
  visible = false;
  ignoresMouse = false;
  opacity = 1;

  getBounds() { return this.bounds; }
  getSize() { return [this.bounds.width, this.bounds.height]; }
  setBounds(bounds) { this.bounds = bounds; this.positions.push(bounds); }
  setSize(width, height) { this.bounds = { ...this.bounds, width, height }; }
  setMovable(value) { this.movable = value; }
  setResizable(value) { this.resizable = value; }
  setMinimumSize() {}
  setVisibleOnAllWorkspaces() {}
  setAlwaysOnTop(value, level) { this.top = [value, level]; }
  setIgnoreMouseEvents(value) { this.ignoresMouse = value; }
  isDestroyed() { return false; }
  isMinimized() { return false; }
  isVisible() { return this.visible; }
  setOpacity(value) { this.opacity = value; }
  show() { this.openingOpacity = this.opacity; this.visible = true; this.emit('show'); }
  showInactive() { this.show(); }
  blur() { this.blurred = true; this.blurOpacity = this.opacity; }
}

async function until(predicate) {
  const deadline = Date.now() + 1800;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'Timed out waiting for notch state');
    await wait(25);
  }
}

async function start(t, { reduceMotion = false, locked = false, floatingX = 600 } = {}) {
  const window = new Window();
  window.bounds = { ...window.bounds, x: floatingX };
  const events = [];
  let point = locked ? { x: 860, y: 18 } : { x: 1500, y: 600 };
  const notch = createNotch({
    app: { isPackaged: false, getAppPath: () => '/app' },
    screen: {
      getAllDisplays: () => [{ id: 1, bounds: { x: 0, y: 0, width: 1728, height: 1117 } }],
      getDisplayMatching: () => ({ workArea: { x: 0, y: 32, width: 1728, height: 1085 } }),
      getCursorScreenPoint: () => point
    },
    publish: state => events.push(state)
  });
  t.after(() => notch.dispose());
  notch.configure(true, false);
  notch.setReducedMotion(reduceMotion);
  if (locked) notch.pause(true);
  notch.bind(window);
  layoutProcess.report({ displayID: 1, center: 864, top: 32, cameraWidth: 185 });
  await notch.openOnLaunch(window, () => assert.fail('The fallback opened on a notched display'));
  return { notch, window, events, move: (x, y) => { point = { x, y }; } };
}

test('the anchored canvas starts small, previews on hover, and passes clicks outside its shape', async (t) => {
  const { notch, window, events, move } = await start(t);
  assert.equal(window.bounds.y, 0);
  assert.equal(window.openingOpacity, 0);
  assert.equal(window.opacity, 1);
  assert.equal(notch.snapshot().height, 32);
  assert.equal(notch.snapshot().mode, 'closed');
  assert.equal(window.ignoresMouse, true);
  notch.answer('**B** is the best answer.');
  assert.equal(notch.snapshot().status, 'Answer');
  move(1029, 31);
  await wait(210);
  assert.equal(notch.snapshot().mode, 'closed');
  assert.equal(window.ignoresMouse, true);
  move(860, 18);
  await until(() => notch.snapshot().mode === 'peek' && notch.snapshot().height === 142);
  assert.equal(notch.snapshot().preview, 'B is the best answer.');
  const hover = events.filter(state => state.mode === 'peek');
  assert.equal(hover.length, 1);
  assert.equal(hover[0].motion.to.height, 142);
  assert.equal(hover[0].motion.to.width, 392);
  assert.equal(window.ignoresMouse, false);
  move(1150, 180);
  await until(() => window.ignoresMouse);
  await until(() => notch.snapshot().mode === 'closed' && notch.snapshot().height === 32);
  assert.equal(window.positions.length, 1);
});

test('a restored answer is available on hover without a new-answer indicator', async (t) => {
  const { notch, move } = await start(t, { reduceMotion: true });
  notch.answer('Saved answer\n\nMore detail', { cached: true });
  assert.equal(notch.snapshot().status, 'Ready');
  move(750, 15);
  await until(() => notch.snapshot().mode === 'peek');
  assert.equal(notch.snapshot().preview, 'Saved answer');
  assert.equal(notch.snapshot().status, 'Ready');
});

test('an open preview keeps single choices compact and makes room for longer answers', async (t) => {
  const { notch, move } = await start(t, { reduceMotion: true });
  move(750, 15);
  await until(() => notch.snapshot().mode === 'peek');
  assert.equal(notch.snapshot().height, 96);
  notch.answer('**B**');
  assert.equal(notch.snapshot().preview, 'B');
  assert.equal(notch.snapshot().height, 96);
  const answer = 'Make yourself more visible by wearing bright reflective clothing and using a light after dark, especially when crossing roads and walking near traffic in areas with limited street lighting.';
  notch.answer(answer);
  assert.equal(notch.snapshot().preview, answer);
  assert.equal(notch.snapshot().height, 142);
  notch.clearAnswer();
  assert.equal(notch.snapshot().height, 96);
  assert.equal(notch.snapshot().preview, '');
});

test('click pins the workspace and explicit collapse waits for the pointer to leave', async (t) => {
  const { notch, window, move } = await start(t, { reduceMotion: true });
  move(860, 18);
  await until(() => notch.snapshot().mode === 'peek');
  assert.equal(notch.snapshot().height, 96);
  assert.equal(notch.snapshot().preview, '');
  assert.equal(notch.snapshot().pinned, false);
  assert.equal(notch.toggle(), true);
  assert.equal(notch.snapshot().pinned, true);
  assert.equal(notch.snapshot().height, 400);
  move(1500, 600);
  await wait(360);
  assert.equal(notch.snapshot().mode, 'compact');
  notch.toggleSize();
  assert.equal(notch.snapshot().mode, 'workspace');
  assert.equal(notch.snapshot().height, 689);
  move(860, 18);
  assert.equal(notch.toggle(), false);
  await wait(360);
  assert.equal(notch.snapshot().mode, 'closed');
  assert.equal(window.blurred, true);
  assert.equal(window.blurOpacity, 0);
  assert.equal(window.opacity, 1);
  assert.equal(window.positions.length, 1);
});

test('mouse movement updates click-through before the next scheduled pointer check', async (t) => {
  const { notch, window, move } = await start(t, { reduceMotion: true });
  const sample = (x, y) => {
    move(x, y);
    window.webContents.emit('before-mouse-event', {}, { type: 'mouseMove' });
  };
  sample(750, 15);
  assert.equal(window.ignoresMouse, false);
  assert.equal(notch.snapshot().mode, 'closed');
  sample(750, 32);
  assert.equal(window.ignoresMouse, true);
  sample(750, 15);
  assert.equal(window.ignoresMouse, false);
  notch.pause(true);
  sample(750, 15);
  assert.equal(window.ignoresMouse, true);
});

test('concealing an animated notch cancels its frames and clears its hover answer', async (t) => {
  const { notch, window, events } = await start(t);
  notch.answer('Private example');
  notch.toggle();
  await until(() => notch.snapshot().height > 32);
  notch.conceal();
  window.setOpacity(0);
  notch.collapse();
  assert.equal(window.opacity, 0);
  assert.equal(notch.snapshot().mode, 'closed');
  assert.equal(notch.snapshot().preview, '');
  assert.equal(window.ignoresMouse, true);
  const before = events.length;
  await wait(440);
  assert.equal(events.length, before);
  assert.equal(notch.snapshot().height, 32);
});

test('losing the notched display restores a usable floating window and preference', async (t) => {
  const { notch, window } = await start(t, { reduceMotion: true, floatingX: 2500 });
  layoutProcess.report({ displayID: null });
  await until(() => !notch.snapshot().docked);
  assert.deepEqual(window.getSize(), [414, 434]);
  assert.equal(window.bounds.x, 1728 - 414);
  assert.deepEqual(window.top, [false, 'floating']);
  assert.equal(window.movable, true);
  assert.equal(window.isVisible(), true);
  assert.equal(window.ignoresMouse, false);
});

test('unlocking with the pointer already over the notch leaves it collapsed', async (t) => {
  const { notch, move } = await start(t, { reduceMotion: true, locked: true });
  notch.pause(false);
  await wait(245);
  assert.equal(notch.snapshot().mode, 'closed');
  move(1450, 450);
  await wait(65);
  move(860, 18);
  await until(() => notch.snapshot().mode === 'peek');
});

test('reversing a morph starts at the last rendered outline and Reduce Motion settles it', async (t) => {
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  const { notch } = await start(t);
  notch.toggle();
  now += 24;
  const opening = notch.snapshot();
  assert.ok(opening.height > 32 && opening.height < 400);
  notch.painted(opening.motion.id, now);
  now += 18;
  notch.collapse();
  const closing = notch.snapshot();
  assert.deepEqual(closing.motion.from, {
    width: opening.width, height: opening.height, top: opening.top, bottom: opening.bottom
  });
  assert.equal(closing.motion.to.height, 32);
  notch.setReducedMotion(true);
  assert.equal(notch.snapshot().motion, undefined);
  assert.equal(notch.snapshot().height, 32);
});

test('a late paint from a cancelled morph cannot shift the next morph', async (t) => {
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  const { notch } = await start(t);
  notch.toggle();
  const opening = notch.snapshot().motion;
  now += 42;
  notch.painted(opening.id, now);
  notch.collapse();
  const closing = notch.snapshot().motion;
  now += 23;
  notch.painted(opening.id, now);
  notch.toggle();
  assert.deepEqual(notch.snapshot().motion.from, closing.from);
});

test('the expanding fringe passes clicks through until the renderer draws it', async (t) => {
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  const { notch, window, move } = await start(t);
  notch.toggle();
  const { id } = notch.snapshot().motion;
  now += 17;
  move(864, 64);
  window.webContents.emit('before-mouse-event', {}, { type: 'mouseMove' });
  assert.ok(notch.snapshot().height > 64);
  assert.equal(window.ignoresMouse, true);
  notch.painted(id, now);
  assert.equal(window.ignoresMouse, false);
});

test('leaving during collapse allows the next hover to open a preview', async (t) => {
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  const { notch, window, move } = await start(t);
  const sample = (x, y) => {
    move(x, y);
    window.webContents.emit('before-mouse-event', {}, { type: 'mouseMove' });
  };
  notch.toggle();
  const open = notch.snapshot().motion;
  now += open.duration + 1;
  notch.painted(open.id, now);
  notch.collapse();
  now += 30;
  sample(1500, 600);
  now += 40;
  sample(750, 15);
  now += 110;
  sample(750, 15);
  assert.equal(notch.snapshot().mode, 'peek');
});
