'use strict';
/*
 * Daily limits (per email, per IP and in total) and the optional Cloudflare
 * Turnstile spam check. Limits are kept in memory and reset at midnight UTC.
 */
const { config } = require('./config');

let day = new Date().toISOString().slice(0, 10);
const counts = { email: new Map(), ip: new Map(), total: 0 };

function rollDay() {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== day) {
    day = today;
    counts.email.clear();
    counts.ip.clear();
    counts.total = 0;
  }
}

/** Returns an error message if a limit is reached, otherwise null. Does not count. */
function checkLimits({ email, ip }) {
  rollDay();
  const L = config.limits;
  if (counts.total >= L.totalPerDay) return 'The checker has reached its limit for today. Please try again tomorrow.';
  if ((counts.email.get(email) || 0) >= L.perEmailPerDay) return `You can review up to ${L.perEmailPerDay} documents a day with one email address. Please try again tomorrow.`;
  if ((counts.ip.get(ip) || 0) >= L.perIpPerDay) return 'Too many reviews from this network today. Please try again tomorrow.';
  return null;
}

function recordUse({ email, ip }) {
  rollDay();
  counts.total += 1;
  counts.email.set(email, (counts.email.get(email) || 0) + 1);
  counts.ip.set(ip, (counts.ip.get(ip) || 0) + 1);
}

async function verifyTurnstile(token, ip) {
  if (!config.turnstile.secret) return true; // not configured
  if (!token) return false;
  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body: new URLSearchParams({ secret: config.turnstile.secret, response: token, remoteip: ip || '' }),
      signal: AbortSignal.timeout(10000),
    });
    const data = await res.json();
    return data.success === true;
  } catch (err) {
    console.error('[turnstile] verification failed:', err.message);
    return false;
  }
}

module.exports = { checkLimits, recordUse, verifyTurnstile };
