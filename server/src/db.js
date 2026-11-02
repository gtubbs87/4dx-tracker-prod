'use strict';
const mysql = require('mysql2/promise');

const isProduction = process.env.NODE_ENV === 'production';
if (isProduction && !process.env.DB_PASSWORD) {
  throw new Error('DB_PASSWORD is required in production — refusing to start with an unauthenticated database connection.');
}

const pool = mysql.createPool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || '4dx',
  waitForConnections: true,
  connectionLimit: Number(process.env.DB_POOL_SIZE || 10),
  namedPlaceholders: true,
  dateStrings: true,
});

async function query(sql, params) {
  const [rows] = await pool.execute(sql, params);
  return rows;
}

module.exports = { pool, query };
