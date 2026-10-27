'use strict';
/*
 * Shared test setup. Every test file calls setTestEnv() before requiring app code,
 * so tests never use the real API keys in .env or send real email.
 * (Environment variables win over .env, because dotenv does not override them.)
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function setTestEnv(extra = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vqc-test-'));
  Object.assign(process.env, {
    NODE_ENV: 'test',
    LLM_PROVIDER: 'mock',
    LLM_MODEL: 'test-model',
    OPENAI_API_KEY: 'test-openai-key',
    ANTHROPIC_API_KEY: 'test-anthropic-key',
    GEMINI_API_KEY: 'test-gemini-key',
    RESEND_API_KEY: 'test-resend-key',
    EMAIL_TRANSPORT: 'log',
    EMAIL_FROM: 'AI CTO <reviews@test.invalid>',
    EMAIL_BCC: '',
    TURNSTILE_SITE_KEY: '',
    TURNSTILE_SECRET_KEY: '',
    DATA_DIR: dataDir,
    ...extra,
  });
  return dataDir;
}

/** Builds a small PDF with the given number of pages of text. */
function makePdf({ pages = 2, text = 'This proposal covers design and build of a customer portal. '.repeat(10) } = {}) {
  const PDFDocument = require('pdfkit');
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER' });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    for (let i = 0; i < pages; i++) {
      if (i) doc.addPage();
      if (text) doc.text(`Page ${i + 1}. ${text}`);
    }
    doc.end();
  });
}

/** Replaces global fetch for one test. Returns the list of calls made. */
function mockFetch(t, handler) {
  const calls = [];
  const original = global.fetch;
  global.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), opts, body: opts.body && typeof opts.body === 'string' ? JSON.parse(opts.body) : opts.body });
    const { status = 200, json } = await handler(String(url), opts);
    return new Response(JSON.stringify(json), { status, headers: { 'content-type': 'application/json' } });
  };
  t.after(() => { global.fetch = original; });
  return calls;
}

module.exports = { setTestEnv, makePdf, mockFetch };
