// ─── Offense Rules ────────────────────────────────────────────────────────────
const RULES = {
  A1: { category: 'Minor',    name: 'Autoclicker',          color: 0xF5C400, bans: [1, 3, 7, 30],   perm: false },
  A2: { category: 'Minor',    name: 'Toxicity',             color: 0xF5C400, bans: [1, 3, 7, 30],   perm: false },
  B1: { category: 'Moderate', name: 'Stat Farming',         color: 0xFF8C00, bans: [7, 30, -1],     perm: true  },
  B2: { category: 'Moderate', name: 'Repeated Glitch Abuse',color: 0xFF8C00, bans: [7, 30, -1],     perm: true  },
  B3: { category: 'Moderate', name: 'Ban Evasion',          color: 0xFF8C00, bans: [7, 30, -1],     perm: true  },
  C1: { category: 'Severe',   name: 'Exploiting',           color: 0xFF2020, bans: [-1],            perm: true  },
  C2: { category: 'Severe',   name: 'Major Bug Abuse',      color: 0xFF2020, bans: [-1],            perm: true  },
};

const CATEGORY_EMOJI = { Minor: '🟡', Moderate: '🟠', Severe: '🔴' };

/**
 * Returns { label, days } based on prior ban count (auto-escalates).
 */
function getBanDuration(ruleCode, priorBanCount) {
  const rule = RULES[ruleCode];
  if (!rule) return { label: 'Unknown', days: 1 };
  const idx = Math.min(priorBanCount, rule.bans.length - 1);
  const days = rule.bans[idx];
  const label = days === -1 ? 'Permanent Ban' : `${days} Day${days === 1 ? '' : 's'}`;
  return { label, days };
}

function banExpiry(days) {
  if (days === -1) return null;
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString();
}

function isActiveBan(banEntry) {
  if (!banEntry) return false;
  if (banEntry.permanent) return true;
  if (!banEntry.expires) return false;
  return new Date(banEntry.expires) > new Date();
}

module.exports = { RULES, CATEGORY_EMOJI, getBanDuration, banExpiry, isActiveBan };
