const fs   = require('fs');
const path = require('path');
const { EmbedBuilder } = require('discord.js');
const { RULES } = require('./rules');
const roblox = require('./roblox');

const DATA_DIR = path.join(__dirname, 'data', 'infractions');
fs.mkdirSync(DATA_DIR, { recursive: true });

function recordPath(id) { return path.join(DATA_DIR, `${id}.json`); }

function loadRecord(id) {
  try { return JSON.parse(fs.readFileSync(recordPath(id), 'utf8')); }
  catch { return { id, infractions: [] }; }
}
function saveRecord(record) {
  fs.writeFileSync(recordPath(record.id), JSON.stringify(record, null, 2));
}

function addInfraction(id, entry) {
  const record = loadRecord(id);
  record.infractions.push({ ...entry, timestamp: new Date().toISOString() });
  saveRecord(record);
}

function removeInfraction(id, oneBasedIndex) {
  const record = loadRecord(id);
  const list   = record.infractions || [];
  const idx    = oneBasedIndex - 1;
  if (idx < 0 || idx >= list.length) return null;
  const [removed] = list.splice(idx, 1);
  record.infractions = list;
  saveRecord(record);
  return removed;
}

function clearWarnsAndNotes(id) {
  const record = loadRecord(id);
  const before = record.infractions.length;
  record.infractions = record.infractions.filter(i => i.action !== 'WARN' && i.action !== 'NOTE');
  saveRecord(record);
  return before - record.infractions.length;
}

// Clean text labels — no coloured emoji blobs
const ACTION_LABELS = {
  BAN:    'Discord Ban',
  UNBAN:  'Discord Unban',
  GBAN:   'Game Ban',
  UNGBAN: 'Game Unban',
  KICK:   'Kick',
  MUTE:   'Timeout',
  UNMUTE: 'Timeout Removed',
  WARN:   'Warning',
  NOTE:   'Staff Note',
};

/**
 * Extract the Roblox username from a Discord guild member's nickname.
 * RoVer sets nicknames as either:
 *   "RobloxUsername"          — plain username
 *   "RobloxUsername (Display)"  — with display name appended
 * We take everything before the first space or parenthesis.
 */
