'use strict';
/**
 * Shared org-wide reporting queries — used by the analytics routes, the
 * Org Analytics dashboard widgets, the scheduled digest job, and the
 * Friday commitment-reminder job, so all four compute the same numbers
 * from one place instead of drifting apart.
 */
const { query } = require('../db');
const { mondaysBack, isoWeekMonday, firstOfMonth } = require('./dates');
const { commitmentAttainment, sessionAttainment } = require('./metrics');

async function getConfig() {
  const rows = await query('SELECT config_key, config_value FROM org_config');
  const c = Object.fromEntries(rows.map((r) => [r.config_key, Number(r.config_value)]));
  return {
    commit_yellow: c.commit_yellow ?? 0.8, commit_green: c.commit_green ?? 0.9,
    session_yellow: c.session_yellow ?? 0.85, session_green: c.session_green ?? 0.95,
  };
}

async function leafTeams() {
  const teams = await query('SELECT id, name, display_name, parent_id FROM teams');
  return teams.filter((t) => !teams.some((c) => c.parent_id === t.id));
}

async function commitmentRowsInWindow(teamId, weeks) {
  const dates = mondaysBack(weeks);
  return query(
    `SELECT c.commitment_made, c.commitment_met FROM commitments c
     JOIN cadence_sessions s ON s.id = c.session_id
     WHERE s.team_id = ? AND s.session_date IN (${dates.map(() => '?').join(',')})`,
    [teamId, ...dates]
  );
}
async function sessionRowsInWindow(teamId, weeks) {
  const dates = mondaysBack(weeks);
  return query(
    `SELECT held FROM cadence_sessions WHERE team_id = ? AND session_date IN (${dates.map(() => '?').join(',')})`,
    [teamId, ...dates]
  );
}

/** Active team members with no commitment logged for the given week's session yet. */
async function pendingCommitmentsForTeam(teamId, weekStart) {
  const members = await query('SELECT id, first_name, last_name, email FROM users WHERE team_id = ? AND active = 1', [teamId]);
  const session = await query('SELECT id FROM cadence_sessions WHERE team_id = ? AND session_date = ?', [teamId, weekStart]);
  const committedIds = session[0]
    ? new Set((await query('SELECT DISTINCT user_id FROM commitments WHERE session_id = ?', [session[0].id])).map((r) => r.user_id))
    : new Set();
  return members.filter((m) => !committedIds.has(m.id));
}

/** Org-wide: pending commitments grouped by team, for the given week (defaults to current). */
async function pendingCommitmentsOrgWide(weekStart = isoWeekMonday()) {
  const leaves = await leafTeams();
  const out = [];
  for (const leaf of leaves) {
    const pending = await pendingCommitmentsForTeam(leaf.id, weekStart);
    if (pending.length > 0) out.push({ teamId: leaf.id, teamName: leaf.display_name || leaf.name, members: pending });
  }
  return out;
}

/** This person's direct manager (one hop up manager_id), or null. */
async function managerOf(userId) {
  const rows = await query(
    `SELECT m.id, m.first_name, m.last_name, m.email
     FROM users u JOIN users m ON m.id = u.manager_id
     WHERE u.id = ?`,
    [userId]
  );
  return rows[0] || null;
}

/** Active manager(s) of a team. */
async function managersOfTeam(teamId) {
  return query("SELECT id, first_name, last_name, email FROM users WHERE team_id = ? AND role = 'manager' AND active = 1", [teamId]);
}

/** Org-wide WIG status counts, plus the most recently completed WIGs. */
async function wigStatusSummary() {
  const counts = await query('SELECT status, COUNT(*) AS n FROM wigs GROUP BY status');
  const recentlyCompleted = await query(
    `SELECT w.id, w.statement, w.effective_end, t.name AS teamName
     FROM wigs w JOIN teams t ON t.id = w.team_id
     WHERE w.status = 'completed' ORDER BY w.effective_end DESC LIMIT 20`
  );
  return { counts, recentlyCompleted };
}

/** Org-wide active WIGs missing this month's lag reading. */
async function metricsDueOrgWide() {
  const monthStart = firstOfMonth();
  return query(
    `SELECT t.id AS teamId, t.name AS teamName, w.id AS wigId, w.statement
     FROM wigs w JOIN teams t ON t.id = w.team_id
     WHERE w.status = 'active'
       AND NOT EXISTS (SELECT 1 FROM wig_metric_readings r WHERE r.wig_id = w.id AND r.measurement_date = ? AND r.lag_actual IS NOT NULL)
     ORDER BY t.name`,
    [monthStart]
  );
}

