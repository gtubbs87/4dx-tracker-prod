'use strict';
/** A leader's standing subscription to a periodic emailed/Teams-posted Org Analytics rollup. */
const express = require('express');
const { query } = require('../db');
const { requireRole } = require('../middleware/requireRole');
const { logAudit } = require('../lib/audit');

const router = express.Router();

// Senior-leadership feature — manager rank and above only.
router.use(requireRole('manager'));

router.get('/', async (req, res) => {
  const rows = await query('SELECT * FROM report_subscriptions WHERE user_id = ? ORDER BY id DESC', [req.user.id]);
  res.json(rows);
});

router.post('/', async (req, res) => {
  const { frequency, widgets, channelEmail, channelTeams } = req.body;
  if (!['daily', 'weekly', 'monthly', 'quarterly'].includes(frequency)) {
    return res.status(400).json({ error: 'frequency must be daily, weekly, monthly, or quarterly' });
  }
  if (!Array.isArray(widgets) || widgets.length === 0) return res.status(400).json({ error: 'at least one widget is required' });
  const result = await query(
    'INSERT INTO report_subscriptions (user_id, frequency, widgets, channel_email, channel_teams) VALUES (?, ?, ?, ?, ?)',
    [req.user.id, frequency, JSON.stringify(widgets), channelEmail === false ? 0 : 1, channelTeams ? 1 : 0]
  );
  logAudit(req.user.id, 'subscription.create', 'report_subscription', result.insertId, { frequency, widgets });
  res.status(201).json({ id: result.insertId });
});

router.patch('/:id', async (req, res) => {
  const { active } = req.body;
  if (active === undefined) return res.status(400).json({ error: 'no fields to update' });
  await query('UPDATE report_subscriptions SET active = ? WHERE id = ? AND user_id = ?', [active ? 1 : 0, req.params.id, req.user.id]);
  res.json({ ok: true });
});

router.delete('/:id', async (req, res) => {
  await query('DELETE FROM report_subscriptions WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
  logAudit(req.user.id, 'subscription.delete', 'report_subscription', Number(req.params.id));
  res.json({ ok: true });
});

module.exports = router;
