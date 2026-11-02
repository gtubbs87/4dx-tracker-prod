'use strict';
const express = require('express');
const { query } = require('../db');
const { requireRole, canViewUser } = require('../middleware/requireRole');
const { mondaysBack, isoWeekMonday } = require('../lib/dates');
const {
  commitmentAttainment,
  sessionAttainment,
  wigProgressRatio,
  healthScore,
  scoreBand,
  rollupFromChildScores,
  band,
} = require('../lib/metrics');
const {
  getConfig, leafTeams, commitmentRowsInWindow, sessionRowsInWindow, pendingCommitmentsForTeam,
  pendingCommitmentsOrgWide, wigStatusSummary, metricsDueOrgWide, individualLeaderboard, alertsOrgWide,
  teamsUnderManager,
} = require('../lib/orgReports');

const router = express.Router();

async function latestWigProgress(teamId) {
  const wigs = await query("SELECT id FROM wigs WHERE team_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1", [teamId]);
  if (!wigs[0]) return null;
  const measure = await query("SELECT target_value FROM wig_measures WHERE wig_id = ? AND measure_type = 'lag'", [wigs[0].id]);
  const reading = await query(
    'SELECT lag_actual FROM wig_metric_readings WHERE wig_id = ? ORDER BY measurement_date DESC LIMIT 1',
    [wigs[0].id]
  );
  if (!measure[0] || !reading[0]) return null;
  return wigProgressRatio(measure[0].target_value, reading[0].lag_actual);
}

async function computeWeekScoreLive(teamId, wk, cfg) {
  // Trailing 4-week window ending at `wk`, matching the client's healthTrend logic.
  const commitRows = await query(
    `SELECT c.commitment_made, c.commitment_met FROM commitments c
     JOIN cadence_sessions s ON s.id = c.session_id
     WHERE s.team_id = ? AND s.session_date <= ? AND s.session_date > DATE_SUB(?, INTERVAL 28 DAY)`,
    [teamId, wk, wk]
  );
  const sessionRows = await query(
    `SELECT held FROM cadence_sessions WHERE team_id = ? AND session_date <= ? AND session_date > DATE_SUB(?, INTERVAL 28 DAY)`,
    [teamId, wk, wk]
  );
  const commitPct = commitmentAttainment(commitRows);
  const sessionPct = sessionAttainment(sessionRows);
  const score = healthScore({ commitPct, sessionPct, wigProgress: null, config: cfg });
  return { score, commitPct, sessionPct };
}

/**
 * Weekly health scores for a set of teams/weeks. Closed (past) weeks are read
 * through the precomputed `team_week_scores` table — populated by the nightly
 * rollup CronJob — and any closed week not yet cached is computed live and
 * written back, so this stays correct even before the job has ever run. The
 * current in-progress week is always computed live since it changes all week.
 */
async function weeklyScoresForTeams(teamIds, weekDates, cfg) {
  const out = new Map(); // `${teamId}|${week}` -> {score, commitPct, sessionPct}
  if (teamIds.length === 0 || weekDates.length === 0) return out;
  const currentWeek = isoWeekMonday();
  const closedWeeks = weekDates.filter((w) => w < currentWeek);

  if (closedWeeks.length > 0) {
    const cached = await query(
      `SELECT team_id, week_start, score, commit_pct, session_pct FROM team_week_scores
       WHERE team_id IN (${teamIds.map(() => '?').join(',')}) AND week_start IN (${closedWeeks.map(() => '?').join(',')})`,
      [...teamIds, ...closedWeeks]
    );
    for (const r of cached) {
      out.set(`${r.team_id}|${r.week_start}`, {
        score: r.score,
        commitPct: r.commit_pct === null ? null : Number(r.commit_pct),
        sessionPct: r.session_pct === null ? null : Number(r.session_pct),
      });
    }
  }

  for (const teamId of teamIds) {
    for (const wk of weekDates) {
      const key = `${teamId}|${wk}`;
      if (out.has(key)) continue;
      const result = await computeWeekScoreLive(teamId, wk, cfg);
      out.set(key, result);
      if (wk < currentWeek) {
        query(
          `INSERT INTO team_week_scores (team_id, week_start, score, commit_pct, session_pct) VALUES (?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE score = VALUES(score), commit_pct = VALUES(commit_pct), session_pct = VALUES(session_pct), computed_at = CURRENT_TIMESTAMP`,
          [teamId, wk, result.score, result.commitPct, result.sessionPct]
        ).catch((err) => console.error('team_week_scores cache write failed:', err)); // eslint-disable-line no-console
      }
    }
  }
  return out;
}

