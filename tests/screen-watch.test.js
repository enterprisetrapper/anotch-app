const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createScreenWatch } = require('../src/screen-watch');

function watchClock(t) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  return async (ms) => {
    t.mock.timers.tick(ms);
    await new Promise((resolve) => setImmediate(resolve));
  };
}

test('screen watch sends only stable changed content and keeps no-question results out of the chat', async (t) => {
  const advance = watchClock(t);
  const source = 'window:14:200';
  let frame = { text: 'Question one', url: 'first-image', thumbnail: Buffer.alloc(400, 100) };
  const submitted = [];
  const answers = [];
  const watch = createScreenWatch({
    canCapture: () => true,
    capture: async (id) => { assert.equal(id, source); return frame; },
    answer: async ({ text }) => {
      submitted.push(text);
      return { answer: text === 'Question one' ? '**First answer**' : '**NO_VISIBLE_QUESTION**' };
    },
    onStatus: () => {}, onAnswer: (answer) => answers.push(answer)
  });
  await watch.start(source);
  await advance(0);
  assert.deepEqual(submitted, []);
  await advance(2000);
  const subtleChange = Buffer.alloc(400, 100);
  subtleChange[0] = 124;
  frame = { text: ' Question  one ', url: 'changed-animation', thumbnail: subtleChange };
  await advance(2000);
  assert.deepEqual(submitted, ['Question one']);
  frame = { text: 'An empty document', url: 'other-image' };
  await advance(2000);
  assert.deepEqual(answers, ['**First answer**']);
  assert.deepEqual(submitted, ['Question one']);
  await advance(2000);
  await advance(2000);
  assert.deepEqual(submitted, ['Question one', 'An empty document']);
  assert.deepEqual(answers, ['**First answer**']);
  watch.stop();
});

test('stopping a watch aborts its answer and discards any late provider response', async (t) => {
  const advance = watchClock(t);
  let activeSignal;
  let resolveAnswer;
  const answers = [];
  const statuses = [];
  const watch = createScreenWatch({
    canCapture: () => true, capture: async () => ({ text: 'A visible question', url: 'image' }),
    answer: (_frame, signal) => new Promise((resolve) => { activeSignal = signal; resolveAnswer = resolve; }),
    onStatus: (state) => statuses.push(state.active), onAnswer: (answer) => answers.push(answer)
  });
  await watch.start('screen:1:0');
  await advance(0);
  await advance(2000);
  watch.stop();
  assert.equal(activeSignal.aborted, true);
  resolveAnswer({ answer: 'Late answer' });
  await advance(50_000);
  assert.deepEqual(answers, []);
  assert.equal(statuses.at(-1), false);
  assert.ok(statuses.slice(0, -1).every(Boolean));
});

test('screen watch notices visual changes with identical OCR and discards stale answers', async (t) => {
  const advance = watchClock(t);
  const answers = [];
  const frame = (color) => ({ text: 'What color is the chart?', url: String(color), thumbnail: Buffer.alloc(400, color) });
  let screen = frame(40);
  let requests = 0;
  const watch = createScreenWatch({
    cooldown: 0, canCapture: () => true, capture: async () => screen,
    answer: async ({ url }) => {
      requests++;
      if (url === '130') screen = frame(220);
      return { answer: 'Chart color ' + url };
    },
    onStatus: () => {}, onAnswer: (answer) => answers.push(answer)
  });
  await watch.start('window:14:200');
  await advance(0);
  await advance(2000);
  await advance(2000);
  screen = frame(130);
  await advance(2000);
  await advance(2000);
  assert.deepEqual(answers, ['Chart color 40']);
  assert.equal(requests, 2);
  await advance(2000);
  await advance(2000);
  await advance(2000);
  assert.deepEqual(answers, ['Chart color 40', 'Chart color 220']);
  watch.stop();
});

test('a capture failure stops the watch with the original reason', async (t) => {
  const advance = watchClock(t);
  const statuses = [];
  let captures = 0;
  const watch = createScreenWatch({
    canCapture: () => true,
    capture: async () => { captures++; throw new Error('The chosen window closed.'); },
    answer: () => assert.fail('A failed capture must not reach the answer provider.'),
    onStatus: (state) => statuses.push(state), onAnswer: () => assert.fail('No answer expected.')
  });
  await watch.start('window:14:200');
  await advance(0);
  await advance(30_000);
  assert.equal(captures, 1);
  assert.equal(statuses[0].active, true);
  assert.deepEqual(statuses.at(-1), { active: false, message: 'The chosen window closed.' });
});

