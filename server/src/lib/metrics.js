'use strict';
/**
 * Shared scoring logic — the single source of truth for health scores,
 * so the API, the analytics service, and any batch job compute the
 * exact same numbers. Pure functions, no DB access, easy to unit test.
 */

function band(value, yellowCut, greenCut) {
  if (value === null || value === undefined) return { color: 'gray', label: 'No data' };
  if (value >= greenCut) return { color: 'green', label: 'Green' };
  if (value >= yellowCut) return { color: 'yellow', label: 'Yellow' };
  return { color: 'red', label: 'Red' };
}

/**
 * commitmentRows: [{ commitment_made: 'yes'|'no'|'pto', commitment_met: 'yes'|'no'|'pending' }]
 */
function commitmentAttainment(commitmentRows) {
  const made = commitmentRows.filter((c) => c.commitment_made === 'yes');
  if (made.length === 0) return null;
  const met = made.filter((c) => c.commitment_met === 'yes');
  return met.length / made.length;
}

/**
 * sessionRows: [{ held: 0|1 }] — one row per expected session in the window
 */
function sessionAttainment(sessionRows) {
  if (sessionRows.length === 0) return null;
  const held = sessionRows.filter((s) => s.held).length;
  return held / sessionRows.length;
}

function wigProgressRatio(targetValue, actualValue) {
  const target = Number(targetValue);
  const actual = Number(actualValue);
  if (!target || Number.isNaN(actual)) return null;
  return Math.max(0, Math.min(1.25, actual / target)) / 1.25;
}

/**
 * Composite 0-100 health score for a single leaf team.
 * config: { commit_yellow, commit_green, session_yellow, session_green }
 */
function healthScore({ commitPct, sessionPct, wigProgress, config }) {
  const parts = [];
  if (commitPct !== null && commitPct !== undefined) {
    parts.push([Math.min(1, commitPct / config.commit_green), 0.4]);
  }
  if (sessionPct !== null && sessionPct !== undefined) {
    parts.push([Math.min(1, sessionPct / config.session_green), 0.3]);
  }
  if (wigProgress !== null && wigProgress !== undefined) {
    parts.push([wigProgress, 0.3]);
  }
  const totalWeight = parts.reduce((a, [, w]) => a + w, 0);
  if (totalWeight === 0) return null;
  const raw = parts.reduce((a, [v, w]) => a + v * w, 0) / totalWeight;
  return Math.round(raw * 100);
}

function scoreBand(score) {
  if (score === null || score === undefined) return { color: 'gray', label: 'No data' };
  if (score >= 90) return { color: 'green', label: 'On track' };
  if (score >= 70) return { color: 'yellow', label: 'At risk' };
  return { color: 'red', label: 'Off track' };
}

/**
 * Average child scores for a parent rollup. Returns { score, min, max, count }
 * so callers can show spread, not just the average (see analytics doc).
 */
function rollupFromChildScores(childScores) {
  const valid = childScores.filter((s) => s !== null && s !== undefined);
  if (valid.length === 0) return { score: null, min: null, max: null, count: 0 };
  return {
    score: Math.round(valid.reduce((a, b) => a + b, 0) / valid.length),
    min: Math.min(...valid),
    max: Math.max(...valid),
    count: valid.length,
  };
}

module.exports = {
  band,
  commitmentAttainment,
  sessionAttainment,
  wigProgressRatio,
  healthScore,
  scoreBand,
  rollupFromChildScores,
};
