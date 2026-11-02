'use strict';
/**
 * Scheduled leadership report digest — invoked once per frequency
 * (daily/weekly/monthly/quarterly) by four separate k8s CronJobs, each
 * passing its frequency as argv[2] (see k8s/cronjobs-and-netpol.yaml). Each
 * run sends every active subscription for that frequency the widgets the
 * subscriber picked, via email and/or Microsoft Teams per their settings.
 */
const { query, pool } = require('../db');
const { sendEmail, postToTeams } = require('../lib/notify');
const {
  alertsOrgWide, pendingCommitmentsOrgWide, metricsDueOrgWide, wigStatusSummary, individualLeaderboard,
} = require('../lib/orgReports');

const FREQUENCIES = ['daily', 'weekly', 'monthly', 'quarterly'];

// Team names, WIG statements, and people's names are all user-entered (via
// Setup / WIG Administration) and flow straight into an HTML email body —
// escape before interpolating so a team/WIG named with markup can't inject
// into a leadership inbox once a real email provider is wired in.
function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function widgetSection(id) {
  switch (id) {
    case 'alerts': {
      const rows = await alertsOrgWide();
      const items = rows.length ? rows.map((a) => `<li>${esc(a.teamName)} — ${esc(a.metric)}: ${Math.round(a.value * 100)}%</li>`).join('') : '<li>No teams below threshold. 🎉</li>';
      return { label: 'Below Red Threshold (T4w)', html: `<ul>${items}</ul>` };
    }
    case 'pendingCommitments': {
      const rows = await pendingCommitmentsOrgWide();
      const items = rows.length
        ? rows.map((t) => `<li>${esc(t.teamName)} — ${t.members.map((m) => esc(`${m.first_name} ${m.last_name}`)).join(', ')}</li>`).join('')
        : "<li>Everyone's logged this week's commitment. 🎉</li>";
      return { label: "Haven't Committed This Week", html: `<ul>${items}</ul>` };
    }
    case 'metricsDue': {
      const rows = await metricsDueOrgWide();
      const items = rows.length ? rows.map((m) => `<li>${esc(m.teamName)} — ${esc(m.statement)}</li>`).join('') : '<li>Every active WIG is up to date. 🎉</li>';
      return { label: 'WIG Metrics Not Yet Logged', html: `<ul>${items}</ul>` };
    }
    case 'wigStatus': {
      const { counts, recentlyCompleted } = await wigStatusSummary();
      const countLine = counts.map((c) => `${c.n} ${esc(c.status)}`).join(', ') || 'no WIGs yet';
      const completedItems = recentlyCompleted.slice(0, 5).map((w) => `<li>${esc(w.teamName)} — ${esc(w.statement)} (${esc(w.effective_end)})</li>`).join('');
      return { label: 'WIG Status Across the Org', html: `<p>${countLine}</p>${completedItems ? `<ul>${completedItems}</ul>` : ''}` };
    }
    case 'leaderboard': {
      const rows = await individualLeaderboard(10);
      const items = rows.map((r, i) => `<li>${i + 1}. ${esc(r.name)} (${esc(r.team)}) — ${r.pct != null ? Math.round(r.pct * 100) + '%' : 'n/a'}</li>`).join('');
      return { label: 'Individual Attainment Leaderboard (T4w)', html: `<ol>${items}</ol>` };
    }
    case 'heatmap':
    case 'rollup':
      return { label: id === 'heatmap' ? 'Org Heatmap' : 'Division / Team Rollup', html: '<p>This widget is visual-only — view it live in the Org Analytics dashboard.</p>' };
    default:
      return null;
  }
}

async function run() {
  const frequency = process.argv[2];
  if (!FREQUENCIES.includes(frequency)) {
    console.error(`Usage: node reportDigest.js <${FREQUENCIES.join('|')}>`); // eslint-disable-line no-console
    process.exit(1);
  }

  const subs = await query(
    `SELECT s.*, u.first_name, u.last_name, u.email
     FROM report_subscriptions s JOIN users u ON u.id = s.user_id
     WHERE s.frequency = ? AND s.active = 1`,
    [frequency]
  );

  console.log(`Report digest (${frequency}): ${subs.length} active subscription(s).`); // eslint-disable-line no-console

  for (const sub of subs) {
    const widgetIds = typeof sub.widgets === 'string' ? JSON.parse(sub.widgets) : sub.widgets;
    const sections = (await Promise.all(widgetIds.map(widgetSection))).filter(Boolean);
    const html = sections.map((s) => `<h3>${s.label}</h3>${s.html}`).join('');
    const text = sections.map((s) => `${s.label}\n${s.html.replace(/<[^>]+>/g, ' ').trim()}`).join('\n\n');
    const subject = `4DX ${frequency} rollup for ${sub.first_name}`;

    if (sub.channel_email) await sendEmail({ to: sub.email, subject, html, text });
    if (sub.channel_teams) await postToTeams(`*${subject}*\n${text}`);
  }

  await pool.end();
}

run().catch((err) => {
  console.error('Report digest failed:', err); // eslint-disable-line no-console
  process.exit(1);
});
