const { spawn } = require('node:child_process');
const path = require('node:path');
const { systemPreferences } = require('electron');
const { parseBase, providerFor } = require('./configuration');
const { transcribe } = require('./provider');

const BYTES_PER_SECOND = 32_000;
const CLIP_SIZE = BYTES_PER_SECOND * 4;
const MIN_CLIP_SIZE = BYTES_PER_SECOND * 0.45;
const PERMISSION_MESSAGE = 'Allow Anotch in System Settings → Privacy & Security → Screen & System Audio Recording, then reopen Anotch.';

function wav(pcm) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16_000, 24);
  header.writeUInt32LE(BYTES_PER_SECOND, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  const data = Buffer.concat([header, pcm]);
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.length);
}

function meaningful(pcm) {
  let square = 0;
  const samples = pcm.length / 2;
  for (let offset = 0; offset + 1 < pcm.length; offset += 2) {
    const value = pcm.readInt16LE(offset) / 32768;
    square += value * value;
  }
  return Math.sqrt(square / samples) >= 0.003;
}

function createSystemAudio(app, emit) {
  const executable = app.isPackaged
    ? path.join(process.resourcesPath, 'anotch-system-audio')
    : path.join(app.getAppPath(), '.build', 'anotch-system-audio');
  let current;

  function flush(capture) {
    const bytes = capture.pending.length;
    const pcm = capture.pending.subarray(0, bytes - bytes % 2);
    capture.pending = Buffer.alloc(0);
    if (pcm.length >= MIN_CLIP_SIZE && meaningful(pcm)) emit('audio:system-clip', wav(pcm));
  }

  function stop(flushClip = false) {
    const capture = current;
    if (!capture) return;
    current = null;
    if (flushClip && capture.ready) flush(capture);
    capture.child.stdin.end();
    const timer = setTimeout(() => capture.child.kill('SIGKILL'), 1200);
    timer.unref();
    capture.child.once('close', () => clearTimeout(timer));
    capture.finish(new Error('Mac audio was stopped.'));
  }

  function start() {
    if (current) throw new Error('Mac audio recording is already active.');
    const status = systemPreferences.getMediaAccessStatus('screen');
    if (status === 'denied' || status === 'restricted') throw new Error(PERMISSION_MESSAGE);
    return new Promise((resolve, reject) => {
      const child = spawn(executable, [], { stdio: ['pipe', 'pipe', 'pipe'] });
      let diagnostics = '';
      let settled = false;
      const capture = {
        child, ready: false, pending: Buffer.alloc(0),
        finish(error) {
          clearTimeout(timer);
          if (settled) return;
          settled = true;
          if (error) reject(error);
          else resolve({ ok: true });
        }
      };
      current = capture;
      const timer = setTimeout(() => {
        if (current !== capture) return;
        capture.finish(new Error(PERMISSION_MESSAGE));
        stop();
      }, 15_000);
      child.stdin.on('error', () => {});
      child.stderr.on('data', (chunk) => {
        diagnostics = (diagnostics + chunk.toString()).slice(-1024);
        if (current === capture && !capture.ready && /(?:^|\n)ready\n/.test(diagnostics)) {
          capture.ready = true;
          capture.finish();
        }
      });
      child.stdout.on('data', (chunk) => {
        if (current !== capture) return;
        capture.pending = Buffer.concat([capture.pending, chunk]);
        while (capture.pending.length >= CLIP_SIZE) {
          const part = capture.pending.subarray(0, CLIP_SIZE);
          capture.pending = capture.pending.subarray(CLIP_SIZE);
          if (meaningful(part)) emit('audio:system-clip', wav(part));
        }
      });
      child.once('error', () => {
        if (current !== capture) return;
        current = null;
        capture.finish(new Error('The Mac audio component could not start. Reinstall Anotch.'));
      });
      child.once('close', () => {
        if (current !== capture) return;
        current = null;
        if (!capture.ready) capture.finish(new Error(PERMISSION_MESSAGE));
        else emit('audio:system-ended', 'Mac audio stopped in macOS.');
      });
    });
  }
  return { start, stop };
}

function wireAudio({ app, handler, send, getSettings, microphone }) {
  const system = createSystemAudio(app, send);
  let session;
  let request;

  function stop() {
    session = undefined;
    system.stop();
    request?.abort();
    request = undefined;
  }

  function applySettings(next) {
    if (!session) return;
    const route = providerFor(next, 'audio');
    if (['base', 'model', 'key'].some((field) => route[field] !== session.route[field])) {
      stop();
      send('audio:routing-changed');
    }
  }

  handler('audio:ready', async (mode) => {
    if (!['mic', 'system', 'both'].includes(mode)) throw new Error('Choose an audio source.');
    if (session) throw new Error('Audio recording is already active.');
    const settings = getSettings();
    const route = providerFor(settings, 'audio');
    if (!route.key && !parseBase(route.base).local) throw new Error('Add a transcription API key in Settings before listening.');
    const owner = session = { settings, route, mode };
    try {
      const micAllowed = mode === 'system' || await microphone();
      if (session !== owner) throw new Error('Listening stopped. Start listening again.');
      return { micAllowed };
    } catch (error) {
      if (session === owner) stop();
      throw error;
    }
  });
  handler('audio:send', async (data, mime) => {
    if (!session) throw new Error('Start listening before sending audio.');
    if (request) throw new Error('Wait for the current audio clip to finish.');
    const controller = request = new AbortController();
    try {
      const text = await transcribe(session.settings, data, mime, controller.signal);
      controller.signal.throwIfAborted();
      return { text };
    }
    finally { if (request === controller) request = undefined; }
  });
  handler('audio:system-start', () => {
    if (!session || session.mode === 'mic') throw new Error('Choose Mac audio before listening.');
    return system.start();
  });
  handler('audio:system-stop', (flush) => { system.stop(flush === true); });
  handler('audio:stop', stop);
  return { stop, applySettings };
}

module.exports = { createSystemAudio, wireAudio };
