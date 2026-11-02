'use strict';
const express = require('express');
const { query } = require('../db');
const { requireRole } = require('../middleware/requireRole');
const { logAudit } = require('../lib/audit');

const router = express.Router();

router.get('/', requireRole('manager'), async (req, res) => {
  // Anyone who passes the role gate above (manager and up) has org-wide
  // roster access — teamId is just an optional filter, not a scope limit.
  const { teamId } = req.query;
  const rows = teamId
    ? await query('SELECT id, first_name, last_name, email, team_id, role, manager_id, active FROM users WHERE team_id = ? ORDER BY last_name', [teamId])
    : await query('SELECT id, first_name, last_name, email, team_id, role, manager_id, active FROM users ORDER BY last_name');
  res.json(rows);
});

router.get('/me', async (req, res) => {
  const rows = await query('SELECT id, first_name, last_name, email, team_id, role FROM users WHERE id = ?', [req.user.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Not found' });
  res.json(rows[0]);
});

router.post('/', requireRole('manager'), async (req, res) => {
  const { firstName, lastName, email, teamId, role = 'ic' } = req.body;
  if (!firstName || !lastName) return res.status(400).json({ error: 'firstName and lastName are required' });
  const result = await query(
    'INSERT INTO users (first_name, last_name, email, team_id, role, active) VALUES (?, ?, ?, ?, ?, 1)',
    [firstName, lastName, email || null, teamId || null, role]
  );
  logAudit(req.user.id, 'user.create', 'user', result.insertId, { firstName, lastName, teamId: teamId || null, role });
  res.status(201).json({ id: result.insertId });
});

router.patch('/:id', requireRole('manager'), async (req, res) => {
  const { teamId, role, active, managerId } = req.body;
  if (managerId !== undefined && Number(managerId) === Number(req.params.id)) {
    return res.status(400).json({ error: 'A person cannot be their own manager' });
  }
  const fields = [];
  const params = [];
  if (teamId !== undefined) { fields.push('team_id = ?'); params.push(teamId); }
  if (role !== undefined) { fields.push('role = ?'); params.push(role); }
  if (active !== undefined) { fields.push('active = ?'); params.push(active ? 1 : 0); }
  if (managerId !== undefined) { fields.push('manager_id = ?'); params.push(managerId || null); }
  if (fields.length === 0) return res.status(400).json({ error: 'no fields to update' });
  params.push(req.params.id);
  await query(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`, params);
  logAudit(req.user.id, 'user.update', 'user', Number(req.params.id), { teamId, role, active, managerId });
  res.json({ ok: true });
});

router.delete('/:id', requireRole('manager'), async (req, res) => {
  await query('UPDATE users SET active = 0 WHERE id = ?', [req.params.id]); // soft delete — preserves commitment history
  logAudit(req.user.id, 'user.deactivate', 'user', Number(req.params.id));
  res.json({ ok: true });
});

/**
 * Bulk roster import: [{ fullName, teamName, role }]
 * Unknown team names are created automatically (top-level, no parent) —
 * mirrors the CSV importer in the client's Setup screen, exposed here so
 * it can also be scripted/CI'd for bulk onboarding.
 */
router.post('/import', requireRole('manager'), async (req, res) => {
  const rows = req.body.rows || [];
  let created = 0;
  let updated = 0;
  const teamCache = new Map((await query('SELECT id, name FROM teams')).map((t) => [t.name.toLowerCase(), t.id]));

  for (const row of rows) {
    const fullName = (row.fullName || '').trim();
    if (!fullName) continue;
    const [firstName, ...rest] = fullName.split(' ');
    const lastName = rest.join(' ');
    const teamName = (row.teamName || '').trim();
    const role = ['ic', 'manager', 'director', 'vp', 'svp', 'exec'].includes(row.role) ? row.role : 'ic';

    let teamId = null;
    if (teamName) {
      const key = teamName.toLowerCase();
      if (teamCache.has(key)) {
        teamId = teamCache.get(key);
      } else {
        const result = await query('INSERT INTO teams (name, display_name) VALUES (?, ?)', [teamName, teamName]);
        teamId = result.insertId;
        teamCache.set(key, teamId);
      }
    }

    const existing = await query('SELECT id FROM users WHERE first_name = ? AND last_name = ?', [firstName, lastName]);
    if (existing[0]) {
      await query('UPDATE users SET team_id = ?, role = ? WHERE id = ?', [teamId, role, existing[0].id]);
      updated += 1;
    } else {
      await query('INSERT INTO users (first_name, last_name, team_id, role, active) VALUES (?, ?, ?, ?, 1)', [firstName, lastName, teamId, role]);
      created += 1;
    }
  }
  res.json({ created, updated });
});

module.exports = router;
