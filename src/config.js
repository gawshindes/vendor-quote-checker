'use strict';
/*
 * All settings come from environment variables (or a .env file in development).
 * See .env.example for the full list with explanations.
 */
const path = require('node:path');
require('dotenv').config({ quiet: true });

const env = (name, fallback = '') => {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
};
const num = (name, fallback) => {
  const n = Number(env(name, ''));
  return Number.isFinite(n) && n > 0 ? n : fallback;
};
const bool = (name, fallback) => {
  const v = env(name, '').toLowerCase();
  if (v === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v);
};

const provider = env('LLM_PROVIDER', 'mock').toLowerCase();

const config = {
  port: num('PORT', 3000),
  baseUrl: env('BASE_URL', 'http://localhost:3000'),
  dataDir: path.resolve(env('DATA_DIR', path.join(__dirname, '..', 'data'))),
  trustProxy: bool('TRUST_PROXY', true),

  brand: {
    toolName: env('TOOL_NAME', 'Vendor quote checker'),
    aiName: env('AI_NAME', 'AI CTO'),
    ownerName: env('OWNER_NAME', 'Sid Gawshinde'),
    ownerTitle: env('OWNER_TITLE', 'Fractional CTO'),
    siteUrl: env('SITE_URL', 'https://gawshinde.com').replace(/\/+$/, ''),
    ctaUrl: env('CTA_URL', 'https://gawshinde.com/#start'),
    contactEmail: env('CONTACT_EMAIL', 'sid@gawshinde.com'),
    mailingAddress: env('MAILING_ADDRESS', ''),
    repoUrl: env('REPO_URL', 'https://github.com/'),
    privacyUrl: env('PRIVACY_URL', ''),
  },

  llm: {
    provider, // openai | anthropic | gemini | mock
    model: env('LLM_MODEL', ''),
    inputMode: env('LLM_INPUT', 'auto').toLowerCase(), // auto | text | pdf
    // Reasoning ("thinking") models count their thinking toward this limit, so leave headroom.
    maxOutputTokens: num('LLM_MAX_OUTPUT_TOKENS', 16000),
    timeoutMs: num('LLM_TIMEOUT_SECONDS', 240) * 1000,
    keys: {
      openai: env('OPENAI_API_KEY'),
      anthropic: env('ANTHROPIC_API_KEY'),
      gemini: env('GEMINI_API_KEY'),
    },
  },

  email: {
    transport: env('EMAIL_TRANSPORT', 'resend').toLowerCase(), // resend | smtp | log
    resendKey: env('RESEND_API_KEY'),
    from: env('EMAIL_FROM', 'AI CTO by Sid Gawshinde <reviews@gawshinde.com>'),
    replyTo: env('EMAIL_REPLY_TO', env('CONTACT_EMAIL', 'sid@gawshinde.com')),
    bcc: env('EMAIL_BCC', ''),
    smtp: {
      host: env('SMTP_HOST'),
      port: num('SMTP_PORT', 465),
      secure: bool('SMTP_SECURE', true),
      user: env('SMTP_USER'),
      pass: env('SMTP_PASS'),
    },
  },

  limits: {
    maxFileMb: num('MAX_FILE_MB', 20),
    maxPages: num('MAX_PAGES', 60),
    maxTextChars: num('MAX_TEXT_CHARS', 150000),
    perEmailPerDay: num('LIMIT_PER_EMAIL_PER_DAY', 3),
    perIpPerDay: num('LIMIT_PER_IP_PER_DAY', 5),
    totalPerDay: num('LIMIT_TOTAL_PER_DAY', 100),
    concurrency: num('QUEUE_CONCURRENCY', 1),
    maxAttempts: num('MAX_ATTEMPTS', 2),
  },

  turnstile: {
    siteKey: env('TURNSTILE_SITE_KEY'),
    secret: env('TURNSTILE_SECRET_KEY'),
  },

  saveSubscribers: bool('SAVE_SUBSCRIBERS', true),
};

config.paths = {
  jobs: path.join(config.dataDir, 'jobs'),
  subscribers: path.join(config.dataDir, 'subscribers.csv'),
  prompts: path.join(__dirname, '..', 'prompts'),
  fonts: path.join(__dirname, '..', 'assets', 'fonts'),
  public: path.join(__dirname, '..', 'public'),
};

function checkConfig() {
  const problems = [];
  const { llm, email } = config;
  if (!['openai', 'anthropic', 'gemini', 'mock'].includes(llm.provider)) {
    problems.push(`LLM_PROVIDER must be openai, anthropic, gemini or mock (got "${llm.provider}").`);
  }
  if (llm.provider !== 'mock') {
    if (!llm.model) problems.push('LLM_MODEL is not set.');
    if (!llm.keys[llm.provider]) problems.push(`The API key for ${llm.provider} is not set.`);
  }
  if (!['auto', 'text', 'pdf'].includes(llm.inputMode)) problems.push('LLM_INPUT must be auto, text or pdf.');
  if (!['resend', 'smtp', 'log'].includes(email.transport)) problems.push('EMAIL_TRANSPORT must be resend, smtp or log.');
  if (email.transport === 'resend' && !email.resendKey) problems.push('RESEND_API_KEY is required when EMAIL_TRANSPORT=resend.');
  if (email.transport !== 'log' && /@example\.(com|org|net)>?$/i.test(email.from.trim().replace(/"$/, ''))) {
    problems.push('EMAIL_FROM still uses example.com. Use an address on a domain you verified in Resend.');
  }
  if (email.transport === 'smtp' && (!email.smtp.host || !email.smtp.user || !email.smtp.pass)) {
    problems.push('SMTP_HOST, SMTP_USER and SMTP_PASS are required when EMAIL_TRANSPORT=smtp.');
  }
  return problems;
}

module.exports = { config, checkConfig };
