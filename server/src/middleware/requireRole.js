'use strict';

// Org hierarchy, lowest to highest. Every role except `ic` (Individual
// Contributor) gets full org-wide admin access — any team's WIGs, the full
// user roster, thresholds, audit log, exports/subscriptions. The ranking
// still matters for the reporting chain (users.manager_id) and for
// requireRole's minimum-rank checks, but there is no team-scoped tier above
// `ic` — see canManageTeam below.
const RANK = { ic: 0, manager: 1, director: 2, vp: 3, svp: 4, exec: 5 };

/** requireRole('manager') passes for manager and anyone above (rank-based, not exact match) */
function requireRole(minRole) {
  return (req, res, next) => {
    const userRank = RANK[req.user?.role] ?? -1;
    const minRank = RANK[minRole] ?? 99;
    if (userRank < minRank) return res.status(403).json({ error: 'Insufficient role' });
    next();
  };
}

/** Allows if the caller is acting on their own user id, OR has at least minRole */
function selfOrRole(minRole, paramName = 'userId') {
  return (req, res, next) => {
    const targetId = Number(req.params[paramName]);
    if (req.user?.id === targetId) return next();
    return requireRole(minRole)(req, res, next);
  };
}

/** True if `user` may manage any team's WIGs/sessions/roster — anyone above `ic`, org-wide. */
function canManageTeam(user) {
  return (RANK[user?.role] ?? -1) >= RANK.manager;
}

/** True if `actingUser` may view `targetUserId`'s data: themself, or anyone above `ic`. */
function canViewUser(actingUser, targetUserId) {
  if (actingUser?.id === targetUserId) return true;
  return canManageTeam(actingUser);
}

module.exports = { RANK, requireRole, selfOrRole, canManageTeam, canViewUser };
