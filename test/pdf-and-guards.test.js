'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setTestEnv, makePdf } = require('./helpers');

setTestEnv({ LIMIT_PER_EMAIL_PER_DAY: '2', LIMIT_PER_IP_PER_DAY: '3', LIMIT_TOTAL_PER_DAY: '4' });
const { readPdf, meaningfulLength, UserFacingError } = require('../src/pdf-text');
const { checkLimits, recordUse, releaseUse } = require('../src/guards');

const opts = { maxPages: 5, maxChars: 100000 };

test('readPdf rejects files that are not PDFs', async () => {
  await assert.rejects(readPdf(Buffer.from('hello world'), opts), UserFacingError);
  await assert.rejects(readPdf(Buffer.alloc(0), opts), UserFacingError);
});

test('readPdf rejects a broken PDF with a friendly message', async () => {
  await assert.rejects(readPdf(Buffer.from('%PDF-1.7 garbage'), opts), (e) => e instanceof UserFacingError && /could not be opened/.test(e.message));
});

test('readPdf reads pages and text', async () => {
  const r = await readPdf(await makePdf({ pages: 3 }), opts);
  assert.equal(r.pages, 3);
  assert.match(r.text, /customer portal/);
  assert.match(r.text, /end of page 1 of 3/);
  assert.equal(r.truncated, false);
});

test('readPdf enforces the page limit', async () => {
  await assert.rejects(readPdf(await makePdf({ pages: 6 }), opts), /has 6 pages\. The limit is 5/);
});

test('readPdf truncates long text', async () => {
  const r = await readPdf(await makePdf({ pages: 1 }), { maxPages: 5, maxChars: 50 });
  assert.equal(r.text.length, 50);
  assert.equal(r.truncated, true);
});

test('meaningfulLength ignores page markers and whitespace', () => {
  assert.equal(meaningfulLength('ab \n\n -- end of page 1 of 2 -- \n cd'), 4);
});

test('limits: per email, per IP, total, and giving a use back', () => {
  const a = { email: 'a@x.com', ip: '1.1.1.1' };
  assert.equal(checkLimits(a), null);
  recordUse(a); recordUse(a);
  assert.match(checkLimits(a), /up to 2 documents a day/);

  const b = { email: 'b@x.com', ip: '1.1.1.1' };
  recordUse(b);
  assert.match(checkLimits(b), /Too many reviews from this network/);

  releaseUse(b);
  assert.equal(checkLimits(b), null, 'released use no longer counts');

  recordUse({ email: 'c@x.com', ip: '2.2.2.2' });
  recordUse({ email: 'd@x.com', ip: '3.3.3.3' });
  assert.match(checkLimits({ email: 'e@x.com', ip: '4.4.4.4' }), /reached its limit for today/);
});
