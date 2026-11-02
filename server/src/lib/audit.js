'use strict';
const { query } = require('../db');

/** Fire-and-forget audit trail entry — never blocks or fails the caller's request. */
async function logAudit(userId, action, entityType, entityId, detail) {
  try {
    await query(
      'INSERT INTO audit_log (user_id, action, entity_type, entity_id, detail) VALUES (?, ?, ?, ?, ?)',
      [userId ?? null, action, entityType, entityId ?? null, detail !== undefined ? JSON.stringify(detail) : null]
    );
  } catch (err) {
    console.error('Audit log write failed:', err); // eslint-disable-line no-console
  }
}

module.exports = { logAudit };
