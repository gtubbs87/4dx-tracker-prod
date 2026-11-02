'use strict';
/**
 * Outbound notification channels for scheduled jobs and alerts.
 *
 * Teams: posts to a Microsoft Teams incoming webhook connector if
 * TEAMS_WEBHOOK_URL is set; no-ops otherwise.
 *
 * Email: no real provider is wired up in this environment (no SMTP/SES/
 * SendGrid credentials). sendEmail() logs the full message so every code
 * path that "sends email" is real and testable — swap the body of this
 * function for a real provider call (nodemailer/SES/SendGrid/Graph API)
 * when credentials are available. Every caller already awaits it, so that
 * swap is the only change needed.
 */

async function postToTeams(text) {
  if (!process.env.TEAMS_WEBHOOK_URL) return;
  await fetch(process.env.TEAMS_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ '@type': 'MessageCard', '@context': 'http://schema.org/extensions', text }),
  }).catch((err) => console.error('Failed to post to Teams:', err)); // eslint-disable-line no-console
}

async function sendEmail({ to, subject, html, text }) {
  const recipients = Array.isArray(to) ? to : [to];
  // Subjects are often built from user-entered names/team names. Strip CR/LF
  // here — once — so no caller can forget it and an interpolated newline
  // can't smuggle extra headers (Bcc:, etc.) into a real provider later.
  const safeSubject = String(subject ?? '').replace(/[\r\n]+/g, ' ');
  // TODO: replace with a real provider call (nodemailer/SES/SendGrid/Graph API) once credentials exist.
  console.log(`[email stub] to=${recipients.filter(Boolean).join(', ')} subject="${safeSubject}"\n${text || html}`); // eslint-disable-line no-console
}

module.exports = { postToTeams, sendEmail };
