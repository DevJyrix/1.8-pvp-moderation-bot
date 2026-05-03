require('dotenv').config();

const ROLES = {
  GAME_STAFF:    { id: process.env.GAME_STAFF_ROLE_ID,    level: 1 },
  DISCORD_STAFF: { id: process.env.DISCORD_STAFF_ROLE_ID, level: 2 },
  SENIOR_STAFF:  { id: process.env.SENIOR_STAFF_ROLE_ID,  level: 3 },
  ADMIN:         { id: process.env.ADMIN_ROLE_ID,          level: 4 },
};

function getMemberLevel(member) {
  let highest = 0;
  for (const role of Object.values(ROLES)) {
    if (role.id && member.roles.cache.has(role.id)) {
      if (role.level > highest) highest = role.level;
    }
  }
  return highest;
}
function getRoleName(level) {
  return ['', 'Game Staff', 'Discord Staff', 'Senior Staff', 'Admin'][level] || 'Unknown';
}
function canUseGameCommands(member)    { const l = getMemberLevel(member); return l === 1 || l >= 3; }
function canUseDiscordCommands(member) { const l = getMemberLevel(member); return l === 2 || l >= 3; }
function isStaff(member)  { return getMemberLevel(member) >= 1; }
function isAdmin(member)  { return getMemberLevel(member) >= 4; }
function isSenior(member) { return getMemberLevel(member) >= 3; }
function canAction(actor, target) { return getMemberLevel(actor) > getMemberLevel(target); }
function allStaffRoleIds() { return Object.values(ROLES).map(r => r.id).filter(Boolean); }

module.exports = {
  DISCORD_TOKEN:              process.env.DISCORD_TOKEN,
  TICKET_CHANNEL_ID:          process.env.TICKET_CHANNEL_ID,
  // Per-type ticket channel IDs (each type has its own channel with a button)
  GAME_REPORT_CHANNEL_ID:     process.env.GAME_REPORT_CHANNEL_ID     || null,
  DISCORD_REPORT_CHANNEL_ID:  process.env.DISCORD_REPORT_CHANNEL_ID  || null,
  APPEAL_CHANNEL_ID:          process.env.APPEAL_CHANNEL_ID          || null,
  OTHER_TICKET_CHANNEL_ID:    process.env.OTHER_TICKET_CHANNEL_ID    || null,
  INFO_CHANNEL_ID:            process.env.INFO_CHANNEL_ID            || null,
  // Content creator requirements
  CC_YT_MIN_SUBS:             parseInt(process.env.CC_YT_MIN_SUBS    || '1000'),
  CC_TT_MIN_SUBS:             parseInt(process.env.CC_TT_MIN_SUBS    || '5000'),
  TICKET_CATEGORY_ID:         process.env.TICKET_CATEGORY_ID,
  SENIOR_TICKET_CATEGORY_ID:  process.env.SENIOR_TICKET_CATEGORY_ID || null,
  ADMIN_TICKET_CATEGORY_ID:   process.env.ADMIN_TICKET_CATEGORY_ID  || null,
  // Ticket transcripts / general log
  LOG_CHANNEL_ID:             process.env.LOG_CHANNEL_ID,
  // Separate ticket logs per type
  GR_LOG_CHANNEL_ID:          '1499484872144588842',
  DR_LOG_CHANNEL_ID:          '1499678254884323469',
  APPEAL_LOG_CHANNEL_ID:      '1500529036466589696',
  CC_LOG_CHANNEL_ID:          '1499677788905672704',
  ART_LOG_CHANNEL_ID:         '1499754325558427760',
  // Game mod actions (gban, ungban, gkick)
  GAME_LOG_CHANNEL_ID:        process.env.GAME_LOG_CHANNEL_ID  || process.env.MOD_LOG_CHANNEL_ID,
  // Discord mod actions (ban, unban, mute, kick)
  DISCORD_LOG_CHANNEL_ID:     process.env.DISCORD_LOG_CHANNEL_ID || process.env.MOD_LOG_CHANNEL_ID,
  // Fallback for anything else
  MOD_LOG_CHANNEL_ID:         process.env.MOD_LOG_CHANNEL_ID,
  STATS_LOG_CHANNEL_ID:       process.env.STATS_LOG_CHANNEL_ID || process.env.MOD_LOG_CHANNEL_ID,
  // Staff duty role — pinged on new tickets
  STAFF_DUTY_ROLE_ID:         process.env.STAFF_DUTY_ROLE_ID || null,
  // Roblox
  ROBLOX_API_KEY:             process.env.ROBLOX_API_KEY,
  UNIVERSE_ID:                process.env.ROBLOX_UNIVERSE_ID,
  DS_STATS:                   process.env.DATASTORE_STATS    || 'PlayerStats',
  DS_BANS:                    process.env.DATASTORE_BANS     || 'PlayerBans',
  // ProfileStore
  PROFILESTORE_NAME:          process.env.PROFILESTORE_NAME       || 'PlayerStore',
  PROFILESTORE_KEY_PREFIX:    process.env.PROFILESTORE_KEY_PREFIX ?? '',
  // YouTube API (for CC applications)
  YOUTUBE_API_KEY:            process.env.YOUTUBE_API_KEY || null,
  CC_VIDEO_MIN_VIEWS:         parseInt(process.env.CC_VIDEO_MIN_VIEWS || '10000'),
  // Anti-raid
  ANTI_RAID_MAX:    parseInt(process.env.ANTI_RAID_MAX_BANS_PER_MINUTE || '3'),
  ANTI_RAID_LOCKOUT: parseInt(process.env.ANTI_RAID_LOCKOUT_MINUTES    || '10'),
  ROLES,
  getMemberLevel, getRoleName, canUseGameCommands, canUseDiscordCommands,
  isStaff, isAdmin, isSenior, canAction, allStaffRoleIds,
};
