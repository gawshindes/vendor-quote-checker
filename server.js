'use strict';
/*
 * Vendor quote checker: upload a vendor proposal, get an AI review by email.
 * Start with `npm start`. Settings are in .env (see .env.example).
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const express = require('express');
const multer = require('multer');
const { config, checkConfig } = require('./src/config');
const { readPdf, UserFacingError } = require('./src/pdf-text');
const { enqueue, resume, stats } = require('./src/queue');
const { checkLimits, recordUse, releaseUse, verifyTurnstile } = require('./src/guards');

const problems = checkConfig();
if (problems.length) {
  console.error('Configuration problems:\n- ' + problems.join('\n- '));
  if (process.env.NODE_ENV === 'production') process.exit(1);
}
if (process.env.NODE_ENV === 'production') {
  if (!config.turnstile.secret) console.warn('Warning: TURNSTILE_SECRET_KEY is not set, so bots can submit the form freely.');
  if (config.turnstile.siteKey && !config.turnstile.secret) console.warn('Warning: TURNSTILE_SITE_KEY is set without TURNSTILE_SECRET_KEY, so the widget shows but nothing is verified.');
  if (config.llm.provider === 'mock') console.warn('Warning: LLM_PROVIDER=mock. Every visitor gets the same sample review.');
  if (config.email.transport === 'log') console.warn('Warning: EMAIL_TRANSPORT=log. No email is sent.');
  const appDir = path.resolve(__dirname);
  if (config.dataDir === appDir || config.dataDir.startsWith(appDir + path.sep)) {
    console.warn(`Warning: DATA_DIR (${config.dataDir}) is inside the app folder, so a redeploy may delete queued reviews and subscribers. Set DATA_DIR=~/vqc-data.`);
  }
}

const app = express();
app.disable('x-powered-by');
if (config.trustProxy) app.set('trust proxy', 1);

app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Frame-Options': 'SAMEORIGIN',
    'Content-Security-Policy': [
      "default-src 'self'",
      "script-src 'self' https://challenges.cloudflare.com",
      "frame-src https://challenges.cloudflare.com",
      "style-src 'self' https://fonts.googleapis.com",
      "font-src https://fonts.gstatic.com",
      "img-src 'self' data:",
      "connect-src 'self'",
      "form-action 'self'",
      "base-uri 'none'",
    ].join('; '),
  });
  next();
});

/* ---------- Pages ---------- */
// Set once per deploy/restart and added to asset URLs (styles.css, app.js, favicon.svg ?v=...), so caches like Cloudflare fetch the new files.
const BUILD_VERSION = Date.now().toString(36);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function renderPage() {
  const b = config.brand;
  const html = fs.readFileSync(path.join(config.paths.public, 'index.html'), 'utf8');
  const values = {
    TOOL_NAME: b.toolName, AI_NAME: b.aiName, OWNER_NAME: b.ownerName, CONTACT_EMAIL: b.contactEmail,
    SITE_URL: b.siteUrl, REPO_URL: b.repoUrl, BASE_URL: config.baseUrl.replace(/\/+$/, ''),
    MAX_FILE_MB: config.limits.maxFileMb, MAX_PAGES: config.limits.maxPages, PER_EMAIL: config.limits.perEmailPerDay,
    TURNSTILE_SITE_KEY: config.turnstile.siteKey, YEAR: new Date().getFullYear(), PRIVACY_URL: b.privacyUrl,
    BUILD_VERSION,
  };
  return html
    .replace(/<!--TURNSTILE-->([\s\S]*?)<!--\/TURNSTILE-->/g, config.turnstile.siteKey ? '$1' : '')
    .replace(/<!--PRIVACY-->([\s\S]*?)<!--\/PRIVACY-->/g, b.privacyUrl ? '$1' : '')
    .replace(/\{\{([A-Z_]+)\}\}/g, (m, k) => (k in values ? esc(values[k]) : m));
}
let pageCache = null;
app.get('/', (req, res) => {
  if (!pageCache || process.env.NODE_ENV !== 'production') pageCache = renderPage();
  res.type('html').send(pageCache);
});
app.use(express.static(config.paths.public, { index: false, maxAge: '1h' }));
app.get('/healthz', (req, res) => res.json({ ok: true, provider: config.llm.provider, queue: stats() }));

