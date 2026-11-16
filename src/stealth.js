const path = require('node:path');
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const { plainAnswer } = require('./shared');

function createStealth(app, onFailure, dockAtNotch) {
  const executable = app.isPackaged
    ? path.join(process.resourcesPath, 'anotch-stealth')
    : path.join(app.getAppPath(), '.build', 'anotch-stealth');
  let current;
  let latest = { body: '', phase: 'idle' };
  let timer;

  function write(child) {
    if (!child.stdin.destroyed) child.stdin.write(JSON.stringify(latest) + '\n');
  }

  function flush() {
    if (!current || timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (current?.ready) write(current.child);
    }, 90);
  }

  function update(body, phase, displayID = latest.displayID) {
    latest = { ...latest, body: plainAnswer(body.slice(0, 8000)), phase, displayID };
    flush();
  }

  function setWatching(watching, watchPhase) {
    if (latest.watching === watching && latest.watchPhase === watchPhase) return;
    latest.watching = watching;
    latest.watchPhase = watchPhase;
    flush();
  }

  async function show() {
    if (current) return;
    await new Promise((resolve, reject) => {
      const child = spawn(executable, dockAtNotch() ? ['--notch'] : [], { stdio: ['pipe', 'pipe', 'ignore'] });
      const session = { child, ready: false, close: null };
      current = session;
      const lines = createInterface({ input: child.stdout });
      const deadline = setTimeout(() => finish(new Error('The protected answer panel couldn’t start.')), 6000);
      function finish(error) {
        clearTimeout(deadline);
        lines.close();
        if (current !== session) return;
        current = undefined;
        clearTimeout(timer);
        timer = undefined;
        child.kill();
        if (session.ready) onFailure();
        else reject(error);
      }
      session.close = () => {
        clearTimeout(deadline);
        lines.close();
        child.stdin.end();
        child.kill();
        if (!session.ready) reject(new Error('Stealth was stopped.'));
      };
      lines.on('line', (line) => {
        if (current !== session || line !== 'ready' || session.ready) return;
        clearTimeout(deadline);
        session.ready = true;
        write(child);
        resolve();
      });
      child.stdin.on('error', () => finish(new Error('The protected answer panel closed.')));
      child.once('error', () => finish(new Error('The protected answer panel couldn’t start.')));
      child.once('exit', () => finish(new Error('The protected answer panel closed.')));
      write(child);
    });
  }

  function hide() {
    if (!current) return;
    const session = current;
    current = undefined;
    clearTimeout(timer);
    timer = undefined;
    session.close();
  }

  return { show, hide, update, setWatching };
}

module.exports = { createStealth };
