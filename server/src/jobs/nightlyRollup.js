'use strict';
/**
 * Nightly rollup job (run via the CronJob in k8s/cronjobs-and-netpol.yaml).
 *
 * Writes one row per (team, week) into `team_week_scores`, which
 * GET /api/analytics/org/heatmap and GET /api/analytics/team/:teamId/history
 * read through as a cache for closed (past) weeks — see weeklyScoresForTeams
 * in routes/analytics.js. Those routes also compute-and-write-back on a
 * cache miss, so this job isn't load-bearing for correctness; it just keeps
 * the cache warm so those routes don't recompute the same closed weeks
 * from raw commitment/session rows on every request.
 *
 * Backfills a trailing window (default 52 weeks) each run — cheap to
 * re-run since it's all ON DUPLICATE KEY UPDATE.
 */
const { query, pool } = require('../db');
const { mondaysBack } = require('../lib/dates');
const { commitmentAttainment, sessionAttainment, wigProgressRatio, healthScore } = require('../lib/metrics');

async function ensureTable() {
  await query(`
    CREATE TABLE IF NOT EXISTS team_week_scores (
      team_id INT NOT NULL,
      week_start DATE NOT NULL,
      score INT NULL,
      commit_pct DECIMAL(6,4) NULL,
      session_pct DECIMAL(6,4) NULL,
      computed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (team_id, week_start)
    )
  `);
}

async function getConfig() {
  const rows = await query('SELECT config_key, config_value FROM org_config');
  const c = Object.fromEntries(rows.map((r) => [r.config_key, Number(r.config_value)]));
  return {
    commit_yellow: c.commit_yellow ?? 0.8, commit_green: c.commit_green ?? 0.9,
    session_yellow: c.session_yellow ?? 0.85, session_green: c.session_green ?? 0.95,
  };
}

async function run() {
  await ensureTable();
  const cfg = await getConfig();
  const teams = await query('SELECT id, name, parent_id FROM teams');
  const leaves = teams.filter((t) => !teams.some((c) => c.parent_id === t.id));
  const backfillWeeks = Number(process.env.ROLLUP_BACKFILL_WEEKS || 52);
  const weekDates = mondaysBack(backfillWeeks);
  let written = 0;

  for (const leaf of leaves) {
    for (const wk of weekDates) {
      const commitRows = await query(
        `SELECT c.commitment_made, c.commitment_met FROM commitments c
         JOIN cadence_sessions s ON s.id = c.session_id
         WHERE s.team_id = ? AND s.session_date <= ? AND s.session_date > DATE_SUB(?, INTERVAL 28 DAY)`,
        [leaf.id, wk, wk]
      );
      const sessionRows = await query(
        `SELECT held FROM cadence_sessions WHERE team_id = ? AND session_date <= ? AND session_date > DATE_SUB(?, INTERVAL 28 DAY)`,
        [leaf.id, wk, wk]
      );
      const commitPct = commitmentAttainment(commitRows);
      const sessionPct = sessionAttainment(sessionRows);
      const score = healthScore({ commitPct, sessionPct, wigProgress: null, config: cfg });

      await query(
        `INSERT INTO team_week_scores (team_id, week_start, score, commit_pct, session_pct) VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE score = VALUES(score), commit_pct = VALUES(commit_pct), session_pct = VALUES(session_pct), computed_at = CURRENT_TIMESTAMP`,
        [leaf.id, wk, score, commitPct, sessionPct]
      );
      written += 1;
    }
  }

  console.log(`Nightly rollup: wrote ${written} team-week scores across ${leaves.length} teams × ${weekDates.length} weeks.`);
  await pool.end();
}

run().catch((err) => {
  console.error('Nightly rollup failed:', err);
  process.exit(1);
});
