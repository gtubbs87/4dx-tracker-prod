'use strict';
const express = require('express');
const { query } = require('../db');
const { requireRole } = require('../middleware/requireRole');
const { logAudit } = require('../lib/audit');

const router = express.Router();

router.get('/', async (req, res) => {
  const rows = await query('SELECT id, name, display_name, parent_id FROM teams ORDER BY name');
  res.json(rows);
});

router.post('/', requireRole('manager'), async (req, res) => {
  const { name, displayName, parentId } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  const result = await query(
    'INSERT INTO teams (name, display_name, parent_id) VALUES (?, ?, ?)',
    [name, displayName || name, parentId || null]
  );
  logAudit(req.user.id, 'team.create', 'team', result.insertId, { name, displayName: displayName || name, parentId: parentId || null });
  res.status(201).json({ id: result.insertId, name, displayName: displayName || name, parentId: parentId || null });
});

router.patch('/:id', requireRole('manager'), async (req, res) => {
  const { name, displayName, parentId } = req.body;
  const fields = [];
  const params = [];
  if (name !== undefined) { fields.push('name = ?'); params.push(name); }
  if (displayName !== undefined) { fields.push('display_name = ?'); params.push(displayName); }
  if (parentId !== undefined) { fields.push('parent_id = ?'); params.push(parentId); }
  if (fields.length === 0) return res.status(400).json({ error: 'no fields to update' });
  params.push(req.params.id);
  await query(`UPDATE teams SET ${fields.join(', ')} WHERE id = ?`, params);
  logAudit(req.user.id, 'team.update', 'team', Number(req.params.id), { name, displayName, parentId });
  res.json({ ok: true });
});

router.delete('/:id', requireRole('manager'), async (req, res) => {
  const children = await query('SELECT id FROM teams WHERE parent_id = ?', [req.params.id]);
  if (children.length > 0) {
    return res.status(409).json({ error: 'Team has sub-teams; reassign or remove them first' });
  }
  await query('DELETE FROM teams WHERE id = ?', [req.params.id]);
  logAudit(req.user.id, 'team.delete', 'team', Number(req.params.id));
  res.json({ ok: true });
});

module.exports = router;
