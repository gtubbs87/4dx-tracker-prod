'use strict';
/**
 * Monthly WIG-metrics reminder (run via the CronJob in
 * k8s/cronjobs-and-netpol.yaml, a few days before month end).
 *
 * Finds every active WIG whose current month has no lag_actual reading yet,
 * and pings the team's manager(s) so metrics don't go stale. Posts to
 * Microsoft Teams (TEAMS_WEBHOOK_URL) if configured; always logs, and emails
 * each affected manager individually via the stubbed mailer.
 */
const { query, pool } = require('../db');
const { postToTeams, sendEmail } = require('../lib/notify');
const { metricsDueOrgWide } = require('../lib/orgReports');

async function run() {
  const dueWigs = await metricsDueOrgWide();

  const lines = [];
  for (const w of dueWigs) {
    const recipients = await query(
      "SELECT first_name, last_name, email FROM users WHERE team_id = ? AND role != 'ic' AND active = 1",
      [w.teamId]
    );
    const who = recipients.length ? recipients.map((r) => `${r.first_name} ${r.last_name}`).join(', ') : 'no manager assigned';
    lines.push(`• *${w.teamName}* — "${w.statement}" — ${who}`);

    await Promise.all(recipients.map((r) => sendEmail({
      to: r.email,
      subject: `Action needed: log this month's WIG numbers for ${w.teamName}`,
      text: `The WIG "${w.statement}" for ${w.teamName} doesn't have this month's actuals logged yet. Enter them on the team Scoreboard.`,
    })));
  }

  const summary = lines.length
    ? `*4DX metrics reminder* — ${lines.length} team(s) haven't logged this month's WIG numbers yet:\n${lines.join('\n')}`
    : "*4DX metrics reminder* — every active WIG is up to date this month. 🎉";

  console.log(summary); // eslint-disable-line no-console
  await postToTeams(summary);

  await pool.end();
}

run().catch((err) => {
  console.error('Metrics reminder failed:', err); // eslint-disable-line no-console
  process.exit(1);
});
