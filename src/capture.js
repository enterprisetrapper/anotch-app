const { systemPreferences, shell, nativeImage } = require('electron');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');

const SETTINGS_LINKS = {
  screen: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  microphone: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone'
};

function permissions() {
  return {
    screen: systemPreferences.getMediaAccessStatus('screen'),
    microphone: systemPreferences.getMediaAccessStatus('microphone')
  };
}

async function microphone() {
  const status = permissions().microphone;
  return status === 'granted' || (status === 'not-determined' && await systemPreferences.askForMediaAccess('microphone'));
}

async function openPrivacy(kind) {
  if (!Object.hasOwn(SETTINGS_LINKS, kind)) throw new Error('Unknown permission.');
  await shell.openExternal(SETTINGS_LINKS[kind]);
}

const SCREEN_PERMISSION = 'macOS hasn’t granted screen capture to Anotch. In Screen & System Audio Recording, turn Anotch on. If it’s already on, turn it off and back on. Then quit and reopen Anotch.';

function helperPath(app, name) {
  return app.isPackaged ? path.join(process.resourcesPath, name) : path.join(app.getAppPath(), '.build', name);
}

function screenCommand(app, args, signal) {
  const executable = helperPath(app, 'anotch-screen');
  return new Promise((resolve, reject) => {
    execFile(executable, args, { signal, encoding: 'buffer', timeout: 12_000, maxBuffer: 3_000_000, killSignal: 'SIGKILL' }, (error, stdout, stderr) => {
      if (signal?.aborted) return reject(signal.reason);
      if (!error) return resolve(stdout);
      const reason = stderr?.toString().trim();
      const message = reason === 'permission' ? SCREEN_PERMISSION : reason === 'stale'
        ? 'That display or window is no longer available. Refresh the list and choose it again.'
        : reason === 'sourceHidden' ? 'Bring the selected window into view to resume.'
        : reason === 'displayAsleep' ? 'Wake and unlock your Mac display, then refresh the list.'
        : reason === 'displayLocked' ? 'Unlock your Mac to capture the whole display. You can still choose a window.'
        : reason === 'watchLocked' ? 'Screen watch stopped when your Mac locked.'
        : reason === 'encoding' ? 'This screenshot is too large to attach. Choose a smaller window.'
          : 'macOS couldn’t capture the selected source. Try again or pick another window.';
      const failure = new Error(message);
      if (reason === 'permission') failure.code = 'SCREEN_PERMISSION';
      failure.retryCapture = Boolean(signal && (error.killed || ['sourceHidden', 'displayAsleep', 'unavailable'].includes(reason)));
      reject(failure);
    });
  });
}

async function listScreens(app) {
  try { return JSON.parse((await screenCommand(app, ['list', String(process.pid)])).toString()); }
  catch (error) {
    if (error.code !== 'SCREEN_PERMISSION' || permissions().screen === 'restricted') throw error;
    const allowed = await screenCommand(app, ['permission']).catch(() => Buffer.from('false'));
    if (allowed.toString() !== 'true') throw error;
    return JSON.parse((await screenCommand(app, ['list', String(process.pid)])).toString());
  }
}

function ocr(jpeg, helper, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(helper, [], { signal, killSignal: 'SIGKILL', stdio: ['pipe', 'pipe', 'ignore'] });
    let text = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 7000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (piece) => {
      text += piece;
      if (text.length > 30_000) child.kill('SIGKILL');
    });
    child.stdin.on('error', () => {});
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(text.trim());
      else reject(new Error('Text recognition did not finish.'));
    });
    child.stdin.end(jpeg);
  });
}

async function captureFrame(id, withOcr, app, signal, notchOwner) {
  if (typeof id !== 'string' || !/^(screen|window):\d+:\d+$/.test(id)) throw new Error('Pick a screen or window first.');
  const [type, source, owner] = id.split(':');
  const args = [signal ? 'watch' : 'capture', String(process.pid), type, source, owner];
  if (notchOwner) args.push(String(notchOwner));
  const jpeg = await screenCommand(app, args, signal);
  signal?.throwIfAborted();
  if (jpeg.length < 100) {
    const message = signal ? 'Waiting for a readable picture from the selected source.' : 'macOS returned an empty screenshot. Choose a different window.';
    throw Object.assign(new Error(message), { retryCapture: Boolean(signal) });
  }
  let text = '';
  let ocrFailed = false;
  if (withOcr) {
    try { text = await ocr(jpeg, helperPath(app, 'anotch-ocr'), signal); }
    catch { ocrFailed = true; }
  }
  const frame = { url: 'data:image/jpeg;base64,' + jpeg.toString('base64'), text, ocrFailed };
  if (signal) {
    signal.throwIfAborted();
    frame.thumbnail = nativeImage.createFromBuffer(jpeg).resize({ width: 48, height: 32 }).getBitmap();
  }
  return frame;
}

module.exports = { permissions, microphone, openPrivacy, listScreens, captureFrame, ocr };
