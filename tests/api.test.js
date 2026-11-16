const assert = require('node:assert/strict');
const { test } = require('node:test');
const http = require('node:http');
const { DEFAULTS, mergeSettings, restoreSettings, providerFor, publicSettings, answerEngine } = require('../src/configuration');
const { streamAnswer, sseData, testProvider, transcribe } = require('../src/provider');
const { OPENROUTER, answerBlocks, answerPresentation, plainAnswer } = require('../src/shared');
const { makeQuery } = require('../src/apple-answer');

async function serve(t, handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return 'http://127.0.0.1:' + server.address().port + '/v1';
}

test('credentials stay bound to their provider origin and are omitted from renderer settings', () => {
  const earlier = mergeSettings(DEFAULTS, { apiKey: 'example-main', transcribeBaseUrl: 'https://audio.example/v1' });
  assert.equal(providerFor(earlier, 'audio').key, '');
  assert.equal(publicSettings(earlier).apiKeySaved, true);
  assert.equal(Object.hasOwn(publicSettings(earlier), 'apiKey'), false);
  assert.equal(mergeSettings(earlier, { baseUrl: 'https://a.example/v1' }).apiKey, '');
  assert.equal(mergeSettings(earlier, { baseUrl: 'https://api.openai.com/v2/' }).apiKey, 'example-main');
  assert.throws(() => mergeSettings(DEFAULTS, { baseUrl: 'http://remote.example/v1' }), /HTTPS/);
});

test('the new glass default replaces the old default while respecting custom opacity', () => {
  assert.equal(restoreSettings({ opacity: 0.89 }).opacity, 0.62);
  assert.equal(restoreSettings({ opacity: 0.74 }).opacity, 0.74);
  const explicit = mergeSettings(DEFAULTS, { opacity: 0.89 });
  assert.equal(restoreSettings(explicit).opacity, 0.89);
});

test('a short opening line is kept whole above the explanation', () => {
  const lead = 'Optimistic checks at save time. Pessimistic locks first.';
  const detail = 'Compare the version before saving.';
  assert.deepEqual(answerPresentation(lead + '\n\n' + detail), { lead, detail });
});

test('response levels migrate legacy preferences and validate persisted values', () => {
  assert.equal(DEFAULTS.responseLevel, 'concise');
  const detailed = mergeSettings(DEFAULTS, { style: 'detail' });
  assert.equal(detailed.responseLevel, 'full');
  assert.equal(detailed.style, 'smart');
  assert.equal(mergeSettings(DEFAULTS, { style: 'brief' }).responseLevel, 'concise');
  assert.equal(mergeSettings(DEFAULTS, { style: 'detail', responseLevel: 'direct' }).responseLevel, 'direct');
  assert.equal(mergeSettings(detailed, { responseLevel: ['direct'] }).responseLevel, 'full');
  const selected = mergeSettings(detailed, { responseLevel: 'direct', style: 'star', dockAtNotch: false });
  assert.equal(publicSettings(selected).responseLevel, 'direct');
  assert.equal(selected.style, 'star');
  assert.equal(DEFAULTS.dockAtNotch, true);
  assert.equal(mergeSettings(selected, { dockAtNotch: 'true' }).dockAtNotch, false);
  assert.equal(mergeSettings(DEFAULTS, selected).responseLevel, 'direct');
});

test('answer formatting renders real emphasis and preserves literals inside code', () => {
  const text = '**Answer:** `2**3` is __8__.\n```python\nprint(2**3)\n```';
  assert.deepEqual(answerBlocks(text), [
    { type: 'strong', text: 'Answer:' }, { type: 'text', text: ' ' },
    { type: 'inline-code', text: '2**3' }, { type: 'text', text: ' is ' },
    { type: 'strong', text: '8' }, { type: 'text', text: '.\n' },
    { type: 'code', text: 'print(2**3)' }
  ]);
  assert.equal(plainAnswer(text), 'Answer: 2**3 is 8.\nprint(2**3)');
  assert.equal(plainAnswer('**Answer still streaming'), 'Answer still streaming');
  assert.equal(plainAnswer('***A finished answer***'), 'A finished answer');
  assert.equal(plainAnswer('The literal 2**3 is unchanged.'), 'The literal 2**3 is unchanged.');
});

