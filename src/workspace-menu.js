function setWorkspaceMenu(Menu, { open, hide, openSettings, startStealth, setFloating, floating }) {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: 'Anotch',
      submenu: [
        { role: 'about', label: 'About Anotch' }, { type: 'separator' },
        { label: 'Settings…', accelerator: 'Command+,', click: openSettings },
        { type: 'separator' }, { label: 'Hide Anotch', accelerator: 'Command+H', click: hide },
        { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' },
        { role: 'quit', label: 'Quit Anotch' }
      ]
    },
    { role: 'editMenu' },
    {
      label: 'Window',
      submenu: [
        { label: 'Show Anotch', click: () => open('focus-question') },
        { label: 'Start Stealth Mode', click: startStealth },
        { label: 'Hide Panel for Screen Sharing', click: hide },
        { label: 'Float on Top', type: 'checkbox', checked: floating, click: (item) => setFloating(item.checked) },
        { type: 'separator' }, { role: 'minimize' }, { role: 'front' }
      ]
    }
  ]));
}

module.exports = { setWorkspaceMenu };
