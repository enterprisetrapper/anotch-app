const {
  app, BrowserWindow, Menu, session, safeStorage, ipcMain, protocol, globalShortcut, clipboard, dialog, screen, powerMonitor
} = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const { createStore } = require('./store');
const { DEFAULTS, mergeSettings, restoreSettings, publicSettings, answerEngine } = require('./configuration');
const { clean, cleanTurns, cleanFrames, streamAnswer, testProvider } = require('./provider');
const capture = require('./capture');
const { wireAudio } = require('./system-audio');
const { createAppleAnswer } = require('./apple-answer');
const { createStealth } = require('./stealth');
const { wireScreenWatch } = require('./screen-watch');
const { createNotch } = require('./notch');
const { setWorkspaceMenu } = require('./workspace-menu');
const { SCHEME, START_URL, setupRendererSession } = require('./renderer-session');
const { createSettingsWindow } = require('./settings-window');

const SESSION = 'anotch-workspace';
const ACTIONS = { 'toggle-window': 'Control+Shift+G', 'focus-question': 'Control+Shift+J' };
app.setName('Anotch');
protocol.registerSchemesAsPrivileged([{
  scheme: SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
}]);
let window;
const settingsWindow = createSettingsWindow();
let panelSession;
let panelReady = false;
let pendingAction;
let store;
let settings = { ...DEFAULTS };
let settingsNotice = '';
let chatController;
let pendingChat;
let audio;
let appleAnswer;
let stealth;
let screenWatch;
let notch;
let stealthActive = false;
let stealthVisible = false;
let stealthWanted = false;
let stealthRead;
let stealthTransition = 0;
let analyzeShortcutReady = false;
let stealthShortcutReady = false;
const STEALTH_RESULT = 'stealth-display';
let hideShortcutReady = false;
let closing = false;
let closedCleanly = false;
let shotCount = 0;
let profileQueue = Promise.resolve();
let workspaceRevision = 0;
function send(topic, data) {
  if (window && !window.isDestroyed()) window.webContents.send(topic, data);
}

function fromWorkspace(event) {
  return window && !window.isDestroyed() && event.sender === window.webContents && event.senderFrame?.url === START_URL;
}

function handler(topic, work) {
  ipcMain.handle(topic, async (event, ...args) => {
    if (event.senderFrame?.parent || (!fromWorkspace(event) && !settingsWindow.allows(topic, event))) {
      return { error: 'Anotch could not verify the request.' };
    }
    try { return await work(...args); }
    catch (error) {
      const code = error?.filtered ? 'ANSWER_FILTERED' : error?.code === 'SCREEN_PERMISSION' ? error.code : undefined;
      return { error: error?.message || 'Something went wrong.', code };
    }
  });
}

function dispatchAction(command) {
  if (command) pendingAction = command;
  if (!panelReady || !pendingAction) return;
  const action = pendingAction;
  pendingAction = undefined;
  send('action', action);
}

function focusPanel(command) {
  if (closing || !window || window.isDestroyed() || stealthActive) return;
  notch.reveal();
  if (window.isMinimized()) window.restore();
  if (window.isVisible()) window.focus();
  else notch.show();
  dispatchAction(command);
}

function showWorkspace(command) {
  if (closing || stealthActive) return;
  if (window) { focusPanel(command); return; }
  pendingAction = command;
  createWindow();
}

async function openSettings() {
  if (closing || stealthActive) return;
  notch.collapse();
  await settingsWindow.open(panelSession);
}

function hideWorkspace() {
  settingsWindow.close();
  notch.conceal();
  screenWatch.stop();
  if (stealthActive) {
    stealthTransition++;
    stealthWanted = stealthVisible = false;
    stealth.hide();
    if (chatController?.stealth) chatController.abort();
  } else window?.hide();
}

function togglePanel() {
  if (closing || !window || window.isDestroyed()) return;
  if (stealthActive) {
    if (stealthWanted) { hideWorkspace(); return; }
    stealthWanted = true;
    const transition = ++stealthTransition;
    stealth.show().then(() => {
      if (stealthTransition === transition && stealthActive && stealthWanted) stealthVisible = true;
    }).catch(() => { if (stealthTransition === transition && !stealthVisible) stealthWanted = false; });
    return;
  }
  if (window.isVisible() && !window.isMinimized()) hideWorkspace();
  else focusPanel();
}

