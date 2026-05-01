const axios = require('axios');
const { ROBLOX_API_KEY, UNIVERSE_ID, DS_STATS, DS_BANS, PROFILESTORE_NAME, PROFILESTORE_KEY_PREFIX } = require('./config');

// ── User lookup ────────────────────────────────────────────────────────────────

async function getUserByName(username) {
  const res = await axios.post('https://users.roblox.com/v1/usernames/users', {
    usernames: [username], excludeBannedUsers: false,
  });
  return res.data.data[0] || null;
}

async function getUserById(userId) {
  const res = await axios.get(`https://users.roblox.com/v1/users/${userId}`);
  return res.data;
}

async function getAvatar(userId) {
  try {
    const res = await axios.get(
      `https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${userId}&size=150x150&format=Png&isCircular=false`
    );
    return res.data.data[0]?.imageUrl || null;
  } catch { return null; }
}

// ── Open Cloud DataStore v1 ────────────────────────────────────────────────────

async function dsGet(datastoreName, key) {
  if (!ROBLOX_API_KEY || !UNIVERSE_ID) { console.warn('[DS] No API key/Universe ID'); return null; }
  try {
    const res = await axios.get(
      `https://apis.roblox.com/datastores/v1/universes/${UNIVERSE_ID}/standard-datastores/datastore/entries/entry`,
      { params: { datastoreName, entryKey: key }, headers: { 'x-api-key': ROBLOX_API_KEY }, responseType: 'text' }
    );
    let value = res.data;
    for (let i = 0; i < 3; i++) {
      if (typeof value !== 'string') break;
      const t = value.trim();
      if (t.startsWith('{') || t.startsWith('[') || t.startsWith('"')) {
        try { value = JSON.parse(t); } catch { break; }
      } else break;
    }
    return value;
  } catch (e) {
    if (e.response?.status === 404) return null;
    console.error(`[DS] GET ${datastoreName}/${key} →`, e.response?.status, e.response?.data ?? e.message);
    throw e;
  }
}

async function dsSet(datastoreName, key, value) {
  if (!ROBLOX_API_KEY || !UNIVERSE_ID) { console.warn('[DS] No API key/Universe ID'); return null; }
  try {
    const body = JSON.stringify(value);
    const res  = await axios.post(
      `https://apis.roblox.com/datastores/v1/universes/${UNIVERSE_ID}/standard-datastores/datastore/entries/entry`,
      body,
      { params: { datastoreName, entryKey: key }, headers: { 'x-api-key': ROBLOX_API_KEY, 'content-type': 'application/json' } }
    );
    console.log(`[DS] SET ${datastoreName}/${key} → ${res.status}`);
    return res.data;
  } catch (e) {
    const status = e.response?.status;
    const detail = e.response?.data ?? e.message;
    console.error(`[DS] SET ${datastoreName}/${key} → ${status}`, JSON.stringify(detail));
    if (status === 403) throw new Error(`DataStore write blocked (403) for "${datastoreName}". Check API key permissions at create.roblox.com/credentials.`);
    if (status === 404) throw new Error(`DataStore "${datastoreName}" not found (404). Run /setstats in the Studio emulator first to create it.`);
    throw e;
  }
}

// ── ProfileStore support ───────────────────────────────────────────────────────
//
// ProfileStore stores data in the DataStore you passed to ProfileStore.New().
// The key format is typically "Player_{userId}" but may vary.
//
// ProfileStore wraps Profile.Data in an outer structure:
// {
//   Data: { ... your game data ... },
//   MetaData: { ProfileCreateTime, SessionLoadCount, ActiveSession, ... },
//   UserIds: [userId],
//   RobloxMetaData: {}
// }
//
// So to read game stats, we read the DataStore and access .Data on the result.

async function getPlayerStats(userId) {
  const profileKey = `${PROFILESTORE_KEY_PREFIX}${userId}`;

  let raw = null;
  try {
    raw = await dsGet(PROFILESTORE_NAME, profileKey);
  } catch (e) {
    console.warn(`[DS] ProfileStore read failed for ${userId}:`, e.message);
  }

  // Fallback to legacy flat DataStore
  if (!raw) {
    try { raw = await dsGet(DS_STATS, String(userId)); } catch {}
  }

  if (!raw || typeof raw !== 'object') return null;

  // ProfileStore wraps data as { Data: {...}, MetaData: {...} }
  const data = (raw.Data && typeof raw.Data === 'object') ? raw.Data : raw;

  // Normalise field names from the game's storage format to what the bot expects.
  // The game stores:  Coins, Level, Experience, Wins, Rank, Stats.LifetimeKills, Stats.BestStreak
  // The bot expects:  coins, level, experience, wins, rank, lifetimeKills, highestKillstreak
  return normaliseStats(data);
}

