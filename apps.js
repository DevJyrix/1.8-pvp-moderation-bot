'use strict';

const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle,
  ChannelType, PermissionFlagsBits,
} = require('discord.js');
const config = require('./config');
const roblox = require('./roblox');

let appsOpen = true;

const APP_TYPES = {
  tester: {
    id:        'tester',
    label:     'Game Tester',
    color:     0x57F287,
    roleKey:   'ACTIVE_MEMBER_ROLE_ID',
    roleLabel: 'Active Member',
    questions: [
      { id: 'age',      label: 'How old are you?',                                       style: TextInputStyle.Short,     max: 20  },
      { id: 'playtime', label: 'How long have you played 1.8 Arena?',                    style: TextInputStyle.Short,     max: 100 },
      { id: 'why',      label: 'Why do you want to be a Game Tester?',                   style: TextInputStyle.Paragraph, max: 500 },
      { id: 'hours',    label: 'How many hours/week can you commit to testing?',          style: TextInputStyle.Short,     max: 50  },
      { id: 'exp',      label: 'Any previous testing or bug reporting experience?',      style: TextInputStyle.Paragraph, max: 500 },
    ],
  },
  discord_staff: {
    id:        'discord_staff',
    label:     'Discord Staff',
    color:     0x5865F2,
    roleKey:   'DEDICATED_MEMBER_ROLE_ID',
    roleLabel: 'Dedicated Member',
    questions: [
      { id: 'age',    label: 'How old are you?',                                         style: TextInputStyle.Short,     max: 20  },
      { id: 'time',   label: 'How long have you been in this server?',                   style: TextInputStyle.Short,     max: 100 },
      { id: 'why',    label: 'Why do you want to be Discord Staff?',                     style: TextInputStyle.Paragraph, max: 500 },
      { id: 'exp',    label: 'Previous Discord moderation experience? Describe.',        style: TextInputStyle.Paragraph, max: 500 },
      { id: 'tz',     label: 'Timezone and how many hours/day are you active?',          style: TextInputStyle.Short,     max: 100 },
    ],
  },
  game_staff: {
    id:        'game_staff',
    label:     'Game Staff',
    color:     0xED4245,
    roleKey:   'DEDICATED_MEMBER_ROLE_ID',
    roleLabel: 'Dedicated Member',
    questions: [
      { id: 'age',   label: 'How old are you?',                                          style: TextInputStyle.Short,     max: 20  },
      { id: 'rank',  label: 'How long played & what is your current rank?',              style: TextInputStyle.Short,     max: 100 },
      { id: 'why',   label: 'Why do you want to be Game Staff?',                         style: TextInputStyle.Paragraph, max: 500 },
      { id: 'exp',   label: 'Previous game staff or moderation experience?',             style: TextInputStyle.Paragraph, max: 500 },
      { id: 'tz',    label: 'Timezone and daily availability hours?',                    style: TextInputStyle.Short,     max: 100 },
    ],
  },
};

// ── Panel ─────────────────────────────────────────────────────────────────────

function buildAppPanel() {
  const embed = new EmbedBuilder()
    .setColor(appsOpen ? 0x57F287 : 0xED4245)
    .setTitle('1.8 Arena — Applications')
    .setDescription(
      appsOpen
        ? 'Applications are currently **open**! Choose your application type below.\n\n' +
          '🎮 **Game Tester** — Requires `Active Member` role\n' +
          '💬 **Discord Staff** — Requires `Dedicated Member` role\n' +
          '⚔️ **Game Staff** — Requires `Dedicated Member` role'
        : '**Applications are currently closed.** Check back soon!'
    )
    .setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('app_open_tester')
      .setLabel('Game Tester')
      .setStyle(ButtonStyle.Success)
      .setEmoji('🎮')
      .setDisabled(!appsOpen),
    new ButtonBuilder()
      .setCustomId('app_open_discord_staff')
      .setLabel('Discord Staff')
      .setStyle(ButtonStyle.Primary)
      .setEmoji('💬')
      .setDisabled(!appsOpen),
    new ButtonBuilder()
      .setCustomId('app_open_game_staff')
      .setLabel('Game Staff')
      .setStyle(ButtonStyle.Danger)
      .setEmoji('⚔️')
      .setDisabled(!appsOpen),
  );

  return { embeds: [embed], components: [row] };
}