async function setStealth(enable, initialAnswer = '') {
  if (enable === stealthActive) return { enabled: stealthActive };
  const panel = window;
  if (!panel || panel.isDestroyed()) return { enabled: false };
  if (enable && (!hideShortcutReady || !analyzeShortcutReady || !stealthShortcutReady)) {
    throw new Error('An Anotch shortcut is in use by another app. Free Control-Shift-G, J, or K and reopen Anotch.');
  }
  const transition = ++stealthTransition;
  stealthActive = enable;
  if (!enable) {
    stealth.hide();
    stealthVisible = stealthWanted = false;
    stealthRead = undefined;
    if (chatController?.stealth) chatController.abort();
    panel.setOpacity(1);
    focusPanel();
    return { enabled: false };
  }
  settingsWindow.close();
  notch.conceal();
  panel.setOpacity(0);
  panel.hide();
  stealthWanted = true;
  stealth.update(initialAnswer, 'idle', screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).id);
  try {
    await stealth.show();
    if (stealthTransition === transition && stealthWanted) stealthVisible = true;
  } catch (error) {
    if (stealthTransition !== transition || panel.isDestroyed() || !stealthWanted) return { enabled: stealthActive };
    screenWatch.stop('The protected answer panel couldn’t start.');
    stealthWanted = stealthVisible = false;
    throw error;
  }
  return { enabled: stealthActive };
}

async function askStealth() {
  if (closing || !stealthVisible || stealthRead) return;
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const transition = stealthTransition;
  const request = Symbol();
  stealthRead = request;
  try {
    await screenWatch.interrupt();
    if (closing || !stealthVisible || transition !== stealthTransition || chatController) return;
    stealth.update('', 'working', display.id);
    const frame = await screenFrame('screen:' + display.id + ':0');
    if (closing || !stealthVisible || transition !== stealthTransition || chatController) return;
    await runChat({
      id: STEALTH_RESULT,
      question: 'Answer the main question visible in this screenshot. If there is no visible question, briefly explain the content.',
      frames: [frame]
    });
  } catch (error) {
    if (stealthActive && transition === stealthTransition) stealth.update(error.message, 'error');
  } finally { if (stealthRead === request) stealthRead = undefined; }
}

async function screenFrame(id, signal) {
  if (shotCount >= 1) throw new Error('A capture is already running.');
  shotCount++;
  try { return await capture.captureFrame(id, settings.ocr || answerEngine(settings) === 'apple', app, signal); }
  finally { shotCount--; }
}

async function runChat(payload, watchSignal) {
  if (watchSignal?.aborted) return { cancelled: true };
  if (chatController) throw new Error('An answer is already in progress.');
  if (!payload || typeof payload.id !== 'string' || payload.id.length > 80) throw new Error('Invalid chat request.');
  const controller = new AbortController();
  const cancelWatch = () => controller.abort(watchSignal.reason);
  watchSignal?.addEventListener('abort', cancelWatch, { once: true });
  const inStealth = payload.id === STEALTH_RESULT;
  const transition = stealthTransition;
  controller.stealth = inStealth;
  chatController = controller;
  let partial = '';
  try {
    const engine = answerEngine(settings);
    if (engine === 'unconfigured') throw new Error('Connect an AI provider in Settings or choose Apple Intelligence.');
    const frames = cleanFrames(payload.frames);
    if (Array.isArray(payload.frames) && payload.frames.length && !frames.length) throw new Error('The screenshot could not be read. Capture it again.');
    if (watchSignal && engine === 'apple' && !frames[0]?.text && !(await appleAnswer.status()).vision) return { answer: '' };
    const stillStealth = () => !watchSignal && stealthActive && (!inStealth || transition === stealthTransition);
    function publish(text, replace) {
      if (watchSignal) return;
      partial = replace ? text : partial + text;
      if (stillStealth()) stealth.update(partial, 'working');
      send('chat:chunk', { id: payload.id, text, replace });
    }
    const answer = engine === 'apple'
      ? await appleAnswer.answer(settings, payload, frames, (text) => publish(text, true), controller.signal)
      : await streamAnswer(settings, payload, frames, publish, controller.signal, () => {
        if (!watchSignal) send('chat:chunk', { id: payload.id, retrying: true });
        if (stillStealth()) stealth.update('Trying a backup model…', 'working');
      });
    if (stillStealth()) stealth.update(answer, 'done');
    if (!watchSignal && !stealthActive) notch.answer(answer);
    if (inStealth && !controller.signal.aborted) send('stealth:answer', answer);
    return { answer };
  } catch (error) {
    if (controller.signal.aborted) return { cancelled: true };
    if (!watchSignal && stealthActive && !inStealth) stealth.update(error.message, 'error');
    throw error;
  } finally {
    watchSignal?.removeEventListener('abort', cancelWatch);
    if (chatController === controller) chatController = null;
  }
}