/** Org-wide individual commitment attainment leaderboard (T4w), best first. */
async function individualLeaderboard(limit = 20) {
  const rows = await query(
    `SELECT u.id, u.first_name, u.last_name, t.name AS teamName,
            SUM(c.commitment_made = 'yes') AS made,
            SUM(c.commitment_made = 'yes' AND c.commitment_met = 'yes') AS met
     FROM users u
     JOIN teams t ON t.id = u.team_id
     LEFT JOIN commitments c ON c.user_id = u.id
     LEFT JOIN cadence_sessions s ON s.id = c.session_id AND s.session_date > DATE_SUB(CURDATE(), INTERVAL 28 DAY)
     WHERE u.active = 1 AND u.team_id IS NOT NULL
     GROUP BY u.id, u.first_name, u.last_name, t.name`
  );
  return rows
    .map((r) => ({
      userId: r.id, name: `${r.first_name} ${r.last_name}`, team: r.teamName,
      made: Number(r.made), met: Number(r.met),
      pct: Number(r.made) > 0 ? Number(r.met) / Number(r.made) : null,
    }))
    .sort((a, b) => (b.pct ?? -1) - (a.pct ?? -1))
    .slice(0, limit);
}

/**
 * Every active team whose manager reports, directly or via the manager_id
 * chain, up to `userId` — e.g. a VP's downline: manager -> director -> vp.
 * Walks the reporting tree in memory rather than a recursive SQL CTE, matching
 * how the team parent/child rollup elsewhere in this codebase is computed.
 */
async function teamsUnderManager(userId) {
  const allUsers = await query('SELECT id, role, team_id, manager_id FROM users WHERE active = 1');
  const childrenOf = new Map();
  for (const u of allUsers) {
    if (!u.manager_id) continue;
    if (!childrenOf.has(u.manager_id)) childrenOf.set(u.manager_id, []);
    childrenOf.get(u.manager_id).push(u);
  }
  const downline = [];
  const stack = [...(childrenOf.get(Number(userId)) || [])];
  while (stack.length) {
    const u = stack.pop();
    downline.push(u);
    stack.push(...(childrenOf.get(u.id) || []));
  }
  return [...new Set(downline.filter((u) => u.role === 'manager' && u.team_id).map((u) => u.team_id))];
}

/** Active WIGs belonging to teams under `userId`'s reporting chain (see teamsUnderManager). */
async function wigsUnderManager(userId) {
  const teamIds = await teamsUnderManager(userId);
  if (teamIds.length === 0) return [];
  return query(
    `SELECT w.id, w.statement, t.id AS teamId, t.name AS teamName, t.display_name AS teamDisplayName
     FROM wigs w JOIN teams t ON t.id = w.team_id
     WHERE w.status = 'active' AND w.team_id IN (${teamIds.map(() => '?').join(',')})
     ORDER BY t.name`,
    teamIds
  );
}

/** Leaf teams currently below the red threshold on either signal (T4w). */
async function alertsOrgWide() {
  const cfg = await getConfig();
  const leaves = await leafTeams();
  const alerts = [];
  for (const leaf of leaves) {
    const commit4 = commitmentAttainment(await commitmentRowsInWindow(leaf.id, 4));
    const session4 = sessionAttainment(await sessionRowsInWindow(leaf.id, 4));
    if (commit4 !== null && commit4 < cfg.commit_yellow) alerts.push({ teamId: leaf.id, teamName: leaf.name, metric: 'Commitment attainment', value: commit4 });
    if (session4 !== null && session4 < cfg.session_yellow) alerts.push({ teamId: leaf.id, teamName: leaf.name, metric: 'Cadence attainment', value: session4 });
  }
  return alerts;
}

module.exports = {
  getConfig, leafTeams, commitmentRowsInWindow, sessionRowsInWindow,
  pendingCommitmentsForTeam, pendingCommitmentsOrgWide, managerOf, managersOfTeam,
  wigStatusSummary, metricsDueOrgWide, individualLeaderboard, alertsOrgWide,
  teamsUnderManager, wigsUnderManager,
};