function nicknameToRobloxUsername(nickname) {
  if (!nickname) return null;
  // Strip any trailing " (DisplayName)" that RoVer sometimes adds
  const cleaned = nickname.split(/[\s(]/)[0].trim();
  // Must look like a Roblox username (letters, numbers, underscores, 3-20 chars)
  if (/^[A-Za-z0-9_]{3,20}$/.test(cleaned)) return cleaned;
  return null;
}

/**
 * @param {string}       discordUserId
 * @param {string|null}  robloxUsernameOrId  — explicit override; if null, auto-detect from nickname
 * @param {Client}       client
 * @param {GuildMember|null} guildMember     — pass to enable nickname auto-detection
 */
async function buildFullInfractionEmbed(discordUserId, robloxUsernameOrId, client, guildMember) {
  const discordRecord = loadRecord(discordUserId);
  const discordInf    = discordRecord.infractions || [];

  // ── Auto-detect Roblox username from RoVer nickname if not supplied ──────────
  let resolvedRobloxArg = robloxUsernameOrId;
  if (!resolvedRobloxArg && guildMember) {
    const fromNick = nicknameToRobloxUsername(guildMember.nickname);
    if (fromNick) {
      resolvedRobloxArg = fromNick;
      console.log(`[infractions] Auto-detected Roblox username from nickname: "${fromNick}"`);
    }
  }

  let robloxUser  = null;
  let banData     = null;
  let gameHistory = [];

  if (resolvedRobloxArg) {
    try {
      robloxUser = /^\d+$/.test(resolvedRobloxArg)
        ? await roblox.getUserById(resolvedRobloxArg)
        : await roblox.getUserById((await roblox.getUserByName(resolvedRobloxArg))?.id);
      if (robloxUser) {
        banData     = await roblox.getBanData(robloxUser.id);
        gameHistory = (banData?.history || []).filter(b => !b._hidden);
      }
    } catch (e) {
      console.warn('[infractions] Roblox lookup failed:', e.message);
    }
  }

  let discordTag = `<@${discordUserId}>`;
  try { const u = await client.users.fetch(discordUserId); discordTag = u.tag; } catch {}

  const totalCount = discordInf.length + gameHistory.length;
  const color = totalCount === 0 ? 0x57F287 : totalCount < 4 ? 0xFEE75C : 0xED4245;

  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle('Infraction History')
    .setTimestamp();

  if (robloxUser) {
    const avatar = await roblox.getAvatar(robloxUser.id).catch(() => null);
    if (avatar) embed.setThumbnail(avatar);
    embed.setURL(`https://www.roblox.com/users/${robloxUser.id}/profile`);
  }

  // Show how Roblox was resolved so staff know what happened
  const robloxValue = robloxUser
    ? `[${robloxUser.name}](https://www.roblox.com/users/${robloxUser.id}/profile)${!robloxUsernameOrId ? ' *(via nickname)*' : ''}`
    : resolvedRobloxArg
      ? `\`${resolvedRobloxArg}\` *(not found)*`
      : '*Not linked — provide username manually*';

  embed.addFields(
    { name: 'Discord',  value: `${discordTag} (\`${discordUserId}\`)`, inline: true },
    { name: 'Roblox',   value: robloxValue,                             inline: true },
    { name: 'Total',    value: `${totalCount}`,                         inline: true },
  );

  // ── Discord actions ──────────────────────────────────────────────────────────
  if (discordInf.length === 0) {
    embed.addFields({ name: 'Discord Actions', value: 'No infractions on record.' });
  } else {
    const recent = discordInf.slice(-10);
    const lines  = recent.map((inf, i) => {
      const globalIdx = discordInf.length > 10 ? discordInf.length - 10 + i + 1 : i + 1;
      const ts     = Math.floor(new Date(inf.timestamp).getTime() / 1000);
      const label  = ACTION_LABELS[inf.action] || inf.action;
      const dur    = inf.duration ? ` (${inf.duration})` : '';
      const reason = inf.reason ? `\n  ↳ ${inf.reason.slice(0, 80)}` : '';
      return `\`#${globalIdx}\` **${label}**${dur} by \`${inf.staff}\` — <t:${ts}:d>${reason}`;
    }).reverse();
    embed.addFields({
      name:  `Discord Actions (${discordInf.length})`,
      value: lines.join('\n') + `\n*Use \`/removewarn\` with the index number to remove an entry*`,
    });
  }

  // ── Game bans ────────────────────────────────────────────────────────────────
  if (!resolvedRobloxArg) {
    embed.addFields({ name: 'Game Bans', value: 'No Roblox account linked. Provide a username or the nickname will be used automatically.' });
  } else if (gameHistory.length === 0) {
    embed.addFields({ name: 'Game Bans', value: 'No game bans on record.' });
  } else {
    const lines = gameHistory.slice(-8).reverse().map((b, i) => {
      const ts  = Math.floor(new Date(b.bannedAt).getTime() / 1000);
      const dur = b.permanent ? 'Permanent' : b.duration;
      const app = b.appealedBy ? ` — Appealed by \`${b.appealedBy}\`` : '';
      const ruleName = RULES[b.rule]?.name;
      const ruleLabel = ruleName ? `${b.rule} (${ruleName})` : b.rule;
      return `${i + 1}. ${ruleLabel} — ${dur} — \`${b.bannedBy || '?'}\` — <t:${ts}:d>${app}`;
    });
    embed.addFields({ name: `Game Bans (${gameHistory.length})`, value: lines.join('\n') });

    if (banData?.active) {
      const a   = banData.active;
      const exp = a.permanent ? 'Permanent' : `<t:${Math.floor(new Date(a.expires).getTime() / 1000)}:R>`;
      embed.addFields({ name: 'Active Game Ban', value: `Rule ${a.rule} — ${exp}\n${a.reason || ''}` });
    }
  }

  embed.setFooter({ text: `User ID: ${discordUserId}` });
  return embed;
}

module.exports = { addInfraction, removeInfraction, clearWarnsAndNotes, buildFullInfractionEmbed, loadRecord };
