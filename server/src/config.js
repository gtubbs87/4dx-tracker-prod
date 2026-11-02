'use strict';

const isProduction = process.env.NODE_ENV === 'production';

// Fail closed: a session-signing secret is the entire trust boundary for
// "who is this request from." No fallback in production — refuse to start
// rather than silently signing tokens with a value anyone can read in this
// repo. The insecure default is only tolerated for local development.
function resolveJwtSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  if (isProduction) {
    throw new Error('JWT_SECRET is required in production — refusing to start with no session-signing secret configured.');
  }
  console.warn('[SECURITY] JWT_SECRET not set — using an insecure development-only default. Set JWT_SECRET before deploying anywhere real.'); // eslint-disable-line no-console
  return 'dev-only-change-me';
}

module.exports = {
  port: Number(process.env.PORT || 3000),
  jwtSecret: resolveJwtSecret(),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '12h',
  corsOrigin: process.env.CORS_ORIGIN || 'http://localhost:5173',
  okta: {
    issuer: process.env.OKTA_ISSUER || '',           // e.g. https://your-org.okta.com/oauth2/default
    clientId: process.env.OKTA_CLIENT_ID || '',
    clientSecret: process.env.OKTA_CLIENT_SECRET || '',
    redirectUri: process.env.OKTA_REDIRECT_URI || 'http://localhost:3000/auth/okta/callback',
    postLoginRedirect: process.env.POST_LOGIN_REDIRECT || 'http://localhost:5173',
    // Unmapped groups (or no groups at all) fall back to 'ic' — see
    // mapGroupsToRole in oktaAuth.js.
    groupRoleMap: {
      '4dx-exec': 'exec',
      '4dx-svp': 'svp',
      '4dx-vp': 'vp',
      '4dx-directors': 'director',
      '4dx-managers': 'manager',
    },
  },
};
