'use strict';
const express = require('express');
const { query, pool } = require('../db');
const { requireRole } = require('../middleware/requireRole');
const { firstOfMonth } = require('../lib/dates');
const { logAudit } = require('../lib/audit');
const { wigsUnderManager } = require('../lib/orgReports');

const router = express.Router();

/**
 * GET /api/wigs/mine-and-downline — active WIGs belonging to teams under the
 * caller's reporting chain (e.g. a VP's several directors'/managers' teams).
 * Registered before /:teamId so this literal path isn't swallowed as a teamId.
 */
router.get('/mine-and-downline', async (req, res) => {
  res.json(await wigsUnderManager(req.user.id));
});

async function loadWig(teamId) {
  const wigs = await query("SELECT * FROM wigs WHERE team_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1", [teamId]);
  const wig = wigs[0];
  if (!wig) return null;
  const measures = await query('SELECT measure_type, label, target_value, unit FROM wig_measures WHERE wig_id = ?', [wig.id]);
  const byType = Object.fromEntries(measures.map((m) => [m.measure_type, m]));
  return { ...wig, lagMeasure: byType.lag || null, lead1: byType.lead1 || null, lead2: byType.lead2 || null, lead3: byType.lead3 || null };
}

router.get('/:teamId', async (req, res) => {
  const wig = await loadWig(req.params.teamId);
  res.json(wig); // null is a valid, expected response — "no WIG set for this team yet"
});

/** Full lifecycle history for a team: every WIG ever set, newest first, with its measures and latest reading. */
router.get('/:teamId/history', requireRole('manager'), async (req, res) => {
  const wigs = await query(
    "SELECT * FROM wigs WHERE team_id = ? ORDER BY id DESC",
    [req.params.teamId]
  );
  const out = [];
  for (const wig of wigs) {
    const measures = await query('SELECT measure_type, label, target_value, unit FROM wig_measures WHERE wig_id = ?', [wig.id]);
    const byType = Object.fromEntries(measures.map((m) => [m.measure_type, m]));
    const latestReading = await query(
      'SELECT measurement_date, lag_actual FROM wig_metric_readings WHERE wig_id = ? ORDER BY measurement_date DESC LIMIT 1',
      [wig.id]
    );
    out.push({
      ...wig,
      lagMeasure: byType.lag || null,
      lead1: byType.lead1 || null,
      lead2: byType.lead2 || null,
      lead3: byType.lead3 || null,
      latestReading: latestReading[0] || null,
    });
  }
  res.json(out);
});

/** Marks the team's current active WIG as completed/on_hold/active. */
router.patch('/:teamId/status', requireRole('manager'), async (req, res) => {
  const { status } = req.body;
  if (!['active', 'completed', 'on_hold'].includes(status)) {
    return res.status(400).json({ error: 'status must be active, completed, or on_hold' });
  }
  const wig = await loadWig(req.params.teamId);
  if (!wig) return res.status(404).json({ error: 'No active WIG for this team' });
  const effectiveEnd = status === 'completed' ? new Date().toISOString().slice(0, 10) : null;
  await query('UPDATE wigs SET status = ?, effective_end = ? WHERE id = ?', [status, effectiveEnd, wig.id]);
  logAudit(req.user.id, 'wig.status_change', 'wig', wig.id, { teamId: Number(req.params.teamId), from: wig.status, to: status });
  res.json({ ok: true, wigId: wig.id, status });
});

/** Reactivates a past (completed/on_hold) WIG, demoting whatever is currently active for the team. */
router.patch('/:teamId/history/:wigId/reactivate', requireRole('manager'), async (req, res) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.execute(
      "UPDATE wigs SET status = 'on_hold' WHERE team_id = ? AND status = 'active' AND id != ?",
      [req.params.teamId, req.params.wigId]
    );
    const [result] = await conn.execute(
      "UPDATE wigs SET status = 'active', effective_end = NULL WHERE id = ? AND team_id = ?",
      [req.params.wigId, req.params.teamId]
    );
    if (result.affectedRows === 0) {
      await conn.rollback();
      return res.status(404).json({ error: 'WIG not found for this team' });
    }
    await conn.commit();
    logAudit(req.user.id, 'wig.reactivate', 'wig', Number(req.params.wigId), { teamId: Number(req.params.teamId) });
    res.json({ ok: true });
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
});

/** Upserts the team's active WIG + its measures in one transaction. */
router.put('/:teamId', requireRole('manager'), async (req, res) => {
  const { statement, lagMeasure, lead1, lead2, lead3 } = req.body;
  if (!statement) return res.status(400).json({ error: 'statement is required' });

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const existing = await conn.execute("SELECT id FROM wigs WHERE team_id = ? AND status = 'active'", [req.params.teamId]);
    let wigId = existing[0][0]?.id;
    if (wigId) {
      await conn.execute('UPDATE wigs SET statement = ? WHERE id = ?', [statement, wigId]);
    } else {
      const [result] = await conn.execute('INSERT INTO wigs (team_id, statement, status) VALUES (?, ?, "active")', [req.params.teamId, statement]);
      wigId = result.insertId;
    }
    const measures = { lag: lagMeasure, lead1, lead2, lead3 };
    for (const [type, m] of Object.entries(measures)) {
      if (!m || !m.name) continue;
      await conn.execute(
        `INSERT INTO wig_measures (wig_id, measure_type, label, target_value, unit) VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE label = VALUES(label), target_value = VALUES(target_value), unit = VALUES(unit)`,
        [wigId, type, m.name, m.target || null, m.unit || null]
      );
    }
    await conn.commit();
    logAudit(req.user.id, 'wig.upsert', 'wig', wigId, { teamId: Number(req.params.teamId), statement });
    res.json({ ok: true, wigId });
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
});

/** Monthly metric readings — defaults to the trailing N months (default 8). */
router.get('/:teamId/metrics', async (req, res) => {
  const wig = await loadWig(req.params.teamId);
  if (!wig) return res.json([]);
  const months = Math.max(1, Math.min(60, Number(req.query.months) || 8));
  const rows = await query(
    `SELECT measurement_date, lag_actual, lead1_actual, lead2_actual, lead3_actual, status FROM wig_metric_readings WHERE wig_id = ? ORDER BY measurement_date DESC LIMIT ${months}`,
    [wig.id]
  );
  res.json(rows.reverse());
});

router.put('/:teamId/metrics/:month', requireRole('manager'), async (req, res) => {
  const wig = await loadWig(req.params.teamId);
  if (!wig) return res.status(404).json({ error: 'No active WIG for this team' });
  const measurementDate = /^\d{4}-\d{2}$/.test(req.params.month) ? `${req.params.month}-01` : firstOfMonth();
  const { lagActual, lead1Actual, lead2Actual, lead3Actual, status } = req.body;
  await query(
    `INSERT INTO wig_metric_readings (wig_id, measurement_date, lag_actual, lead1_actual, lead2_actual, lead3_actual, status)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE lag_actual = VALUES(lag_actual), lead1_actual = VALUES(lead1_actual),
       lead2_actual = VALUES(lead2_actual), lead3_actual = VALUES(lead3_actual), status = VALUES(status)`,
    [wig.id, measurementDate, lagActual ?? null, lead1Actual ?? null, lead2Actual ?? null, lead3Actual ?? null, status || 'Active']
  );
  logAudit(req.user.id, 'wig.metrics_update', 'wig', wig.id, { teamId: Number(req.params.teamId), month: measurementDate });
  res.json({ ok: true });
});

module.exports = router;
