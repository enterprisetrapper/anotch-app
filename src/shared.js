// Pure helpers shared by main (require) and renderer (<script> before renderer.js).
// No Electron or DOM dependencies — this file is unit-testable in plain Node (scripts/test.js).

const OPENROUTER = Object.freeze({
  baseUrl: 'https://openrouter.ai/api/v1',
  chatModel: 'openai/gpt-4o-mini',
  transcribeModel: 'openai/whisper-large-v3-turbo'
});

function isOpenRouterKey(key) {
  return typeof key === 'string' && key.trim().startsWith('sk-or-v1-');
}

function answerBlocks(text) {
  return text.split('```').flatMap((block, index) => {
    if (index % 2) return [{ type: 'code', text: block.replace(/^[\w+#.-]*\r?\n/, '').trimEnd() }];
    const parts = [];
    const inline = /`([^`\n]+)(?:`|$)|(?<![\w\\])\*{2,3}(\S[^\n]*?)(?:\*{2,3}|$)|(?<![\w\\])__(\S[^\n]*?)(?:__|$)/gm;
    let offset = 0;
    for (const match of block.matchAll(inline)) {
      if (match.index > offset) parts.push({ type: 'text', text: block.slice(offset, match.index) });
      parts.push({ type: match[1] ? 'inline-code' : 'strong', text: match[1] ?? match[2] ?? match[3] });
      offset = match.index + match[0].length;
    }
    if (offset < block.length) parts.push({ type: 'text', text: block.slice(offset).replace(/\*\*$/, '') });
    return parts;
  });
}

function plainAnswer(text) {
  return answerBlocks(text).map((part) => part.text).join('');
}

function isChoiceAnswer(text) {
  return /^[A-Z](?:\s*,\s*[A-Z])*$/.test(text.trim());
}

// rough token estimate: ~4 chars per token, small per-message overhead
function estimateTokens(msgs) {
  return msgs.reduce((n, m) => n + Math.ceil(String(m.content).length / 4) + 4, 0);
}

// Trim history so system prompt + turns stay under the budget
function fitContext(msgs, budget) {
  while (estimateTokens(msgs) > budget && msgs.length > 3) {
    // drop the oldest user/assistant pair after the system prompt
    msgs.splice(1, 2);
  }
  return msgs;
}

// Smallest text budget worth sending. A 4k window with a screenshot cannot hold
// 2 000 tokens of history plus the frame plus the output reserve, and the old
// floor silently overshot the window; dropping the frame is the honest trade.
const MIN_TEXT_TOKENS = 512;

// Decide which captured frames actually fit: frames + reserved output + text must
// stay inside the window. Keeps the primary (first) frame when anything fits at all.
function fitFrames(frames, budget, maxOut) {
  const room = Math.max(1024, budget - maxOut - 512); // frames + text
  const kept = frames.slice();
  let frameTokens = kept.reduce((n, f) => n + (f.tokens || 0), 0);
  while (kept.length && frameTokens > room - MIN_TEXT_TOKENS) {
    frameTokens -= kept.pop().tokens; // drop the last frame first
  }
  return { frames: kept, frameTokens, textBudget: Math.max(MIN_TEXT_TOKENS, room - frameTokens) };
}

// conservative vision cost: larger of OpenAI's tile formula and Anthropic's pixels/750
function visionTokens(w, h) {
  const s = Math.min(2048 / Math.max(w, h), 768 / Math.min(w, h), 1);
  const tw = Math.round(w * s);
  const th = Math.round(h * s);
  const tiles = Math.ceil(tw / 512) * Math.ceil(th / 512);
  return Math.max(85 + 170 * tiles, Math.ceil((w * h) / 750));
}

// heuristic validated against 14 real-speech cases (fixtures in scripts/test.js)
function looksLikeQuestion(tail) {
  const t = tail.trim().toLowerCase();
  if (!t) return false;
  if (t.endsWith('?')) return true;
  const sents = t.split(/[.!?\n]/).map((s) => s.trim()).filter(Boolean);
  const last = sents.length ? sents[sents.length - 1] : t;
  return /^((so|okay|alright|well|and|right|yeah)[,.]?\s+)*(what|how|why|tell me about|tell me|describe|explain|walk me through|can you|do you|have you|are you|would you|could you)\b/.test(last.slice(0, 80));
}

// ---------- local knowledge retrieval ----------
// The notes a user pastes (cheat sheet, project list, JD, study notes) are the
// cheapest source of "correct" answers there is: local, offline, and impossible to
// confuse with the model's imagination. Retrieval is deliberately simple — term
// overlap over paragraphs, no embeddings, no network — because it has to run in
// the few milliseconds between a question being heard and the answer starting.
const STOP_WORDS = new Set(('a an the and or but if then than that this these those of in on at to for from by with without into over under ' +
  'is are was were be been being do does did done have has had will would can could should may might must ' +
  'i you he she it we they me my your our their as so such not no yes about what which who whom whose when where why how').split(' '));

function terms(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9+#._-]+/)
    .map((w) => w.replace(/^[._-]+|[._-]+$/g, ''))
    .filter((w) => w.length > 1 && !STOP_WORDS.has(w));
}

// Rank note blocks against a question. Returns the best blocks (score > 0),
// joined by blank lines and capped, or '' when nothing overlaps.
function rankNotes(knowledge, query, { maxBlocks = 3, maxChars = 1400 } = {}) {
  const blocks = String(knowledge || '')
    .split(/\n\s*\n+/)
    .map((b) => b.trim())
    .filter((b) => b.length > 20);
  if (!blocks.length) return '';
  const q = new Set(terms(query));
  if (!q.size) return '';

  const scored = blocks.map((block) => {
    const bt = new Set(terms(block));
    let score = 0;
    for (const t of q) if (bt.has(t)) score += 2;
    // a heading-ish block that shares a rare word is worth more than a long one
    if (score) score += Math.min(3, Math.floor(block.length / 400) ? 1 : 0);
    return { block, score };
  });

  scored.sort((a, b) => b.score - a.score);
  const picked = [];
  let used = 0;
  for (const s of scored) {
    if (s.score <= 0 || picked.length >= maxBlocks) break;
    if (used + s.block.length > maxChars && picked.length) break;
    picked.push(s.block);
    used += s.block.length;
  }
  return picked.join('\n\n');
}

const NOTCH_SHOULDER = 12;

function answerPresentation(text) {
  const content = text.trim();
  if (!content || /^(?:~~~|```|[-*+]\s|\d+[.)]\s)/.test(content)) return { lead: '', detail: content };
  const firstLine = content.split(/\r?\n/, 1)[0];
  const firstSentence = firstLine.match(/^.{12,139}?[.!?](?=\s|$)/)?.[0] || '';
  const separateHeadline = firstLine.length < content.length && firstLine.length <= 140;
  const headline = separateHeadline ? firstLine : firstSentence || (firstLine.length <= 140 ? firstLine : '');
  return headline
    ? { lead: headline.replace(/^#{1,6}\s+/, ''), detail: content.slice(headline.length).trimStart() }
    : { lead: '', detail: content };
}

const NOTCH_EASE = 0.72;
const NOTCH_EASING = `cubic-bezier(0.333333, ${NOTCH_EASE}, 0.666667, 1)`;

function notchShape(width, height) {
  const top = Math.min(NOTCH_SHOULDER, height / 3);
  return { width, height, top, bottom: Math.min(24, width / 2, height - top) };
}

function notchOutline({ width, height, top, bottom }, canvasWidth) {
  const left = (canvasWidth - width) / 2;
  const right = left + width;
  const start = left - NOTCH_SHOULDER;
  const outline = [
    `M ${start} 0 H ${right + NOTCH_SHOULDER} Q ${right} 0 ${right} ${top}`,
    `V ${height - bottom} Q ${right} ${height} ${right - bottom} ${height}`,
    `H ${left + bottom} Q ${left} ${height} ${left} ${height - bottom}`,
    `V ${top} Q ${left} 0 ${start} 0 Z`
  ];
  return `path("${outline.join(' ')}")`;
}

function notchFrame({ from, to, started, duration }, now) {
  const elapsed = (now - started) / duration;
  if (elapsed <= 0) return from;
  if (elapsed >= 1) return to;
  // One-third/two-thirds x control points make the curve's input linear in time.
  const progress = 3 * NOTCH_EASE * (1 - elapsed) ** 2 * elapsed + 3 * (1 - elapsed) * elapsed ** 2 + elapsed ** 3;
  return {
    width: from.width + (to.width - from.width) * progress,
    height: from.height + (to.height - from.height) * progress,
    top: from.top + (to.top - from.top) * progress,
    bottom: from.bottom + (to.bottom - from.bottom) * progress
  };
}

function notchContainsPoint({ width, height, top, bottom }, centerOffset, y) {
  if (y < 0 || y >= height) return false;
  let halfWidth = width / 2;
  // Solve the quadratic corners for their horizontal edge at this height.
  if (y < top) halfWidth += NOTCH_SHOULDER * (1 - Math.sqrt(y / top)) ** 2;
  if (y > height - bottom) halfWidth -= bottom * (1 - Math.sqrt((height - y) / bottom)) ** 2;
  return Math.abs(centerOffset) <= halfWidth;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    OPENROUTER, isOpenRouterKey, answerBlocks, plainAnswer, isChoiceAnswer, estimateTokens, fitContext, visionTokens, looksLikeQuestion,
    fitFrames, MIN_TEXT_TOKENS, rankNotes, terms, answerPresentation, NOTCH_SHOULDER, NOTCH_EASE, NOTCH_EASING,
    notchShape, notchOutline, notchFrame, notchContainsPoint
  };
}
