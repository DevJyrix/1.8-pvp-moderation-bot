const fs   = require('fs');
const path = require('path');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

const DATA_DIR = path.join(__dirname, 'data', 'modstats');
fs.mkdirSync(DATA_DIR, { recursive: true });

function statPath(id) { return path.join(DATA_DIR, `${id}.json`); }

function loadStats(id) {
  try { return JSON.parse(fs.readFileSync(statPath(id), 'utf8')); }
  catch { return { id, actions: [] }; }
}
function saveStats(record) {
  fs.writeFileSync(statPath(record.id), JSON.stringify(record, null, 2));
}

/**
 * Record a mod action.
 * @param {string} modId   Discord user ID of the moderator
 * @param {string} action  e.g. 'GBAN', 'BAN', 'MUTE', 'TICKET_CLOSED'
 * @param {string} target  Who was actioned (username)
 */
function recordAction(modId, action, target) {
  const rec = loadStats(modId);
  rec.actions.push({
    action,
    target,
    timestamp: new Date().toISOString(),
  });
  saveStats(rec);
}

function thisMonthKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function isThisMonth(ts) {
  return ts.startsWith(thisMonthKey());
}

function summarise(actions) {
  const counts = {};
  for (const a of actions) {
    counts[a.action] = (counts[a.action] || 0) + 1;
  }
  return counts;
}

function buildStatsEmbed(modTag, modId, scope) {
  const rec     = loadStats(modId);
  const all     = rec.actions || [];
  const monthly = all.filter(a => isThisMonth(a.timestamp));
  const actions = scope === 'month' ? monthly : all;
  const counts  = summarise(actions);

  const label = scope === 'month'
    ? `This Month (${thisMonthKey()})`
    : 'All Time';

  const totalActions = actions.length;
  const rows = [
    ['Game Bans',       counts['GBAN']          || 0],
    ['Game Unbans',     counts['UNGBAN']         || 0],
    ['Discord Bans',    counts['BAN']            || 0],
    ['Discord Unbans',  counts['UNBAN']          || 0],
    ['Timeouts',        counts['MUTE']           || 0],
    ['Kicks',           counts['KICK']           || 0],
    ['Warnings',        counts['WARN']           || 0],
    ['Tickets Handled', counts['TICKET_CLOSED']  || 0],
  ].filter(([, v]) => v > 0);

  const embed = new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle('Moderator Statistics')
    .addFields(
      { name: 'Moderator', value: `${modTag}`, inline: true },
      { name: 'Period',    value: label,        inline: true },
      { name: 'Total Actions', value: `${totalActions}`, inline: true },
    );

  if (rows.length > 0) {
    embed.addFields({
      name: 'Breakdown',
      value: rows.map(([k, v]) => `\`${String(v).padStart(3)}\`  ${k}`).join('\n'),
      inline: false,
    });
  } else {
    embed.addFields({ name: 'Breakdown', value: 'No actions recorded for this period.', inline: false });
  }

  // Recent activity (last 5)
  const recent = actions.slice(-5).reverse();
  if (recent.length > 0) {
    const lines = recent.map(a => {
      const ts = Math.floor(new Date(a.timestamp).getTime() / 1000);
      return `<t:${ts}:d> — **${a.action}** on \`${a.target || 'unknown'}\``;
    });
    embed.addFields({ name: 'Recent Activity', value: lines.join('\n'), inline: false });
  }

  embed.setTimestamp();
  return embed;
}

function buildModStatsRow(modId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`modstats_month_${modId}`)
      .setLabel('This Month')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`modstats_all_${modId}`)
      .setLabel('All Time')
      .setStyle(ButtonStyle.Secondary),
  );
}

module.exports = { recordAction, buildStatsEmbed, buildModStatsRow };