/* ---------- Review requests ---------- */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.limits.maxFileMb * 1024 * 1024, files: 1, fields: 12 },
});

const SIZES = { small: 'Small business', midsize: 'Midsize business' };
const ROLES = { owner: 'Business owner', manager: 'Manager', other: 'Other' };
const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[a-z]{2,}$/i;

function cleanFileName(name) {
  const base = path.basename(String(name || 'document.pdf')).replace(/[\u0000-\u001F\u007F<>]/g, '').trim();
  return (base || 'document.pdf').slice(0, 120);
}

app.post('/api/review', (req, res) => {
  upload.single('document')(req, res, async (err) => {
    const fail = (status, message) => res.status(status).json({ ok: false, error: message });
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') return fail(413, `That file is larger than ${config.limits.maxFileMb} MB.`);
      return fail(400, 'The upload did not work. Please try again.');
    }
    let reserved = null;
    try {
      const b = req.body || {};
      const email = String(b.email || '').trim().toLowerCase();
      const businessSize = SIZES[b.businessSize];
      const role = ROLES[b.role];
      if (!req.file) return fail(400, 'Choose a PDF to review.');
      if (!businessSize) return fail(400, 'Choose your business size.');
      if (!role) return fail(400, 'Choose your role.');
      if (!EMAIL_RE.test(email) || email.length > 200) return fail(400, 'Enter a valid email address.');
      if (b.acceptTerms !== 'yes') return fail(400, 'Please confirm that you understand the review is for information only.');

      const ip = req.ip || '';
      if (!(await verifyTurnstile(b['cf-turnstile-response'], ip))) return fail(400, 'The spam check did not pass. Please try again.');
      const limitMessage = checkLimits({ email, ip });
      if (limitMessage) return fail(429, limitMessage);
      // Count it before the slow PDF read, so parallel requests cannot slip past the limits.
      recordUse({ email, ip });
      reserved = { email, ip };

      // Read it now, so problems are reported on the page instead of by email.
      const parsed = await readPdf(req.file.buffer, { maxPages: config.limits.maxPages, maxChars: config.limits.maxTextChars });
      const fileName = cleanFileName(req.file.originalname);
      await enqueue({ pdfBuffer: req.file.buffer, email, fileName, pages: parsed.pages, businessSize, role });
      reserved = null;
      if (b.optIn === 'yes' && config.saveSubscribers) {
        await saveSubscriber(email).catch((e) => console.error('[api] could not save subscriber:', e.message));
      }
      return res.status(202).json({ ok: true, email, fileName, pages: parsed.pages });
    } catch (e) {
      if (reserved) releaseUse(reserved);
      if (e instanceof UserFacingError) return fail(400, e.message);
      console.error('[api] review request failed:', e);
      return fail(500, 'Something went wrong on our side. Please try again in a few minutes.');
    }
  });
});

async function saveSubscriber(email) {
  const file = config.paths.subscribers;
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const exists = fs.existsSync(file);
  await fsp.appendFile(file, `${exists ? '' : 'date,email,source\n'}${new Date().toISOString()},${csvSafe(email)},vendor-quote-checker\n`);
}

/** Strips CSV separators and stops spreadsheet apps from running a value as a formula. */
function csvSafe(value) {
  const v = String(value).replace(/[,\n\r"]/g, '');
  return /^[=+\-@\t]/.test(v) ? `'${v}` : v;
}

app.use((req, res) => res.status(404).type('text').send('Not found'));

app.listen(config.port, () => {
  console.log(`Vendor quote checker on port ${config.port} (AI provider: ${config.llm.provider}${config.llm.model ? `, model ${config.llm.model}` : ''}, email: ${config.email.transport}, data: ${config.dataDir})`);
  resume();
});
