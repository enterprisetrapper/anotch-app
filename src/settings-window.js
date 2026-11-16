const path = require('node:path');
const { BrowserWindow } = require('electron');
const { SETTINGS_URL } = require('./renderer-session');

const SETTINGS_COMMANDS = new Set(['settings:save', 'settings:status', 'settings:models', 'settings:close', 'permission:open', 'permission:status', 'workspace:wipe']);

function createSettingsWindow() {
  let panel;
  return {
    allows(topic, event) {
      return Boolean(panel && event.sender === panel.webContents && event.senderFrame?.url === SETTINGS_URL && SETTINGS_COMMANDS.has(topic));
    },
    close() { panel?.close(); },
    isOpen() { return Boolean(panel); },
    async open(session) {
      if (panel) { panel.show(); panel.focus(); return; }
      const window = new BrowserWindow({
        title: 'Anotch Settings', width: 668, height: 540, minWidth: 554, minHeight: 440,
        show: false, titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 16 },
        vibrancy: 'hud', visualEffectState: 'active', backgroundColor: '#00000000',
        webPreferences: { session, preload: path.join(__dirname, 'preload.js'), sandbox: true, contextIsolation: true, nodeIntegration: false }
      });
      panel = window;
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      window.webContents.on('will-navigate', (event) => event.preventDefault());
      window.webContents.on('will-attach-webview', (event) => event.preventDefault());
      window.on('focus', () => window.setAlwaysOnTop(true, 'modal-panel'));
      window.on('blur', () => window.setAlwaysOnTop(false));
      window.once('closed', () => { panel = undefined; });
      window.once('ready-to-show', () => { window.show(); window.focus(); });
      try { await window.loadURL(SETTINGS_URL); }
      catch { if (!window.isDestroyed()) window.close(); throw new Error('Anotch could not open Settings.'); }
    }
  };
}

module.exports = { createSettingsWindow };
