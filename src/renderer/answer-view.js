(() => {
  function appendFormatted(node, text) {
    for (const part of answerBlocks(text)) {
      if (part.type === 'text') { node.append(part.text); continue; }
      const body = document.createElement(part.type === 'strong' ? 'strong' : 'code');
      body.textContent = part.text;
      const parent = part.type === 'code' ? node.appendChild(document.createElement('pre')) : node;
      parent.append(body);
    }
  }

  function renderAnswer(node, text) {
    const choice = isChoiceAnswer(text);
    node.classList.toggle('choice-answer', choice);
    if (choice) { node.textContent = text.trim(); return; }
    const { lead, detail } = answerPresentation(text);
    node.replaceChildren();
    for (const [name, section] of [['answer-lead', lead], ['answer-detail', detail]]) {
      if (!section) continue;
      const part = document.createElement('div');
      part.className = name;
      appendFormatted(part, section);
      node.append(part);
    }
  }

  function chatEntry(role, text) {
    const node = document.createElement('div');
    node.className = 'chat-entry ' + role;
    if (role === 'assistant') renderAnswer(node, text);
    else node.textContent = text;
    return node;
  }

  function paintMessages(answer, asked, turns, active, emptyAnswer) {
    const latestQuestion = active ? -1 : turns.findLastIndex(turn => turn.role === 'user');
    const content = turns.flatMap((turn, index) => index === latestQuestion ? [] : [chatEntry(turn.role, turn.content)]);
    if (active) {
      active.node = chatEntry('assistant', active.answer);
      content.push(active.node);
    }
    const question = active?.title || turns[latestQuestion]?.content || '';
    asked.hidden = !question;
    asked.textContent = question ? 'Asked: ' + question.trim().split(/\r?\n/, 1)[0] : '';
    asked.title = question;
    answer.replaceChildren(...(content.length ? content : [emptyAnswer.cloneNode(true)]));
  }

  window.anotchAnswer = { paintMessages, renderAnswer };
})();
