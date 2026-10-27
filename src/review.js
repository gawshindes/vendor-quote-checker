'use strict';
/*
 * Builds the prompt, asks the configured AI model for a review, and turns the
 * answer into a clean, predictable object the report and email can trust.
 */
const fs = require('node:fs');
const path = require('node:path');
const { config } = require('./config');
const { complete, LlmError } = require('./llm');
const { meaningfulLength } = require('./pdf-text');

const AREAS = ['scope', 'missing_items', 'pricing', 'timeline', 'change_control', 'acceptance', 'ownership', 'exit', 'team', 'technical_approach', 'ongoing_costs'];
const DOC_TYPES = ['proposal', 'estimate', 'statement_of_work', 'contract', 'other'];
const PRICING = ['fixed', 'time_and_materials', 'retainer', 'mixed', 'unclear'];

function loadPrompt(name) {
  const raw = fs.readFileSync(path.join(config.paths.prompts, name), 'utf8');
  return raw.replace(/^<!--[\s\S]*?-->\s*/, '').trim();
}

function fill(template, values) {
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (m, key) => (key in values ? values[key] : m));
}

function buildPrompts({ text, truncated, businessSize, role, sendPdf }) {
  const brand = { AI_NAME: config.brand.aiName, OWNER_NAME: config.brand.ownerName };
  const system = fill(loadPrompt('system-prompt.md'), brand);
  const safeText = String(text || '').replace(/<\/?vendor_document>/gi, '[tag removed]');
  const documentBlock = sendPdf
    ? '<vendor_document>\nThe document is attached as a PDF.\n</vendor_document>'
    : `<vendor_document>\n${safeText}\n</vendor_document>`;
  const user = fill(loadPrompt('user-message.md'), {
    ...brand,
    BUSINESS_SIZE: businessSize,
    ROLE: role,
    TRUNCATION_NOTE: truncated && !sendPdf ? 'Note: the document is long, so only its first part is included below. Say so in limitations.\n\n' : '',
    DOCUMENT: documentBlock,
  });
  return { system, user };
}

/* ---------- Parsing and cleaning the answer ---------- */

function extractJson(raw) {
  const s = String(raw || '').trim();
  const attempts = [s];
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) attempts.push(fence[1]);
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a !== -1 && b > a) attempts.push(s.slice(a, b + 1));
  for (const t of attempts) {
    try {
      const v = JSON.parse(t);
      if (v && typeof v === 'object' && !Array.isArray(v)) return v;
    } catch { /* try the next form */ }
  }
  return null;
}

const str = (v, max = 2000) => {
  if (typeof v !== 'string') return '';
  return v.replace(/\u2014/g, ', ').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, max);
};
const strOrNull = (v, max) => str(v, max) || null;
const oneOf = (v, list, fallback) => (list.includes(v) ? v : fallback);

function normalizeReview(r) {
  const items = (Array.isArray(r.items) ? r.items : [])
    .filter((x) => x && typeof x === 'object' && str(x.title))
    .map((x) => ({
      type: x.type === 'red_flag' ? 'red_flag' : 'suggestion',
      area: oneOf(x.area, AREAS, 'scope'),
      title: str(x.title, 160),
      detail: str(x.detail, 1200),
      evidence: str(x.evidence, 400) || 'I could not find this in the document',
    }))
    .slice(0, 12);
  items.sort((a, b) => (a.type === b.type ? 0 : a.type === 'red_flag' ? -1 : 1));
  const list = (v, n, max) => (Array.isArray(v) ? v.map((x) => str(x, max)).filter(Boolean).slice(0, n) : []);
  const ps = r.price_summary && typeof r.price_summary === 'object' ? r.price_summary : {};
  const sum = r.summary && typeof r.summary === 'object' ? r.summary : {};
  return {
    is_reviewable: r.is_reviewable !== false,
    document_type: oneOf(r.document_type, DOC_TYPES, 'other'),
    vendor_name: strOrNull(r.vendor_name, 160),
    project_summary: str(r.project_summary, 1200),
    price_summary: {
      total: strOrNull(ps.total, 160),
      pricing_model: oneOf(ps.pricing_model, PRICING, 'unclear'),
      payment_terms: strOrNull(ps.payment_terms, 300),
    },
    summary: {
      headline: str(sum.headline, 400) || 'Review complete.',
      overview: str(sum.overview, 1600),
    },
    items,
    questions_to_send: list(r.questions_to_send, 10, 500),
    ongoing_costs_to_ask_about: list(r.ongoing_costs_to_ask_about, 10, 300),
    limitations: str(r.limitations, 1200),
  };
}

/**
 * Runs one review. `doc` is { text, truncated, pages, pdfBuffer }.
 * Returns the normalized review object.
 */
async function runReview(doc, { businessSize, role }) {
  const mode = config.llm.inputMode;
  const hasText = meaningfulLength(doc.text) >= 300;
  const sendPdf = mode === 'pdf' || (mode === 'auto' && !hasText);
  if (!sendPdf && !hasText) {
    throw new LlmError('No readable text in the PDF and LLM_INPUT=text, so the PDF cannot be sent.', { retryable: false });
  }
  const { system, user } = buildPrompts({ ...doc, businessSize, role, sendPdf });
  const raw = await complete({
    system,
    userText: user,
    pdfBase64: sendPdf ? doc.pdfBuffer.toString('base64') : null,
  });
  const parsed = extractJson(raw);
  if (!parsed) throw new LlmError('The AI answer was not valid JSON.');
  return normalizeReview(parsed);
}

module.exports = { runReview, normalizeReview, extractJson, buildPrompts };
