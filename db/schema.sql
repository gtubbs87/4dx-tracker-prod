-- ============================================================
-- 4DX Execution Tracker — MySQL 8 schema
-- Normalizes the legacy spreadsheet's Division > Team > Individual
-- structure, weekly Cadence-of-Accountability commitments, and
-- monthly WIG (lag + up to 3 lead measures) tracking.
-- ============================================================

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

-- Divisions and teams share one self-referencing table.
-- A row with parent_id NULL is a division; a row with parent_id set
-- is a team/sub-team. A node can carry its own WIG and commitments
-- even if it also has children (mirrors the legacy sheet, where a
-- division tab logs its own leaders' commitments too).
CREATE TABLE teams (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  name          VARCHAR(100) NOT NULL UNIQUE,      -- e.g. CDP_CI, CDP_CI_Arch
  display_name  VARCHAR(150) NULL,
  parent_id     INT NULL,
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_teams_parent FOREIGN KEY (parent_id) REFERENCES teams(id) ON DELETE RESTRICT
) ENGINE=InnoDB;

CREATE INDEX idx_teams_parent ON teams(parent_id);

CREATE TABLE users (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  okta_sub        VARCHAR(255) UNIQUE,             -- Okta 'sub' claim; set on first SSO login
  email           VARCHAR(255) UNIQUE,
  first_name      VARCHAR(100) NOT NULL,
  last_name       VARCHAR(100) NOT NULL,
  team_id         INT NULL,
  role            ENUM('ic','manager','director','vp','svp','exec') NOT NULL DEFAULT 'ic',
  manager_id      INT NULL,                        -- who this person directly reports to (for escalation routing) — e.g. a manager's manager_id is typically a director, a director's is typically a VP
  active          TINYINT(1) NOT NULL DEFAULT 1,
  initiation_date DATE NULL,                       -- when tracking/cadence started for them
  created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_users_team FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE SET NULL,
  CONSTRAINT fk_users_manager FOREIGN KEY (manager_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE INDEX idx_users_team ON users(team_id);
CREATE INDEX idx_users_active ON users(active);
CREATE INDEX idx_users_manager ON users(manager_id);

CREATE TABLE wigs (
  id               INT AUTO_INCREMENT PRIMARY KEY,
  team_id          INT NOT NULL,
  wig_code         VARCHAR(30),                    -- e.g. CDP_WIG_0001, kept for legacy traceability
  statement        VARCHAR(500) NOT NULL,
  status           ENUM('active','completed','on_hold') NOT NULL DEFAULT 'active',
  effective_start  DATE NULL,
  effective_end    DATE NULL,
  created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_wigs_team FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE INDEX idx_wigs_team ON wigs(team_id);

-- One row per measure per WIG (lag, lead1, lead2, lead3).
CREATE TABLE wig_measures (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  wig_id        INT NOT NULL,
  measure_type  ENUM('lag','lead1','lead2','lead3') NOT NULL,
  label         VARCHAR(150) NOT NULL,
  target_value  DECIMAL(18,4) NULL,
  unit          VARCHAR(30) NULL,
  CONSTRAINT fk_measures_wig FOREIGN KEY (wig_id) REFERENCES wigs(id) ON DELETE CASCADE,
  UNIQUE KEY uq_wig_measure (wig_id, measure_type)
) ENGINE=InnoDB;

-- Monthly actuals snapshot (mirrors MetricTracking).
CREATE TABLE wig_metric_readings (
  id                BIGINT AUTO_INCREMENT PRIMARY KEY,
  wig_id            INT NOT NULL,
  measurement_date  DATE NOT NULL,
  lag_actual        DECIMAL(18,4) NULL,
  lead1_actual      DECIMAL(18,4) NULL,
  lead2_actual      DECIMAL(18,4) NULL,
  lead3_actual      DECIMAL(18,4) NULL,
  status            VARCHAR(30) NULL,               -- Active / Completed / Under Review, etc.
  created_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_readings_wig FOREIGN KEY (wig_id) REFERENCES wigs(id) ON DELETE CASCADE,
  UNIQUE KEY uq_wig_month (wig_id, measurement_date)
) ENGINE=InnoDB;

CREATE INDEX idx_readings_date ON wig_metric_readings(measurement_date);

-- One row per team per calendar week: was the Cadence of
-- Accountability session held.
CREATE TABLE cadence_sessions (
  id                  BIGINT AUTO_INCREMENT PRIMARY KEY,
  team_id             INT NOT NULL,
  session_date        DATE NOT NULL,
  held                TINYINT(1) NOT NULL DEFAULT 0,
  facilitator_user_id INT NULL,
  created_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_sessions_team FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE,
  CONSTRAINT fk_sessions_facilitator FOREIGN KEY (facilitator_user_id) REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE KEY uq_team_session_date (team_id, session_date)
) ENGINE=InnoDB;

CREATE INDEX idx_sessions_date ON cadence_sessions(session_date);

CREATE TABLE commitments (
  id                BIGINT AUTO_INCREMENT PRIMARY KEY,
  session_id        BIGINT NOT NULL,
  user_id           INT NOT NULL,
  commitment_text   VARCHAR(1000) NULL,
  wig_id            INT NULL,                      -- which WIG (usually a downline team's, for anyone spanning several teams) this commitment is in service of
  commitment_made   ENUM('yes','no','pto') NOT NULL DEFAULT 'yes',
  commitment_met    ENUM('yes','no','pending') NOT NULL DEFAULT 'pending',
  notes             VARCHAR(1000) NULL,
  created_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_commitments_session FOREIGN KEY (session_id) REFERENCES cadence_sessions(id) ON DELETE CASCADE,
  CONSTRAINT fk_commitments_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_commitments_wig FOREIGN KEY (wig_id) REFERENCES wigs(id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE INDEX idx_commitments_user ON commitments(user_id);
CREATE INDEX idx_commitments_session ON commitments(session_id);
CREATE INDEX idx_commitments_made_met ON commitments(commitment_made, commitment_met);

-- Org-wide health-score thresholds (mirrors the legacy Config tab),
-- editable from the admin UI.
CREATE TABLE org_config (
  config_key    VARCHAR(50) PRIMARY KEY,
  config_value  DECIMAL(6,4) NOT NULL
) ENGINE=InnoDB;

-- Precomputed weekly team health scores — a read-through/write-back cache
-- for closed weeks in the analytics history/heatmap routes (see
-- weeklyScoresForTeams in routes/analytics.js), kept warm by the nightly
-- rollup CronJob but populated on-demand on a cache miss either way.
CREATE TABLE team_week_scores (
  team_id      INT NOT NULL,
  week_start   DATE NOT NULL,
  score        INT NULL,
  commit_pct   DECIMAL(6,4) NULL,
  session_pct  DECIMAL(6,4) NULL,
  computed_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (team_id, week_start),
  CONSTRAINT fk_week_scores_team FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE
) ENGINE=InnoDB;

INSERT INTO org_config (config_key, config_value) VALUES
  ('commit_yellow', 0.80),
  ('commit_green',  0.90),
  ('session_yellow', 0.85),
  ('session_green',  0.95);

-- Lightweight audit trail for compliance / "who changed what".
CREATE TABLE audit_log (
  id           BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id      INT NULL,
  action       VARCHAR(100) NOT NULL,
  entity_type  VARCHAR(50) NOT NULL,
  entity_id    BIGINT NULL,
  detail       JSON NULL,
  created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_audit_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE INDEX idx_audit_entity ON audit_log(entity_type, entity_id);
CREATE INDEX idx_audit_created ON audit_log(created_at);

-- Generic per-user preference store (e.g. saved Org Analytics widget layout).
CREATE TABLE user_preferences (
  user_id     INT NOT NULL,
  pref_key    VARCHAR(50) NOT NULL,
  pref_value  JSON NOT NULL,
  updated_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, pref_key),
  CONSTRAINT fk_prefs_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- A leader's standing subscription to a periodic emailed/Teams-posted rollup
-- of the Org Analytics widgets they care about.
CREATE TABLE report_subscriptions (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  user_id        INT NOT NULL,
  frequency      ENUM('daily','weekly','monthly','quarterly') NOT NULL,
  widgets        JSON NOT NULL,
  channel_email  TINYINT(1) NOT NULL DEFAULT 1,
  channel_teams  TINYINT(1) NOT NULL DEFAULT 0,
  active         TINYINT(1) NOT NULL DEFAULT 1,
  created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_subs_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE INDEX idx_subs_user ON report_subscriptions(user_id);

SET FOREIGN_KEY_CHECKS = 1;

-- ------------------------------------------------------------
-- Reporting views used directly by the analytics layer (see
-- PRODUCTION_ARCHITECTURE.md, section "Analytics").
-- ------------------------------------------------------------

-- Rolling 4-week commitment attainment per user.
CREATE OR REPLACE VIEW v_individual_attainment_t4w AS
SELECT
  c.user_id,
  u.team_id,
  SUM(c.commitment_made = 'yes') AS made,
  SUM(c.commitment_made = 'yes' AND c.commitment_met = 'yes') AS met,
  CASE WHEN SUM(c.commitment_made = 'yes') > 0
       THEN SUM(c.commitment_made = 'yes' AND c.commitment_met = 'yes') / SUM(c.commitment_made = 'yes')
       ELSE NULL END AS attainment_pct
FROM commitments c
JOIN cadence_sessions s ON s.id = c.session_id
JOIN users u ON u.id = c.user_id
WHERE s.session_date >= DATE_SUB(CURDATE(), INTERVAL 28 DAY)
GROUP BY c.user_id, u.team_id;

-- Rolling 4-week team-level commitment + cadence attainment.
CREATE OR REPLACE VIEW v_team_attainment_t4w AS
SELECT
  t.id AS team_id,
  t.name AS team_name,
  SUM(c.commitment_made = 'yes') AS commitments_made,
  SUM(c.commitment_made = 'yes' AND c.commitment_met = 'yes') AS commitments_met,
  CASE WHEN SUM(c.commitment_made = 'yes') > 0
       THEN SUM(c.commitment_made = 'yes' AND c.commitment_met = 'yes') / SUM(c.commitment_made = 'yes')
       ELSE NULL END AS commitment_attainment_pct,
  COUNT(DISTINCT s.session_date) AS sessions_expected,
  COUNT(DISTINCT CASE WHEN s.held = 1 THEN s.session_date END) AS sessions_held,
  CASE WHEN COUNT(DISTINCT s.session_date) > 0
       THEN COUNT(DISTINCT CASE WHEN s.held = 1 THEN s.session_date END) / COUNT(DISTINCT s.session_date)
       ELSE NULL END AS session_attainment_pct
FROM teams t
LEFT JOIN cadence_sessions s ON s.team_id = t.id AND s.session_date >= DATE_SUB(CURDATE(), INTERVAL 28 DAY)
LEFT JOIN commitments c ON c.session_id = s.id
GROUP BY t.id, t.name;