test('screen watch ignores a moving timer and keeps reading while an earlier request is pending', async (t) => {
  const advance = watchClock(t);
  let visible = 'What is 8 plus 7?';
  let reads = 0;
  let resolveFirst;
  const requests = [];
  const answers = [];
  const watch = createScreenWatch({
    cooldown: 0, canCapture: () => true,
    capture: async () => ({ text: visible + '\nElapsed ' + ++reads + ' seconds', url: 'moving pixels ' + reads }),
    answer: ({ text }) => {
      requests.push(text.split('\n')[0]);
      if (requests.length === 1) return new Promise((resolve) => { resolveFirst = resolve; });
      return { answer: '16' };
    },
    onStatus: () => {}, onAnswer: (answer) => answers.push(answer)
  });
  await watch.start('screen:1:0', 'Main display');
  await advance(0);
  await advance(2000);
  assert.deepEqual(requests, ['What is 8 plus 7?']);
  visible = 'What is 9 plus 7?';
  await advance(2000);
  await advance(2000);
  assert.equal(reads, 4);
  assert.equal(requests.length, 1);
  resolveFirst({ answer: '15' });
  await advance(0);
  await advance(2000);
  await advance(2000);
  assert.deepEqual(requests, ['What is 8 plus 7?', 'What is 9 plus 7?']);
  assert.deepEqual(answers, ['16']);
  watch.stop();
});

test('screen watch keeps its source selected when it briefly goes out of view', async (t) => {
  const advance = watchClock(t);
  let hidden = true;
  const states = [];
  const results = [];
  const watch = createScreenWatch({
    canCapture: () => true,
    capture: async (id) => {
      assert.equal(id, 'window:14:200');
      if (hidden) throw Object.assign(new Error('Bring the window into view.'), { retryCapture: true });
      return { text: 'What is visible?', url: 'fixture' };
    },
    answer: async () => ({ answer: 'The window is back.' }),
    onStatus: (state) => states.push(state), onAnswer: (answer) => results.push(answer)
  });
  await watch.start('window:14:200', 'Fixture');
  await advance(0);
  assert.equal(states.at(-1).active, true);
  assert.equal(states.at(-1).phase, 'waiting');
  hidden = false;
  await advance(2000);
  await advance(2000);
  await advance(2000);
  assert.equal(states.at(-1).source, 'Fixture');
  assert.equal(states.at(-1).phase, 'watching');
  assert.deepEqual(results, ['The window is back.']);
  watch.stop();
});

test('changed context under the same question gets a fresh answer even when the thumbnail matches', async (t) => {
  const advance = watchClock(t);
  let count = 2;
  const answers = [];
  const watch = createScreenWatch({
    cooldown: 0, canCapture: () => true,
    capture: async () => ({ text: 'What is the quantity?\nCount: ' + count, url: 'same thumbnail' }),
    answer: async ({ text }) => ({ answer: text.match(/Count: (\d+)/)[1] }),
    onStatus: () => {}, onAnswer: (answer) => answers.push(answer)
  });
  await watch.start('screen:1:0');
  await advance(0);
  await advance(2000);
  await advance(2000);
  count = 3;
  await advance(2000);
  await advance(2000);
  await advance(2000);
  assert.deepEqual(answers, ['2', '3']);
  watch.stop();
});

test('a provider outage allows one delayed retry and monitoring continues on the next question', async (t) => {
  const advance = watchClock(t);
  let question = 'What is visible in the first scene?';
  let requests = 0;
  const answers = [];
  const watch = createScreenWatch({
    canCapture: () => true, capture: async () => ({ text: question, url: 'fixture' }),
    answer: async () => {
      if (++requests < 3) throw Object.assign(new Error('Temporary provider outage.'), { retry: true });
      return { answer: 'The next question worked.' };
    },
    onStatus: () => {}, onAnswer: (answer) => answers.push(answer)
  });
  await watch.start('screen:1:0');
  await advance(0);
  for (let i = 0; i < 7; i++) await advance(2000);
  assert.equal(requests, 2);
  question = 'What changed in the next scene?';
  for (let i = 0; i < 3; i++) await advance(2000);
  assert.equal(requests, 3);
  assert.deepEqual(answers, ['The next question worked.']);
  watch.stop();
});

test('changing small numbers still require a fresh answer when pixels look stable', async (t) => {
  const advance = watchClock(t);
  let count = 51;
  const sent = [];
  const shown = [];
  const watch = createScreenWatch({
    cooldown: 0, canCapture: () => true,
    capture: async () => ({ text: 'What is the count?\nCount: ' + count, url: 'nearly identical pixels' }),
    answer: async ({ text }) => {
      const value = text.match(/Count: (\d+)/)[1];
      sent.push(value);
      return { answer: value };
    },
    onStatus: () => {}, onAnswer: (answer) => shown.push(answer)
  });
  await watch.start('screen:1:0');
  await advance(0);
  count = 52;
  await advance(2000);
  count = 53;
  await advance(2000);
  await advance(2000);
  await advance(2000);
  assert.deepEqual(sent, ['52', '53']);
  assert.deepEqual(shown, ['53']);
  watch.stop();
});
