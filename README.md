# 4DX Execution Tracker

A full-stack app for running the 4 Disciplines of Execution (WIGs, lead/lag
measures, weekly commitments, Cadence of Accountability) across an
organization with nested divisions and teams — built to replace a manual
spreadsheet with real-time input, tracking, and leadership rollups.

```
4dx-tracker-prod/
├── server/                  Express API (Node 20) — see server/src
│   └── src/jobs/             nightly rollup, digests, and reminder batch jobs
├── client/                  React SPA (Vite) — talks to the API over HTTP
├── db/
│   └── schema.sql             MySQL 8 schema (teams, users, WIGs, commitments, ...)
├── k8s/                     Kubernetes manifests for production
├── docker-compose.yml        Production-shaped stack (Okta SSO required)
├── .env.example
├── SECURITY.md              Threat model, RBAC detail, hardening changelog
└── PRODUCTION_ARCHITECTURE.md   Full architecture writeup (this file is the quick-start)
```

Authentication is Okta SSO (OIDC authorization code + PKCE) only. There is no
credential-free or password login path in this codebase.

## Run locally (Docker Compose)

1. `cp .env.example .env` and fill in real values — a long random
   `JWT_SECRET`, real MySQL credentials, and your Okta app's issuer/client
   ID/secret (Okta Admin Console → Applications → your app → General).
2. `docker compose up --build`
3. Open `http://localhost:8080` — you'll be redirected to Okta to sign in.

First-time setup: with no teams/users yet, sign in as whoever your Okta
`4dx-exec` group maps to (see role mapping in
`server/src/config.js` / `PRODUCTION_ARCHITECTURE.md` §3), then use
the **WIG Administration** tab to create teams and either add people
manually or bulk import a CSV roster.

Optional: set `GA_MEASUREMENT_ID` in `.env` to enable Google Analytics. It is
baked into the client at build time and does nothing when unset — see
`.env.example`.

## Deploy to Kubernetes (any cloud)

1. Build and push both images:
   ```bash
   docker build -t <registry>/4dx/api:v1 ./server && docker push <registry>/4dx/api:v1
   docker build -t <registry>/4dx/web:v1 ./client && docker push <registry>/4dx/web:v1
   ```
2. `kubectl apply -f k8s/namespace.yaml`
3. Fill in `k8s/secrets.example.yaml` with real values and apply it (or better, wire up External Secrets Operator — see PRODUCTION_ARCHITECTURE.md §10).
4. Edit `k8s/configmap.yaml` with your real `DB_HOST`, `OKTA_ISSUER`, and domain.
5. Replace `__TAG__` in every manifest with your image tag, then:
   ```bash
   kubectl apply -f k8s/configmap.yaml -f k8s/api-deployment.yaml -f k8s/web-deployment.yaml -f k8s/ingress.yaml -f k8s/cronjobs-and-netpol.yaml
   ```
6. Point `DB_HOST` at a managed MySQL instance (RDS/Cloud SQL/Azure Database for MySQL) — see PRODUCTION_ARCHITECTURE.md §2 for why that's recommended over a self-hosted StatefulSet at this scale.
7. Run `k8s/migration-job.yaml` once (after creating the `4dx-schema-sql` ConfigMap it references) to load `schema.sql` into your managed DB.

Full detail on all of the above — Okta flow internals, analytics ideas for
every leadership level, CI/CD, observability, and a phased rollout plan —
is in **PRODUCTION_ARCHITECTURE.md**.

## Local development (no Docker)

You need a MySQL 8 / MariaDB instance and an Okta application (a free Okta
developer org works) with the sign-in redirect URI
`http://localhost:3000/auth/okta/callback`. The defaults in
`server/src/config.js` already match the Vite dev server's ports.

```bash
# Terminal 1 — database (any local MySQL/MariaDB works)
mysql -u root -e "CREATE DATABASE fourdx"
mysql -u root fourdx < db/schema.sql

# Terminal 2 — API
cd server && npm install
DB_HOST=127.0.0.1 DB_USER=root DB_NAME=fourdx \
  OKTA_ISSUER=https://your-org.okta.com/oauth2/default \
  OKTA_CLIENT_ID=... OKTA_CLIENT_SECRET=... npm run dev

# Terminal 3 — client
cd client && npm install && npm run dev
```

Visit `http://localhost:5173`.

## What's been verified vs. what to verify yourself

Verified for this codebase: both Docker images build, the API starts under
`NODE_ENV=production` and refuses to start without a `JWT_SECRET`, every
`/api` route rejects unauthenticated requests, and the client bundle
contains only the Okta sign-in flow. The application logic (CRUD routes,
role-based access control, commitment logging and close-out, session
toggling, the recursive rollup, the org heatmap, alerts, and the batch jobs)
was exercised in development against a real MySQL-compatible database.

Not yet tested (no Kubernetes cluster or real Okta org was available) —
verify these yourself before go-live:
- The Okta OIDC flow end-to-end against a real Okta application.
- The Kubernetes manifests against a real cluster (they're valid YAML and
  follow the architecture doc, but haven't been `kubectl apply`'d anywhere).