function watchClock(t) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  return async (ms) => {
    t.mock.timers.tick(ms);
    await new Promise((resolve) => setImmediate(resolve));
  };
}

test('an OpenRouter key cannot be sent to the default OpenAI endpoint', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 401 }));
  const settings = mergeSettings(DEFAULTS, { apiKey: 'sk-or-v1-fixture' });
  await assert.rejects(testProvider(settings), /OpenRouter key requires https:\/\/openrouter\.ai\/api\/v1/);
  assert.equal(fetch.mock.callCount(), 0);
});

test('OpenRouter rejects an invalid key before loading its public catalog', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async (url) => {
    if (url.endsWith('/key')) return new Response(null, { status: 401 });
    return Response.json({ data: [{ id: OPENROUTER.chatModel }] });
  });
  const settings = mergeSettings(DEFAULTS, { ...OPENROUTER, apiKey: 'sk-or-v1-invalid' });
  await assert.rejects(testProvider(settings), /API key was rejected/);
  assert.deepEqual(fetch.mock.calls.map((call) => call.arguments[0]), [OPENROUTER.baseUrl + '/key']);
});

function fakeOpenRouter(t, respond) {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, OPENROUTER.baseUrl + '/chat/completions');
    assert.equal(options.headers.Authorization, 'Bearer sk-or-v1-fixture');
    const request = JSON.parse(options.body);
    assert.equal(Object.hasOwn(request, 'models'), false);
    calls.push(request);
    return respond(request, options.signal);
  });
  return calls;
}

const routerSettings = (model = OPENROUTER.chatModel) => mergeSettings(DEFAULTS, {
  ...OPENROUTER, apiKey: 'sk-or-v1-fixture', chatModel: model
});

test('all response levels reach the provider and preserve optional format outside Direct', async (t) => {
  const calls = fakeOpenRouter(t, () => Response.json({ choices: [{ message: { content: 'A short answer.' } }] }));
  const { signal } = new AbortController();
  for (const level of ['direct', 'concise', 'full']) {
    const settings = mergeSettings(routerSettings(), { responseLevel: level, style: 'star' });
    await streamAnswer(settings, { question: 'What improved?' }, [], () => {}, signal);
  }
  const [direct, concise, full] = calls.map(({ messages }) => messages[0].content);
  assert.match(direct, /output only the chosen letter/i);
  assert.doesNotMatch(direct, /Situation, Task/);
  assert.match(concise, /one to three short sentences.*Situation, Task/);
  assert.match(full, /complete explanation.*Situation, Task/);
});

test('Direct emits only selected letters for typed choices, OCR, and explicit image choices', async (t) => {
  let content;
  fakeOpenRouter(t, () => new Response([
    'data: ' + JSON.stringify({ choices: [{ delta: { content: content.slice(0, 5) } }] }),
    'data: ' + JSON.stringify({ choices: [{ delta: { content: content.slice(5) }, finish_reason: 'stop' }] }),
    'data: [DONE]'
  ].join('\n\n')));
  const settings = mergeSettings(routerSettings(), { responseLevel: 'direct' });
  const jpeg = { url: 'data:image/jpeg;base64,AA==' };
  const options = 'A) Blue\n(B) Green\nC. Red\nD: Purple';
  const cases = [
    ['Which color is the grass?\n' + options, [], '**B. Green**', 'B'],
    ['Select all that apply.', [{ ...jpeg, text: options }], '**Final answer: A, B, and D.**', 'A, B, D'],
    ['Which numbers are prime? Select all. A)4 B)5 C)6 D)7', [], 'B and D because both are prime.', 'B, D'],
    ['Answer the question in the image.', [jpeg], 'Correct option: (C) Red', 'C'],
    ['Answer the question in the image.', [jpeg], 'B) Four', 'B'],
    ['Answer the question in the image.', [jpeg], 'B. Four', 'B'],
    ['Identify the surname.', [], 'B. Franklin', 'B. Franklin'],
    ['Identify the name shown in the image.', [jpeg], 'B. Franklin', 'B. Franklin'],
    ['Which color is the grass?\n' + options, [], '(B) is not the answer.', '(B) is not the answer.'],
    ['What is the status?', [], '**Ready**\n  All set.', 'Ready All set.'],
    ['Read the screen.', [jpeg], 'NO_VISIBLE_QUESTION', 'NO_VISIBLE_QUESTION']
  ];
  for (const [question, frames, raw, expected] of cases) {
    content = raw;
    const pieces = [];
    const answer = await streamAnswer(settings, { question }, frames, (value) => pieces.push(value), new AbortController().signal);
    assert.equal(answer, expected, raw);
    assert.deepEqual(pieces, [expected], raw);
  }
});

