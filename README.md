# Vendor quote checker

An AI CTO for small and midsize businesses. Upload a proposal, estimate or contract from a developer, agency or IT company, and get an email with possible red flags, suggestions and ready-to-send questions, plus a full PDF report.

Built by [Sid Gawshinde](https://gawshinde.com), fractional CTO. Free to use, free to fork.

## What it does

1. A visitor picks their business size and role, uploads a PDF and enters their email.
2. The server checks the file right away (is it a PDF, under the size and page limits, readable) and replies "Your review is on its way."
3. In the background, a small queue:
   - reads the text out of the PDF (or sends the PDF itself if it is a scan),
   - asks the AI model you configured (OpenAI, Anthropic Claude or Google Gemini) for a review, using [the prompt in `prompts/`](prompts/),
   - checks and cleans the answer,
   - builds a letter-size PDF report,
   - emails a short summary with the report attached,
   - deletes the uploaded document.
4. If the review fails after retrying, the visitor gets an email saying so, and the document is still deleted.

The review never tells the reader whether to sign or hire. Every finding is written as an observation ("appears to", "I could not find"), and every email and report carries an information-only notice. See [prompts/README.md](prompts/README.md) for the rules the model follows.

## Quick start

Requires Node.js 20 or newer.

```bash
npm install
cp .env.example .env
npm run sample        # creates data/sample-proposal.pdf
LLM_PROVIDER=mock EMAIL_TRANSPORT=log npm start
```

Open http://localhost:3000, upload `data/sample-proposal.pdf`, and the email (with the PDF attached) is written to `data/outbox/` as an `.eml` file you can open in any mail app. The `mock` provider returns a fixed sample review, so you can test everything without an API key.

To use a real model, set `LLM_PROVIDER`, `LLM_MODEL` and that provider's API key in `.env`. To send real email, set `EMAIL_TRANSPORT=resend`, `RESEND_API_KEY`, and an `EMAIL_FROM` on a domain you verified in Resend.

## Testing

```bash
npm test                                  # automated tests: no API calls, no real email
npm run check:llm                         # one real review with your provider (paid, a few cents or less)
npm run check:llm -- my-quote.pdf --report  # your own PDF, also writes data/check-report.pdf
npm run check:email -- you@gmail.com      # sends one real sample review email
```

`npm test` covers the upload endpoint end to end (with the mock model and emails written to a temp folder), input checks, daily limits including parallel requests, PDF reading, answer cleaning, the report, the Resend request, and each AI provider's request and error handling against a fake API. Run the two `check:` scripts after changing provider, model, or email settings.

## Configuration

Everything is set with environment variables. [.env.example](.env.example) lists them all with comments. The ones you will change first:

| Setting | What it does |
| --- | --- |
| `LLM_PROVIDER` | `openai`, `anthropic`, `gemini` or `mock` |
| `LLM_MODEL` | The model name from your provider's documentation |
| `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `GEMINI_API_KEY` | Only the one for your provider |
| `LLM_INPUT` | `auto` (default) sends extracted text, or the PDF itself when it has no text. `text` or `pdf` forces one. |
| `EMAIL_TRANSPORT` | `resend` (default) to send with the Resend API, `smtp` for any SMTP service, `log` to write emails to `data/outbox` |
| `EMAIL_FROM`, `RESEND_API_KEY` | Your sending address (on a domain verified in Resend) and Resend key. `SMTP_*` is only needed with `EMAIL_TRANSPORT=smtp`. |
| `PRIVACY_URL` | Link to your privacy policy, shown under the form |
| `OWNER_NAME`, `AI_NAME`, `SITE_URL`, `CTA_URL`, `CONTACT_EMAIL` | Your details, used on the page, in the email and in the report |
| `MAILING_ADDRESS` | Postal address for the email footer |
| `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY` | Cloudflare Turnstile spam check. Strongly recommended in production. |
| `LIMIT_PER_EMAIL_PER_DAY`, `LIMIT_PER_IP_PER_DAY`, `LIMIT_TOTAL_PER_DAY` | Caps that protect your AI bill |
| `DATA_DIR` | Where queued jobs and opted-in subscribers are stored. Must be outside any folder that is replaced on deploy. |

### Choosing a model

Any capable model works. Larger models give more careful reviews; the cost per review depends on the model and document length. Text mode (the default for text PDFs) is cheaper than sending the PDF file. Check your provider's pricing page.

## Project layout

```
server.js              Web server: page, upload endpoint, health check
src/config.js          Settings from environment variables
src/pdf-text.js        Reads text and page count from the PDF
src/review.js          Builds the prompt, calls the model, cleans the answer
src/llm/index.js       OpenAI, Anthropic and Gemini calls (plain HTTPS, no SDKs)
src/report-pdf.js      The PDF report
src/email.js           The review email and the failure email (Resend API, or SMTP via Nodemailer)
src/queue.js           Disk-backed job queue; survives restarts
src/guards.js          Daily limits and the Turnstile check
prompts/               The system prompt and user message sent to the model
public/                The upload page, styles and script
assets/fonts/          Newsreader and Schibsted Grotesk for the PDF (SIL Open Font License)
```

## Privacy

- Uploaded documents are stored only while they wait in the queue, and deleted after the email is sent or the review fails.
- The document text (or file) is sent to the AI provider you configure. Check that provider's data-retention terms and say so in your privacy policy.
- Email addresses are not stored, except for people who tick "send me occasional notes", who are added to `subscribers.csv` in `DATA_DIR`.
- No analytics or tracking are included.

## Deploying

See [docs/hostinger.md](docs/hostinger.md) for Hostinger Business or Cloud hosting. Any host that runs a Node.js process with a writable folder works the same way: set the environment variables, run `npm install` and `npm start`.

## License

MIT. See [LICENSE](LICENSE). The fonts in `assets/fonts` are under the SIL Open Font License; their license files are in the same folder.

This tool produces information, not advice. If you run it for others, keep the information-only notices in place.