async function leafScore(teamId, cfg) {
  const commit4 = commitmentAttainment(await commitmentRowsInWindow(teamId, 4));
  const session4 = sessionAttainment(await sessionRowsInWindow(teamId, 4));
  const wigProgress = await latestWigProgress(teamId);
  const score = healthScore({ commitPct: commit4, sessionPct: session4, wigProgress, config: cfg });
  return { score, commit4, session4, wigProgress };
}

/** GET /api/analytics/team/:teamId/attainment — T4w/T13w/T26w for commitment + cadence */
router.get('/team/:teamId/attainment', async (req, res) => {
  const cfg = await getConfig();
  const windows = (req.query.windows || '4,13,26').split(',').map(Number);
  const out = { commit: {}, session: {} };
  for (const w of windows) {
    out.commit[w] = commitmentAttainment(await commitmentRowsInWindow(req.params.teamId, w));
    out.session[w] = sessionAttainment(await sessionRowsInWindow(req.params.teamId, w));
  }
  out.commitBand = band(out.commit[4], cfg.commit_yellow, cfg.commit_green);
  out.sessionBand = band(out.session[4], cfg.session_yellow, cfg.session_green);
  res.json(out);
});

/** GET /api/analytics/team/:teamId/individuals — manager drill-down, mirrors legacy Leadership View table */
router.get('/team/:teamId/individuals', requireRole('manager'), async (req, res) => {
  const cfg = await getConfig();
  const members = await query('SELECT id, first_name, last_name FROM users WHERE team_id = ? AND active = 1', [req.params.teamId]);
  const dates4 = mondaysBack(4);
  const dates13 = mondaysBack(13);

  const results = [];
  for (const m of members) {
    const rows4 = await query(
      `SELECT c.commitment_made, c.commitment_met FROM commitments c
       JOIN cadence_sessions s ON s.id = c.session_id
       WHERE s.team_id = ? AND c.user_id = ? AND s.session_date IN (${dates4.map(() => '?').join(',')})`,
      [req.params.teamId, m.id, ...dates4]
    );
    const rows13 = await query(
      `SELECT c.commitment_made, c.commitment_met FROM commitments c
       JOIN cadence_sessions s ON s.id = c.session_id
       WHERE s.team_id = ? AND c.user_id = ? AND s.session_date IN (${dates13.map(() => '?').join(',')})`,
      [req.params.teamId, m.id, ...dates13]
    );
    const pct4 = commitmentAttainment(rows4);
    results.push({
      userId: m.id,
      name: `${m.first_name} ${m.last_name}`,
      made4: rows4.filter((r) => r.commitment_made === 'yes').length,
      met4: rows4.filter((r) => r.commitment_made === 'yes' && r.commitment_met === 'yes').length,
      pct4,
      pct13: commitmentAttainment(rows13),
      band: band(pct4, cfg.commit_yellow, cfg.commit_green),
    });
  }
  res.json(results);
});

/** GET /api/analytics/rollup/:teamId — recursive rollup with min/max spread, per the architecture doc */
router.get('/rollup/:teamId', async (req, res) => {
  const cfg = await getConfig();

  async function compute(teamId) {
    const children = await query('SELECT id FROM teams WHERE parent_id = ?', [teamId]);
    if (children.length === 0) {
      const leaf = await leafScore(teamId, cfg);
      return { teamId, ...leaf, min: leaf.score, max: leaf.score, count: leaf.score === null ? 0 : 1 };
    }
    const childResults = await Promise.all(children.map((c) => compute(c.id)));
    const rollup = rollupFromChildScores(childResults.map((c) => c.score));
    return { teamId, ...rollup };
  }

  const result = await compute(req.params.teamId);
  res.json({ ...result, ...scoreBand(result.score) });
});

/**
 * GET /api/analytics/org/heatmap — division x week grid for the leadership landing view.
 * NOTE: this computes on the fly (leaves × weeks × 2 queries) — fine at the
 * scale this app ships for (dozens of teams), but past a few hundred teams
 * or a long weeks= window, move this to the nightly-rollup CronJob
 * described in PRODUCTION_ARCHITECTURE.md, writing into a precomputed
 * `team_week_scores` table this endpoint just reads from.
 */
router.get('/org/heatmap', requireRole('manager'), async (req, res) => {
  const weeks = Number(req.query.weeks || 8);
  const cfg = await getConfig();
  const leaves = await leafTeams();
  const weekDates = mondaysBack(weeks);
  const scores = await weeklyScoresForTeams(leaves.map((l) => l.id), weekDates, cfg);

  const grid = leaves.map((leaf) => ({
    teamId: leaf.id,
    teamName: leaf.name,
    cells: weekDates.map((wk) => ({ week: wk, score: scores.get(`${leaf.id}|${wk}`)?.score ?? null })),
  }));
  res.json({ weeks: weekDates, teams: grid });
});