test('Direct preserves an interrupted reply and suppresses a filtered reply before publication', async (t) => {
  let terminalEvent = '';
  const calls = fakeOpenRouter(t, () => new Response(
    'data: {"choices":[{"delta":{"content":"Answer: B."}}]}\n\n' + terminalEvent
  ));
  const settings = mergeSettings(routerSettings(), { responseLevel: 'direct' });
  const input = { question: 'Choose the color of grass. A) Blue B) Green' };
  const pieces = [];
  const emit = (text) => pieces.push(text);
  const { signal } = new AbortController();
  await assert.rejects(streamAnswer(settings, input, [], emit, signal), /connection closed before the answer finished/);
  assert.deepEqual(pieces, ['Answer: B.']);
  terminalEvent = 'data: {"choices":[{"delta":{},"finish_reason":"content_filter"}]}\n\n';
  pieces.length = 0;
  await assert.rejects(streamAnswer(settings, input, [], emit, signal), /declined/);
  assert.deepEqual(pieces, []);
  assert.equal(calls.length, 2);
});

test('OpenRouter changes models on image incompatibility and empty replies, reusing the same screenshot and key', async (t) => {
  const calls = fakeOpenRouter(t, ({ model }) => {
    if (model === 'example/text-only') {
      return Response.json({ error: { message: 'This model doesn’t support image inputs.' } }, { status: 400 });
    }
    if (model === OPENROUTER.chatModel) {
      return new Response('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    }
    return Response.json({ choices: [{ message: { content: 'Result from the backup.' } }] });
  });
  const url = 'data:image/jpeg;base64,AA==';
  const pieces = [];
  let retries = 0;
  const answer = await streamAnswer(routerSettings('example/text-only'), { question: 'Read the label.' }, [{ url }],
    (text) => pieces.push(text), new AbortController().signal, () => retries++);
  assert.deepEqual(calls.map(({ model }) => model), ['example/text-only', OPENROUTER.chatModel, 'google/gemini-3.1-flash-lite']);
  assert.ok(calls.every(({ messages }) => messages.at(-1).content[1].image_url.url === url));
  assert.equal(retries, 2);
  assert.equal(answer, 'Result from the backup.');
  assert.deepEqual(pieces, [answer]);
});

test('automatic backups for a free OpenRouter model stay free', async (t) => {
  const calls = fakeOpenRouter(t, () => Response.json({ error: { code: 503 } }, { status: 503 }));
  await assert.rejects(streamAnswer(routerSettings('example/unavailable:free'), { question: 'Hello' }, [], () => {}, new AbortController().signal), /503/);
  assert.equal(calls.length, 3);
  assert.ok(calls.every(({ model }) => model.endsWith(':free')));
});

test('moderation, structured refusals, credentials and credit errors are terminal', async (t) => {
  let response;
  const calls = fakeOpenRouter(t, () => response);
  const fixtures = [
    [Response.json({ error: { metadata: { error_type: 'content_policy_violation' } } }, { status: 502 }), /declined/],
    [Response.json({ choices: [{ message: { refusal: 'Declined.' } }] }), /declined/],
    [Response.json({ choices: [{ message: { content: '' }, native_finish_reason: 'IMAGE_SAFETY' }] }), /declined/],
    [Response.json({ choices: [{ message: { content: '' }, native_finish_reason: 'SPII' }] }), /declined/],
    [Response.json({ error: { code: 403 } }, { status: 403 }), /access/],
    [Response.json({ error: { code: 401 } }, { status: 401 }), /key was rejected/],
    [Response.json({ error: { code: 402 } }, { status: 402 }), /insufficient credits/],
    [Response.json({ error: { code: 429, metadata: { limit_source: 'openrouter_free_tier_daily' } } }, { status: 429 }), /rate limit/],
    [Response.json({ error: { code: 'billing_hard_limit_reached' } }, { status: 429 }), /rate limit/]
  ];
  for (const [index, [fixture, message]] of fixtures.entries()) {
    response = fixture;
    await assert.rejects(streamAnswer(routerSettings(), { question: 'Fixture' }, [], () => {}, new AbortController().signal), message);
    assert.equal(calls.length, index + 1);
  }
});

test('a streamed content filter clears partial text and never invokes a backup', async (t) => {
  const calls = fakeOpenRouter(t, () => new Response([
    'data: {"choices":[{"delta":{"content":"Partial text."}}]}',
    'data: {"choices":[{"delta":{},"finish_reason":"content_filter"}]}',
    'data: [DONE]'
  ].join('\n\n')));
  const pieces = [];
  await assert.rejects(streamAnswer(routerSettings(), { question: 'Fixture' }, [], (text, replace) => pieces.push([text, replace]),
    new AbortController().signal), /declined/);
  assert.equal(calls.length, 1);
  assert.deepEqual(pieces, [['Partial text.', undefined], ['', true]]);
});

test('a stream that ends midway leaves a partial answer and does not send it to a backup', async (t) => {
  const calls = fakeOpenRouter(t, () => new Response('data: {"choices":[{"delta":{"content":"A partial answer"}}]}\n\n'));
  const pieces = [];
  await assert.rejects(streamAnswer(routerSettings(), { question: 'Fixture' }, [], (text) => pieces.push(text),
    new AbortController().signal), /connection closed before the answer finished/);
  assert.deepEqual(pieces, ['A partial answer']);
  assert.equal(calls.length, 1);
});

test('a stalled model times out before first text and stopping prevents any further request', async (t) => {
  const advance = watchClock(t);
  const calls = fakeOpenRouter(t, ({ model }, signal) => {
    if (model === OPENROUTER.chatModel) {
      return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    }
    return Response.json({ choices: [{ message: { content: 'Backup completed.' } }] });
  });
  const answer = streamAnswer(routerSettings(), { question: 'Fixture' }, [], () => {}, new AbortController().signal);
  await advance(29_999);
  assert.equal(calls.length, 1);
  await advance(1);
  assert.equal(await answer, 'Backup completed.');
  assert.equal(calls.length, 2);

  const controller = new AbortController();
  const cancelled = streamAnswer(routerSettings(), { question: 'Fixture' }, [], () => {}, controller.signal);
  const done = assert.rejects(cancelled, { name: 'AbortError' });
  controller.abort();
  await done;
  assert.equal(calls.length, 3);
});

test('one OpenRouter key can verify setup, answer image questions, and route both audio formats', async (t) => {
  const settings = mergeSettings(DEFAULTS, { ...OPENROUTER, apiKey: 'sk-or-v1-fixture' });
  const fetch = t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(options.headers.Authorization, 'Bearer ' + settings.apiKey);
    if (url === OPENROUTER.baseUrl + '/key') return Response.json({ data: { is_management_key: false } });
    if (url === OPENROUTER.baseUrl + '/models') return Response.json({ data: [{ id: OPENROUTER.chatModel }] });
    if (url === OPENROUTER.baseUrl + '/chat/completions') {
      return Response.json({ choices: [{ message: { content: 'Orchard 4729' } }] });
    }
    assert.equal(url, OPENROUTER.baseUrl + '/audio/transcriptions');
    return Response.json({ text: 'Transcript result.' });
  });
  assert.deepEqual(await testProvider(settings), { models: [OPENROUTER.chatModel], keyVerified: true });
  assert.deepEqual(fetch.mock.calls.slice(0, 2).map((call) => [call.arguments[0], call.arguments[1].method]), [
    [OPENROUTER.baseUrl + '/key', 'GET'], [OPENROUTER.baseUrl + '/models', 'GET']
  ]);

  const { signal } = new AbortController();
  const url = 'data:image/jpeg;base64,AA==';
  const answer = await streamAnswer(settings, { question: 'What is the label?' }, [{ url }], () => {}, signal);
  assert.equal(answer, 'Orchard 4729');
  const chat = JSON.parse(fetch.mock.calls[2].arguments[1].body);
  assert.equal(chat.model, OPENROUTER.chatModel);
  assert.deepEqual(chat.messages.at(-1).content[1], { type: 'image_url', image_url: { url } });

  const clip = new Uint8Array([1, 2, 3]).buffer;
  assert.equal(await transcribe(settings, clip, 'audio/webm;codecs=opus', signal), 'Transcript result.');
  assert.equal(await transcribe(settings, clip, 'audio/wav', signal), 'Transcript result.');
  for (const [index, filename] of [[3, 'clip.webm'], [4, 'clip.wav']]) {
    const audio = fetch.mock.calls[index].arguments[1].body;
    assert.equal(audio.get('model'), OPENROUTER.transcribeModel);
    assert.equal(audio.get('file').name, filename);
  }
});

