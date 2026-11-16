(() => {
  const $ = (id) => document.getElementById(id);
  const api = window.anotch;
  const audio = window.anotchAudio;
  const { paintMessages, renderAnswer } = window.anotchAnswer;
  const captureDialog = $('captureDialog');
  let settings;
  let workspaceRevision = 0;
  let turns = [];
  let transcript = [];
  let frames = [];
  let active = null;
  let practice = false;
  let practiceStart = 0;
  let auto = false;
  let lastAuto = 0;
  let nextCaptureAction = null;
  let captureEpoch = 0;
  let lastSource;
  let noticeTimer = null;
  const emptyAnswer = $('answer').firstElementChild.cloneNode(true);
  function notice(text, tone = '') {
    clearTimeout(noticeTimer);
    const message = $('message');
    message.className = tone;
    message.toggleAttribute('data-idle', text === 'Ready' && !tone);
    message.lastElementChild.textContent = text;
    message.title = text;
    message.firstElementChild.classList.toggle('good', tone === 'good');
    if (tone === 'good') noticeTimer = setTimeout(() => {
      if (message.lastElementChild.textContent === text) notice(audio.active() ? 'Listening…' : 'Ready', audio.active() ? 'recording' : '');
    }, 5000);
  }
  function safely(task) {
    return async (event) => {
      event?.preventDefault();
      try { await task(event); } catch (error) { notice(error.message, 'error'); }
    };
  }

  function openSettings() { void api.openSettings().catch(error => notice(error.message, 'error')); }
  function localProvider(base) {
    try { return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(base).hostname); }
    catch { return false; }
  }
  function applySettings(value) {
    if (settings && captureDialog.open && settings.engine !== value.engine) {
      captureEpoch++;
      nextCaptureAction = null;
      captureDialog.close();
    }
    settings = value;
    for (const level of $('answerLevels').querySelectorAll('input')) level.checked = level.value === value.responseLevel;
    const apple = settings.engine === 'apple' && settings.apple?.available;
    const provider = settings.engine === 'provider';
    const status = $('providerStatus');
    status.classList.toggle('ready', apple || provider);
    status.lastElementChild.textContent = apple ? 'On this Mac' : provider ? 'Provider set up' : 'Set up answers';
    if (settings.hideShortcutReady) $('hidePanel').title = 'Hide or show Anotch (⌃⇧G)';
    document.documentElement.style.setProperty('--panel-opacity', String(settings.opacity));
  }
  async function answersReady() {
    if (settings.engine === 'provider' || settings.apple?.available && settings.engine === 'apple') return true;
    const refreshed = await api.refreshSettings();
    applySettings(refreshed);
    if (refreshed.engine === 'provider' || refreshed.apple?.available && refreshed.engine === 'apple') return true;
    notice(refreshed.engine === 'apple' ? refreshed.apple.reason : 'Connect an AI provider in Settings to get answers.', 'error');
    openSettings();
    return false;
  }
  async function persist() {
    if (settings?.keepHistory) await api.saveWorkspace({ turns, transcript, revision: workspaceRevision });
  }

  function paintTranscript() {
    const content = transcript.slice(-70).map((line) => {
      const label = Object.assign(document.createElement('strong'), { textContent: line.source });
      const row = document.createElement('p');
      row.append(label, document.createTextNode(line.text));
      return row;
    });
    if (!content.length) content.push(Object.assign(document.createElement('p'), { className: 'empty-line', textContent: 'Press Listen to transcribe an audio source.' }));
    const box = $('transcript');
    box.replaceChildren(...content);
    box.scrollTop = box.scrollHeight;
    $('answerTranscript').disabled = !transcript.length || practice;
    $('recap').disabled = !transcript.length || practice;
    updateExport();
  }

  function lastAnswer() { return turns.findLast((entry) => entry.role === 'assistant')?.content || ''; }
  function updateExport() { $('export').disabled = !turns.length && !transcript.length; }
  function paintChat() {
    const answer = $('answer');
    paintMessages(answer, $('askedQuestion'), turns, active, emptyAnswer);
    answer.scrollTop = answer.scrollHeight;
    $('copy').disabled = !lastAnswer();
    $('read').disabled = !lastAnswer() || !window.speechSynthesis;
    updateExport();
  }
  function paintFrames() {
    const tray = $('attachments');
    tray.hidden = frames.length === 0;
    tray.replaceChildren(...frames.map((frame, index) => {
      const figure = document.createElement('div');
      figure.className = 'shot-thumb';
      const image = Object.assign(document.createElement('img'), { src: frame.url, alt: '' });
      const remove = Object.assign(document.createElement('button'), { type: 'button', textContent: '×', title: 'Remove screenshot' });
      remove.setAttribute('aria-label', 'Remove screenshot ' + (index + 1));
      remove.addEventListener('click', () => { frames.splice(index, 1); paintFrames(); });
      figure.append(image, document.createTextNode('Shot ' + (index + 1)), remove);
      return figure;
    }));
  }

  function setSending(value) {
    $('answerProgress').hidden = !value;
    $('answerProgress').textContent = 'Thinking…';
    $('submit').hidden = value;
    $('cancel').hidden = !value;
    $('cancel').disabled = false;
    $('newChat').disabled = value;
  }
  async function ask(question, { label = question, screenshots = false, fromInput = false } = {}) {
    if (!question.trim() || active) return;
    if (practice) { notice('Finish the practice round to get feedback.'); return; }
    if (!await answersReady() || active) return;
    const selected = screenshots ? frames.slice() : [];
    const task = active = { id: crypto.randomUUID(), title: label, answer: '', pending: false };
    setSending(true);
    paintChat();
    if (fromInput) $('question').value = '';
    try {
      const { cancelled, answer } = await api.ask({ id: task.id, question, turns, frames: selected });
      if (active !== task) return;
      if (!cancelled) {
        turns = [...turns, { role: 'user', content: label }, { role: 'assistant', content: answer }].slice(-30);
        if (selected.length) {
          frames = frames.filter((frame) => !selected.includes(frame));
          paintFrames();
        }
        await persist();
      } else notice('Answer stopped');
    } catch (error) {
      if (active === task) {
        if (error.code !== 'ANSWER_FILTERED' && task.answer.trim()) {
          turns = [...turns, { role: 'user', content: label }, { role: 'assistant', content: task.answer + '\n\n[Incomplete answer]' }].slice(-30);
          void persist().catch(() => {});
        }
        if (fromInput && !$('question').value) $('question').value = question;
        notice(error.message, 'error');
      }
    } finally {
      if (active === task) {
        active = null;
        setSending(false);
        paintChat();
      }
    }
  }

  api.onChunk(({ id, text, replace, retrying }) => {
    const task = active;
    if (!task || task.id !== id) return;
    $('answerProgress').textContent = retrying ? 'Trying a backup model…' : 'Writing…';
    if (retrying) return;
    task.answer = replace ? text : task.answer + text;
    if (task.pending) return;
    task.pending = true;
    requestAnimationFrame(() => {
      task.pending = false;
      if (active !== task) return;
      renderAnswer(task.node, task.answer);
      $('answer').scrollTop = $('answer').scrollHeight;
    });
  });
  function transcriptText(lines = transcript) {
    return lines.slice(-70).map((row) => row.source + ': ' + row.text).join('\n').slice(-13_000);
  }
  function askTranscript(recap = false) {
    if (!transcript.length) return;
    const instruction = recap ? 'Summarize the transcript and list decisions or next steps.' : 'Answer the most recent question in the transcript.';
    return ask(instruction + '\n\nTranscript:\n' + transcriptText(), { label: recap ? 'Recap the transcript' : 'Answer from the transcript' });
  }

  function setPractice(value) {
    practice = value;
    $('practice').textContent = value ? 'Finish practice' : 'Practice interview';
    $('question').placeholder = value ? 'Type a practice response or use Listen…' : 'Ask Anotch…';
    $('modeLine').hidden = !value;
    $('modeLine').textContent = 'Practice mode · Answer out loud or type a response. Get feedback when you finish.';
    $('practice').setAttribute('aria-pressed', String(value));
    paintTranscript();
  }

  const PRACTICE_QUESTION = 'Tell me about a difficult problem you solved. What did you do, and what changed?';
  async function togglePractice() {
    if (active) return;
    if (!practice) {
      await api.stopScreenWatch();
      practiceStart = transcript.length;
      setPractice(true);
      const block = chatEntry('assistant', PRACTICE_QUESTION);
      $('answer').replaceChildren(block);
      return;
    }
    if (audio.active()) await audio.stop(true);
    const practiceText = [$('question').value.trim(), transcriptText(transcript.slice(practiceStart))].filter(Boolean).join('\n');
    if (!practiceText) {
      setPractice(false);
      paintChat();
      notice('Practice ended. There was no response to review.');
      return;
    }
    if (!await answersReady()) return;
    setPractice(false);
    $('question').value = '';
    await ask('Score this practice answer out of 10 for structure, clarity, and evidence. Give two concrete improvements.\n\nInterview question: ' + PRACTICE_QUESTION + '\n\nResponse:\n' + practiceText, { label: 'Practice interview debrief' });
  }
  const audioEvents = {
    recording(labels, error) {
      void api.notchRecording(true).catch(() => {});
      $('listen').lastElementChild.textContent = 'Stop';
      $('listen').setAttribute('aria-pressed', 'true');
      notice(error || 'Listening · ' + labels.join(' + '), error ? 'error' : 'recording');
    },
    line(line) {
      transcript.push(line);
      paintTranscript();
      void persist().catch((error) => notice(error.message, 'error'));
      if (auto && !practice && !active && Date.now() - lastAuto > 12_000 && looksLikeQuestion(line.text)) {
        lastAuto = Date.now();
        void ask('Respond to the last question in this transcript.\n\n' + transcriptText(), { label: 'Copilot · ' + line.text.slice(0, 130) });
      }
    },
    error: (message) => notice(message, 'error'),
    stopping(flush) { if (flush) notice('Finishing transcription…', 'recording'); },
    stopped() {
      void api.notchRecording(false).catch(() => {});
      $('listen').lastElementChild.textContent = 'Listen';
      $('listen').setAttribute('aria-pressed', 'false');
      $('listen').disabled = false;
      $('source').disabled = false;
      if ($('message').className !== 'error') notice('Listening stopped', 'good');
    }
  };

  async function toggleListening() {
    if (audio.active()) { await audio.stop(true); return; }
    const base = settings.transcribeBaseUrl || settings.baseUrl;
    const key = settings.transcribeBaseUrl ? settings.transcribeApiKeySaved : settings.apiKeySaved;
    if (!key && !localProvider(base)) {
      openSettings();
      throw new Error('Add a transcription API key in Settings before listening.');
    }
    $('source').disabled = true;
    $('listen').lastElementChild.textContent = 'Cancel';
    notice('Starting audio…');
    try { await audio.start($('source').value, audioEvents); }
    catch (error) { audioEvents.stopped(); throw error; }
  }
  async function selectSource(then) {
    if (captureDialog.open) return;
    const watch = then === 'watch';
    const limit = settings.engine === 'apple' && settings.apple.vision ? 2 : 5;
    if (!watch && frames.length >= limit) { notice('Remove a screenshot before adding another (limit ' + limit + ').', 'error'); return; }
    nextCaptureAction = then;
    $('captureTitle').textContent = watch ? 'Watch a screen' : 'Capture a screen';
    $('captureDescription').textContent = watch ? 'Choose a display to follow across apps, or select one window.' : 'Pick the display or window you want to attach.';
    $('takeScreen').textContent = watch ? 'Start watching' : then ? 'Capture and answer' : 'Attach screenshot';
    $('captureRoute').textContent = settings.engine === 'apple'
      ? 'Apple Intelligence reads screenshots on this Mac.'
      : watch ? 'Anotch sends changed screenshots from this source to your connected AI provider.'
        : then ? 'The screenshot will be sent to your connected AI provider.'
        : 'The screenshot stays here until you send a question with it attached.';
    captureDialog.showModal();
    await refreshSources();
  }
  async function refreshSources() {
    const epoch = ++captureEpoch;
    $('screenList').replaceChildren();
    $('screenList').disabled = true;
    $('takeScreen').disabled = true;
    $('openScreenPrivacy').hidden = true;
    captureMessage('Looking for windows and displays…');
    $('refreshScreens').disabled = true;
    try {
      const sources = await api.listScreens();
      if (epoch !== captureEpoch || !captureDialog.open) return;
      const groups = { screen: Object.assign(document.createElement('optgroup'), { label: 'Displays' }), window: Object.assign(document.createElement('optgroup'), { label: 'Windows' }) };
      for (const source of sources) groups[source.kind].append(Object.assign(document.createElement('option'), { value: source.id, textContent: source.name }));
      $('screenList').replaceChildren(...Object.values(groups).filter((group) => group.children.length));
      if (nextCaptureAction !== 'watch' && sources.some(({ id }) => id === lastSource)) $('screenList').value = lastSource;
      else if (typeof nextCaptureAction === 'function') {
        const firstWindow = sources.find(({ kind }) => kind === 'window');
        if (firstWindow) $('screenList').value = firstWindow.id;
      }
      $('screenList').disabled = !sources.length;
      $('takeScreen').disabled = !sources.length;
      captureMessage(sources.length ? '' : 'No capturable screens or windows found.');
    } catch (error) {
      if (epoch !== captureEpoch || !captureDialog.open) return;
      captureError(error);
    } finally { if (epoch === captureEpoch) $('refreshScreens').disabled = false; }
  }

  function captureMessage(text, tone = '') {
    $('captureMessage').textContent = text;
    $('captureMessage').className = 'form-message ' + tone;
  }
  function captureError(error) {
    captureMessage(error.message, 'error');
    $('openScreenPrivacy').hidden = error.code !== 'SCREEN_PERMISSION';
  }
  async function takeScreen() {
    const control = $('takeScreen');
    const epoch = captureEpoch;
    const selected = $('screenList').value;
    control.disabled = true;
    $('refreshScreens').disabled = true;
    const watch = nextCaptureAction === 'watch';
    captureMessage(watch ? 'Starting screen watch…' : 'Capturing screenshot…');
    try {
      if (watch) {
        await api.startScreenWatch(selected, $('screenList').selectedOptions[0]?.textContent);
        if (epoch !== captureEpoch || !captureDialog.open) return await api.stopScreenWatch();
        captureDialog.close();
        return;
      }
      const shot = await api.capture(selected);
      if (epoch !== captureEpoch || !captureDialog.open) return;
      lastSource = selected;
      frames.push(shot);
      paintFrames();
      const then = nextCaptureAction;
      nextCaptureAction = null;
      captureDialog.close();
      notice(shot.ocrFailed ? 'Screenshot attached. Local text recognition did not finish.' : 'Screenshot attached', shot.ocrFailed ? '' : 'good');
      if (then) await then();
      else $('question').focus();
    } catch (error) {
      if (epoch === captureEpoch && captureDialog.open) captureError(error);
    } finally {
      if (epoch === captureEpoch) {
        control.disabled = false;
        $('refreshScreens').disabled = false;
      }
    }
  }

  async function analyzeScreen() {
    if (active || !await answersReady()) return;
    if (practice) { notice('Finish the practice round before analyzing a screen.'); return; }
    const typed = $('question').value.trim();
    const question = typed || 'Explain what is shown in the attached screenshot. If a question is visible, answer it.';
    const send = () => ask(question, { label: typed || 'Analyze screen', screenshots: true, fromInput: Boolean(typed) });
    return frames.length ? send() : selectSource(send);
  }
  function resetWorkspace() {
    void audio.stop(false).catch(() => {});
    captureEpoch++;
    nextCaptureAction = null;
    captureDialog.close();
    active = null;
    turns = []; transcript = []; frames = [];
    setSending(false);
    setPractice(false);
    paintChat(); paintTranscript(); paintFrames();
    $('question').value = '';
    notice('Local data cleared', 'good');
  }
  async function exportNotes() {
    const chat = turns.map((entry) => '### ' + (entry.role === 'user' ? 'You' : 'Anotch') + '\n' + entry.content).join('\n\n');
    const notes = '# Anotch Notes\n\n' + (transcript.length ? '## Transcript\n\n' + transcriptText() + '\n\n' : '') + (turns.length ? '## Chat\n\n' + chat : '');
    const result = await api.saveNotes(notes);
    if (result?.ok) notice('Notes exported', 'good');
  }
  function wire() {
    function showStealthSetup() {
      const dialog = $('stealthDialog');
      $('stealthRoute').textContent = settings.engine === 'provider'
        ? 'Your provider receives screenshots from screen watch or when you press the analyze shortcut.'
        : 'When you press the analyze shortcut, Apple Intelligence reads the screenshot on this Mac.';
      if (!dialog.open) dialog.showModal();
    }
    $('stealthPanel').addEventListener('click', showStealthSetup);
    $('startStealth').addEventListener('click', safely(async () => {
      $('stealthDialog').close();
      await api.startStealth(lastAnswer());
    }));
    function appendScreenAnswer(label, answer) {
      turns = [...turns, { role: 'user', content: label }, { role: 'assistant', content: answer }].slice(-30);
      paintChat();
      void persist().catch((error) => notice(error.message, 'error'));
    }
    api.onStealthAnswer((answer) => appendScreenAnswer('Analyze display', answer));
    api.onScreenWatchAnswer((answer) => appendScreenAnswer('Watched screen', answer));
    const levels = $('answerLevels');
    levels.addEventListener('change', async (event) => {
      const input = event.target;
      if (input.name !== 'answerLevel' || !input.checked || levels.disabled) return;
      levels.disabled = true;
      try { applySettings((await api.saveSettings({ responseLevel: input.value })).settings); }
      catch (error) { applySettings(settings); notice(error.message, 'error'); }
      finally { levels.disabled = false; }
    });
    $('toggleTranscript').addEventListener('click', (event) => {
      const transcript = $('transcript');
      transcript.hidden = !transcript.hidden;
      event.currentTarget.setAttribute('aria-expanded', String(!transcript.hidden));
    });
    const watchButton = $('watchScreen');
    watchButton.addEventListener('click', safely(async () => {
      if (watchButton.getAttribute('aria-pressed') === 'true') return api.stopScreenWatch();
      if (!practice && await answersReady()) await selectSource('watch');
      else if (practice) notice('Finish practice before watching a screen.', 'error');
    }));
    api.onScreenWatchStatus(({ active: watching, message, phase, source, checkedAt }) => {
      watchButton.setAttribute('aria-pressed', String(watching));
      const label = watching ? 'Stop watching' : 'Watch screen';
      watchButton.lastElementChild.textContent = label;
      watchButton.setAttribute('aria-label', label);
      watchButton.title = label;
      const status = $('watchStatus');
      status.hidden = !watching;
      const checked = checkedAt == null ? 'Starting…' : 'Checked ' + new Date(checkedAt).toLocaleTimeString();
      status.title = status.textContent = (message || (phase === 'answering' ? 'Answering · ' : '') + checked) + ' · ' + (source || '');
      if (!watching && message) notice(message, 'error');
    });
    $('question').addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
      event.preventDefault();
      if (!$('submit').hidden) $('askForm').requestSubmit();
    });
    $('askForm').addEventListener('submit', safely(() => practice ? (notice('Response ready. Select Finish practice for feedback.'), undefined)
      : ask($('question').value.trim(), { screenshots: Boolean(frames.length), fromInput: true })));
    $('cancel').addEventListener('click', safely(async () => { $('cancel').disabled = true; await api.cancel(); }));
    $('newChat').addEventListener('click', safely(async () => {
      void api.clearNotchAnswer?.().catch(() => {});
      turns = []; frames = []; paintChat(); paintFrames(); await persist();
      $('question').focus(); notice('New chat started', 'good');
    }));
    for (const id of ['providerStatus', 'openSettings', 'answerSettings']) $(id).addEventListener('click', openSettings);
    $('closeWindow').addEventListener('click', safely(api.close));
    $('minimizeWindow').addEventListener('click', safely(api.minimize));
    $('workspaceSize').addEventListener('click', safely(api.toggleWorkspaceSize));
    $('hidePanel').addEventListener('click', safely(api.hide));
    $('listen').addEventListener('click', safely(toggleListening));
    $('answerTranscript').addEventListener('click', safely(() => askTranscript()));
    $('recap').addEventListener('click', safely(() => askTranscript(true)));
    $('screenButton').addEventListener('click', safely(() => selectSource(null)));
    $('askScreen').addEventListener('click', safely(analyzeScreen));
    $('takeScreen').addEventListener('click', safely(takeScreen));
    $('refreshScreens').addEventListener('click', safely(refreshSources));
    $('openScreenPrivacy').addEventListener('click', safely(() => api.openPrivacy('screen')));
    $('practice').addEventListener('click', safely(togglePractice));
    $('autoAnswer').addEventListener('click', () => {
      auto = !auto;
      $('autoAnswer').setAttribute('aria-pressed', String(auto));
      $('autoAnswer').querySelector('.copilot-label').textContent = auto ? 'Copilot on' : 'Copilot off';
      if (auto) notice(settings.engine === 'apple' ? 'Copilot answers transcript questions on this Mac.' : 'Copilot can send transcript questions to your provider.');
    });
    $('copy').addEventListener('click', safely(async () => { await api.copy(plainAnswer(lastAnswer())); notice('Answer copied', 'good'); }));
    $('read').addEventListener('click', () => {
      if (speechSynthesis.speaking) { speechSynthesis.cancel(); return; }
      const line = new SpeechSynthesisUtterance(plainAnswer(lastAnswer()).slice(0, 7000));
      speechSynthesis.speak(line);
    });
    $('export').addEventListener('click', safely(exportNotes));
    for (const button of document.querySelectorAll('[data-close]')) button.addEventListener('click', () => $(button.dataset.close).close());
    api.onAction((action) => {
      if (action === 'focus-question') $('question').focus({ preventScroll: true });
      else if (action === 'stealth') showStealthSetup();
      else if (action?.settings) {
        applySettings(action.settings);
        if (action.reset) { workspaceRevision = action.workspaceRevision; resetWorkspace(); }
      }
      else if (action?.notice) notice(action.notice, 'error');
    });
  }
  async function boot() {
    const result = await api.boot();
    workspaceRevision = result.workspaceRevision;
    turns = Array.isArray(result.workspace.turns) ? result.workspace.turns : [];
    transcript = Array.isArray(result.workspace.transcript) ? result.workspace.transcript : [];
    applySettings(result.settings);
    wire();
    paintChat(); paintTranscript();
    if (result.notice) notice(result.notice, 'error');
    await api.workspaceReady(matchMedia('(prefers-reduced-motion: reduce)').matches);
  }
  void boot().catch((error) => notice(error.message, 'error'));
})();
