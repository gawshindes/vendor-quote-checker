'use strict';
/*
 * Sends the review email (short summary in the body, full report attached as a PDF)
 * and the failure email. EMAIL_TRANSPORT=resend uses the Resend API, smtp works
 * with any SMTP service, and log writes
 * the messages to data/outbox instead of sending them, for local testing.
 */
const fs = require('node:fs');
const path = require('node:path');
const nodemailer = require('nodemailer');
const { config } = require('./config');

let transporter;
function getTransport() {
  if (transporter) return transporter;
  if (config.email.transport === 'log') {
    transporter = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'unix' });
  } else {
    const s = config.email.smtp;
    transporter = nodemailer.createTransport({ host: s.host, port: s.port, secure: s.secure, auth: { user: s.user, pass: s.pass } });
  }
  return transporter;
}

/* Resend HTTP API: https://resend.com/docs/api-reference/emails/send-email */
async function sendViaResend(message, idempotencyKey) {
  const body = {
    from: config.email.from,
    to: [message.to],
    subject: message.subject,
    html: message.html,
    text: message.text,
  };
  if (config.email.replyTo) body.reply_to = config.email.replyTo;
  if (config.email.bcc) body.bcc = config.email.bcc.split(',').map((s) => s.trim()).filter(Boolean);
  if (message.attachments) {
    body.attachments = message.attachments.map((a) => ({ filename: a.filename, content: Buffer.from(a.content).toString('base64') }));
  }
  const headers = { authorization: `Bearer ${config.email.resendKey}`, 'content-type': 'application/json' };
  // Stops a retried job from sending the same email twice (Resend keeps keys for 24 hours).
  if (idempotencyKey) headers['idempotency-key'] = idempotencyKey.slice(0, 256);
  let res;
  try {
    res = await fetch('https://api.resend.com/emails', { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
  } catch (err) {
    throw new Error(`Could not reach Resend: ${err.message}`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`Resend returned ${res.status}: ${data.message || data.name || 'unknown error'}`);
    err.status = res.status;
    throw err;
  }
  return { messageId: data.id, accepted: [message.to] };
}

async function send(message, { idempotencyKey } = {}) {
  if (config.email.transport === 'resend') return sendViaResend(message, idempotencyKey);
  const info = await getTransport().sendMail({
    from: config.email.from,
    replyTo: config.email.replyTo || undefined,
    bcc: config.email.bcc || undefined,
    ...message,
  });
  if (config.email.transport === 'log') {
    const dir = path.join(config.dataDir, 'outbox');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${Date.now()}-${message.to.replace(/[^a-z0-9]+/gi, '_')}.eml`);
    fs.writeFileSync(file, info.message);
    console.log(`[email] written to ${file}`);
  }
  return info;
}

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const serif = "Georgia, 'Times New Roman', serif";
const sans = 'Arial, Helvetica, sans-serif';

function slug(name) {
  return String(name || 'document').replace(/\.pdf$/i, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'document';
}

function layout({ preheader, bodyHtml }) {
  const b = config.brand;
  const footer = `You received this email because you asked for a vendor quote review at ${esc(b.siteUrl.replace(/^https?:\/\//, ''))}. Your document was deleted after this review was written.${b.mailingAddress ? `<br><br>${esc(b.ownerName)} · ${esc(b.mailingAddress)}` : ''}`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(b.toolName)}</title></head>
<body style="margin:0;padding:0;background:#E9E7E2;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#E9E7E2;"><tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background:#FFFFFF;">
<tr><td style="padding:24px 32px 18px;border-bottom:1px solid #E4E2DD;font-family:${sans};">
<div style="font-family:${serif};font-size:20px;color:#16181A;">${esc(b.aiName)}</div>
<div style="font-size:13px;color:#5A5F63;margin-top:2px;">${esc(b.toolName)} by ${esc(b.ownerName)}</div>
</td></tr>
${bodyHtml}
<tr><td style="padding:20px 32px 26px;font-family:${sans};font-size:12px;line-height:1.6;color:#5A5F63;">${footer}</td></tr>
</table></td></tr></table></body></html>`;
}

function ctaBlock() {
  const b = config.brand;
  const first = b.ownerName.split(' ')[0];
  return `<tr><td style="padding:28px 32px;background:#1E4535;font-family:${sans};">
<div style="font-family:${serif};font-size:22px;line-height:1.25;color:#FFFFFF;">Want a second opinion?</div>
<div style="margin-top:10px;font-size:15px;line-height:1.55;color:#D6DAD5;">This report is generated by ${esc(b.aiName)}. For a second opinion from an experienced human CTO, ${esc(b.ownerName)} reviews vendor proposals and technology projects for small and midsize businesses. Reply to this email to reach ${esc(first)}, or book a short intro call.</div>
<table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:18px;"><tr><td style="background:#EEECE6;"><a href="${esc(b.ctaUrl)}" style="display:inline-block;padding:13px 22px;font-family:${sans};font-size:15px;font-weight:bold;color:#16181A;text-decoration:none;">Book an intro call</a></td></tr></table>
</td></tr>`;
}

async function sendReviewEmail({ to, review, meta, pdfBuffer, idempotencyKey }) {
  const b = config.brand;
  const flags = review.items.filter((i) => i.type === 'red_flag');
  const suggs = review.items.filter((i) => i.type !== 'red_flag');
  const nQ = review.questions_to_send.length;
  const attachmentName = `vendor-quote-review-${slug(meta.fileName)}.pdf`;
  const preheader = review.is_reviewable
    ? `${flags.length} possible red flag${flags.length === 1 ? '' : 's'}, ${suggs.length} suggestion${suggs.length === 1 ? '' : 's'} and ${nQ} question${nQ === 1 ? '' : 's'} you could ask the vendor.`
    : 'I could not review this document. Details inside.';

  const stat = (n, label, color, first) => `<td width="33%" style="padding:14px 0 14px ${first ? 0 : 16}px;${first ? '' : 'border-left:1px solid #E4E2DD;'}font-family:${sans};vertical-align:top;"><div style="font-family:${serif};font-size:30px;line-height:1;color:${color};">${n}</div><div style="margin-top:6px;font-size:13px;color:#44484B;">${label}</div></td>`;
  const flagList = flags.slice(0, 5).map((f) => `<li style="margin-bottom:6px;"><strong style="color:#16181A;">${esc(f.title)}.</strong> ${esc(firstSentence(f.detail))}</li>`).join('');

  const body = `
<tr><td style="padding:28px 32px 0;font-family:${sans};">
<p style="margin:0;font-size:15px;line-height:1.6;color:#33373A;">Hi, I’m ${esc(b.aiName)}, an AI reviewer built by ${esc(b.ownerName)}. Here is my review of <strong style="color:#16181A;">${esc(meta.fileName)}</strong>. The full report is attached as a PDF you can forward or keep.</p>
<h1 style="margin:22px 0 0;font-family:${serif};font-weight:normal;font-size:25px;line-height:1.25;color:#16181A;">${esc(review.summary.headline)}</h1>
</td></tr>
${review.is_reviewable ? `
<tr><td style="padding:22px 32px 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #16181A;border-bottom:1px solid #16181A;"><tr>${stat(flags.length, 'Possible red flags', '#9A3412', true)}${stat(suggs.length, 'Suggestions', '#1E4535')}${stat(nQ, 'Questions to ask', '#16181A')}</tr></table></td></tr>
${flags.length ? `<tr><td style="padding:24px 32px 0;font-family:${sans};"><h2 style="margin:0 0 10px;font-family:${serif};font-weight:normal;font-size:20px;color:#16181A;">Possible red flags</h2><ul style="margin:0;padding-left:20px;font-size:15px;line-height:1.6;color:#33373A;">${flagList}</ul></td></tr>` : ''}
` : `<tr><td style="padding:16px 32px 0;font-family:${sans};font-size:15px;line-height:1.6;color:#33373A;">${esc(review.summary.overview)}</td></tr>`}
<tr><td style="padding:24px 32px 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #D9D7D2;"><tr>
<td width="52" style="padding:16px 0 16px 18px;vertical-align:middle;"><div style="width:32px;border:1px solid #16181A;font-family:${sans};font-size:10px;font-weight:bold;color:#16181A;text-align:center;line-height:14px;height:14px;padding-top:24px;">PDF</div></td>
<td style="padding:16px 18px 16px 12px;font-family:${sans};vertical-align:middle;"><div style="font-size:15px;font-weight:bold;color:#16181A;">${esc(attachmentName)}</div><div style="margin-top:2px;font-size:13px;line-height:1.5;color:#5A5F63;">The full review: each possible red flag and suggestion with the page it relates to, the questions you could ask, ongoing costs, and what the review could not check.</div></td>
</tr></table></td></tr>
<tr><td style="padding:22px 32px 28px;font-family:${sans};font-size:13px;line-height:1.55;color:#44484B;">This review is for information only. It is not legal, financial or professional advice, and it does not recommend whether to sign or hire. It was generated by ${esc(b.aiName)}, an AI model, reflects only what could be found in your document, and may contain mistakes. Have a lawyer review any contract before you sign.</td></tr>
${ctaBlock()}`;

  const text = [
    `Hi, I'm ${b.aiName}, an AI reviewer built by ${b.ownerName}. Here is my review of ${meta.fileName}. The full report is attached as a PDF.`,
    '',
    review.summary.headline,
    '',
    review.is_reviewable ? `Possible red flags: ${flags.length}. Suggestions: ${suggs.length}. Questions to ask: ${nQ}.` : review.summary.overview,
    ...flags.slice(0, 5).map((f) => `- ${f.title}`),
    '',
    'This review is for information only. It is not legal, financial or professional advice, and it does not recommend whether to sign or hire. Have a lawyer review any contract before you sign.',
    '',
    `Want a second opinion? This report is generated by ${b.aiName}. ${b.ownerName} reviews vendor proposals and technology projects for small and midsize businesses: ${b.ctaUrl}`,
  ].join('\n');

  return send({
    to,
    subject: `Your vendor quote review: ${meta.fileName}`,
    html: layout({ preheader, bodyHtml: body }),
    text,
    attachments: [{ filename: attachmentName, content: pdfBuffer, contentType: 'application/pdf' }],
  }, { idempotencyKey });
}

async function sendFailureEmail({ to, meta, idempotencyKey }) {
  const b = config.brand;
  const body = `<tr><td style="padding:28px 32px;font-family:${sans};font-size:15px;line-height:1.6;color:#33373A;">
<h1 style="margin:0 0 14px;font-family:${serif};font-weight:normal;font-size:24px;color:#16181A;">I could not finish your review</h1>
<p style="margin:0 0 12px;">Something went wrong while I was reviewing <strong style="color:#16181A;">${esc(meta.fileName)}</strong>, so there is no report this time. Your document has been deleted.</p>
<p style="margin:0;">You can <a href="${esc(config.baseUrl)}" style="color:#1E4535;">try again</a>, or reply to this email and ${esc(b.ownerName.split(' ')[0])} will take a look.</p>
</td></tr>${ctaBlock()}`;
  return send({
    to,
    subject: `Your vendor quote review could not be completed: ${meta.fileName}`,
    html: layout({ preheader: 'Something went wrong. Your document has been deleted.', bodyHtml: body }),
    text: `I could not finish the review of ${meta.fileName}, so there is no report this time. Your document has been deleted. You can try again at ${config.baseUrl}.`,
  }, { idempotencyKey });
}

function firstSentence(s) {
  const m = String(s || '').match(/^.*?[.!?](\s|$)/);
  return (m ? m[0] : String(s || '')).trim();
}

module.exports = { sendReviewEmail, sendFailureEmail };
