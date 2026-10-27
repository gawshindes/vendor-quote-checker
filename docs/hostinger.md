# Deploying on Hostinger

Hostinger runs Node.js apps on its Business Web Hosting and Cloud plans. These steps put the checker on its own subdomain, for example `tools.yourdomain.com`, next to your main site.

## 1. Before you start

- An API key for your AI provider (OpenAI, Anthropic or Google Gemini).
- An email account that can send by SMTP. A mailbox on your domain works (for example `reviews@yourdomain.com` in Hostinger Email: hPanel shows its SMTP host and port). A transactional email service such as Resend or Postmark usually lands in inboxes more reliably.
- Recommended: a free Cloudflare Turnstile site key and secret key for the spam check, created for your subdomain.

## 2. Create the app

1. In hPanel, go to **Websites**, then **Add Website** (or **Create Website**), and choose **Web App** (Node.js).
2. Choose **Connect with GitHub** (or **Import Git Repository**) and pick this repository. Private repositories work once Hostinger's GitHub app has access.
3. Pick the branch to deploy (usually `main`). Every push to that branch redeploys automatically.
4. Framework: **Express.js** (or **Other** with entry file `server.js`). Node version: **22.x** (20.x and 24.x also work).
5. Domain: create the subdomain, such as `tools.yourdomain.com`, as its own website. Hostinger does not run Node.js apps in a subfolder of an existing site.

## 3. Set the environment variables

Open the app's **Environment Variables** and add the settings from `.env.example`. At minimum:

```
NODE_ENV=production
BASE_URL=https://tools.yourdomain.com
LLM_PROVIDER=anthropic
LLM_MODEL=<model name>
ANTHROPIC_API_KEY=<key>
EMAIL_TRANSPORT=smtp
EMAIL_FROM="AI CTO by Your Name <reviews@yourdomain.com>"
EMAIL_REPLY_TO=you@yourdomain.com
SMTP_HOST=<host>
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=reviews@yourdomain.com
SMTP_PASS=<password>
OWNER_NAME=Your Name
SITE_URL=https://yourdomain.com
CTA_URL=https://yourdomain.com/#start
CONTACT_EMAIL=you@yourdomain.com
MAILING_ADDRESS=<postal address>
REPO_URL=https://github.com/<you>/vendor-quote-checker
DATA_DIR=/home/<username>/domains/tools.yourdomain.com/vqc-data
TURNSTILE_SITE_KEY=<site key>
TURNSTILE_SECRET_KEY=<secret key>
```

**`DATA_DIR` matters.** Hostinger replaces everything in `hbuilds/` and `public_html` on every deploy. Point `DATA_DIR` at a folder outside them, such as the `vqc-data` folder above, so queued reviews and opted-in subscribers survive a deploy. Your username is shown in hPanel and in File Manager paths.

With `NODE_ENV=production`, the app refuses to start if a required setting is missing, and the deployment log says which one.

## 4. Deploy and test

1. Click **Deploy** (or **Redeploy**). Watch the deployment log for errors.
2. Visit `https://tools.yourdomain.com/healthz`. It should show `"ok": true` and your provider name.
3. Upload a real proposal you have permission to share, using your own email address. Check the email, the attached PDF, and your spam folder.
4. Set `EMAIL_BCC` to your address for the first weeks if you want a copy of every review that goes out.

## 5. Day to day

- **Change a setting:** edit the environment variable, then **Restart** the app (no rebuild needed).
- **Change the prompt or page:** edit the files in GitHub and push. Hostinger redeploys automatically.
- **Logs and usage:** the app dashboard shows deployment logs and CPU, memory and I/O against your plan's limits.
- **Costs:** the daily limits in the environment variables cap how many reviews run per day. Set a monthly spending limit in your AI provider's console as well.