async function workspaceSettings() {
  const engine = answerEngine(settings);
  return { ...publicSettings(settings), engine, apple: await appleAnswer.status(), hideShortcutReady };
}
function cancelChat() {
  pendingChat?.abort();
  chatController?.abort();
}

function setupMenu() {
  setWorkspaceMenu(Menu, {
    open: showWorkspace, hide: hideWorkspace, startStealth: () => showWorkspace('stealth'), floating: settings.float,
    openSettings: () => void openSettings().catch((error) => send('action', { notice: error.message })),
    setFloating: (float) => void saveSettings({ float }).catch((error) => {
      setupMenu();
      send('action', { notice: error.message });
    })
  });
}

function mutateProfile(work) {
  const operation = profileQueue.then(work);
  profileQueue = operation.catch(() => {});
  return operation;
}

function saveSettings(patch) {
  return mutateProfile(async () => {
    if (settingsNotice) throw new Error(settingsNotice);
    const next = mergeSettings(settings, patch);
    const clearHistory = settings.keepHistory && !next.keepHistory;
    await store.write('preferences', next);
    if (['answerMode', 'baseUrl', 'apiKey', 'chatModel', 'backupBaseUrl', 'backupApiKey', 'backupModel', 'ocr']
      .some((field) => next[field] !== settings[field])) screenWatch.stop('Screen watch stopped after answer settings changed.');
    audio.applySettings(next);
    settings = next;
    settingsNotice = '';
    notch.configure(settings.dockAtNotch, settings.float);
    setupMenu();
    let notice = '';
    if (clearHistory) {
      try { await store.remove('workspace'); }
      catch { notice = 'History is off, but Anotch could not remove the old copy. Use Clear all local data to retry.'; }
    }
    const current = await workspaceSettings();
    send('action', { settings: current });
    return { settings: current, notice };
  });
}

function cleanTranscript(value) {
  return Array.isArray(value) ? value.slice(-200).flatMap((entry) => {
    if (!entry || !['Mic', 'Mac audio'].includes(entry.source)) return [];
    const text = clean(entry.text, 3500).trim();
    return text ? [{ source: entry.source, text }] : [];
  }) : [];
}

