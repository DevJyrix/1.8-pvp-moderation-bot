const { EmbedBuilder } = require('discord.js');
const { getPlayerStats, getBanData, getAvatar, getUserRestriction, formatPlaytime } = require('./roblox');
const { isActiveBan } = require('./rules');

function accountAge(createdStr) {
  if (!createdStr) return 'Unknown';
  const created = new Date(createdStr);
  const days    = Math.floor((Date.now() - created) / 86400000);
  const dateStr = created.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  return `${days} days (${dateStr})`;
}

function winRate(wins, losses) {
  const total = (wins || 0) + (losses || 0);
  if (!total) return 'N/A';
  return `${((wins / total) * 100).toFixed(1)}%`;
}

function progressBar(current, max) {
  if (current == null || !max) return null;
  const pct    = Math.min(current / max, 1);
  const filled = Math.round(pct * 14);
  return `\`${'█'.repeat(filled)}${'░'.repeat(14 - filled)}\`  ${current.toLocaleString()} / ${max.toLocaleString()}  (${Math.round(pct * 100)}%)`;
}

function val(v) {
  if (v === undefined || v === null) return 'N/A';
  return typeof v === 'number' ? v.toLocaleString() : String(v);
}

async function buildStatsEmbed(robloxUser, requestedBy) {
  const [stats, banData, avatarUrl, restriction] = await Promise.all([
    getPlayerStats(robloxUser.id).catch(() => null),
    getBanData(robloxUser.id).catch(() => ({ active: null, history: [] })),
    getAvatar(robloxUser.id).catch(() => null),
    getUserRestriction(robloxUser.id).catch(() => null),
  ]);

  const platformBan  = restriction?.gameJoinRestriction?.active ? restriction.gameJoinRestriction : null;
  const active       = banData?.active && isActiveBan(banData.active) ? banData.active : null;
  const validHistory = (banData?.history || []).filter(b => !b._hidden);
  const isBanned     = !!(platformBan || active);
  const color        = isBanned ? 0xED4245 : validHistory.length > 0 ? 0xFEE75C : 0x57F287;

  const isDiff    = robloxUser.displayName && robloxUser.displayName !== robloxUser.name;
  const titleText = isDiff ? `${robloxUser.displayName} (${robloxUser.name})` : robloxUser.name;

  const embed = new EmbedBuilder()
    .setColor(color)
    .setAuthor({ name: '1.8 Arena  —  Player Profile', iconURL: avatarUrl || undefined })
    .setTitle(titleText)
    .setURL(`https://www.roblox.com/users/${robloxUser.id}/profile`)
    .setThumbnail(avatarUrl);

  // Identity
  embed.addFields(
    { name: 'Username',    value: `[${robloxUser.name}](https://www.roblox.com/users/${robloxUser.id}/profile)`, inline: true },
    { name: 'User ID',     value: `\`${robloxUser.id}\``, inline: true },
    { name: 'Account Age', value: accountAge(robloxUser.created), inline: false },
  );

  // Stats (ProfileStore fields: Coins, Level, Experience, Wins, Rank)
  const rank  = stats?.rank  ?? null;
  const level = stats?.level ?? null;
  const coins = stats?.coins ?? null;
  const wins  = stats?.wins  ?? null;
  const exp   = stats?.experience ?? stats?.progress ?? null;
  const maxExp = stats?.maxProgress ?? null;
  const lifetimeKills  = stats?.lifetimeKills ?? null;
  const bestStreak     = stats?.highestKillstreak ?? null;
  const winstreak      = stats?.winstreak ?? null;
  const bestWinstreak  = stats?.bestWinstreak ?? null;
  const bar = exp != null && maxExp != null ? progressBar(exp, maxExp) : null;

  const statFields = [];
  if (rank  != null) statFields.push({ name: 'Rank',          value: `${rank}`,   inline: true });
  if (level != null) statFields.push({ name: 'Level',         value: `${level}`,  inline: true });
  if (coins != null) statFields.push({ name: 'Coins',         value: val(coins),  inline: true });
  if (wins           != null) statFields.push({ name: 'Wins',           value: val(wins),          inline: true });
  if (winstreak      != null) statFields.push({ name: 'Win Streak',     value: val(winstreak),     inline: true });
  if (bestWinstreak  != null) statFields.push({ name: 'Best Win Streak', value: val(bestWinstreak), inline: true });
  if (lifetimeKills  != null) statFields.push({ name: 'Lifetime Kills', value: val(lifetimeKills), inline: true });
  if (bestStreak     != null) statFields.push({ name: 'Best Kill Streak', value: val(bestStreak),  inline: true });
  if (stats?.playtime != null) statFields.push({ name: 'Playtime', value: formatPlaytime(stats.playtime), inline: true });

  if (statFields.length) {
    embed.addFields({ name: 'Stats', value: '\u200B', inline: false }, ...statFields);
  }
  if (bar) embed.addFields({ name: 'Experience', value: bar, inline: false });



  // Moderation
  let banStatus;
  if (platformBan) {
    let expires = 'Permanent';
    if (platformBan.duration) {
      const durSecs = parseInt(platformBan.duration);
      const startMs = platformBan.startTime ? new Date(platformBan.startTime).getTime() : Date.now();
      const expTs   = Math.floor((startMs + durSecs * 1000) / 1000);
      expires = `<t:${expTs}:R>`;
    }
    banStatus = `Banned (Platform) — Expires ${expires}`;
    if (platformBan.displayReason) banStatus += `\nReason: ${platformBan.displayReason}`;
  } else if (active) {
    const tsExp   = active.permanent ? null : Math.floor(new Date(active.expires).getTime() / 1000);
    const expires = active.permanent ? 'Permanent' : `<t:${tsExp}:R>`;
    banStatus = `Banned — Rule ${active.rule} — Expires ${expires}\nIssued by: ${active.bannedBy}`;
  } else {
    banStatus = validHistory.length > 0
      ? `Not banned — ${validHistory.length} prior ban(s) on record`
      : 'Clean record';
  }
  embed.addFields(
    { name: 'Moderation', value: '\u200B', inline: false },
    { name: 'Status', value: banStatus, inline: false },
  );

  if (validHistory.length > 0) {
    const lines = validHistory.slice(-5).reverse().map((b, i) => {
      const ts  = Math.floor(new Date(b.bannedAt).getTime() / 1000);
      const dur = b.permanent ? 'Permanent' : b.duration;
      const app = b.appealedBy ? ` — Appealed by ${b.appealedBy}` : '';
      return `${i + 1}. Rule ${b.rule} — ${dur} — <t:${ts}:d>${app}`;
    });
    embed.addFields({ name: `Ban History (${validHistory.length} total)`, value: lines.join('\n'), inline: false });
  }

  if (requestedBy) {
    embed.setFooter({ text: `Requested by ${requestedBy.tag}`, iconURL: requestedBy.displayAvatarURL() });
  }
  embed.setTimestamp();

  return { embed, banData, active, isBanned, robloxUser };
}

module.exports = { buildStatsEmbed };
