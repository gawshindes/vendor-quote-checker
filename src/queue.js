'use strict';
/*
 * A small job queue kept on disk, so reviews survive a restart. Each job is two
 * files in data/jobs: <id>.json (who and what) and <id>.pdf (the document).
 * Both are deleted as soon as the email is sent, or after the last failed attempt.
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { config } = require('./config');
const { readPdf } = require('./pdf-text');
const { runReview } = require('./review');
const { buildReportPdf } = require('./report-pdf');
const { sendReviewEmail, sendFailureEmail } = require('./email');

const dir = config.paths.jobs;
fs.mkdirSync(dir, { recursive: true });

const waiting = [];
let running = 0;

const jobFile = (id, ext) => path.join(dir, `${id}.${ext}`);

async function enqueue({ pdfBuffer, email, fileName, pages, businessSize, role }) {
  const id = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
  const job = { id, email, fileName, pages, businessSize, role, attempts: 0, createdAt: new Date().toISOString() };
  await fsp.writeFile(jobFile(id, 'pdf'), pdfBuffer);
  await fsp.writeFile(jobFile(id, 'json'), JSON.stringify(job));
  waiting.push(id);
  pump();
  return id;
}

function pump() {
  while (running < config.limits.concurrency && waiting.length) {
    const id = waiting.shift();
    running++;
    processJob(id).catch((err) => console.error(`[queue] ${id} crashed:`, err)).finally(() => { running--; pump(); });
  }
}

async function removeJob(id) {
  await Promise.all(['pdf', 'json'].map((ext) => fsp.rm(jobFile(id, ext), { force: true })));
}

async function processJob(id) {
  let job;
  try {
    job = JSON.parse(await fsp.readFile(jobFile(id, 'json'), 'utf8'));
  } catch {
    await removeJob(id);
    return;
  }
  const started = Date.now();
  try {
    const pdfBuffer = await fsp.readFile(jobFile(id, 'pdf'));
    const parsed = await readPdf(pdfBuffer, { maxPages: config.limits.maxPages, maxChars: config.limits.maxTextChars });
    const review = await runReview({ ...parsed, pdfBuffer }, { businessSize: job.businessSize, role: job.role });
    const meta = { fileName: job.fileName, pages: parsed.pages, businessSize: job.businessSize, role: job.role, date: new Date() };
    const report = await buildReportPdf(review, meta);
    await sendReviewEmail({ to: job.email, review, meta, pdfBuffer: report });
    await removeJob(id);
    console.log(`[queue] ${id} sent in ${Math.round((Date.now() - started) / 1000)}s (${review.items.length} items)`);
  } catch (err) {
    job.attempts += 1;
    const retry = err.retryable !== false && job.attempts < config.limits.maxAttempts;
    console.error(`[queue] ${id} attempt ${job.attempts} failed: ${err.message}${retry ? ' (will retry)' : ''}`);
    if (retry) {
      await fsp.writeFile(jobFile(id, 'json'), JSON.stringify(job));
      setTimeout(() => { waiting.push(id); pump(); }, 30000 * job.attempts);
      return;
    }
    try {
      await sendFailureEmail({ to: job.email, meta: { fileName: job.fileName } });
    } catch (mailErr) {
      console.error(`[queue] ${id} failure email also failed: ${mailErr.message}`);
    }
    await removeJob(id);
  }
}

/** Pick up jobs left over from before a restart. */
function resume() {
  const ids = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort();
  if (ids.length) console.log(`[queue] resuming ${ids.length} job(s)`);
  waiting.push(...ids);
  pump();
}

const stats = () => ({ waiting: waiting.length, running });

module.exports = { enqueue, resume, stats };
