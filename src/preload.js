const { contextBridge, ipcRenderer } = require('electron');

const invoke = (topic) => async (...args) => {
  const response = await ipcRenderer.invoke(topic, ...args);
  if (response?.error) throw Object.assign(new Error(response.error), { code: response.code });
  return response;
};
const on = (topic) => (listener) => ipcRenderer.on(topic, (_event, value) => listener(value));

const settings = {
  saveSettings: invoke('settings:save'),
  testProvider: invoke('settings:models'),
  refreshSettings: invoke('settings:status'),
  permissions: invoke('permission:status'),
  openPrivacy: invoke('permission:open'),
  wipe: invoke('workspace:wipe'),
  closeSettings: invoke('settings:close')
};

contextBridge.exposeInMainWorld('anotch', location.pathname === '/settings.html' ? settings : {
  ...settings,
  boot: invoke('boot'),
  openSettings: invoke('settings:open'),
  audioReady: invoke('audio:ready'),
  sendAudio: invoke('audio:send'),
  stopAudio: invoke('audio:stop'),
  startSystemAudio: invoke('audio:system-start'),
  stopSystemAudio: invoke('audio:system-stop'),
  onSystemClip: on('audio:system-clip'),
  onSystemEnded: on('audio:system-ended'),
  onAudioRouteChanged: on('audio:routing-changed'),
  notchRecording: invoke('notch:recording'),
  getNotchState: invoke('notch:state'),
  notchPainted: (id, drawnAt) => ipcRenderer.send('notch:painted', id, drawnAt),
  onNotchState: on('notch:state'),
  toggleNotch: invoke('notch:toggle'),
  clearNotchAnswer: invoke('notch:clear-answer'),
  listScreens: invoke('screen:list'),
  capture: invoke('screen:get'),
  startScreenWatch: invoke('screen:watch-start'),
  stopScreenWatch: invoke('screen:watch-stop'),
  onScreenWatchStatus: on('screen:watch-status'),
  onScreenWatchAnswer: on('screen:watch-answer'),
  ask: invoke('chat:start'),
  cancel: invoke('chat:stop'),
  saveWorkspace: invoke('workspace:save'),
  copy: invoke('clipboard:copy'),
  minimize: invoke('window:minimize'),
  toggleWorkspaceSize: invoke('window:size'),
  workspaceReady: invoke('window:ready'),
  hide: invoke('window:hide'),
  startStealth: invoke('stealth:start'),
  close: invoke('window:close'),
  quit: invoke('window:quit'),
  saveNotes: invoke('workspace:export'),
  onChunk: on('chat:chunk'),
  onStealthAnswer: on('stealth:answer'),
  onAction: on('action')
});