async function postPanel(channel) {
  return channel.send(buildAppPanel());
}

async function refreshPanel(client) {
  const ch = await client.channels.fetch(config.APP_CHANNEL_ID).catch(() => null);
  if (!ch) return;
  const msgs = await ch.messages.fetch({ limit: 20 }).catch(() => null);
  if (!msgs) return;
  const panel = msgs.find(m =>
    m.author.id === client.user.id &&
    m.embeds[0]?.title?.includes('Applications')
  );
  if (panel) await panel.edit(buildAppPanel()).catch(() => null);
}

// ── Button: open modal ─────────────────────────────────────────────────────────

async function handleAppButton(interaction) {
  const appType = interaction.customId.replace('app_open_', '');
  return showAppModal(interaction, appType);
}

// Can also be called directly (e.g. from a select menu) with the appType string
async function showAppModal(interaction, appType) {
  const def = APP_TYPES[appType];
  if (!def) return interaction.reply({ content: 'Unknown application type.', flags: 64 });

  if (!appsOpen) {
    return interaction.reply({ content: 'Applications are currently closed.', flags: 64 });
  }

  const reqRoleId = config[def.roleKey];
  if (reqRoleId && !interaction.member.roles.cache.has(reqRoleId)) {
    return interaction.reply({
      content: `You need the **${def.roleLabel}** role to apply for ${def.label}.`,
      flags: 64,
    });
  }

  const modal = new ModalBuilder()
    .setCustomId(`app_modal_${appType}`)
    .setTitle(`${def.label} Application`);

  for (const q of def.questions) {
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId(q.id)
          .setLabel(q.label)
          .setStyle(q.style)
          .setMaxLength(q.max)
          .setRequired(true)
      )
    );
  }

  await interaction.showModal(modal);
}

// ── Modal submit ──────────────────────────────────────────────────────────────

