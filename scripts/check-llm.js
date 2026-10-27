'use strict';
/*
 * Runs one real review against the AI provider in your .env and prints the result.
 * Use it to confirm the provider, model name and API key work before deploying.
 *
 *   npm run check:llm                       uses data/sample-proposal.pdf
 *   npm run check:llm -- path/to/file.pdf   uses your own PDF
 *   npm run check:llm -- file.pdf --pdf     sends the PDF file itself (tests scan handling)
 *   npm run check:llm -- --report           also writes the PDF report to data/check-report.pdf
 *
 * This calls the paid API once. Nothing is emailed.
 */
const args = process.argv.slice(2);
if (args.includes('--pdf')) process.env.LLM_INPUT = 'pdf';
if (args.includes('--text')) process.env.LLM_INPUT = 'text';

const fs = require('node:fs');
const path = require('node:path');
const { config, checkConfig } = require('../src/config');
const { readPdf } = require('../src/pdf-text');
const { runReview } = require('../src/review');
const { buildReportPdf } = require('../src/report-pdf');

async function main() {
  const problems = checkConfig().filter((p) => !p.startsWith('SMTP_'));
  if (problems.length) {
    console.error('Fix these settings first:\n- ' + problems.join('\n- '));
    process.exit(1);
  }
  if (config.llm.provider === 'mock') console.warn('LLM_PROVIDER is mock, so this only checks the sample review. Set a real provider to test it.\n');

  const file = path.resolve(args.find((a) => !a.startsWith('--')) || path.join(__dirname, '..', 'data', 'sample-proposal.pdf'));
  if (!fs.existsSync(file)) {
    console.error(`No PDF at ${file}. Run \`npm run sample\` first, or pass a path.`);
    process.exit(1);
  }
  const buffer = fs.readFileSync(file);
  const parsed = await readPdf(buffer, { maxPages: config.limits.maxPages, maxChars: config.limits.maxTextChars });
  console.log(`Provider: ${config.llm.provider}  Model: ${config.llm.model || '(none)'}  Input: ${config.llm.inputMode}`);
  console.log(`Document: ${path.basename(file)}, ${parsed.pages} pages, ${parsed.text.length} characters of text${parsed.truncated ? ' (truncated)' : ''}`);
  console.log('Asking the model. This can take a minute...\n');

  const started = Date.now();
  const review = await runReview({ ...parsed, pdfBuffer: buffer }, { businessSize: 'Small business', role: 'Business owner' });
  const secs = ((Date.now() - started) / 1000).toFixed(1);

  const flags = review.items.filter((i) => i.type === 'red_flag');
  console.log(`OK in ${secs}s. Reviewable: ${review.is_reviewable}. ${flags.length} possible red flags, ${review.items.length - flags.length} suggestions, ${review.questions_to_send.length} questions.\n`);
  console.log(`Headline: ${review.summary.headline}\n`);
  for (const it of review.items) console.log(`- [${it.type === 'red_flag' ? 'FLAG' : 'sugg'}] ${it.title}  (${it.evidence})`);

  // Simple checks on the prompt rules, so wording problems show up here instead of in a visitor's inbox.
  const all = JSON.stringify(review).toLowerCase();
  const warnings = [];
  if (/\byou should (sign|reject|accept|hire)\b|\bdo not sign\b|\bdon't sign\b/.test(all)) warnings.push('The review appears to tell the reader what to decide.');
  if (/\b\d+\s*\/\s*10\b|\bscore\b|\bgrade\b/.test(all)) warnings.push('The review may contain a score or grade.');
  if (!review.items.length && review.is_reviewable) warnings.push('No items at all. Check the document had readable content.');
  if (warnings.length) console.log('\nCheck the wording:\n- ' + warnings.join('\n- '));

  const out = path.join(config.dataDir, 'check-review.json');
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.writeFileSync(out, JSON.stringify(review, null, 2));
  console.log(`\nFull review saved to ${out}`);
  if (args.includes('--report')) {
    const pdf = await buildReportPdf(review, { fileName: path.basename(file), pages: parsed.pages, businessSize: 'Small business', role: 'Business owner', date: new Date() });
    const pdfOut = path.join(config.dataDir, 'check-report.pdf');
    fs.writeFileSync(pdfOut, pdf);
    console.log(`Report saved to ${pdfOut}`);
  }
}

main().catch((err) => {
  console.error(`\nFAILED: ${err.message}`);
  if (err.status === 401 || err.status === 403) console.error('The API key looks wrong, or it does not have access to this model.');
  if (err.status === 404) console.error('The model name looks wrong. Copy the exact model ID from your provider\'s model list.');
  if (err.status === 400) console.error('The provider rejected the request. The message above usually says which field.');
  process.exit(1);
});
