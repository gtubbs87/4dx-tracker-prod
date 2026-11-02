'use strict';
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');
const config = require('./config');
const { requireAuth } = require('./middleware/auth');

const oktaAuth = require('./auth/oktaAuth');
const teamsRoutes = require('./routes/teams');
const usersRoutes = require('./routes/users');
const wigsRoutes = require('./routes/wigs');
const sessionsRoutes = require('./routes/sessions');
const commitmentsRoutes = require('./routes/commitments');
const configRoutes = require('./routes/config');
const analyticsRoutes = require('./routes/analytics');
const auditRoutes = require('./routes/audit');
const preferencesRoutes = require('./routes/preferences');
const subscriptionsRoutes = require('./routes/subscriptions');

const app = express();

// This app always sits behind exactly one reverse proxy in every shipped
// topology (the nginx `web` container in docker-compose, ingress-nginx in
// k8s — see k8s/ingress.yaml) which sets X-Forwarded-For. Trust that one hop
// so req.ip (and therefore rate limiting below) reflects the real client,
// not the proxy. Raise this if another hop (e.g. an external LB) is added.
app.set('trust proxy', 1);

app.use(helmet());
app.use(cors({ origin: config.corsOrigin, credentials: true }));
app.use(express.json());
app.use(cookieParser());

app.get('/healthz', (req, res) => res.json({ ok: true }));

// Auth endpoints are the highest-value brute-force/enumeration target in
// this app (the Okta callback is a normal OAuth attack surface) —
// rate-limit them tighter than the general API.
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false });
app.use('/auth', authLimiter);
// Auth routes are unauthenticated by definition (they're how you get a session).
app.use('/auth', oktaAuth);

// General API rate limit — generous enough for normal dashboard polling,
// tight enough to blunt scripted abuse of an authenticated endpoint.
const apiLimiter = rateLimit({ windowMs: 5 * 60 * 1000, limit: 600, standardHeaders: true, legacyHeaders: false });
app.use('/api', apiLimiter);

// Everything under /api requires a valid session.
app.use('/api', requireAuth);
app.use('/api/teams', teamsRoutes);
app.use('/api/users', usersRoutes);
app.use('/api/wigs', wigsRoutes);
app.use('/api/sessions', sessionsRoutes);
app.use('/api/commitments', commitmentsRoutes);
app.use('/api/config', configRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/audit', auditRoutes);
app.use('/api/preferences', preferencesRoutes);
app.use('/api/subscriptions', subscriptionsRoutes);

// Centralized error handler — keeps route handlers free of try/catch boilerplate
// for anything that isn't a deliberate 4xx (those are thrown as res.status().json()
// directly in the route). Wrap async route handlers so thrown errors land here.
app.use((err, req, res, next) => {
  console.error(err); // eslint-disable-line no-console
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(config.port, () => {
  console.log(`4DX API listening on :${config.port}`); // eslint-disable-line no-console
});

module.exports = app;