test('unconfigured installs use Apple Intelligence and an explicit local choice never routes to a provider', () => {
  assert.equal(answerEngine(DEFAULTS), 'apple');
  assert.equal(answerEngine(mergeSettings(DEFAULTS, { answerMode: 'provider' })), 'unconfigured');
  const configured = mergeSettings(DEFAULTS, { apiKey: 'example-provider' });
  assert.equal(answerEngine(configured), 'provider');
  assert.equal(answerEngine(mergeSettings(configured, { answerMode: 'apple' })), 'apple');
});

test('on-device screen questions include the pixels where supported, otherwise require readable text', () => {
  const question = { question: 'What is the label?' };
  const screenshot = { url: 'data:image/jpeg;base64,AA==', text: 'Orchard 4729' };
  assert.deepEqual(makeQuery(DEFAULTS, question, [screenshot], true).images, ['AA==']);
  const textOnly = makeQuery(DEFAULTS, question, [screenshot], false);
  assert.deepEqual(textOnly.images, []);
  assert.match(textOnly.prompt, /Orchard 4729/);
  assert.throws(() => makeQuery(DEFAULTS, question, [{ ...screenshot, text: '' }], false), /No readable text/);
  assert.throws(() => makeQuery(DEFAULTS, question, [screenshot, screenshot, screenshot], true), /up to 2 screenshots/);
});

