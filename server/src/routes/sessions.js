'use strict';
const express = require('express');
const { query } = require('../db');
const { requireRole, canManageTeam } = require('../middleware/requireRole');
const { isoWeekMonday } = require('../lib/dates');

const router = express.Router();

async function getOrCreateSession(teamId, sessionDate) {
  const existing = await query('SELECT * FROM cadence_sessions WHERE team_id = ? AND session_date = ?', [teamId, sessionDate]);
  if (existing[0]) return existing[0];
  const result = await query('INSERT INTO cadence_sessions (team_id, session_date, held) VALUES (?, ?, 0)', [teamId, sessionDate]);
  return { id: result.insertId, team_id: teamId, session_date: sessionDate, held: 0 };
}

async function commitmentsForSession(sessionId) {
  return query(
    `SELECT c.id, c.user_id, u.first_name, u.last_name, c.commitment_text, c.commitment_made, c.commitment_met, c.notes,
            c.wig_id, w.statement AS wig_statement
     FROM commitments c
     JOIN users u ON u.id = c.user_id
     LEFT JOIN wigs w ON w.id = c.wig_id
     WHERE c.session_id = ? ORDER BY c.id`,
    [sessionId]
  );
}

// The Scoreboard's team switcher intentionally lets anyone browse any
// team's aggregate committed/PTO counts and held status — that's the 4DX
// "visible scoreboard" model. But individual commitment text, notes, and
// names are more sensitive than a count, and an IC on a different team
// never needs them — MyWeek only shows your own team, and the Individual
// Attainment table is already gated separately. Redact to count-only
// fields for anyone who isn't on the team and isn't manager rank or
// above (who have org-wide visibility), rather than requiring a role
// outright (which would break the open scoreboard for ICs).
function redactUnlessAuthorized(req, teamId, commitments) {
  const authorized = Number(req.user.teamId) === Number(teamId) || canManageTeam(req.user);
  if (authorized) return commitments;
  return commitments.map((c) => ({ id: c.id, commitment_made: c.commitment_made, commitment_met: c.commitment_met }));
}

/** GET /api/sessions/:teamId  (this week) and /api/sessions/:teamId/:weekStart */
router.get('/:teamId', async (req, res) => {
  const session = await getOrCreateSession(req.params.teamId, isoWeekMonday());
  const commitments = redactUnlessAuthorized(req, req.params.teamId, await commitmentsForSession(session.id));
  res.json({ ...session, commitments });
});
router.get('/:teamId/:weekStart', async (req, res) => {
  const session = await getOrCreateSession(req.params.teamId, req.params.weekStart);
  const commitments = redactUnlessAuthorized(req, req.params.teamId, await commitmentsForSession(session.id));
  res.json({ ...session, commitments });
});

router.put('/:teamId/:weekStart/held', requireRole('manager'), async (req, res) => {
  const { held } = req.body;
  const session = await getOrCreateSession(req.params.teamId, req.params.weekStart);
  await query('UPDATE cadence_sessions SET held = ?, facilitator_user_id = ? WHERE id = ?', [held ? 1 : 0, req.user.id, session.id]);
  res.json({ ok: true });
});

module.exports = router;
module.exports.getOrCreateSession = getOrCreateSession;
