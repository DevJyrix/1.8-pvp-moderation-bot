const { ANTI_RAID_MAX, ANTI_RAID_LOCKOUT } = require('./config');

// staffId -> { count, windowStart, locked, lockExpires }
const banTracker = new Map();

/**
 * Call before executing a ban. Returns { allowed: bool, reason: string }.
 */
function checkRaid(staffId) {
  const now = Date.now();
  let entry = banTracker.get(staffId);

  if (!entry) {
    entry = { count: 0, windowStart: now, locked: false, lockExpires: null };
    banTracker.set(staffId, entry);
  }

  // Check if locked out
  if (entry.locked) {
    if (now < entry.lockExpires) {
      const remaining = Math.ceil((entry.lockExpires - now) / 60000);
      return { allowed: false, reason: `🔒 You are on anti-raid lockout for another **${remaining} minute(s)**. Contact a higher admin if this is a mistake.` };
    } else {
      // Lockout expired, reset
      entry.locked = false;
      entry.count = 0;
      entry.windowStart = now;
    }
  }

  // Reset window if > 60 seconds old
  if (now - entry.windowStart > 60000) {
    entry.count = 0;
    entry.windowStart = now;
  }

  entry.count++;

  if (entry.count > ANTI_RAID_MAX) {
    entry.locked = true;
    entry.lockExpires = now + ANTI_RAID_LOCKOUT * 60000;
    return { allowed: false, reason: `⚠️ Anti-raid triggered! You've issued **${entry.count} bans in under a minute**. You've been locked out for **${ANTI_RAID_LOCKOUT} minutes**. If this was legitimate, ask an admin to reset your lockout.` };
  }

  return { allowed: true, reason: null };
}

/**
 * Resets lockout for a staff member (admin use).
 */
function resetLockout(staffId) {
  banTracker.delete(staffId);
}

module.exports = { checkRaid, resetLockout };
