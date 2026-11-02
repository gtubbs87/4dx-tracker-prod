'use strict';
const express = require('express');
const crypto = require('crypto');
const { Issuer, generators } = require('openid-client');
const { query } = require('../db');
const { signSession } = require('../middleware/auth');
const config = require('../config');

const router = express.Router();

let clientPromise = null;
function getClient() {
  if (!config.okta.issuer) throw new Error('OKTA_ISSUER is not configured');
  if (!clientPromise) {
    clientPromise = Issuer.discover(config.okta.issuer).then(
      (issuer) =>
        new issuer.Client({
          client_id: config.okta.clientId,
          client_secret: config.okta.clientSecret,
          redirect_uris: [config.okta.redirectUri],
          response_types: ['code'],
        })
    );
  }
  return clientPromise;
}

// In-memory PKCE/state store (fine for a single instance). In a multi-pod
// deployment, back this with Redis (or sign state+verifier into a
// short-lived, encrypted cookie) so any pod can handle the callback.
const pendingLogins = new Map();
const PENDING_LOGIN_TTL_MS = 10 * 60 * 1000; // must complete within 10 minutes

function pruneExpiredLogins() {
  const cutoff = Date.now() - PENDING_LOGIN_TTL_MS;
  for (const [state, entry] of pendingLogins) {
    if (entry.createdAt < cutoff) pendingLogins.delete(state);
  }
}

router.get('/okta/login', async (req, res, next) => {
  try {
    const client = await getClient();
    // Every abandoned login attempt (closed tab, expired flow) would
    // otherwise leak an entry forever — prune before adding a new one so
    // this map can't grow unbounded under repeated/automated login attempts.
    pruneExpiredLogins();
    const state = generators.state();
    const codeVerifier = generators.codeVerifier();
    const codeChallenge = generators.codeChallenge(codeVerifier);
    pendingLogins.set(state, { codeVerifier, createdAt: Date.now() });

    const url = client.authorizationUrl({
      scope: 'openid profile email groups',
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    });
    res.redirect(url);
  } catch (err) {
    next(err);
  }
});

router.get('/okta/callback', async (req, res, next) => {
  try {
    const client = await getClient();
    const params = client.callbackParams(req);
    const pending = pendingLogins.get(params.state);
    pendingLogins.delete(params.state); // single-use regardless of outcome
    if (!pending || pending.createdAt < Date.now() - PENDING_LOGIN_TTL_MS) {
      return res.status(400).send('Login session expired — please try again.');
    }

    const tokenSet = await client.callback(config.okta.redirectUri, params, {
      state: params.state,
      code_verifier: pending.codeVerifier,
    });
    const claims = tokenSet.claims();
    const groups = claims.groups || [];
    const role = mapGroupsToRole(groups);

    const user = await upsertUser({
      oktaSub: claims.sub,
      email: claims.email,
      firstName: claims.given_name || (claims.name || '').split(' ')[0] || 'Unknown',
      lastName: claims.family_name || (claims.name || '').split(' ').slice(1).join(' ') || '',
      role,
    });

    const sessionToken = signSession(user);
    // Server-side session cookie keeps the token out of browser JS/localStorage.
    res.cookie('session', sessionToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 12 * 60 * 60 * 1000,
    });
    res.redirect(config.okta.postLoginRedirect);
  } catch (err) {
    next(err);
  }
});

router.post('/logout', (req, res) => {
  res.clearCookie('session');
  res.json({ ok: true });
});

function mapGroupsToRole(groups) {
  const map = config.okta.groupRoleMap;
  for (const group of groups) {
    if (map[group]) return map[group];
  }
  return 'ic';
}

async function upsertUser({ oktaSub, email, firstName, lastName, role }) {
  const bySub = await query('SELECT * FROM users WHERE okta_sub = ?', [oktaSub]);
  if (bySub[0]) {
    await query('UPDATE users SET email = ?, role = ? WHERE id = ?', [email, role, bySub[0].id]);
    return { ...bySub[0], email, role };
  }
  // Fall back to matching by email — covers users an admin added ahead of
  // time (with an email), who won't have an okta_sub until their first
  // real SSO login links the two records.
  const byEmail = email ? await query('SELECT * FROM users WHERE email = ?', [email]) : [];
  if (byEmail[0]) {
    await query('UPDATE users SET okta_sub = ?, role = ? WHERE id = ?', [oktaSub, role, byEmail[0].id]);
    return { ...byEmail[0], okta_sub: oktaSub, role };
  }
  const result = await query(
    'INSERT INTO users (okta_sub, email, first_name, last_name, role, active) VALUES (?, ?, ?, ?, ?, 1)',
    [oktaSub, email, firstName, lastName, role]
  );
  return { id: result.insertId, okta_sub: oktaSub, email, first_name: firstName, last_name: lastName, role, team_id: null };
}

module.exports = router;
