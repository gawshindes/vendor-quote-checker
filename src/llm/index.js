'use strict';
/*
 * One function, three providers. Each provider gets the same system prompt,
 * the same user text and, when needed, the original PDF, and returns plain text
 * (which should be the JSON review).
 */
const { config } = require('../config');

class LlmError extends Error {
  constructor(message, { retryable = true, status } = {}) {
    super(message);
    this.retryable = retryable;
    this.status = status;
  }
}

async function postJson(url, headers, body) {
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(config.llm.timeoutMs),
    });
  } catch (err) {
    throw new LlmError(`Request to the AI provider failed: ${err.message}`);
  }
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = null; }
  if (!res.ok) {
    const detail = (data && (data.error?.message || data.message)) || text.slice(0, 300);
    // 4xx other than rate limits are configuration problems: do not retry.
    const retryable = res.status === 429 || res.status >= 500;
    throw new LlmError(`AI provider returned ${res.status}: ${detail}`, { retryable, status: res.status });
  }
  if (!data) throw new LlmError('AI provider returned a response that was not JSON.');
  return data;
}

async function callOpenAI({ system, userText, pdfBase64 }) {
  const content = [];
  if (pdfBase64) {
    content.push({ type: 'input_file', filename: 'vendor-document.pdf', file_data: `data:application/pdf;base64,${pdfBase64}` });
  }
  content.push({ type: 'input_text', text: userText });
  const data = await postJson(
    'https://api.openai.com/v1/responses',
    { authorization: `Bearer ${config.llm.keys.openai}` },
    {
      model: config.llm.model,
      instructions: system,
      input: [{ role: 'user', content }],
      max_output_tokens: config.llm.maxOutputTokens,
      text: { format: { type: 'json_object' } },
    },
  );
  if (typeof data.output_text === 'string' && data.output_text) return data.output_text;
  const parts = [];
  for (const item of data.output || []) {
    for (const c of item.content || []) if (c.type === 'output_text' && c.text) parts.push(c.text);
  }
  return parts.join('');
}

async function callAnthropic({ system, userText, pdfBase64 }) {
  const content = [];
  if (pdfBase64) {
    content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 } });
  }
  content.push({ type: 'text', text: userText });
  const data = await postJson(
    'https://api.anthropic.com/v1/messages',
    { 'x-api-key': config.llm.keys.anthropic, 'anthropic-version': '2023-06-01' },
    {
      model: config.llm.model,
      max_tokens: config.llm.maxOutputTokens,
      system,
      messages: [{ role: 'user', content }],
    },
  );
  return (data.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
}

async function callGemini({ system, userText, pdfBase64 }) {
  const parts = [];
  if (pdfBase64) parts.push({ inline_data: { mime_type: 'application/pdf', data: pdfBase64 } });
  parts.push({ text: userText });
  const model = encodeURIComponent(config.llm.model);
  const data = await postJson(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    { 'x-goog-api-key': config.llm.keys.gemini },
    {
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts }],
      generationConfig: { responseMimeType: 'application/json', maxOutputTokens: config.llm.maxOutputTokens },
    },
  );
  const cand = (data.candidates || [])[0];
  if (!cand) throw new LlmError('Gemini returned no answer.', { retryable: false });
  return (cand.content?.parts || []).map((p) => p.text || '').join('');
}

async function callMock() {
  // A fixed example review, so the whole flow can be tested without an API key.
  await new Promise((r) => setTimeout(r, 300));
  return JSON.stringify(require('./mock-review.json'));
}

async function complete(args) {
  switch (config.llm.provider) {
    case 'openai': return callOpenAI(args);
    case 'anthropic': return callAnthropic(args);
    case 'gemini': return callGemini(args);
    case 'mock': return callMock(args);
    default: throw new LlmError(`Unknown provider ${config.llm.provider}`, { retryable: false });
  }
}

module.exports = { complete, LlmError };
