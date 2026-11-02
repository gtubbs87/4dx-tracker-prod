'use strict';
/** Generic per-user preference store — currently used for the Org Analytics saved widget layout. */
const express = require('express');
const { query } = require('../db');

const router = express.Router();

router.get('/:key', async (req, res) => {
  const rows = await query('SELECT pref_value FROM user_preferences WHERE user_id = ? AND pref_key = ?', [req.user.id, req.params.key]);
  res.json(rows[0] ? rows[0].pref_value : null);
});

router.put('/:key', async (req, res) => {
  await query(
    `INSERT INTO user_preferences (user_id, pref_key, pref_value) VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE pref_value = VALUES(pref_value)`,
    [req.user.id, req.params.key, JSON.stringify(req.body)]
  );
  res.json({ ok: true });
});

module.exports = router;
