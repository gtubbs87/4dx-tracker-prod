'use strict';
const express = require('express');
const { query } = require('../db');
const { isoWeekMonday, mondaysBack } = require('../lib/dates');
const { getOrCreateSession } = require('./sessions');
const { canManageTeam } = require('../middleware/requireRole');

const router = express.Router();

/**
 * GET /api/commitments/history?weeks=13
 * The caller's own commitment history (most recent first), excluding the
 * current week (My Week already shows that one), plus stats over the same
 * window: how many commitments were made, how many were met, and the
 * resulting percentage. Always scoped to the caller — there is no teamId
 * or userId param, so this can't be used to pull anyone else's history.
 */
router.get('/history', async (req, res) => {
  const weeks = Math.max(1, Math.min(104, Number(req.query.weeks) || 13));
  const dates = mondaysBack(weeks).filter((d) => d !== isoWeekMonday());
  if (dates.length === 0) return res.json({ history: [], stats: { made: 0, met: 0, pct: null } });

  const rows = await query(
    `SELECT c.id, s.session_date, c.commitment_text, c.commitment_made, c.commitment_met, c.notes
     FROM commitments c JOIN cadence_sessions s ON s.id = c.session_id
     WHERE c.user_id = ? AND s.session_date IN (${dates.map(() => '?').join(',')})
     ORDER BY s.session_date DESC`,
    [req.user.id, ...dates]
  );

  const made = rows.filter((r) => r.commitment_made === 'yes');
  const met = made.filter((r) => r.commitment_met === 'yes');
  res.json({
    history: rows,
    stats: { made: made.length, met: met.length, pct: made.length ? met.length / made.length : null },
  });
});

/**
 * POST /api/commitments
 * body: { teamId, weekStart? (defaults to this week), text, made: 'yes'|'pto', notes?, wigId? }
 * Always logs against the caller's own user id — a member can't log a
 * commitment on someone else's behalf via this endpoint. wigId is optional —
 * used by directors/managers spanning several teams to say which downline
 * WIG this week's commitment is in service of (see GET /api/wigs/mine-and-downline).
 */
router.post('/', async (req, res) => {
  const { teamId, weekStart, text, made, notes, wigId } = req.body;
  if (!teamId) return res.status(400).json({ error: 'teamId is required' });
  // A commitment is always logged against the caller's own team — otherwise
  // any authenticated user could POST an arbitrary teamId and inject
  // fabricated commitments (and even create cadence_sessions rows) for a
  // team they don't belong to, skewing that team's attainment numbers.
  if (Number(teamId) !== Number(req.user.teamId)) {
    return res.status(403).json({ error: 'You can only log a commitment for your own team' });
  }
  if (made === 'yes' && !text?.trim()) return res.status(400).json({ error: 'text is required when made=yes' });
  if (wigId) {
    const wig = await query("SELECT id FROM wigs WHERE id = ? AND status = 'active'", [wigId]);
    if (!wig[0]) return res.status(400).json({ error: 'wigId must reference an active WIG' });
  }

  const session = await getOrCreateSession(teamId, weekStart || isoWeekMonday());
  const result = await query(
    'INSERT INTO commitments (session_id, user_id, commitment_text, wig_id, commitment_made, commitment_met, notes) VALUES (?, ?, ?, ?, ?, "pending", ?)',
    [session.id, req.user.id, made === 'yes' ? text.trim() : null, wigId || null, made === 'pto' ? 'pto' : 'yes', notes || null]
  );
  res.status(201).json({ id: result.insertId, sessionId: session.id });
});

/**
 * PATCH /api/commitments/:id  — close out: { met: 'yes'|'no', notes? }
 * Only the commitment's own owner, or manager rank and above (org-wide), may close it out.
 */
router.patch('/:id', async (req, res) => {
  const rows = await query('SELECT c.*, s.team_id FROM commitments c JOIN cadence_sessions s ON s.id = c.session_id WHERE c.id = ?', [req.params.id]);
  const commitment = rows[0];
  if (!commitment) return res.status(404).json({ error: 'Not found' });
  const isOwner = commitment.user_id === req.user.id;
  const isManager = canManageTeam(req.user);
  if (!isOwner && !isManager) return res.status(403).json({ error: 'Not allowed' });

  const { met, notes } = req.body;
  const fields = [];
  const params = [];
  if (met !== undefined) { fields.push('commitment_met = ?'); params.push(met); }
  if (notes !== undefined) {
    const merged = commitment.notes ? `${commitment.notes} — ${notes}` : notes;
    fields.push('notes = ?'); params.push(merged);
  }
  if (fields.length === 0) return res.status(400).json({ error: 'no fields to update' });
  params.push(req.params.id);
  await query(`UPDATE commitments SET ${fields.join(', ')} WHERE id = ?`, params);
  res.json({ ok: true });
});

module.exports = router;