test('Apple Intelligence receives Direct for vision, and Full can use a larger answer budget', () => {
  const question = { question: 'Read the question and answer.' };
  const screenshot = { url: 'data:image/jpeg;base64,AA==', text: 'A) Blue\nB) Green' };
  const direct = makeQuery(mergeSettings(DEFAULTS, { responseLevel: 'direct', style: 'code' }), question, [screenshot], true);
  assert.match(direct.instructions, /output only the chosen letter/);
  assert.doesNotMatch(direct.instructions, /Start with working code/);
  assert.deepEqual(direct.images, ['AA==']);
  const full = makeQuery(mergeSettings(DEFAULTS, { responseLevel: 'full' }), question, [], false);
  assert.match(full.instructions, /complete explanation/);
  assert.ok(full.maximumResponseTokens > direct.maximumResponseTokens);
});

test('long transcript questions keep the instruction and the most recent lines', () => {
  const query = makeQuery(DEFAULTS, {
    question: 'Answer the last question.\n' + 'Earlier lines. '.repeat(400) + '\nWhat is Fern-4829?'
  }, [], false);
  assert.match(query.prompt, /Answer the last question/);
  assert.match(query.prompt, /What is Fern-4829\?/);
});

test('SSE handles chunks split in UTF-8 and a final event without a newline', async () => {
  const lines = Buffer.from('event: ignored\r\ndata: café\r\n\r\ndata: tail');
  const items = [];
  async function* chunks() {
    yield lines.subarray(0, lines.indexOf(0xc3) + 1);
    yield lines.subarray(lines.indexOf(0xc3) + 1);
  }
  for await (const item of sseData(chunks())) items.push(item);
  assert.deepEqual(items, ['café', 'tail']);
});