async function handleAppModal(interaction, client, msgCountMap) {
  const appType = interaction.customId.replace('app_modal_', '');
  const def = APP_TYPES[appType];
  if (!def) return;

  await interaction.deferReply({ flags: 64 });

  const member   = interaction.member;
  const user     = interaction.user;
  const nickname = member.nickname || user.username;

  // Roblox lookup via server nickname
  let robloxUser = null;
  let gameStats  = null;
  let avatarUrl  = null;
  try {
    const basic = await roblox.getUserByName(nickname).catch(() => null);
    if (basic) {
      robloxUser = await roblox.getUserById(basic.id).catch(() => null);
      if (robloxUser) {
        [gameStats, avatarUrl] = await Promise.all([
          roblox.getPlayerStats(robloxUser.id).catch(() => null),
          roblox.getAvatar(robloxUser.id).catch(() => null),
        ]);
      }
    }
  } catch {}

  const msgCount = msgCountMap?.get(user.id) ?? null;

  const embed = new EmbedBuilder()
    .setColor(def.color)
    .setTitle(`${def.label} Application`)
    .setAuthor({ name: user.tag, iconURL: user.displayAvatarURL() })
    .setThumbnail(avatarUrl || user.displayAvatarURL())
    .addFields(
      { name: 'Applicant',   value: `<@${user.id}>`,                                                        inline: true },
      { name: 'User ID',     value: user.id,                                                                 inline: true },
      { name: 'Account Age', value: `<t:${Math.floor(user.createdTimestamp / 1000)}:R>`,                     inline: true },
      { name: 'Server Join', value: member.joinedAt ? `<t:${Math.floor(member.joinedAt.getTime() / 1000)}:R>` : 'Unknown', inline: true },
      { name: 'Messages',    value: msgCount !== null ? msgCount.toLocaleString() : 'N/A (since bot start)', inline: true },
    );

  // Roblox info
  if (robloxUser) {
    embed.addFields({
      name: 'Roblox',
      value: `[${robloxUser.name}](https://www.roblox.com/users/${robloxUser.id}/profile) (ID: \`${robloxUser.id}\`)`,
      inline: false,
    });
    if (gameStats) {
      const lines = [];
      if (gameStats.level          != null) lines.push(`Level: **${gameStats.level}**`);
      if (gameStats.rank           != null) lines.push(`Rank: **${gameStats.rank}**`);
      if (gameStats.wins           != null) lines.push(`Wins: **${gameStats.wins.toLocaleString()}**`);
      if (gameStats.lifetimeKills  != null) lines.push(`Kills: **${gameStats.lifetimeKills.toLocaleString()}**`);
      if (gameStats.playtime       != null) lines.push(`Playtime: **${roblox.formatPlaytime(gameStats.playtime)}**`);
      if (lines.length) embed.addFields({ name: 'Game Stats', value: lines.join('\n'), inline: false });
    }
  } else {
    embed.addFields({ name: 'Roblox', value: `No match for server nickname \`${nickname}\` — check manually.`, inline: false });
  }

  embed.addFields({ name: '​', value: '**── Answers ──**', inline: false });
  for (const q of def.questions) {
    const answer = interaction.fields.getTextInputValue(q.id);
    embed.addFields({ name: q.label, value: answer.slice(0, 1024), inline: false });
  }
  embed.addFields({ name: 'Status', value: '⏳ Pending review', inline: false });
  embed.setTimestamp();

  const logChannel = await client.channels.fetch(config.APP_LOG_CHANNEL_ID).catch(() => null);
  if (!logChannel) {
    return interaction.editReply('Configuration error: application log channel not found. Contact an admin.');
  }

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`app_accept_${user.id}_${appType}`)
      .setLabel('Accept')
      .setStyle(ButtonStyle.Success)
      .setEmoji('✅'),
    new ButtonBuilder()
      .setCustomId(`app_deny_${user.id}_${appType}`)
      .setLabel('Deny')
      .setStyle(ButtonStyle.Danger)
      .setEmoji('❌'),
  );

  await logChannel.send({ embeds: [embed], components: [row] });
  await interaction.editReply(
    '✅ Your application has been submitted! You will be contacted if you pass the first phase.'
  );
}

// ── Accept ────────────────────────────────────────────────────────────────────

async function handleAppAccept(interaction, client) {
  if (!config.isStaff(interaction.member)) {
    return interaction.reply({ content: 'Staff only.', flags: 64 });
  }

  // customId: app_accept_{userId}_{appType}  (appType may contain underscores)
  const withoutPrefix = interaction.customId.replace('app_accept_', '');
  const userId  = withoutPrefix.match(/^(\d+)_/)?.[1];
  const appType = withoutPrefix.replace(`${userId}_`, '');
  const def     = APP_TYPES[appType];
  if (!userId) return interaction.reply({ content: 'Malformed interaction ID.', flags: 64 });

  await interaction.deferReply({ flags: 64 });

  // Update status field in the log embed
  try {
    const oldEmbed = interaction.message.embeds[0];
    const fields   = oldEmbed.fields.map(f =>
      f.name === 'Status'
        ? { name: 'Status', value: `✅ Accepted by ${interaction.user.tag}`, inline: false }
        : { name: f.name, value: f.value, inline: f.inline }
    );
    await interaction.message.edit({
      embeds: [EmbedBuilder.from(oldEmbed).setColor(0x57F287).setFields(fields)],
      components: [],
    });
  } catch {}

  const guild    = interaction.guild;
  const member   = await guild.members.fetch(userId).catch(() => null);
  const appName  = def?.label || appType;
  const chanName = `app-${(member?.user.username || userId).toLowerCase().replace(/[^a-z0-9-]/g, '')}`;

  const permOverwrites = [
    { id: guild.roles.everyone.id, deny:  [PermissionFlagsBits.ViewChannel] },
    { id: client.user.id,          allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels] },
    { id: interaction.user.id,     allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
  ];
  if (member) {
    permOverwrites.push({ id: userId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] });
  }
  for (const roleId of config.allStaffRoleIds()) {
    if (roleId) permOverwrites.push({ id: roleId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] });
  }

  const ticketCh = await guild.channels.create({
    name: chanName,
    type: ChannelType.GuildText,
    parent: config.ADMIN_TICKET_CATEGORY_ID || config.TICKET_CATEGORY_ID || undefined,
    permissionOverwrites: permOverwrites,
  });

  const notifyEmbed = new EmbedBuilder()
    .setColor(0x57F287)
    .setTitle(`${appName} — First Phase Passed`)
    .setDescription(
      `Congratulations <@${userId}>! Your **${appName}** application has passed the first phase of review.\n\n` +
      `<@${interaction.user.id}> will be in touch with you here shortly.`
    )
    .setTimestamp();

  await ticketCh.send({
    content: `<@${userId}> <@${interaction.user.id}>`,
    embeds:  [notifyEmbed],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('close_app_ticket')
          .setLabel('Close Ticket')
          .setStyle(ButtonStyle.Secondary)
          .setEmoji('🔒')
      ),
    ],
  });

  await interaction.editReply(`Ticket created: <#${ticketCh.id}>`);
}

