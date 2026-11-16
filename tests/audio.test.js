const assert = require('node:assert/strict');
const { test } = require('node:test');
const { EventEmitter } = require('node:events');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const vm = require('node:vm');

const source = (file) => readFileSync(path.join(__dirname, '../src', file), 'utf8');
const requireAudio = createRequire(path.join(__dirname, '../src/system-audio.js'));
const idle = () => new Promise((resolve) => setImmediate(resolve));
const audible = { numberOfChannels: 1, getChannelData: () => new Float32Array(16).fill(0.2) };

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { resolve, promise };
}

function rendererAudio(overrides = {}) {
  const sent = [];
  const lines = [];
  const recorders = [];
  const track = { readyState: 'live', stop() { this.readyState = 'ended'; }, addEventListener() {} };
  const stream = { getAudioTracks: () => [track], getTracks: () => [track] };
  let systemClip;
  class Recorder {
    static isTypeSupported() { return true; }
    constructor(_stream, options) {
      this.mimeType = options.mimeType;
      this.state = 'inactive';
      recorders.push(this);
    }
    start() { this.state = 'recording'; }
    stop() {
      this.state = 'inactive';
      this.ondataavailable({ data: new Blob([new Uint8Array(1024)]) });
      this.onstop();
    }
  }
  const bridge = {
    audioReady: async () => ({ micAllowed: true }), startSystemAudio: async () => {},
    stopSystemAudio: async () => {}, stopAudio: async () => {},
    onSystemClip: (fn) => { systemClip = fn; }, onSystemEnded() {}, onAudioRouteChanged() {},
    sendAudio(_bytes, mime) {
      sent.push(mime);
      return overrides.sendAudio?.() ?? Promise.resolve({ text: 'Fixture transcript.' });
    },
    ...overrides.bridge
  };
  const window = { anotch: bridge, MediaRecorder: Recorder };
  vm.runInNewContext(source('renderer/audio.js'), {
    window, Blob, setTimeout, clearTimeout,
    MediaRecorder: Recorder, MediaStream: class {},
    AudioContext: class {
      decodeAudioData() { return overrides.decode?.() ?? Promise.resolve(audible); }
      close() { return Promise.resolve(); }
    },
    navigator: { mediaDevices: { getUserMedia: async () => stream } }
  });
  return { feed: window.anotchAudio, sent, lines, recorders, clip: () => systemClip(new ArrayBuffer(2048)),
    events: { recording() {}, stopping() {}, stopped() {}, line: (line) => lines.push(line), error: assert.fail } };
}

test('discarding mic audio prevents an upload when decoding completes late', async () => {
  const decoding = deferred();
  const decoded = deferred();
  const stopped = deferred();
  const fixture = rendererAudio({
    decode: () => { decoding.resolve(); return decoded.promise; },
    bridge: { stopAudio: () => stopped.promise, stopSystemAudio: () => stopped.promise }
  });
  await fixture.feed.start('mic', fixture.events);
  fixture.recorders[0].stop();
  await decoding.promise;
  const stopping = fixture.feed.stop(false);
  decoded.resolve(audible);
  await idle();
  assert.deepEqual(fixture.sent, []);
  stopped.resolve();
  await stopping;
});

test('discarding Mac audio drops its queue and ignores an outstanding transcript', async () => {
  const reply = deferred();
  const stopped = deferred();
  const fixture = rendererAudio({
    sendAudio: () => reply.promise,
    bridge: { stopAudio: () => stopped.promise, stopSystemAudio: () => stopped.promise }
  });
  await fixture.feed.start('system', fixture.events);
  fixture.clip();
  fixture.clip();
  const stopping = fixture.feed.stop(false);
  reply.resolve({ text: 'Discarded clip.' });
  await idle();
  assert.deepEqual(fixture.sent, ['audio/wav']);
  assert.deepEqual(fixture.lines, []);
  stopped.resolve();
  await stopping;
});

test('intentional Stop still transcribes the pending clips from both audio sources', async () => {
  const fixture = rendererAudio();
  await fixture.feed.start('both', fixture.events);
  fixture.clip();
  await fixture.feed.stop(true);
  assert.deepEqual(fixture.sent.sort(), ['audio/wav', 'audio/webm;codecs=opus']);
  assert.deepEqual(fixture.lines.map(({ source }) => source).sort(), ['Mac audio', 'Mic']);
});

test('final Mac audio clip contains whole 16-bit samples even if the pipe read ends on an odd byte', async () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = new EventEmitter();
  child.stdin.end = () => {};
  const module = { exports: {} };
  vm.runInNewContext(source('system-audio.js'), {
    module, Buffer, ArrayBuffer, process, setTimeout, clearTimeout,
    require: (name) => name === 'electron' ? { systemPreferences: { getMediaAccessStatus: () => 'granted' } }
      : name === 'node:child_process' ? { spawn: () => child } : requireAudio(name)
  });
  const clips = [];
  const capture = module.exports.createSystemAudio({ getAppPath: () => '/fixture' }, (_event, audio) => clips.push(Buffer.from(audio)));
  const ready = capture.start();
  child.stderr.emit('data', Buffer.from('ready\n'));
  await ready;
  child.stdout.emit('data', Buffer.alloc(14_401, 0x30));
  capture.stop(true);
  child.emit('close', 0);
  assert.equal(clips.length, 1);
  assert.equal(clips[0].readUInt16LE(32), 2);
  assert.equal(clips[0].readUInt32LE(40), 14_400);
  assert.equal(clips[0].length, 44 + 14_400);
});

test('changing transcription settings stops listening before another clip can use the new endpoint', async () => {
  const module = { exports: {} };
  const routes = [];
  const active = deferred();
  let replySignal;
  vm.runInNewContext(source('system-audio.js'), {
    module, process, AbortController,
    require: (name) => {
      if (name === 'electron') return { systemPreferences: {} };
      if (name === './provider') return { transcribe(settings, _data, _mime, signal) {
        routes.push(settings.transcribeBaseUrl);
        if (routes.length > 1) return 'New clip';
        replySignal = signal;
        return active.promise;
      } };
      return requireAudio(name);
    }
  });
  const callbacks = new Map();
  const notifications = [];
  let settings = { transcribeBaseUrl: 'http://localhost:4200', transcribeModel: 'fixture' };
  const audio = module.exports.wireAudio({
    app: { getAppPath: () => '/fixture' }, getSettings: () => settings,
    handler: (event, fn) => callbacks.set(event, fn), send: (event) => notifications.push(event), microphone: async () => true
  });
  await callbacks.get('audio:ready')('mic');
  const sendClip = () => callbacks.get('audio:send')(new ArrayBuffer(8), 'audio/webm');
  const first = sendClip();
  settings = { ...settings, transcribeBaseUrl: 'http://localhost:4300' };
  audio.applySettings(settings);
  assert.equal(replySignal.aborted, true);
  assert.deepEqual(notifications, ['audio:routing-changed']);
  await assert.rejects(sendClip(), /start listening/i);
  active.resolve('Discarded clip');
  await assert.rejects(first, { name: 'AbortError' });
  await callbacks.get('audio:ready')('mic');
  assert.equal((await sendClip()).text, 'New clip');
  assert.deepEqual(routes, ['http://localhost:4200', 'http://localhost:4300']);
  audio.stop();
});
