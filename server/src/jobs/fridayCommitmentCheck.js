'use strict';
/**
 * Friday commitment check — invoked hourly on Fridays via the CronJob in
 * k8s/cronjobs-and-netpol.yaml ("0 9-17 * * 5", 9am-5pm UTC).
 *
 * Before 2pm UTC: reminds each person who hasn't logged this week's
 * commitment (or PTO) yet. From 2pm onward: escalates too — the employee's
 * team manager(s) and the manager's own manager (one hop up manager_id, see
 * users.manager_id) are also notified, every hour the gap persists.
 */
const { pool } = require('../db');
const { sendEmail, postToTeams } = require('../lib/notify');
const { isoWeekMonday } = require('../lib/dates');
const { pendingCommitmentsOrgWide, managersOfTeam, managerOf } = require('../lib/orgReports');

const ESCALATION_HOUR = 14; // 2pm

async function run() {
  const escalate = new Date().getUTCHours() >= ESCALATION_HOUR;
  const pending = await pendingCommitmentsOrgWide(isoWeekMonday());

  let reminded = 0;
  let escalated = 0;

  for (const team of pending) {
    const managers = escalate ? await managersOfTeam(team.teamId) : [];

    for (const member of team.members) {
      reminded += 1;
      await sendEmail({
        to: member.email,
        subject: "Reminder: log this week's commitment",
        text: `You haven't logged a commitment (or PTO) for ${team.teamName} this week yet. Do it on My Week before end of day.`,
      });

      if (!escalate) continue;
      escalated += 1;
      for (const teamManager of managers) {
        if (teamManager.id === member.id) continue; // don't escalate a manager's own lateness to themself
        await sendEmail({
          to: teamManager.email,
          subject: `Escalation: ${member.first_name} ${member.last_name} hasn't committed this week`,
          text: `${member.first_name} ${member.last_name} on ${team.teamName} still hasn't logged this week's commitment as of 2pm.`,
        });
        const upManager = await managerOf(teamManager.id);
        if (upManager) {
          await sendEmail({
            to: upManager.email,
            subject: `Escalation: ${member.first_name} ${member.last_name} (${team.teamName}) hasn't committed this week`,
            text: `${member.first_name} ${member.last_name} on ${team.teamName}, managed by ${teamManager.first_name} ${teamManager.last_name}, still hasn't logged this week's commitment as of 2pm.`,
          });
        }
      }
    }
  }

  const summary = escalate
    ? `*4DX Friday commitment check* — ${escalated} member(s) still haven't committed as of 2pm; manager escalations sent.`
    : `*4DX Friday commitment check* — reminded ${reminded} member(s) who haven't committed yet this week.`;
  console.log(summary); // eslint-disable-line no-console
  await postToTeams(summary);

  await pool.end();
}

run().catch((err) => {
  console.error('Friday commitment check failed:', err); // eslint-disable-line no-console
  process.exit(1);
});
