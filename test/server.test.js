'use strict';
/*
 * End-to-end: starts the real server with the mock AI and the log email transport,
 * uploads PDFs over HTTP, and checks the response, the emailed .eml file,
 * that the document is deleted, and that bad input and limits are rejected.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { setTestEnv, makePdf } = require('./helpers');

const PORT = String(38000 + Math.floor(Math.random() * 1000));
const dataDir = setTestEnv({ PORT, LIMIT_PER_EMAIL_PER_DAY: '2', LIMIT_PER_IP_PER_DAY: '100', LIMIT_TOTAL_PER_DAY: '100', MAX_PAGES: '5', MAX_FILE_MB: '1', SAVE_SUBSCRIBERS: 'true' });
const base = `http://127.0.0.1:${PORT}`;
let server;
let logs = '';

before(async () => {
  server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', (d) => { logs += d; });
  server.stderr.on('data', (d) => { logs += d; });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${base}/healthz`)).ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Server did not start:\n${logs}`);
});
after(() => { server?.kill(); });

const form = (fields, file) => {
  const fd = new FormData();
  const all = { businessSize: 'small', role: 'owner', email: 'visitor@test.invalid', acceptTerms: 'yes', ...fields };
  for (const [k, v] of Object.entries(all)) if (v != null) fd.set(k, v);
  if (file) fd.set('document', new Blob([file.buffer], { type: 'application/pdf' }), file.name);
  return fd;
};
const post = (fd) => fetch(`${base}/api/review`, { method: 'POST', body: fd });
const waitFor = async (check, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = check(); if (v) return v; await new Promise((r) => setTimeout(r, 100)); }
  return null;
};

test('the page renders with settings filled in and security headers', async () => {
  const res = await fetch(base + '/');
  const html = await res.text();
  assert.equal(res.status, 200);
  assert.ok(!/\{\{[A-Z_]+\}\}/.test(html), 'no unfilled placeholders');
  assert.ok(!html.includes('cf-turnstile'), 'no Turnstile widget without a site key');
  assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('x-powered-by'), null);
});

test('a valid upload is queued, emailed with the report, and deleted', async () => {
  const pdf = await makePdf({ pages: 2 });
  const res = await post(form({ optIn: 'yes' }, { buffer: pdf, name: 'acme-quote.pdf' }));
  const out = await res.json();
  assert.equal(res.status, 202, JSON.stringify(out));
  assert.deepEqual(out, { ok: true, email: 'visitor@test.invalid', fileName: 'acme-quote.pdf', pages: 2 });

  const outbox = path.join(dataDir, 'outbox');
  const eml = await waitFor(() => fs.existsSync(outbox) && fs.readdirSync(outbox).find((f) => f.endsWith('.eml')));
  assert.ok(eml, `no email written. Server log:\n${logs}`);
  const raw = fs.readFileSync(path.join(outbox, eml), 'utf8');
  assert.match(raw, /To: visitor@test\.invalid/);
  assert.match(raw, /Subject: Your vendor quote review: acme-quote\.pdf/);
  assert.match(raw, /filename=vendor-quote-review-acme-quote\.pdf/);

  const jobs = path.join(dataDir, 'jobs');
  assert.ok(await waitFor(() => fs.readdirSync(jobs).length === 0), 'job files are deleted after sending');

  const csv = fs.readFileSync(path.join(dataDir, 'subscribers.csv'), 'utf8');
  assert.match(csv, /^date,email,source\n.*,visitor@test\.invalid,vendor-quote-checker\n$/);
});

test('bad input is rejected with a clear message', async () => {
  const pdf = await makePdf({ pages: 1 });
  const cases = [
    [form({}, null), 400, /Choose a PDF/],
    [form({ businessSize: 'huge' }, { buffer: pdf, name: 'a.pdf' }), 400, /business size/],
    [form({ role: 'ceo' }, { buffer: pdf, name: 'a.pdf' }), 400, /role/],
    [form({ email: 'not-an-email' }, { buffer: pdf, name: 'a.pdf' }), 400, /valid email/],
    [form({ acceptTerms: null }, { buffer: pdf, name: 'a.pdf' }), 400, /information only/],
    [form({ email: 'notpdf@test.invalid' }, { buffer: Buffer.from('hello'), name: 'a.pdf' }), 400, /does not look like a PDF/],
    [form({ email: 'pages@test.invalid' }, { buffer: await makePdf({ pages: 6 }), name: 'a.pdf' }), 400, /limit is 5/],
    [form({ email: 'big@test.invalid' }, { buffer: Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(1.2 * 1024 * 1024)]), name: 'a.pdf' }), 413, /larger than 1 MB/],
  ];
  for (const [fd, status, msg] of cases) {
    const res = await post(fd);
    const out = await res.json();
    assert.equal(res.status, status, `${msg}: got ${JSON.stringify(out)}`);
    assert.match(out.error, msg);
  }
});

test('rejected uploads do not use up the daily limit, and the limit is enforced', async () => {
  const email = 'limits@test.invalid';
  // A bad PDF must not count against this address.
  await post(form({ email }, { buffer: Buffer.from('%PDF-1.7 broken'), name: 'bad.pdf' }));
  const pdf = await makePdf({ pages: 1 });
  for (let i = 0; i < 2; i++) assert.equal((await post(form({ email }, { buffer: pdf, name: `ok${i}.pdf` }))).status, 202);
  const res = await post(form({ email }, { buffer: pdf, name: 'third.pdf' }));
  assert.equal(res.status, 429);
  assert.match((await res.json()).error, /up to 2 documents a day/);
});

test('parallel requests cannot slip past the per-email limit', async () => {
  const pdf = await makePdf({ pages: 3 });
  const results = await Promise.all(Array.from({ length: 6 }, (_, i) => post(form({ email: 'race@test.invalid' }, { buffer: pdf, name: `r${i}.pdf` }))));
  const accepted = results.filter((r) => r.status === 202).length;
  assert.equal(accepted, 2, `expected 2 accepted, got ${accepted}`);
});

test('a CSV formula in an email cannot reach the subscriber file unescaped', async () => {
  const pdf = await makePdf({ pages: 1 });
  const res = await post(form({ email: '=cmd@test.invalid', optIn: 'yes' }, { buffer: pdf, name: 'x.pdf' }));
  assert.equal(res.status, 202);
  const csv = fs.readFileSync(path.join(dataDir, 'subscribers.csv'), 'utf8');
  assert.ok(!/,=cmd/.test(csv), 'formula is neutralised');
  assert.match(csv, /,'=cmd@test\.invalid,/);
});

test('unknown routes return 404', async () => {
  assert.equal((await fetch(`${base}/nope`)).status, 404);
  assert.equal((await fetch(`${base}/.env`)).status, 404);
});
