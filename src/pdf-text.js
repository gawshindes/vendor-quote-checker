'use strict';
const { PDFParse } = require('pdf-parse');

/** Returns { pages, text } for a PDF buffer. Throws a UserFacingError for unreadable files. */
class UserFacingError extends Error {}

async function readPdf(buffer, { maxPages, maxChars }) {
  if (!buffer || buffer.length < 5 || buffer.subarray(0, 5).toString('latin1') !== '%PDF-') {
    throw new UserFacingError('That file does not look like a PDF.');
  }
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  try {
    let info;
    try {
      info = await parser.getInfo();
    } catch (err) {
      if (/password/i.test(String(err && (err.name || err.message)))) {
        throw new UserFacingError('That PDF is password protected. Remove the password and try again.');
      }
      throw new UserFacingError('That PDF could not be opened. Try saving it again as a PDF.');
    }
    const pages = info.total || 0;
    if (pages > maxPages) {
      throw new UserFacingError(`That PDF has ${pages} pages. The limit is ${maxPages}.`);
    }
    const result = await parser.getText({ pageJoiner: '\n-- end of page page_number of total_number --\n' });
    let text = String(result.text || '').replace(/[ \t]+\n/g, '\n').replace(/\n{4,}/g, '\n\n\n').trim();
    let truncated = false;
    if (text.length > maxChars) {
      text = text.slice(0, maxChars);
      truncated = true;
    }
    return { pages, text, truncated };
  } finally {
    await parser.destroy().catch(() => {});
  }
}

/** Characters of real text, ignoring page markers and whitespace. */
function meaningfulLength(text) {
  return String(text || '').replace(/-- end of page \d+ of \d+ --/g, '').replace(/\s+/g, '').length;
}

module.exports = { readPdf, meaningfulLength, UserFacingError };