function wire() {
  handler('boot', () => mutateProfile(async () => {
    let workspace = { turns: [], transcript: [] };
    let notice = settingsNotice;
    if (settings.keepHistory) {
      try { workspace = await store.read('workspace', workspace); }
      catch (error) { notice ||= error.message; }
      const last = Array.isArray(workspace?.turns) && workspace.turns.findLast(turn => turn?.role === 'assistant');
      if (typeof last?.content === 'string') notch.answer(last.content, { cached: true });
    }
    return { settings: await workspaceSettings(), workspace, workspaceRevision, notice, permissions: capture.permissions() };
  }));
  handler('settings:save', saveSettings);
  handler('settings:open', openSettings);
  handler('settings:close', settingsWindow.close);
  handler('settings:models', (patch) => testProvider(mergeSettings(settings, patch)));
  handler('settings:status', workspaceSettings);
  handler('permission:status', capture.permissions);
  handler('permission:open', capture.openPrivacy);
  handler('screen:list', () => capture.listScreens(app));
  handler('screen:get', async (id) => { await screenWatch.interrupt(); return screenFrame(id); });
  handler('notch:recording', (recording) => notch.recording(recording === true));
  handler('notch:state', notch.snapshot);
  ipcMain.on('notch:painted', (event, id, drawnAt) => {
    if (fromWorkspace(event) && !event.senderFrame?.parent) notch.painted(id, drawnAt);
  });
  handler('notch:toggle', () => { if (notch.toggle()) focusPanel('focus-question'); });
  handler('notch:clear-answer', notch.clearAnswer);
  handler('chat:start', async (payload) => {
    if (pendingChat) throw new Error('An answer is already in progress.');
    const controller = pendingChat = new AbortController();
    try {
      await profileQueue;
      await screenWatch.interrupt();
      return controller.signal.aborted ? { cancelled: true } : runChat(payload);
    } finally { pendingChat = null; }
  });
  handler('chat:stop', cancelChat);
  handler('stealth:start', (answer) => setStealth(true, clean(answer, 8000)));
  handler('workspace:save', (data) => mutateProfile(async () => {
    if (data?.revision !== workspaceRevision) return { ok: false };
    const turns = cleanTurns(data?.turns);
    if (!settings.keepHistory || settingsNotice) return { ok: true };
    await store.write('workspace', { turns, transcript: cleanTranscript(data?.transcript) });
    return { ok: true };
  }));
  handler('workspace:wipe', () => mutateProfile(async () => {
    screenWatch.stop();
    audio.stop();
    cancelChat();
    await store.remove('workspace');
    await store.remove('preferences');
    workspaceRevision++;
    settings = { ...DEFAULTS };
    settingsNotice = '';
    notch.clearAnswer();
    notch.configure(settings.dockAtNotch, settings.float);
    setupMenu();
    const current = await workspaceSettings();
    send('action', { settings: current, reset: true, workspaceRevision });
    return { settings: current };
  }));
  handler('clipboard:copy', (text) => { clipboard.writeText(clean(text, 40_000)); });
  handler('window:minimize', () => notch.available() ? notch.collapse() : window.minimize());
  handler('window:size', () => notch.toggleSize());
  handler('window:ready', (reduceMotion) => { notch.setReducedMotion(reduceMotion); panelReady = true; dispatchAction(); });
  handler('window:hide', hideWorkspace);
  handler('window:close', () => { window.close(); });
  handler('window:quit', () => { app.quit(); });
  handler('workspace:export', async (text) => {
    const safe = clean(text, 100_000).trim();
    if (!safe) throw new Error('There is nothing to export.');
    const result = await dialog.showSaveDialog(window, {
      title: 'Export your notes',
      defaultPath: 'Anotch Notes.md',
      filters: [{ name: 'Markdown', extensions: ['md'] }]
    });
    if (result.canceled || !result.filePath) return { cancelled: true };
    await fs.writeFile(result.filePath, safe, { mode: 0o600 });
    return { ok: true };
  });
}

