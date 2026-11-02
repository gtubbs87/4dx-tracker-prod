'use strict';
const jwt = require('jsonwebtoken');
const config = require('../config');

const JWT_ALGORITHM = 'HS256';

function signSession(user) {
  return jwt.sign(
    { sub: String(user.id), role: user.role, teamId: user.team_id, name: `${user.first_name} ${user.last_name}` },
    config.jwtSecret,
    { expiresIn: config.jwtExpiresIn, algorithm: JWT_ALGORITHM }
  );
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : req.cookies?.session;
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    // Pin the algorithm explicitly — never trust an `alg` the token itself
    // claims. Without this, a verifier that also handles asymmetric keys
    // elsewhere can be tricked into accepting a forged HS256 token signed
    // with a public key. Not currently reachable here (this app only ever
    // signs/verifies HS256), but pinning is the correct default regardless.
    const payload = jwt.verify(token, config.jwtSecret, { algorithms: [JWT_ALGORITHM] });
    req.user = { id: Number(payload.sub), role: payload.role, teamId: payload.teamId, name: payload.name };
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }
}

module.exports = { signSession, requireAuth };
