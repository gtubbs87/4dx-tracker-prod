'use strict';
/**
 * Weekly leadership digest (run via the CronJob in
 * k8s/cronjobs-and-netpol.yaml, Monday mornings).
 *
 * Summarizes which teams are below the red threshold this week, and which
 * teams have members who haven't logged their commitment yet. Posts to
 * Microsoft Teams (TEAMS_WEBHOOK_URL) if configured; always logs too.
 */
const { pool } = require('../db');
const { band, commitmentAttainment, sessionAttainment } = require('../lib/metrics');
const { isoWeekMonday } = require('../lib/dates');
const { postToTeams } = require('../lib/notify');
const { getConfig, leafTeams, commitmentRowsInWindow, sessionRowsInWindow, pendingCommitmentsForTeam } = require('../lib/orgReports');

async function run() {
  const cfg = await getConfig();
  const leaves = await leafTeams();
  const thisWeek = isoWeekMonday();

  const thresholdLines = [];
  const pendingLines = [];
  for (const leaf of leaves) {
    const commit4 = commitmentAttainment(await commitmentRowsInWindow(leaf.id, 4));
    const session4 = sessionAttainment(await sessionRowsInWindow(leaf.id, 4));
    const cBand = band(commit4, cfg.commit_yellow, cfg.commit_green);
    const sBand = band(session4, cfg.session_yellow, cfg.session_green);
    if (cBand.label === 'Red' || sBand.label === 'Red') {
      thresholdLines.push(`• *${leaf.name}* — commitment ${commit4 != null ? Math.round(commit4 * 100) + '%' : 'n/a'} (${cBand.label}), cadence ${session4 != null ? Math.round(session4 * 100) + '%' : 'n/a'} (${sBand.label})`);
    }
    const pending = await pendingCommitmentsForTeam(leaf.id, thisWeek);
    if (pending.length > 0) {
      pendingLines.push(`• *${leaf.name}* — ${pending.map((m) => `${m.first_name} ${m.last_name}`).join(', ')}`);
    }
  }

  const parts = [
    thresholdLines.length
      ? `${thresholdLines.length} team(s) below threshold this week:\n${thresholdLines.join('\n')}`
      : 'No teams below threshold this week. 🎉',
    pendingLines.length
      ? `${pendingLines.length} team(s) with members who haven't committed yet this week:\n${pendingLines.join('\n')}`
      : "Everyone's logged this week's commitment. 🎉",
  ];
  const summary = `*4DX weekly digest*\n${parts.join('\n\n')}`;

  console.log(summary); // eslint-disable-line no-console
  await postToTeams(summary);

  await pool.end();
}

run().catch((err) => {
  console.error('Weekly digest failed:', err); // eslint-disable-line no-console
  process.exit(1);
});
