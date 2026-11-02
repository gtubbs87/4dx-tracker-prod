# Security overview — 4DX Execution Tracker

This document is written for whoever is about to run SAST/SCA scans, a
pentest, or a CVE sweep against this app. It covers the trust model, what's
already been hardened, what's explicitly out of scope and why, and how to
reproduce the checks already run.

Last reviewed: 2026-09 (see git history / commit messages for date if this
file is stale relative to the code).

## TL;DR for the pentest team

- **Auth**: Okta OIDC (authorization code + PKCE) is the only login path —
  no password login and no credential-bypass route exists in this codebase
  (see [No credential-bypass login path](#no-credential-bypass-login-path)).
- **Sessions**: JWT (HS256), signed server-side, issued only by the Okta
  callback and delivered as an `httpOnly`/`sameSite=lax`/`secure` cookie.
  The API middleware also accepts an `Authorization: Bearer` header carrying
  a token signed with `JWT_SECRET`, but nothing in this repo issues one to
  browsers. No refresh tokens; sessions expire after 12h (`JWT_EXPIRES_IN`).
- **Authorization**: role-rank + team-membership checks on every mutating
  route (`server/src/middleware/requireRole.js`). See
  [RBAC model](#rbac-model) for the exact rank order and what each rank can
  reach.
- **Data**: MySQL via parameterized queries throughout (`mysql2` prepared
  statements). No raw string concatenation of user input into SQL anywhere
  in `server/src` — every dynamic `${...}` in a query string is either a
  placeholder-count generator (`?,?,?`) or a numeric value clamped in code
  before interpolation. Grep for `\${` inside `server/src` if you want to
  re-verify this yourself.
- **Dependency audit**: 0 known vulnerabilities, both `server/` and
  `client/`, as of this review (`npm audit`, see
  [Reproducing the dependency audit](#reproducing-the-dependency-audit)).

## Threat model / trust boundaries

```
Browser (untrusted)
   │  HTTPS (TLS terminated at ingress in k8s; plain HTTP in local docker-compose)
   ▼
nginx (web container) — serves the static SPA, reverse-proxies /api and /auth
   │  HTTP, internal network only (docker network / k8s ClusterIP)
   ▼
Express API (api container) — the only thing that talks to the database
   │  MySQL protocol, internal network only
   ▼
MySQL — never exposed outside the internal network (no host port mapping in
         the compose file; no Service of type LoadBalancer/NodePort in k8s)
```

Outbound from the API: Okta (OIDC discovery + token exchange), and
optionally a Microsoft Teams incoming-webhook URL if `TEAMS_WEBHOOK_URL` is
set. Email is **not** actually sent anywhere yet — see
[Email is a stub, not a real integration](#email-is-a-stub-not-a-real-integration).

Outbound from the **browser**, separately from the above: optionally
Google Analytics (GA4), if `VITE_GA_MEASUREMENT_ID` was set at build time
(`client/src/analytics.js`) — unset by default, in which case nothing is
ever loaded from Google and this whole paragraph is moot. When it is
configured, page views and product-usage events go straight from the
browser to `googletagmanager.com`/`google-analytics.com`; they never
transit the `api` container or touch the database. Event payloads are
limited by code review to roles, ids, booleans, and action-type strings —
never names or emails — but treat this as any third-party data flow: it's
disclosure to Google, not to this app's own infra, and CSP in
`client/nginx.conf` had to be loosened (`script-src`/`connect-src`) to
allow it.

The `k8s/cronjobs-and-netpol.yaml` NetworkPolicies encode this: `default-deny`
on the namespace, then explicit allow rules for web→api ingress and
api→(MySQL/HTTPS/DNS) egress. Nothing else is reachable.

## RBAC model

Roles, in ascending rank (`server/src/middleware/requireRole.js`):

```
ic (0) < manager (1) < director (2) < vp (3) < svp (4) < exec (5)
```

Unlike a typical graduated-rank RBAC model, there is exactly one permission
boundary here: **`ic` (Individual Contributor) vs. everyone else.** Every
role from `manager` up is intentionally identical in what it can do — full
org-wide admin access, not scoped to a single team:

- **Org-wide admin access** (`requireRole('manager')`, the floor for every
  non-`ic` role): team/user/threshold CRUD, bulk roster import, any team's
  WIGs/sessions/metrics, the Org Analytics dashboard endpoints (heatmap,
  alerts, org-wide pending-commitments, WIG-status summary, individual
  leaderboard), and the audit log. `canManageTeam(user)` — used to gate
  commitment close-out and the Scoreboard's redaction logic below — is the
  same rank check with no team-id comparison: manager rank and above can
  act on *any* team, not just one they belong to. This is a deliberate
  product decision, not an oversight — see the merge/role-hierarchy change
  that introduced it if you're diffing against an earlier scan expecting
  team-scoped write access.
- **Self-scoped, no role check needed**: `/api/users/me`,
  `/api/preferences/:key`, `/api/wigs/mine-and-downline`,
  `/api/commitments/history`, `/api/analytics/my-reports/pending-commitments`
  — these are safe without a role gate because they only ever act on
  `req.user.id`, never a caller-supplied target id. The last one walks the
  caller's own reporting-chain downline (`teamsUnderManager()`), but that's
  still self-scoped — it's *whose* downline is fixed to the caller, not an
  arbitrary id.
- **Intentionally open to any authenticated user**: team-level aggregate
  numbers (attainment %, health score, WIG statement) on
  `GET /api/analytics/team/:teamId/attainment` and
  `GET /api/analytics/rollup/:teamId` — this mirrors the product's
  "visible scoreboard" model from 4DX methodology (the Scoreboard page's
  team switcher lets anyone browse any team's aggregate numbers by design).
  Individual-level detail (names, free-text commitment/notes) is **not**
  included in these — see the next point.
- **Redacted, not blocked**: `GET /api/sessions/:teamId/...` returns full
  commitment text/notes/names only to the team's own members or anyone
  manager rank and above (`canManageTeam`, org-wide); everyone else gets
  `{id, commitment_made, commitment_met}` only — enough to compute a count,
  not enough to read what anyone actually committed to. This was a real gap
  closed in an earlier hardening pass — it's called out here because it's
  easy to "fix" the wrong way by just adding a role gate, which would break
  the intentional org-wide count visibility for an IC.

`canViewUser(actingUser, targetUserId)` (self, or anyone manager rank and
above) gates the individual commitment-history drill-down
(`GET /api/analytics/user/:userId/history`).

## What changed in the last hardening pass

Concrete fixes, for anyone diffing this against an earlier scan:

1. **`server/src/config.js`** — `JWT_SECRET` no longer silently falls back
   to a hardcoded value in production; the process now refuses to start
   without one. Same for `DB_PASSWORD` in `server/src/db.js`.
2. **No credential-bypass login path exists in this codebase.** An earlier
   build carried a `DEMO_MODE` login (`POST /auth/demo-login`) that signed in
   as any seeded user id with no password, guarded only by a startup check
   that refused to run it under `NODE_ENV=production`. This repository
   removes that code outright — the server route, the client sign-in screen,
   the config flag, and the compose/k8s settings — rather than relying on a
   guard. The client is also cookie-only now: it no longer stores a session
   token in `localStorage`.
3. **JWT algorithm pinned** (`{ algorithms: ['HS256'] }` on every
   `jwt.verify` call) — defense against algorithm-confusion, even though
   this app never mixes symmetric/asymmetric verification today.
4. **Broken access control fixed** in `server/src/routes/sessions.js`
   (cross-team commitment detail was readable by any authenticated user —
   see RBAC section above) and `server/src/routes/commitments.js`
   (`POST /api/commitments` didn't validate that the caller-supplied
   `teamId` matched their own team, so any user could forge a commitment
   under an arbitrary team).
5. **Unescaped user content in HTML email** (`server/src/jobs/reportDigest.js`)
   — team names, WIG statements, and people's names are user-entered and
   were interpolated straight into an HTML string. Not exploitable *today*
   (email sending is stubbed — see below) but would have been the moment a
   real provider was wired in. Fixed with a small `esc()` helper. Email
   subject lines are now also stripped of `\r\n` centrally in
   `lib/notify.js`, to prevent header injection once a real provider exists.
6. **Security headers**: `helmet()` added to the API (`server/src/server.js`);
   an explicit CSP/X-Frame-Options/X-Content-Type-Options/Referrer-Policy
   set added to `client/nginx.conf` (the browser enforces these against the
   page's own origin — the SPA is served by nginx, not by the API, so the
   API's helmet headers don't govern page-level behavior; both are needed).
7. **Rate limiting** added (`express-rate-limit`): a tight limiter on
   `/auth/*` (30 req/15min/IP — this is the highest-value brute-force
   target), a looser one on `/api/*` (600 req/5min/IP). `trust proxy` is
   set to `1` so this reads the real client IP through the one reverse-proxy
   hop every shipped topology has, not the proxy's own IP.
8. **`nginx.conf` cache-control** — `index.html` is now `Cache-Control:
   no-cache` (it references a content-hashed JS bundle; without this, a
   stale cached `index.html` can point at assets from a previous deploy
   that no longer exist, or just silently serve an old build). Hashed
   assets under `/assets/` are cached aggressively instead, which is safe
   precisely because they're content-hashed.
9. **Dependency vulnerabilities fixed**: `client/` had a moderate (esbuild,
   [GHSA-67mh-4wv8-2f99](https://github.com/advisories/GHSA-67mh-4wv8-2f99))
   and a high (`vite`,
   [GHSA-fx2h-pf6j-xcff](https://github.com/advisories/GHSA-fx2h-pf6j-xcff))
   — both dev-tooling only (the production image ships static build output
   through nginx, never the Vite dev server), but fixed anyway by upgrading
   `vite` 5→8 and `@vitejs/plugin-react` 4→6. `server/` was already clean.
   Removed an unused `dotenv` dependency from `server/package.json` (never
   actually `require()`'d anywhere — pure unused attack surface).
10. **Container/k8s hardening**: `readOnlyRootFilesystem`,
    `allowPrivilegeEscalation: false`, `capabilities: drop: [ALL]`,
    `runAsNonRoot` with explicit non-root UIDs, and
    `automountServiceAccountToken: false` added to every Deployment and
    CronJob in `k8s/`. The namespace also now sets the built-in Pod Security
    admission label (`pod-security.kubernetes.io/enforce: restricted`) as a
    backstop for anything added later without the same care.
11. **DB migration Job password exposure fixed**
    (`k8s/migration-job.yaml`) — the password was passed as a literal
    `-p$DB_PASSWORD` CLI argument to the `mysql` client, visible to any
    other process on the node via `ps`. Switched to the `MYSQL_PWD` env var.
12. **Cron job network policy gap fixed** — none of the 8 CronJob pod
    templates carried the `app: api` label the existing `api-egress`
    NetworkPolicy selects on, so under `default-deny` every scheduled job
    would have had *zero* network access (couldn't reach MySQL, couldn't
    resolve DNS) and failed silently. All CronJob pods now carry the label.
13. **Security headers weren't actually reaching real page loads** —
    found while adding Google Analytics forced a closer look at response
    headers on the page itself (not just the API). nginx's `add_header`
    does **not** merge with the parent context once a `location` block sets
    its own `add_header` — it's a full reset, not an addition. Both
    `location = /index.html` and `location /assets/` in `client/nginx.conf`
    only set `Cache-Control`, which meant every real page load (bare `/`,
    and every SPA route via `try_files`, since both resolve to
    `/index.html`) silently shipped with **none** of the headers item 6
    above describes — CSP, `X-Frame-Options`, `X-Content-Type-Options`,
    `Referrer-Policy` were only ever reaching the proxied `/api`/`/auth`
    JSON responses, never the HTML page a browser actually enforces CSP
    against. Fixed by repeating the four headers explicitly in both
    locations; verified present on `/`, `/index.html`, and a real asset
    response afterward. Worth re-checking with `curl -I` on any future
    `nginx.conf` change that adds a `location` block — this class of bug is
    silent (nginx logs no warning, the response just quietly lacks headers)
    and won't be caught by anything that only tests the API.
14. **`server_tokens off`** added to `client/nginx.conf` — nginx was
    disclosing its exact version (`nginx/1.27.5`) in both the `Server`
    header and the default error-page bodies (403/404/50x), free
    fingerprinting for matching against known nginx CVEs. No behavior
    change.
15. **CSP loosened, deliberately, for optional Google Analytics** —
    `script-src`/`connect-src` in `client/nginx.conf` now allow
    `googletagmanager.com`/`google-analytics.com`. This is inert (nothing
    reachable, nothing loaded) unless `VITE_GA_MEASUREMENT_ID` was set at
    image build time — see the [threat-model note above](#threat-model--trust-boundaries)
    for what data does and doesn't leave the app when it is.
16. **Container-image CVEs found and fixed** — see
    [Container image CVE scan](#container-image-cve-scan) below; not a
    `npm audit` finding (item 9 above), a separate class of issue in the
    base OS image and its bundled tooling.

## Container image CVE scan

`npm audit` (see [Reproducing the dependency audit](#reproducing-the-dependency-audit)
above) only covers this app's own JS dependency tree. It says nothing about
the base OS image or tooling bundled into it — a separate class of finding
that showed up when the built `api` image was scanned with Docker Scout:

**Before**: 43 vulnerabilities — 2 critical, 25 high, 12 medium, 4 low.
**After** (current `server/Dockerfile`): 1 — a medium-severity busybox CVE
with no fix published upstream yet (confirmed via `apk update`; nothing to
do until Alpine ships one, and `apk upgrade` at build time picks it up
automatically once they do).

Two unrelated root causes, both explained in
[`server/Dockerfile`'s hardening changes](PRODUCTION_ARCHITECTURE.md#7-containerization):
- **OpenSSL/Alpine OS packages** — genuinely outdated at the time of the
  base image's own last build. Fixed with `apk update && apk upgrade
  --no-cache` in both build stages (`libssl3`/`libcrypto3` 3.5.6-r0 →
  3.5.7-r0, matching the scanner's own recommended fix version).
- **The other ~8 flagged packages** (`tar`, `glob`, `minimatch`,
  `cross-spawn`, `sigstore`, `ip-address`, `brace-expansion`, `diff`) were
  never this app's own dependencies at all — confirmed by grepping
  `server/package-lock.json`, they don't appear there. They're vendored
  inside the base image's *own bundled npm CLI*
  (`/usr/local/lib/node_modules/npm/node_modules/...`), which this
  container never invokes (`CMD` is `node src/server.js`, never `npm`).
  Removing the unused `npm`/`npx`/`corepack`/`yarn` binaries and their
  `node_modules` from the final stage removed those findings entirely
  rather than trying to "upgrade" packages this app doesn't control and
  doesn't use.

**Reproducing this scan**:
```bash
docker build -t 4dx-tracker-api:latest ./server
docker scout cves 4dx-tracker-api:latest
```
Requires Docker Desktop with Docker Scout enabled (or `docker scout` CLI
configured separately). Re-run before any release the same way as the
`npm audit` check — this is a point-in-time result against whatever the
Alpine package repos currently publish, not a standing guarantee.

## No credential-bypass login path

Okta is the only way to obtain a session. There is no password login, no
test-user login, and no environment flag that turns one on — the code simply
isn't in this repository (see hardening item 2 below). The only routes under
`/auth` are `GET /auth/okta/login`, `GET /auth/okta/callback`, and
`POST /auth/logout` (`server/src/auth/oktaAuth.js`).

If you're pentesting a deployment and any other `/auth/*` path responds with
anything other than 404 — in particular anything that looks like
`/auth/demo-login` — stop and flag it immediately: that would mean the
deployed build isn't this code.

If this app is reachable from the public internet, expect routine
background-radiation scanning (automated vulnerability and credential-file
probes — `.env`, `.git/config`, `.aws/credentials`, common exploit paths).
Those fail harmlessly here since none of those files ship in the image
(verified in [Container image CVE scan](#container-image-cve-scan) above)
and every `/api` route requires a valid session. Nothing in this repo
detects or alerts on probing, so periodically skimming
`docker logs <web-container> --since 24h` (or your ingress logs) for
unfamiliar `Referer`/`User-Agent` patterns is worth doing manually.

## Email is a stub, not a real integration

No SMTP/SES/SendGrid/Graph API credentials exist anywhere in this repo or
its example configs. `server/src/lib/notify.js`'s `sendEmail()` logs the
full message instead of delivering it. Every code path that "sends email"
(monthly metrics reminders, the Friday commitment escalation, the
daily/weekly/monthly/quarterly Org Analytics digest) is fully wired and
exercised — the only thing missing is a real provider behind that one
function. If you're testing email-injection-style attacks, the sinks to
check are the ones already fixed above (HTML escaping, header-injection
stripping) — they're correct now regardless of whether a real provider ever
gets wired in.

## Known accepted risks / explicitly out of scope

These were identified during the review and deliberately **not** changed,
with the reasoning:

- **`openid-client` is pinned to v5** (`^5.6.5`), not the current v6 major.
  v6 is a ground-up rewrite of the library's API (drops the
  `Issuer`/`Client` class-based interface `server/src/auth/oktaAuth.js`
  uses for the entire PKCE + token-exchange flow). v5 has 0 known
  vulnerabilities today. Migrating is real, auth-critical work that needs
  testing against a live Okta org, which isn't available in this
  environment — recommended as a tracked follow-up, not done blind here.
- **Base images are tag-pinned (`node:20-alpine`, `nginx:1.27-alpine`), not
  digest-pinned.** Digest pinning is more reproducible but goes stale the
  moment it's written unless something (Renovate/Dependabot) actively
  maintains it. A floating minor tag at least picks up patch-level base
  image fixes on every rebuild. Recommend wiring up Renovate or Dependabot
  for both the npm manifests and the Dockerfile `FROM` lines rather than
  hand-pinning a digest that will be stale by the time anyone reads this.
- **`recharts` is on the 2.x line**, which upstream has marked as no longer
  actively maintained (recommending a v3 migration). This is a maintenance
  status, not a CVE — `npm audit` shows 0 vulnerabilities for it. Left
  as-is because it's a UI charting library used throughout the app
  (`client/src/App.jsx`) and a major-version migration carries real
  breaking-change risk that needs visual QA across every chart, which this
  pass didn't do. Recommended follow-up, not a security finding.
- **`npm ci` is not run with `--ignore-scripts`.** Would reduce
  supply-chain attack surface from a compromised dependency's install
  hooks, but none of this app's current dependencies need install scripts,
  and adding it blind (without verifying every current and future
  dependency still installs cleanly) risks silently breaking a future
  `npm install`. Worth adopting once there's CI to catch that breakage.

## Reproducing the dependency audit

```bash
# Server
docker run --rm -v "$(pwd)/server:/app" -w /app node:20-alpine npm audit

# Client
docker run --rm -v "$(pwd)/client:/app" -w /app node:20-alpine npm audit
```

Both returned 0 vulnerabilities as of this review. Re-run before every
pentest engagement — this is a point-in-time result, not a standing
guarantee; new CVEs get disclosed against existing package versions
constantly.

## Secrets inventory

| Secret | Where it lives | Notes |
|---|---|---|
| `JWT_SECRET` | `k8s/secrets.example.yaml` (template only, real value injected at deploy time) | Session-signing key. Required in production — see above. |
| `DB_PASSWORD` | same | Required in production — see above. |
| `OKTA_CLIENT_SECRET` | same | OIDC client secret. |
| `TEAMS_WEBHOOK_URL` | not templated (optional) | Not currently a secret *value* holder of concern (a webhook URL is bearer-token-like — treat it as one if you add it to a real config). |

No secret value is committed anywhere in this repo — `.env.example` and
`k8s/secrets.example.yaml` both use placeholder text and say so explicitly
in their own comments.
