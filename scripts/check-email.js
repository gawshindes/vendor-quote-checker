'use strict';
/*
 * Checks your email settings (Resend or SMTP) and sends one real sample review email (with the PDF report)
 * so you can see exactly what visitors receive and whether it lands in the inbox.
 *
 *   npm run check:email -- you@example.com
 *
 * Tip: send it to the address shown at https://www.mail-tester.com to get a spam score,
 * and to a Gmail and an Outlook address to check where it lands.
 */
const nodemailer = require('nodemailer');
const { config } = require('../src/config');
const { sendReviewEmail } = require('../src/email');
const { buildReportPdf } = require('../src/report-pdf');
const { normalizeReview } = require('../src/review');

async function main() {
  const to = process.argv[2];
  if (!to || !to.includes('@')) {
    console.error('Usage: npm run check:email -- you@example.com');
    process.exit(1);
  }
  const s = config.email.smtp;
  if (config.email.transport === 'resend') {
    if (!config.email.resendKey) {
      console.error('Set RESEND_API_KEY first.');
      process.exit(1);
    }
    console.log(`Sending through Resend from ${config.email.from}...`);
  } else if (config.email.transport === 'smtp') {
    if (!s.host || !s.user || !s.pass) {
      console.error('Set SMTP_HOST, SMTP_USER and SMTP_PASS first.');
      process.exit(1);
    }
    console.log(`Connecting to ${s.host}:${s.port} (secure: ${s.secure}) as ${s.user}...`);
    const t = nodemailer.createTransport({ host: s.host, port: s.port, secure: s.secure, auth: { user: s.user, pass: s.pass } });
    await t.verify();
    console.log('SMTP login OK.');
  } else {
    console.log(`EMAIL_TRANSPORT=${config.email.transport}, so the email is written to ${config.dataDir}/outbox instead of sent.`);
  }

  const fromAddr = (config.email.from.match(/<([^>]+)>/) || [, config.email.from])[1];
  if (/@example\./i.test(fromAddr) && config.email.transport !== 'log') {
    console.error(`EMAIL_FROM is ${fromAddr}. Set it to an address on the domain you verified in Resend.`);
    process.exit(1);
  }
  if (config.email.transport === 'smtp' && s.user && fromAddr && fromAddr.toLowerCase() !== s.user.toLowerCase()) {
    console.warn(`Note: EMAIL_FROM (${fromAddr}) differs from SMTP_USER (${s.user}). Many providers reject or flag this unless the address is verified.`);
  }

  const review = normalizeReview(require('../src/llm/mock-review.json'));
  const meta = { fileName: 'sample-proposal.pdf', pages: 2, businessSize: 'Small business', role: 'Business owner', date: new Date() };
  const pdfBuffer = await buildReportPdf(review, meta);
  const info = await sendReviewEmail({ to, review, meta, pdfBuffer });
  console.log(`Sent. Message ID: ${info.messageId || '(none)'}${info.accepted ? `, accepted: ${info.accepted.join(', ')}` : ''}`);
  if (info.rejected && info.rejected.length) console.warn(`Rejected: ${info.rejected.join(', ')}`);
}

main().catch((err) => {
  console.error(`FAILED: ${err.message}`);
  if (err.status === 401 || err.status === 403) console.error('Resend rejected the key or the sender. Check RESEND_API_KEY, and that the EMAIL_FROM domain is verified at https://resend.com/domains.');
  if (err.status === 422) console.error('Resend rejected a field. The message above says which one (often EMAIL_FROM).');
  if (err.code === 'EAUTH') console.error('The username or password was not accepted.');
  if (err.code === 'ESOCKET' || err.code === 'ECONNECTION' || err.code === 'ETIMEDOUT') console.error('Could not connect. Check SMTP_HOST and SMTP_PORT, and that SMTP_SECURE=true for port 465 or false for 587.');
  process.exit(1);
});
