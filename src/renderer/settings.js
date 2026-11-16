(() => {
  const byId = (id) => document.getElementById(id);
  const bridge = window.anotch;
  const form = byId('settingsForm');
  const tabs = [...document.querySelectorAll('.settings-nav [role="tab"]')];
  const confirmDialog = byId('confirmDialog');
  const providerFields = ['baseUrl', 'chatModel', 'transcribeBaseUrl', 'transcribeModel', 'backupBaseUrl', 'backupModel'];
  const textFields = [...providerFields, 'language', 'background', 'notes', 'style'];
  const radioFields = ['answerMode', 'responseLevel'];
  const checks = ['keepHistory', 'ocr', 'float', 'dockAtNotch'];
  const keyOrigins = { apiKey: 'baseUrl', transcribeApiKey: 'transcribeBaseUrl', backupApiKey: 'backupBaseUrl' };
  const keys = Object.keys(keyOrigins);
  let current;
  let activeTab = tabs[0];
  let working = false;
  let removal;

  function message(text, tone = '') {
    const status = byId('settingsHint');
    status.textContent = text;
    status.dataset.tone = tone;
  }

  function radioValue(name) {
    return form.elements.namedItem(name).value;
  }

  function setRadio(name, value) {
    form.elements.namedItem(name).value = value;
  }

  function origin(base) {
    if (!base?.trim()) return '';
    try { return new URL(base.trim()).origin; }
    catch { return null; }
  }

  function clearKeyDrafts() {
    for (const id of keys) byId(id).value = '';
  }

  function updateKeyHint(id) {
    const base = keyOrigins[id];
    const sameOrigin = origin(byId(base).value) === origin(current[base]);
    const saved = current[id + 'Saved'] && sameOrigin;
    byId(id).placeholder = saved ? 'Saved · type to replace'
      : id === 'apiKey' && byId('baseUrl').value.trim().replace(/\/+$/, '') === OPENROUTER.baseUrl
        ? 'Enter OpenRouter API key' : 'Enter API key';
  }

  function paintEngine() {
    const mode = radioValue('answerMode');
    const local = current.apple?.available
      ? (current.apple.vision ? 'Apple Intelligence can read images and text on this Mac.' : 'Apple Intelligence can answer from extracted screen text on this Mac.')
      : current.apple?.reason || 'Apple Intelligence is unavailable on this Mac.';
    byId('answerEngineSummary').textContent = mode === 'provider'
      ? 'Questions and attachments go to the AI provider.'
      : mode === 'apple' ? local : '';
  }

  function populate() {
    for (const id of textFields) byId(id).value = current[id] ?? '';
    for (const id of radioFields) setRadio(id, current[id]);
    for (const id of checks) byId(id).checked = Boolean(current[id]);
    byId('opacity').value = current.opacity;
    clearKeyDrafts();
    for (const id of keys) updateKeyHint(id);
    paintEngine();
  }

  function credentials() {
    const changes = {};
    for (const [id, base] of Object.entries(keyOrigins)) {
      const value = byId(id).value.trim();
      if (!value) continue;
      changes[id] = value;
      changes[base] = byId(base).value;
    }
    return changes;
  }

  function draft() {
    const values = {};
    for (const id of textFields) values[id] = byId(id).value;
    for (const id of radioFields) values[id] = radioValue(id);
    for (const id of checks) values[id] = byId(id).checked;
    values.opacity = Number(byId('opacity').value);
    const changed = Object.fromEntries(Object.entries(values).filter(([id, value]) => value !== current[id]));
    return { ...changed, ...credentials() };
  }

  function providerDraft() {
    const values = {};
    for (const id of providerFields) values[id] = byId(id).value;
    return { ...values, ...credentials() };
  }

  async function refreshPermissions() {
    const label = (value) => ({ granted: 'Allowed', denied: 'Denied', restricted: 'Restricted', 'not-determined': 'Not requested' })[value] || 'Unavailable';
    let status;
    try { status = await bridge.permissions(); }
    catch { status = {}; }
    const microphone = label(status.microphone);
    const screen = label(status.screen);
    byId('microphonePermission').textContent = microphone;
    byId('screenPermission').textContent = screen;
    byId('permissionSummary').textContent = 'Microphone ' + microphone + '. Screen recording ' + screen + '.';
  }

  function showPane(tab, focus = false) {
    activeTab = tab;
    for (const item of tabs) {
      const selected = item === tab;
      item.setAttribute('aria-selected', String(selected));
      item.tabIndex = selected ? 0 : -1;
      byId(item.getAttribute('aria-controls')).hidden = !selected;
    }
    form.scrollTop = 0;
    if (focus) tab.focus();
    if (tab.id === 'tab-permissions') void refreshPermissions();
  }

  document.querySelector('.settings-nav').addEventListener('keydown', (event) => {
    const index = tabs.indexOf(activeTab);
    const step = event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0;
    const position = step ? (index + step + tabs.length) % tabs.length
      : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : -1;
    if (position < 0) return;
    event.preventDefault();
    showPane(tabs[position], true);
  });
  for (const tab of tabs) tab.addEventListener('click', () => showPane(tab));
  window.addEventListener('focus', () => { if (activeTab.id === 'tab-permissions') void refreshPermissions(); });

  function revealInvalidField(scope) {
    const invalid = [...scope.querySelectorAll('input, select, textarea')].find((field) => !field.validity.valid);
    if (!invalid) return false;
    const pane = invalid.closest('[role="tabpanel"]');
    if (pane.hidden) showPane(byId(pane.getAttribute('aria-labelledby')));
    invalid.reportValidity();
    return true;
  }

  function syncControls() {
    form.inert = working || !current;
    form.setAttribute('aria-busy', String(working || !current));
    byId('saveSettings').disabled = working || !current;
    byId('cancelSettings').disabled = working;
    byId('confirmWipe').disabled = working;
    byId('cancelRemoval').disabled = working;
  }

  async function run(operation) {
    if (working || !current) return;
    working = true;
    syncControls();
    try { await operation(); }
    catch (error) { message(error.message, 'error'); }
    finally { working = false; syncControls(); }
  }

  function cancel() {
    if (working) return;
    clearKeyDrafts();
    void bridge.closeSettings().catch((error) => message(error.message, 'error'));
  }

  byId('cancelSettings').addEventListener('click', cancel);
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || confirmDialog.open || event.defaultPrevented) return;
    event.preventDefault();
    cancel();
  });

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!current || working || confirmDialog.open || revealInvalidField(form)) return;
    void run(async () => {
      const patch = draft();
      if (Object.keys(patch).length) {
        const { settings, notice } = await bridge.saveSettings(patch);
        current = settings;
        populate();
        if (notice) { message(notice, 'error'); return; }
      }
      await bridge.closeSettings();
    });
  });

  byId('answerMode').addEventListener('change', paintEngine);
  for (const [id, base] of Object.entries(keyOrigins)) {
    byId(base).addEventListener('input', () => updateKeyHint(id));
  }

  byId('useOpenRouter').addEventListener('click', () => {
    const base = byId('baseUrl');
    const key = byId('apiKey');
    if (base.value.trim().replace(/\/+$/, '') !== OPENROUTER.baseUrl && !isOpenRouterKey(key.value)) key.value = '';
    base.value = OPENROUTER.baseUrl;
    byId('chatModel').value = OPENROUTER.chatModel;
    if (!byId('transcribeBaseUrl').value.trim()) byId('transcribeModel').value = OPENROUTER.transcribeModel;
    setRadio('answerMode', 'provider');
    byId('modelList').replaceChildren();
    updateKeyHint('apiKey');
    paintEngine();
    const hasKey = key.value.trim() || (current.baseUrl === OPENROUTER.baseUrl && current.apiKeySaved);
    message(hasKey ? 'Test the provider, then save settings.' : 'Enter your OpenRouter API key, then test the provider.');
    if (!hasKey) key.focus();
  });

  byId('testProvider').addEventListener('click', () => {
    if (revealInvalidField(byId('pane-provider'))) return;
    void run(async () => {
      message('Checking the provider…');
      const { models, keyVerified } = await bridge.testProvider(providerDraft());
      byId('modelList').replaceChildren(...models.map((value) => Object.assign(document.createElement('option'), { value })));
      message(keyVerified ? 'OpenRouter key verified. Save settings to keep this setup.'
        : 'Connected · ' + models.length + ' model' + (models.length === 1 ? '' : 's') + ' available', 'success');
    });
  });

  for (const [id, kind] of [['screenPrivacy', 'screen'], ['microphonePrivacy', 'microphone']]) {
    byId(id).addEventListener('click', () => bridge.openPrivacy(kind).catch((error) => message(error.message, 'error')));
  }

  function confirmRemoval(kind) {
    if (working || !current) return;
    removal = kind;
    const wipe = kind === 'all';
    byId('confirmTitle').textContent = wipe ? 'Clear all local data?' : 'Delete saved API keys?';
    byId('confirmDescription').textContent = wipe
      ? 'Anotch will delete saved settings, keys, chat, and transcript from this Mac.'
      : 'Anotch will remove the saved keys for your AI, audio, and backup providers from this Mac.';
    byId('confirmWipe').textContent = wipe ? 'Clear Data' : 'Delete Keys';
    confirmDialog.showModal();
  }

  byId('wipeData').addEventListener('click', () => confirmRemoval('all'));
  byId('clearKeys').addEventListener('click', () => confirmRemoval('keys'));
  byId('cancelRemoval').addEventListener('click', () => confirmDialog.close());
  confirmDialog.addEventListener('cancel', (event) => { if (working) event.preventDefault(); });
  confirmDialog.addEventListener('close', () => { removal = undefined; });
  byId('confirmWipe').addEventListener('click', () => {
    if (!removal) return;
    const wipe = removal === 'all';
    void run(async () => {
      try {
        const { settings } = wipe ? await bridge.wipe() : await bridge.saveSettings(Object.fromEntries(keys.map((id) => [id, ''])));
        current = settings;
        if (wipe) populate();
        else {
          clearKeyDrafts();
          for (const id of keys) updateKeyHint(id);
        }
        message(wipe ? 'Local data cleared.' : 'Saved API keys deleted.', 'success');
      } finally { confirmDialog.close(); }
    });
  });

  void bridge.refreshSettings().then((settings) => {
    current = settings;
    populate();
    syncControls();
  }).catch((error) => message(error.message, 'error'));
})();
