'use strict';
const express = require('express');
const { query } = require('../db');
const { requireRole } = require('../middleware/requireRole');

const router = express.Router();

/** GET /api/audit — recent activity log, newest first. Manager rank and above (org-wide admin access). */
router.get('/', requireRole('manager'), async (req, res) => {
  const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 50));
  const rows = await query(
    `SELECT a.id, a.action, a.entity_type, a.entity_id, a.detail, a.created_at,
            u.first_name, u.last_name
     FROM audit_log a
     LEFT JOIN users u ON u.id = a.user_id
     ORDER BY a.id DESC
     LIMIT ${limit}`
  );
  res.json(rows);
});

module.exports = router;
