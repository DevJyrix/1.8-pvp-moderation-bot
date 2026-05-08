const axios = require('axios');
const { EmbedBuilder } = require('discord.js');
const { GAME_LOG_CHANNEL_ID, DISCORD_LOG_CHANNEL_ID, MOD_LOG_CHANNEL_ID } = require('./config');
const { RULES } = require('./rules');

const ACTION_COLORS = {
  BAN: 0xED4245, GBAN: 0xED4245, UNBAN: 0x57F287, UNGBAN: 0x57F287,
  KICK: 0xFEE75C, GKICK: 0xFEE75C, MUTE: 0xEB459E, UNMUTE: 0x57F287,
  WARN: 0xFEE75C, NOTE: 0x5865F2,
};
const ACTION_LABELS = {
  BAN: 'Discord Ban', GBAN: 'Game Ban', UNBAN: 'Discord Unban', UNGBAN: 'Game Unban',
  KICK: 'Discord Kick', GKICK: 'Game Kick', MUTE: 'Timeout', UNMUTE: 'Timeout Removed',
  WARN: 'Formal Warning', NOTE: 'Staff Note',
};
// Which log channel each action type goes to
const ACTION_CHANNEL = {
  BAN:   'discord', UNBAN:  'discord', KICK:  'discord',
  MUTE:  'discord', UNMUTE: 'discord',
  GBAN:  'game',    UNGBAN: 'game',    GKICK: 'game',
  WARN:  'mod',     NOTE:   'mod',
};

async function logAction(client, { action, target, staff, rule, duration, reason, permanent, extra }) {
  const r     = rule ? RULES[rule] : null;
  const color = ACTION_COLORS[action] || 0x5865F2;
  const label = ACTION_LABELS[action] || action;

  const embed = new EmbedBuilder().setColor(color).setTitle(label).setTimestamp();

  if (target?.robloxId) {
    embed.setURL(`https://www.roblox.com/users/${target.robloxId}/profile`);
    if (target.avatarUrl) embed.setThumbnail(target.avatarUrl);
  }

  const fields = [];
  if (target?.username) {
    // Don't show a "Player" field for channel-targeted actions (purge, lock, etc.)
    if (!target.isChannel) {
      const playerVal = target.robloxId
        ? `[${target.username}](https://www.roblox.com/users/${target.robloxId}/profile)`
        : target.username;
      fields.push({ name: 'Player', value: playerVal, inline: true });
    }
  }
  if (target?.discordTag) {
    const discordVal = target.discordId
      ? `${target.discordTag} (\`${target.discordId}\`)`
      : target.discordTag;
    fields.push({ name: 'Discord', value: discordVal, inline: true });
  }
  if (target?.discordId && !target?.discordTag) {
    fields.push({ name: 'Discord ID', value: `\`${target.discordId}\``, inline: true });
  }
  if (staff) {
    const modVal = staff.robloxName
      ? `${staff.robloxName} | <@${staff.id}>`
      : `${staff.tag} | <@${staff.id}>`;
    fields.push({ name: 'Moderator', value: modVal, inline: true });
  }
  if (rule && r)          fields.push({ name: 'Rule',       value: `${rule} — ${r.name}`, inline: true });
  if (duration)           fields.push({ name: 'Duration',   value: permanent ? 'Permanent' : duration, inline: true });
  if (reason)             fields.push({ name: 'Reason',     value: reason, inline: false });
  if (extra)              fields.push({ name: 'Notes',      value: extra,  inline: false });
  embed.addFields(fields);

  const channelType = ACTION_CHANNEL[action] || 'mod';
  const channelId   = channelType === 'game'    ? GAME_LOG_CHANNEL_ID
                    : channelType === 'discord'  ? DISCORD_LOG_CHANNEL_ID
                    : MOD_LOG_CHANNEL_ID;

  if (client && channelId) {
    try {
      const ch = await client.channels.fetch(channelId);
      if (ch) await ch.send({ embeds: [embed] });
    } catch (e) { console.error('[logger] Failed to send log:', e.message); }
  }
}

module.exports = { logAction };
