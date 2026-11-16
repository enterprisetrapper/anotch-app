const { plainAnswer } = require('./shared');
const SETTINGS_VERSION = 1;

const DEFAULTS = Object.freeze({
  answerMode: 'auto',
  baseUrl: 'https://api.openai.com/v1',
  chatModel: 'gpt-4o-mini',
  apiKey: '',
  transcribeBaseUrl: '',
  transcribeModel: 'gpt-transcribe',
  transcribeApiKey: '',
  backupBaseUrl: '',
  backupModel: '',
  backupApiKey: '',
  responseLevel: 'concise',
  style: 'smart',
  language: '',
  background: '',
  notes: '',
  keepHistory: true,
  ocr: true,
  float: true,
  dockAtNotch: true,
  opacity: 0.62,
  settingsVersion: SETTINGS_VERSION
});
const CREDENTIALS = { apiKey: 'baseUrl', transcribeApiKey: 'transcribeBaseUrl', backupApiKey: 'backupBaseUrl' };
const TEXT_LIMITS = { chatModel: 180, transcribeModel: 180, backupModel: 180, language: 100, background: 6000, notes: 16000 };
const STYLES = {
  smart: '',
  star: 'Use Situation, Task, Action, and Result labels when they fit the question. Do not invent experiences or outcomes.',
  bullets: 'Organize the answer as bullets.',
  code: 'Start with working code when appropriate, then explain it.'
};
const RESPONSE_LEVELS = {
  direct: 'For a multiple-choice question with lettered options, output only the chosen letter (for example, B). For a question that asks for multiple selections, give only the chosen letters separated by commas (for example, B, D). Omit option text, explanation, labels, and Markdown. For other questions, give the shortest useful answer in one line.',
  concise: 'Give the answer first and explain it briefly, usually in one to three short sentences. For multiple choice, include the letter and option text.',
  full: 'Give the answer first, followed by a complete explanation with relevant reasoning, context, or trade-offs. For multiple choice, include the letter, option text, and why it fits.'
};
const LEGACY_LEVELS = { brief: 'concise', detail: 'full' };
const SELECTION_SEPARATOR = /[ \t]*(?:,\s*(?:and\s+)?|&|\band\b)[ \t]*/i;
const SELECTION_LABEL = /(?:\([a-z]\)|[a-z](?![a-z]))/i;
const SELECTION_START = new RegExp(`^${SELECTION_LABEL.source}(?:${SELECTION_SEPARATOR.source}${SELECTION_LABEL.source})*`, 'i');

function knownKey(choices, value) {
  return typeof value === 'string' && Object.hasOwn(choices, value);
}

function responseLevel(value, style, fallback = DEFAULTS.responseLevel) {
  if (knownKey(RESPONSE_LEVELS, value)) return value;
  return knownKey(LEGACY_LEVELS, style) ? LEGACY_LEVELS[style] : fallback;
}

function answerInstructions(settings) {
  const level = responseLevel(settings.responseLevel, settings.style);
  const format = knownKey(STYLES, settings.style) ? STYLES[settings.style] : '';
  return [RESPONSE_LEVELS[level], level !== 'direct' && format].filter(Boolean).join(' ');
}

function directAnswer(answer, question, frames) {
  const plain = plainAnswer(answer).trim();
  const oneLine = plain.replace(/\s*\n\s*/g, ' ');
  const prefix = /^(?:(?:the|final|correct)\s+)*(?:answers?|options?|choices?)\b\s*(?:(?:is|are)\b\s*)?[:–—-]?\s*/i;
  const candidate = plain.replace(prefix, '');
  const selection = candidate.match(SELECTION_START)?.[0];
  if (!selection) return oneLine;
  const tail = candidate.slice(selection.length).trim();
  const marker = /^(?:[):–—]|[.\-](?:\s|$))/;
  const explanation = /^(?:,?\s*because\b|(?:is|are)\s+correct[.!]?$)/i;
  if (/^(?:(?:is|are)\s+(?:not|incorrect|wrong)|(?:is|are)n['’]t)\b/i.test(tail.replace(marker, '').trimStart())) return oneLine;
  if (tail && !marker.test(tail) && !explanation.test(tail) && !selection.endsWith(')')) return oneLine;

  const letters = selection.split(SELECTION_SEPARATOR).map((value) => value.replace(/[()]/g, '').toUpperCase());
  const options = [question, ...frames.map((frame) => frame.text)].map((source) => new Set(
    Array.from(plainAnswer(typeof source === 'string' ? source.slice(0, 16_000) : '').matchAll(
      /(?:^|\s)(?:[-*][ \t]+)?(?:\(([a-z])\)|([a-z])(?:\)|[.:](?=[ \t])))[ \t]*(?=\S)/gi
    ), ([, parenthesized, standalone]) => (parenthesized || standalone).toUpperCase())
  )).filter((set) => set.size >= 2);
  const hasOptions = options.some((set) => letters.every((letter) => set.has(letter)));
  const askingAboutChoices = /\b(?:choose|select|multiple[- ]choice|which option)\b/i.test(question);
  const askingAboutImageQuestion = /\bquestion\b/i.test(question) && /\b(?:screen(?:shot)?|image|photo|picture)\b/i.test(question);
  // A period may denote an initial. Use it as an option marker only in a choice or image-question context.
  const markedImageChoice = tail.startsWith(')') || selection.endsWith(')')
    || /^\.(?:\s|$)/.test(tail) && (askingAboutChoices || askingAboutImageQuestion);
  const explicitImageChoice = frames.length && !options.length && (candidate !== plain || markedImageChoice);
  return hasOptions || explicitImageChoice ? [...new Set(letters)].join(', ') : oneLine;
}

function parseBase(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Enter a complete provider URL, including https://.'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new Error('Use HTTPS for a remote provider. HTTP is only allowed on this Mac.');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('Enter a base URL without a password, query, or fragment.');
  }
  return { value: url.origin + url.pathname.replace(/\/+$/, ''), origin: url.origin, local };
}