function createWindow(initial = false) {
  const panel = new BrowserWindow({
    show: false, width: 414, height: 434, minWidth: 382, minHeight: 392,
    type: 'panel', frame: false, transparent: true, title: 'Anotch', hasShadow: false, enableLargerThanScreen: true, acceptFirstMouse: true,
    alwaysOnTop: settings.float, backgroundColor: '#00000000',
    webPreferences: {
      session: panelSession, preload: path.join(__dirname, 'preload.js'),
      sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true,
      backgroundThrottling: false
    }
  });
  window = panel;
  notch.bind(panel);
  panel.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  panel.webContents.on('will-navigate', (event) => event.preventDefault());
  panel.webContents.on('will-attach-webview', (event) => event.preventDefault());
  panel.once('ready-to-show', () => initial ? void notch.openOnLaunch(panel, focusPanel) : focusPanel());
  panel.webContents.on('did-start-loading', () => { panelReady = false; });
  panel.webContents.on('render-process-gone', () => screenWatch.stop());
  panel.on('close', (event) => { if (!closing && !stealthActive && notch.available()) { event.preventDefault(); notch.collapse(); } });
  panel.on('hide', () => { if (!stealthActive && !panel.isMinimized()) screenWatch.stop(); });
  panel.on('closed', () => {
    screenWatch.stop();
    stealth.hide();
    stealthTransition++;
    stealthActive = stealthVisible = stealthWanted = false;
    stealthRead = undefined;
    cancelChat();
    audio.stop();
    if (window === panel) { window = null; pendingAction = undefined; panelReady = false; }
  });
  panel.loadURL(START_URL).catch((error) => {
    console.error('Anotch could not load its workspace:', error);
    app.quit();
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('window-all-closed', () => app.quit());
  app.whenReady().then(async () => {
    panelSession = session.fromPartition(SESSION);
    app.setAboutPanelOptions({ applicationName: 'Anotch', applicationVersion: app.getVersion(), copyright: 'Copyright © 2026 Enterprise Trapper' });
    store = createStore(app.getPath('userData'), safeStorage);
    notch = createNotch({ app, screen, publish: state => send('notch:state', state) });
    notch.pause(powerMonitor.getSystemIdleState(1) === 'locked');
    powerMonitor.on('lock-screen', () => notch.pause(true));
    powerMonitor.on('unlock-screen', () => notch.pause(false));
    audio = wireAudio({ app, handler, send, getSettings: () => settings, microphone: capture.microphone });
    appleAnswer = createAppleAnswer(app);
    stealth = createStealth(app, () => {
      stealthTransition++;
      stealthWanted = stealthVisible = false;
      if (chatController?.stealth) chatController.abort();
      screenWatch.stop('The protected answer panel closed.');
    }, () => settings.dockAtNotch);
    screenWatch = wireScreenWatch({
      handler, powerMonitor, capture: screenFrame, runChat,
      ready: () => answerEngine(settings) !== 'unconfigured',
      canCapture: () => !closing && !shotCount && !stealthRead &&
        (stealthActive ? stealthVisible : window?.isVisible() || window?.isMinimized()),
      canAnswer: () => !chatController && !pendingChat && !stealthRead,
      onStatus: (state) => {
        stealth.setWatching(state.active, state.phase);
        notch.watch(state);
        if (stealthVisible && !state.active && state.message) stealth.update(state.message, 'error');
        send('screen:watch-status', state);
      },
      onAnswer: (answer) => {
        if (stealthActive) stealth.update(answer, 'done');
        else notch.answer(answer);
        send('screen:watch-answer', answer);
      }
    });
    try { settings = restoreSettings(await store.read('preferences', DEFAULTS)); }
    catch (error) { settingsNotice = error.message; }
    notch.configure(settings.dockAtNotch, settings.float);
    setupRendererSession(panelSession, () => window, notch.logoPath);
    setupMenu();
    wire();
    hideShortcutReady = globalShortcut.register(ACTIONS['toggle-window'], () => window ? togglePanel() : showWorkspace());
    analyzeShortcutReady = globalShortcut.register(ACTIONS['focus-question'], () => {
      if (stealthActive) void askStealth();
      else showWorkspace('focus-question');
    });
    stealthShortcutReady = globalShortcut.register('Control+Shift+K', () => {
      if (stealthActive) void setStealth(false).catch(() => {});
      else if (window) focusPanel();
    });
    createWindow(true);
    app.on('activate', () => { if (!notch.starting() && !settingsWindow.isOpen()) showWorkspace(); });
    app.on('second-instance', () => showWorkspace());
  }).catch((error) => {
    console.error('Anotch could not start:', error);
    app.quit();
  });
  app.on('before-quit', (event) => {
    if (closedCleanly || !store) return;
    event.preventDefault();
    if (closing) return;
    closing = true;
    notch?.dispose();
    screenWatch?.stop();
    stealth?.hide();
    cancelChat();
    audio?.stop();
    Promise.race([profileQueue.then(() => store.drain()), new Promise((resolve) => setTimeout(resolve, 1400))])
      .finally(() => { closedCleanly = true; app.quit(); });
  });
  app.on('will-quit', () => globalShortcut.unregisterAll());
}
