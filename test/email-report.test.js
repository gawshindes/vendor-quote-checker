'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setTestEnv, mockFetch } = require('./helpers');

setTestEnv({ EMAIL_TRANSPORT: 'resend', EMAIL_BCC: 'copy@test.invalid', EMAIL_REPLY_TO: 'reply@test.invalid' });
const { config, checkConfig } = require('../src/config');
const { sendReviewEmail, sendFailureEmail } = require('../src/email');
const { buildReportPdf } = require('../src/report-pdf');
const { normalizeReview } = require('../src/review');

const review = normalizeReview(require('../src/llm/mock-review.json'));
const meta = { fileName: 'quote <script>.pdf', pages: 2, businessSize: 'Small business', role: 'Business owner', date: new Date('2026-10-27') };

test('the report PDF builds and is a real PDF', async () => {
  const pdf = await buildReportPdf(review, meta);
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
  assert.ok(pdf.length > 5000);
});

test('the report also builds for an unreviewable document', async () => {
  const pdf = await buildReportPdf(normalizeReview({ is_reviewable: false, summary: { headline: 'Not a proposal', overview: 'This is a menu.' } }), meta);
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
});

test('resend: review email has the right fields, attachment and idempotency key', async (t) => {
  const calls = mockFetch(t, () => ({ json: { id: 'email-123' } }));
  const pdf = Buffer.from('%PDF-fake');
  const info = await sendReviewEmail({ to: 'visitor@test.invalid', review, meta, pdfBuffer: pdf, idempotencyKey: 'review-job1' });
  assert.equal(info.messageId, 'email-123');
  const { url, opts, body } = calls[0];
  assert.equal(url, 'https://api.resend.com/emails');
  assert.equal(opts.headers.authorization, 'Bearer test-resend-key');
  assert.equal(opts.headers['idempotency-key'], 'review-job1');
  assert.deepEqual(body.to, ['visitor@test.invalid']);
  assert.deepEqual(body.bcc, ['copy@test.invalid']);
  assert.equal(body.reply_to, 'reply@test.invalid');
  assert.equal(body.from, config.email.from);
  assert.match(body.subject, /Your vendor quote review/);
  assert.equal(body.attachments.length, 1);
  assert.match(body.attachments[0].filename, /^vendor-quote-review-.*\.pdf$/);
  assert.equal(Buffer.from(body.attachments[0].content, 'base64').toString(), '%PDF-fake');
  assert.ok(body.text.length > 50, 'has a plain-text version');
  assert.ok(!body.html.includes('<script>'), 'file name is escaped in the HTML');
  assert.match(body.html, /information only/);
});

test('resend: errors are reported with the status code', async (t) => {
  mockFetch(t, () => ({ status: 403, json: { name: 'validation_error', message: 'The gawshinde.com domain is not verified.' } }));
  await assert.rejects(sendFailureEmail({ to: 'v@test.invalid', meta }), (e) => e.status === 403 && /not verified/.test(e.message));
});

test('config check catches missing Resend key and placeholder sender', () => {
  const before = { ...config.email };
  config.email.resendKey = '';
  config.email.from = 'AI CTO <reviews@example.com>';
  const problems = checkConfig();
  Object.assign(config.email, before);
  assert.ok(problems.some((p) => /RESEND_API_KEY/.test(p)));
  assert.ok(problems.some((p) => /example\.com/.test(p)));
});
