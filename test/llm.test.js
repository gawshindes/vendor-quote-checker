'use strict';
/*
 * Checks each provider adapter against the request and response shapes in the
 * providers' API docs, using a fake fetch. No real API is called.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setTestEnv, mockFetch } = require('./helpers');

setTestEnv();
const { config } = require('../src/config');
const { complete } = require('../src/llm');

const args = { system: 'SYS', userText: 'USER', pdfBase64: null };
const use = (t, provider) => {
  const before = config.llm.provider;
  config.llm.provider = provider;
  t.after(() => { config.llm.provider = before; });
};

/* ---------- OpenAI ---------- */

test('openai: sends a Responses API request and reads output_text parts', async (t) => {
  use(t, 'openai');
  const calls = mockFetch(t, () => ({ json: { status: 'completed', output: [
    { type: 'reasoning', content: [] },
    { type: 'message', content: [{ type: 'output_text', text: '{"ok":' }, { type: 'output_text', text: 'true}' }] },
  ] } }));
  assert.equal(await complete({ ...args, pdfBase64: 'QUJD' }), '{"ok":true}');
  const { url, opts, body } = calls[0];
  assert.equal(url, 'https://api.openai.com/v1/responses');
  assert.equal(opts.headers.authorization, 'Bearer test-openai-key');
  assert.equal(body.model, 'test-model');
  assert.equal(body.instructions, 'SYS');
  assert.equal(body.text.format.type, 'json_object');
  assert.equal(body.input[0].content[0].type, 'input_file');
  assert.equal(body.input[0].content[0].file_data, 'data:application/pdf;base64,QUJD');
  assert.equal(body.input[0].content[1].text, 'USER');
});

test('openai: an incomplete answer is not retried', async (t) => {
  use(t, 'openai');
  mockFetch(t, () => ({ json: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [] } }));
  await assert.rejects(complete(args), (e) => e.retryable === false && /max_output_tokens/.test(e.message));
});

test('openai: a refusal is not retried', async (t) => {
  use(t, 'openai');
  mockFetch(t, () => ({ json: { status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'no' }] }] } }));
  await assert.rejects(complete(args), (e) => e.retryable === false && /refused/.test(e.message));
});

/* ---------- Anthropic ---------- */

test('anthropic: sends a Messages API request with the PDF as a document block', async (t) => {
  use(t, 'anthropic');
  const calls = mockFetch(t, () => ({ json: { stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '...' }, { type: 'text', text: '{"ok":true}' }] } }));
  assert.equal(await complete({ ...args, pdfBase64: 'QUJD' }), '{"ok":true}');
  const { url, opts, body } = calls[0];
  assert.equal(url, 'https://api.anthropic.com/v1/messages');
  assert.equal(opts.headers['x-api-key'], 'test-anthropic-key');
  assert.equal(opts.headers['anthropic-version'], '2023-06-01');
  assert.equal(body.system, 'SYS');
  assert.ok(body.max_tokens > 0);
  assert.deepEqual(body.messages[0].content[0], { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'QUJD' } });
});

test('anthropic: hitting max_tokens is not retried', async (t) => {
  use(t, 'anthropic');
  mockFetch(t, () => ({ json: { stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"half":' }] } }));
  await assert.rejects(complete(args), (e) => e.retryable === false && /output limit/.test(e.message));
});

/* ---------- Gemini ---------- */

test('gemini: sends generateContent with inline PDF and skips thought parts', async (t) => {
  use(t, 'gemini');
  const calls = mockFetch(t, () => ({ json: { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'thinking...', thought: true }, { text: '{"ok":true}' }] } }] } }));
  assert.equal(await complete({ ...args, pdfBase64: 'QUJD' }), '{"ok":true}');
  const { url, opts, body } = calls[0];
  assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/models/test-model:generateContent');
  assert.equal(opts.headers['x-goog-api-key'], 'test-gemini-key');
  assert.equal(body.systemInstruction.parts[0].text, 'SYS');
  assert.equal(body.generationConfig.responseMimeType, 'application/json');
  assert.deepEqual(body.contents[0].parts[0], { inline_data: { mime_type: 'application/pdf', data: 'QUJD' } });
});

test('gemini: MAX_TOKENS and blocked prompts are not retried', async (t) => {
  use(t, 'gemini');
  mockFetch(t, () => ({ json: { candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: '{' }] } }] } }));
  await assert.rejects(complete(args), (e) => e.retryable === false && /output limit/.test(e.message));
});

test('gemini: a blocked prompt is reported', async (t) => {
  use(t, 'gemini');
  mockFetch(t, () => ({ json: { promptFeedback: { blockReason: 'SAFETY' } } }));
  await assert.rejects(complete(args), /blocked: SAFETY/);
});

/* ---------- Shared error handling ---------- */

test('rate limits and server errors are retried, bad requests are not', async (t) => {
  use(t, 'openai');
  let status = 429;
  mockFetch(t, () => ({ status, json: { error: { message: 'slow down' } } }));
  await assert.rejects(complete(args), (e) => e.retryable === true && e.status === 429 && /slow down/.test(e.message));
  status = 503;
  await assert.rejects(complete(args), (e) => e.retryable === true);
  status = 400;
  await assert.rejects(complete(args), (e) => e.retryable === false);
  status = 401;
  await assert.rejects(complete(args), (e) => e.retryable === false);
});

test('an empty answer is an error', async (t) => {
  use(t, 'anthropic');
  mockFetch(t, () => ({ json: { stop_reason: 'end_turn', content: [] } }));
  await assert.rejects(complete(args), /empty answer/);
});