test('a real failing completion can fall back with a separate key and image context', async (t) => {
  let requests = 0;
  const baseUrl = await serve(t, (_req, res) => { requests++; res.writeHead(503).end(); });
  let captured;
  const backupBaseUrl = await serve(t, async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    captured = { authorization: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks)) };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"Anotch "}}]}\n\n');
    res.end('data: {"choices":[{"delta":{"content":"works."}}]}\n\ndata: [DONE]\n\n');
  });
  const settings = mergeSettings(DEFAULTS, {
    baseUrl, apiKey: 'example-main', backupBaseUrl, backupApiKey: 'example-backup', backupModel: 'test-vision'
  });
  const pieces = [];
  const answer = await streamAnswer(settings, { question: 'What is this?', turns: [] },
    [{ url: 'data:image/jpeg;base64,AA==', text: 'Anotch fixture OCR' }], (value) => pieces.push(value), new AbortController().signal);
  assert.equal(requests, 1);
  assert.equal(captured.authorization, 'Bearer example-backup');
  assert.equal(captured.body.model, 'test-vision');
  const imageMessage = captured.body.messages.at(-1).content;
  assert.match(imageMessage[0].text, /Anotch fixture OCR/);
  assert.equal(imageMessage[1].image_url.url, 'data:image/jpeg;base64,AA==');
  assert.equal(answer, 'Anotch works.');
  assert.deepEqual(pieces, ['Anotch ', 'works.']);
});

test('a response cannot redirect the request to another provider', async (t) => {
  let received = false;
  const redirected = await serve(t, (_req, res) => { received = true; res.writeHead(500).end(); });
  const baseUrl = await serve(t, (_req, res) => res.writeHead(307, { location: redirected + '/chat/completions' }).end());
  const settings = mergeSettings(DEFAULTS, { baseUrl, apiKey: 'example-main' });
  await assert.rejects(streamAnswer(settings, { question: 'Hello' }, [], () => {}, new AbortController().signal), /Could not reach/);
  assert.equal(received, false);
});

test('transcription sends one standard multipart clip to the configured audio provider', async (t) => {
  let posted;
  const url = await serve(t, async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    posted = { url: req.url, key: req.headers.authorization, body: Buffer.concat(chunks).toString() };
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ text: '  Transcript result.  ' }));
  });
  const settings = mergeSettings(DEFAULTS, { transcribeBaseUrl: url, transcribeApiKey: 'example-audio' });
  const result = await transcribe(settings, new Uint8Array([1, 2, 3]).buffer, 'audio/webm;codecs=opus', new AbortController().signal);
  assert.equal(result, 'Transcript result.');
  assert.equal(posted.url, '/v1/audio/transcriptions');
  assert.equal(posted.key, 'Bearer example-audio');
  assert.match(posted.body, /filename="clip.webm"/);
  assert.match(posted.body, /gpt-transcribe/);
});

test('transcription distinguishes a silent clip from an error envelope or malformed response', async (t) => {
  let result;
  t.mock.method(globalThis, 'fetch', async () => Response.json(result));
  const settings = mergeSettings(DEFAULTS, { transcribeBaseUrl: 'http://localhost:4321/v1' });
  const clip = new Uint8Array([0, 1, 2]).buffer;
  const transcribeClip = () => transcribe(settings, clip, 'audio/wav', new AbortController().signal);
  result = { text: '' };
  assert.equal(await transcribeClip(), '');
  result = { error: { code: 502, message: 'Provider error with untrusted details' } };
  await assert.rejects(transcribeClip(), /provider returned an error \(502\)/);
  result = {};
  await assert.rejects(transcribeClip(), /unreadable response/);
});