/**
 * GET /api/analytics/team/:teamId/history — weekly health-score trend for one team.
 * Same trailing-4-week-window-per-point logic as org/heatmap, scoped to a single team
 * so anyone manager rank and above can pull up one team's history without the
 * full multi-team org/heatmap view.
 */
router.get('/team/:teamId/history', requireRole('manager'), async (req, res) => {
  const weeks = Math.max(1, Math.min(104, Number(req.query.weeks) || 26));
  const cfg = await getConfig();
  const weekDates = mondaysBack(weeks);
  const teamId = Number(req.params.teamId);
  const scores = await weeklyScoresForTeams([teamId], weekDates, cfg);

  const points = weekDates.map((wk) => {
    const s = scores.get(`${teamId}|${wk}`) || { score: null, commitPct: null, sessionPct: null };
    return { week: wk, ...s };
  });
  res.json(points);
});

/**
 * GET /api/analytics/user/:userId/history — one person's weekly commitment
 * attainment trend (4w rolling window per point). Viewable by the person
 * themself, or anyone manager rank and above (org-wide).
 */
router.get('/user/:userId/history', async (req, res) => {
  const targetId = Number(req.params.userId);
  const target = await query('SELECT id FROM users WHERE id = ?', [targetId]);
  if (!target[0]) return res.status(404).json({ error: 'Not found' });
  if (!canViewUser(req.user, targetId)) return res.status(403).json({ error: 'Not allowed' });

  const weeks = Math.max(1, Math.min(104, Number(req.query.weeks) || 16));
  const weekDates = mondaysBack(weeks);
  const points = [];
  for (const wk of weekDates) {
    const rows = await query(
      `SELECT c.commitment_made, c.commitment_met FROM commitments c
       JOIN cadence_sessions s ON s.id = c.session_id
       WHERE c.user_id = ? AND s.session_date <= ? AND s.session_date > DATE_SUB(?, INTERVAL 28 DAY)`,
      [targetId, wk, wk]
    );
    points.push({ week: wk, pct: commitmentAttainment(rows) });
  }
  res.json(points);
});

/** GET /api/analytics/team/:teamId/pending-commitments — active members with no commitment logged for this week's session yet */
router.get('/team/:teamId/pending-commitments', requireRole('manager'), async (req, res) => {
  const pending = await pendingCommitmentsForTeam(req.params.teamId, isoWeekMonday());
  res.json(pending.map((m) => ({ userId: m.id, name: `${m.first_name} ${m.last_name}` })));
});

/** GET /api/analytics/metrics-due — org-wide active WIGs missing this month's lag reading, for the Org Analytics widget */
router.get('/metrics-due', requireRole('manager'), async (req, res) => {
  res.json(await metricsDueOrgWide());
});

/** GET /api/analytics/alerts — teams currently below the red threshold on either signal */
router.get('/alerts', requireRole('manager'), async (req, res) => {
  res.json(await alertsOrgWide());
});

/** GET /api/analytics/org/pending-commitments — every team with members who haven't logged this week's commitment yet */
router.get('/org/pending-commitments', requireRole('manager'), async (req, res) => {
  res.json(await pendingCommitmentsOrgWide());
});

/** GET /api/analytics/org/wig-status-summary — counts by status + the most recently completed WIGs, org-wide */
router.get('/org/wig-status-summary', requireRole('manager'), async (req, res) => {
  res.json(await wigStatusSummary());
});

/** GET /api/analytics/org/individuals — org-wide commitment attainment leaderboard (T4w) */
router.get('/org/individuals', requireRole('manager'), async (req, res) => {
  const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 20));
  res.json(await individualLeaderboard(limit));
});

/**
 * GET /api/analytics/my-reports/pending-commitments — this week's pending
 * commitments across the caller's own team plus every team in their
 * downline (via teamsUnderManager, same reporting chain the WIG picker
 * walks). Self-scoped to req.user.id — no role gate needed, and an IC with
 * no downline and no team just gets an empty list back.
 */
router.get('/my-reports/pending-commitments', async (req, res) => {
  const teamIds = new Set(await teamsUnderManager(req.user.id));
  if (req.user.teamId) teamIds.add(Number(req.user.teamId));
  if (teamIds.size === 0) return res.json([]);

  const teams = await query(
    `SELECT id, name, display_name FROM teams WHERE id IN (${[...teamIds].map(() => '?').join(',')})`,
    [...teamIds]
  );
  const weekStart = isoWeekMonday();
  const out = [];
  for (const t of teams) {
    const pending = await pendingCommitmentsForTeam(t.id, weekStart);
    if (pending.length > 0) {
      out.push({
        teamId: t.id,
        teamName: t.display_name || t.name,
        members: pending.map((m) => ({ userId: m.id, name: `${m.first_name} ${m.last_name}` })),
      });
    }
  }
  res.json(out);
});

module.exports = router;
