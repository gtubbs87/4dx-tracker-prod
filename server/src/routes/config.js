'use strict';
const express = require('express');
const { query } = require('../db');
const { requireRole } = require('../middleware/requireRole');
const { logAudit } = require('../lib/audit');

const router = express.Router();

router.get('/', async (req, res) => {
  const rows = await query('SELECT config_key, config_value FROM org_config');
  const config = Object.fromEntries(rows.map((r) => [r.config_key, Number(r.config_value)]));
  res.json({
    commit_yellow: config.commit_yellow ?? 0.8,
    commit_green: config.commit_green ?? 0.9,
    session_yellow: config.session_yellow ?? 0.85,
    session_green: config.session_green ?? 0.95,
  });
});

router.put('/', requireRole('manager'), async (req, res) => {
  const allowed = ['commit_yellow', 'commit_green', 'session_yellow', 'session_green'];
  const changed = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) {
      await query(
        'INSERT INTO org_config (config_key, config_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE config_value = VALUES(config_value)',
        [key, req.body[key]]
      );
      changed[key] = req.body[key];
    }
  }
  logAudit(req.user.id, 'config.update', 'org_config', null, changed);
  res.json({ ok: true });
});

module.exports = router;