// ── Deny ──────────────────────────────────────────────────────────────────────

async function handleAppDeny(interaction, client) {
  if (!config.isStaff(interaction.member)) {
    return interaction.reply({ content: 'Staff only.', flags: 64 });
  }

  const withoutPrefix = interaction.customId.replace('app_deny_', '');
  const userId  = withoutPrefix.match(/^(\d+)_/)?.[1];
  const appType = withoutPrefix.replace(`${userId}_`, '');
  const def     = APP_TYPES[appType];
  if (!userId) return interaction.reply({ content: 'Malformed interaction ID.', flags: 64 });

  await interaction.deferReply({ flags: 64 });

  // Update status field in the log embed
  try {
    const oldEmbed = interaction.message.embeds[0];
    const fields   = oldEmbed.fields.map(f =>
      f.name === 'Status'
        ? { name: 'Status', value: `❌ Denied by ${interaction.user.tag}`, inline: false }
        : { name: f.name, value: f.value, inline: f.inline }
    );
    await interaction.message.edit({
      embeds: [EmbedBuilder.from(oldEmbed).setColor(0xED4245).setFields(fields)],
      components: [],
    });
  } catch {}

  // DM the applicant
  try {
    const member = await interaction.guild.members.fetch(userId).catch(() => null);
    if (member) {
      await member.send(
        `Thank you for applying for **${def?.label || appType}** in 1.8 Arena. ` +
        `Unfortunately your application was not successful at this time. ` +
        `You are welcome to apply again in the future.`
      ).catch(() => null);
    }
  } catch {}

  await interaction.editReply('Application denied. The applicant has been notified via DM if possible.');
}

// ── Close app ticket button ───────────────────────────────────────────────────

async function handleCloseAppTicket(interaction) {
  if (!config.isStaff(interaction.member)) {
    return interaction.reply({ content: 'Staff only.', flags: 64 });
  }
  await interaction.reply({ content: 'Closing ticket in 5 seconds...', flags: 64 });
  setTimeout(async () => {
    await interaction.channel.delete().catch(() => null);
  }, 5000);
}

// ── State helpers ─────────────────────────────────────────────────────────────

function setAppsOpen(open)  { appsOpen = open; }
function getAppsOpen()      { return appsOpen; }

module.exports = {
  APP_TYPES,
  buildAppPanel, postPanel, refreshPanel,
  handleAppButton, showAppModal, handleAppModal, handleAppAccept, handleAppDeny, handleCloseAppTicket,
  setAppsOpen, getAppsOpen,
};