function normaliseStats(d) {
  if (!d) return null;
  const n = {};

  // Top-level fields — handle both capitalised (game) and lowercase (legacy) keys
  n.coins            = d.Coins            ?? d.coins            ?? null;
  n.level            = d.Level            ?? d.level            ?? null;
  n.experience       = d.Experience       ?? d.experience       ?? null;
  n.wins             = d.Wins             ?? d.wins             ?? null;
  n.rank             = d.Rank             ?? d.rank             ?? d.rankName ?? null;

  // Stats sub-table (ProfileStore stores some values nested)
  const s            = d.Stats            ?? d.stats            ?? d;
  n.lifetimeKills    = s.LifetimeKills    ?? s.lifetimeKills    ?? d.lifetimeKills    ?? null;
  n.highestKillstreak= s.BestStreak       ?? s.bestStreak       ?? s.highestKillstreak ?? d.highestKillstreak ?? null;
  n.killstreak       = s.Killstreak       ?? s.killstreak       ?? d.killstreak       ?? null;
  n.losses           = s.Losses           ?? s.losses           ?? d.losses           ?? null;
  n.playtime         = s.Playtime         ?? s.playtime         ?? d.playtime         ?? null;
  n.clicksPerSecond  = s.CPS              ?? s.clicksPerSecond  ?? d.clicksPerSecond  ?? null;

  // Progress / XP — experience doubles as progress bar source
  n.progress  = d.Experience ?? d.experience ?? d.progress ?? d.xp ?? null;
  n.maxProgress = d.MaxExperience ?? d.maxExperience ?? d.maxProgress ?? d.maxXP ?? null;

  return n;
}

async function savePlayerStats(userId, stats) {
  const profileKey = `${PROFILESTORE_KEY_PREFIX}${userId}`;
  // Try to read existing ProfileStore record so we preserve MetaData
  let existing = null;
  try { existing = await dsGet(PROFILESTORE_NAME, profileKey); } catch {}

  if (existing && existing.MetaData) {
    // ProfileStore format — update only the Data field
    existing.Data = stats;
    return dsSet(PROFILESTORE_NAME, profileKey, existing);
  }
  // Fallback: write as flat object to legacy DataStore
  return dsSet(DS_STATS, String(userId), stats);
}

async function getBanData(userId) {
  const data = await dsGet(DS_BANS, String(userId));
  return data || { active: null, history: [] };
}

async function saveBanData(userId, banData) {
  return dsSet(DS_BANS, String(userId), banData);
}

// ── Messaging Service ──────────────────────────────────────────────────────────

async function publishMessage(topic, data) {
  if (!ROBLOX_API_KEY || !UNIVERSE_ID) return;
  try {
    const payload = JSON.stringify(data);
    if (Buffer.byteLength(payload) > 1000) { console.warn('[MSG] Payload too large'); return; }
    const res = await axios.post(
      `https://apis.roblox.com/messaging-service/v1/universes/${UNIVERSE_ID}/topics/${encodeURIComponent(topic)}`,
      { message: payload },
      { headers: { 'x-api-key': ROBLOX_API_KEY, 'content-type': 'application/json' } }
    );
    console.log(`[MSG] Published to "${topic}" → ${res.status}`);
  } catch (e) {
    const status = e.response?.status;
    if (status === 403) console.warn('[MSG] 403 — add universe-messaging-service:publish to API key');
    else if (status === 404) console.warn('[MSG] 404 — game must be published for MessagingService to work');
    else console.warn(`[MSG] Publish failed (${status}):`, e.response?.data ?? e.message);
  }
}

// ── Formatters ─────────────────────────────────────────────────────────────────

function formatPlaytime(seconds) {
  if (!seconds || seconds < 0) return 'N/A';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

module.exports = {
  getUserByName, getUserById, getAvatar,
  getPlayerStats, savePlayerStats, getBanData, saveBanData,
  formatPlaytime, dsSet, publishMessage,
};