function mergeSettings(previous, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Invalid settings.');
  const next = { ...DEFAULTS, ...previous };
  for (const [field, limit] of Object.entries(TEXT_LIMITS)) {
    if (typeof patch[field] === 'string') next[field] = patch[field].trim().slice(0, limit);
  }
  for (const field of Object.values(CREDENTIALS)) {
    if (typeof patch[field] === 'string') {
      const raw = patch[field].trim();
      next[field] = raw || field === 'baseUrl' ? parseBase(raw || DEFAULTS.baseUrl).value : '';
    }
  }
  for (const [key, field] of Object.entries(CREDENTIALS)) {
    const oldOrigin = previous[field] ? parseBase(previous[field]).origin : '';
    const newOrigin = next[field] ? parseBase(next[field]).origin : '';
    const replacement = typeof patch[key] === 'string' ? patch[key].trim() : null;
    if (replacement !== null && replacement.length > 4096) throw new Error('The API key is too long.');
    if (replacement !== null) next[key] = replacement;
    else if (oldOrigin !== newOrigin) next[key] = '';
  }
  if (!next.chatModel || !next.transcribeModel) throw new Error('Both chat and transcription models need a name.');
  if (['auto', 'apple', 'provider'].includes(patch.answerMode)) next.answerMode = patch.answerMode;
  next.responseLevel = responseLevel(patch.responseLevel, patch.style, responseLevel(previous.responseLevel, previous.style));
  if (knownKey(STYLES, patch.style) || knownKey(LEGACY_LEVELS, patch.style)) next.style = patch.style;
  if (!knownKey(STYLES, next.style)) next.style = DEFAULTS.style;
  for (const field of ['keepHistory', 'ocr', 'float', 'dockAtNotch']) {
    if (typeof patch[field] === 'boolean') next[field] = patch[field];
  }
  if (Number.isFinite(patch.opacity)) next.opacity = Math.min(0.98, Math.max(0.55, patch.opacity));
  return next;
}

function publicSettings(settings) {
  const result = { ...settings };
  for (const key of Object.keys(CREDENTIALS)) {
    result[key + 'Saved'] = Boolean(settings[key]);
    delete result[key];
  }
  return result;
}

function restoreSettings(saved) {
  const settings = mergeSettings(DEFAULTS, saved);
  if (saved.settingsVersion !== SETTINGS_VERSION && saved.opacity === 0.89) settings.opacity = DEFAULTS.opacity;
  return settings;
}

function providerFor(settings, kind) {
  if (kind === 'audio' && settings.transcribeBaseUrl) {
    return { base: settings.transcribeBaseUrl, key: settings.transcribeApiKey, model: settings.transcribeModel };
  }
  if (kind === 'backup') {
    return {
      base: settings.backupBaseUrl,
      key: settings.backupApiKey,
      model: settings.backupModel || settings.chatModel
    };
  }
  return { base: settings.baseUrl, key: settings.apiKey, model: kind === 'audio' ? settings.transcribeModel : settings.chatModel };
}

function answerEngine(settings) {
  if (settings.answerMode === 'apple') return 'apple';
  const configured = Boolean(settings.apiKey) || parseBase(settings.baseUrl).local;
  if (configured) return 'provider';
  return settings.answerMode === 'provider' ? 'unconfigured' : 'apple';
}

module.exports = { DEFAULTS, answerInstructions, directAnswer, mergeSettings, restoreSettings, publicSettings, providerFor, parseBase, answerEngine };
