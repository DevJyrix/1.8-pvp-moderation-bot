/**
 * tickets.js — Full ticket system
 *
 * Each ticket type has its OWN channel with a dedicated button/panel:
 *   #game-reports       → "Report Player" button → gr-nickname
 *   #discord-reports    → "Report User" button   → dr-nickname
 *   #appeals            → "Appeal" button        → appeal-nickname
 *   #other-tickets      → dropdown: Art / CC App → cc-nickname / art-nickname
 *
 * Channel names always use the server nickname (RoVer-linked Roblox username).
 */

const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, ModalBuilder, TextInputBuilder,
  TextInputStyle, PermissionFlagsBits, ChannelType,
} = require('discord.js');

const cfg = require('./config');
const fs_state = require('fs');
const STATE_FILE = require('path').join(__dirname, 'data', 'state.json');
function loadState() { try { return JSON.parse(fs_state.readFileSync(STATE_FILE,'utf8')); } catch { return {}; } }
function saveState(s) { fs_state.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); }
function getCCOpen() { return loadState().ccAppsOpen !== false; } // default open

// Ticket type → log channel mapping
function ticketLogChannel(type) {
  if (type === 'gr')     return cfg.GR_LOG_CHANNEL_ID;
  if (type === 'dr')     return cfg.DR_LOG_CHANNEL_ID;
  if (type === 'appeal') return cfg.APPEAL_LOG_CHANNEL_ID;
  if (type === 'cc')     return cfg.CC_LOG_CHANNEL_ID;
  if (type === 'art')    return cfg.ART_LOG_CHANNEL_ID;
  return cfg.LOG_CHANNEL_ID;
}
const { generateAndPostTranscript } = require('./transcript');
const { recordAction } = require('./modstats');
const roblox = require('./roblox');
const yt     = require('./youtube');
const { isActiveBan, RULES } = require('./rules');
const fs   = require('fs');
const path = require('path');

const COUNTER_FILE    = path.join(__dirname, 'ticket_counter.json');
const TICKET_META_DIR = path.join(__dirname, 'data', 'tickets');
fs.mkdirSync(TICKET_META_DIR, { recursive: true });

// ── Counters ──────────────────────────────────────────────────────────────────
function loadCounters() {
  try { return JSON.parse(fs.readFileSync(COUNTER_FILE, 'utf8')); }
  catch { return {}; }
}
function saveCounters(c) { fs.writeFileSync(COUNTER_FILE, JSON.stringify(c, null, 2)); }
function nextNumber(type) {
  const c = loadCounters();
  c[type] = (c[type] || 0) + 1;
  saveCounters(c);
  return c[type];
}

// ── Metadata ──────────────────────────────────────────────────────────────────
function saveTicketMeta(channelId, meta) {
  fs.writeFileSync(path.join(TICKET_META_DIR, `${channelId}.json`), JSON.stringify(meta, null, 2));
}
function loadTicketMeta(channelId) {
  try { return JSON.parse(fs.readFileSync(path.join(TICKET_META_DIR, `${channelId}.json`), 'utf8')); }
  catch { return null; }
}
function deleteTicketMeta(channelId) {
  try { fs.unlinkSync(path.join(TICKET_META_DIR, `${channelId}.json`)); } catch {}
}

// ── Get nickname (RoVer sets this to Roblox username) ─────────────────────────
function getSafeNick(member) {
  const nick = member.nickname || member.user.username;
  return nick.toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 20) || member.user.username.slice(0, 20);
}

// ── Build channel permissions ─────────────────────────────────────────────────

// Returns the minimum staff level required for a given category ID
function categoryLevel(categoryId) {
  if (categoryId && categoryId === cfg.ADMIN_TICKET_CATEGORY_ID)  return 4;
  if (categoryId && categoryId === cfg.SENIOR_TICKET_CATEGORY_ID) return 3;
  return 1;
}

function buildPerms(guild, creatorId, minimumLevel = 1) {
  const staffIds = Object.values(cfg.ROLES)
    .filter(r => r.level >= minimumLevel && r.id)
    .map(r => r.id);
  return [
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    {
      id: creatorId,
      allow: [
        PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles,
        PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.UseExternalEmojis,
        PermissionFlagsBits.AddReactions,
      ],
    },
    ...staffIds.map(id => ({
      id,
      allow: [
        PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles,
        PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.ManageMessages,
        PermissionFlagsBits.UseExternalEmojis, PermissionFlagsBits.AddReactions,
      ],
    })),
    {
      id: guild.members.me.id,
      allow: [
        PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageChannels,
        PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.AttachFiles,
        PermissionFlagsBits.ManageMessages,
      ],
    },
  ];
}

async function createChannel(guild, name, categoryId, creatorId) {
  await guild.roles.fetch().catch(() => {});
  const level = categoryLevel(categoryId);
  return guild.channels.create({
    name,
    type: ChannelType.GuildText,
    parent: categoryId || null,
    permissionOverwrites: buildPerms(guild, creatorId, level),
    topic: `CreatorID: ${creatorId}`,
  });
}

function staffPing(guild, minimumLevel = 1, maxLevel = Infinity) {
  if (minimumLevel === 1 && maxLevel >= 1) {
    const dutyId = cfg.STAFF_DUTY_ROLE_ID;
    if (dutyId && guild.roles.cache.has(dutyId)) return `<@&${dutyId}>`;
  }
  return Object.values(cfg.ROLES)
    .filter(r => r.level >= minimumLevel && r.level <= maxLevel && r.id && guild.roles.cache.has(r.id))
    .map(r => `<@&${r.id}>`)
    .join(' ');
}

function dupCheck(guild, creatorId, prefix) {
  return guild.channels.cache.find(ch =>
    ch.topic?.includes(`CreatorID: ${creatorId}`) && ch.name.startsWith(prefix)
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// PANEL BUILDERS — one per channel
// ──────────────────────────────────────────────────────────────────────────────

function buildGameReportPanel() {
  const embed = new EmbedBuilder()
    .setColor(0xED4245)
    .setTitle('Game Report System')
    .setDescription(
      '**Help us maintain a safe and fair gaming environment!**\n\n' +
      'The bot will create a new channel to gather information about the report. ' +
      'Please make sure you have your DMs open.'
    )
    .addFields(
      {
        name: 'Report Guidelines',
        value: '• Provide clear evidence (screenshots/videos)\n• Be specific about the incident\n• Include player names and timestamps\n• Avoid false accusations',
        inline: true,
      },
      {
        name: 'Quick Tips',
        value: '• Reports are generally reviewed within 24 hours\n• False reports may result in punishments\n• Use this system responsibly\n• Contact staff for urgent matters',
        inline: true,
      },
      {
        name: 'Privacy Notice',
        value: 'All report decisions are confidential and you will not be notified of the result.',
        inline: false,
      }
    )
    .setFooter({ text: 'Game Report System • 1.8 Arena' });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('ticket_gr').setLabel('Report Player').setStyle(ButtonStyle.Danger).setEmoji('🚨'),
  );
  return { embeds: [embed], components: [row] };
}

function buildDiscordReportPanel() {
  const embed = new EmbedBuilder()
    .setColor(0xED4245)
    .setTitle('Discord Report System')
    .setDescription(
      '**Report a user for breaking Discord rules.**\n\n' +
      'Did someone break a rule in our Discord server or in your DMs? ' +
      'Click the button below to open a report ticket.'
    )
    .addFields(
      {
        name: 'What to include',
        value: '• Username of the person\n• Screenshots or evidence\n• Description of what happened\n• Any relevant context',
        inline: false,
      },
    )
    .setFooter({ text: 'Discord Report System • 1.8 Arena' });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('ticket_dr').setLabel('Report User').setStyle(ButtonStyle.Danger).setEmoji('🚩'),
  );
  return { embeds: [embed], components: [row] };
}

function buildAppealPanel() {
  const embed = new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle('Ban Appeals')
    .setDescription(
      '**Do you think you\'ve been unfairly punished?**\n\n' +
      'This channel is for game ban appeals only. If you were banned from Discord, ' +
      'please contact a staff member directly.\n\n' +
      'Appeals are reviewed on a case-by-case basis. Be honest and provide as much context as possible.'
    )
    .addFields(
      {
        name: 'Before appealing',
        value: '• Make sure your appeal is for a game ban\n• Have your Roblox username ready\n• Be honest about what happened\n• Provide any relevant evidence',
        inline: false,
      },
    )
    .setFooter({ text: 'Appeals System • 1.8 Arena' });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('ticket_appeal').setLabel('Submit Appeal').setStyle(ButtonStyle.Primary).setEmoji('📋'),
  );
  return { embeds: [embed], components: [row] };
}

function buildOtherTicketsPanel() {
  const embed = new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle('Other Tickets')
    .setDescription(
      '**Have a concern that doesn\'t fit the other categories?**\n\n' +
      'Select an option from the dropdown below.'
    )
    .setFooter({ text: '1.8 Arena Support' });

  const menu = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('ticket_other_select')
      .setPlaceholder('Select a category...')
      .addOptions([
        {
          label: 'Art — Request Fanart Posting',
          description: 'Request to have your fanart posted',
          value: 'art',
          emoji: '🎨',
        },
        {
          label: 'Content Creator Application',
          description: 'Apply for the Content Creator role',
          value: 'cc',
          emoji: '🎬',
        },
      ])
  );
  return { embeds: [embed], components: [menu] };
}

// ──────────────────────────────────────────────────────────────────────────────
// TICKET CREATION HANDLERS
// ──────────────────────────────────────────────────────────────────────────────

// Game Report
async function handleGameReport(interaction) {
  const nick = getSafeNick(interaction.member);
  const dup  = dupCheck(interaction.guild, interaction.user.id, 'gr-');
  if (dup) return interaction.reply({ content: `You already have an open game report: <#${dup.id}>`, flags: 64 });

  const modal = new ModalBuilder().setCustomId('modal_gr').setTitle('Game Report');
  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('reported').setLabel('Roblox username of reported player')
        .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(50)
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('rule').setLabel('Rule broken (e.g. A1, C1)')
        .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(10)
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('evidence').setLabel('Evidence (Medal or YouTube only)')
        .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(300)
        .setPlaceholder('https://medal.tv/... or https://youtube.com/...')
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('description').setLabel('What happened?')
        .setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(1000)
    ),
  );
  return interaction.showModal(modal);
}

async function submitGameReport(interaction) {
  const reported    = interaction.fields.getTextInputValue('reported').trim();
  const rule        = interaction.fields.getTextInputValue('rule').trim().toUpperCase();
  const evidence    = interaction.fields.getTextInputValue('evidence').trim();
  const description = interaction.fields.getTextInputValue('description').trim();
  const nick        = getSafeNick(interaction.member);

  const validEvidence = /^https?:\/\/(www\.)?(medal\.tv|youtube\.com|youtu\.be)\//i.test(evidence);
  if (!validEvidence) return interaction.reply({ content: 'Invalid evidence link. We only accept **Medal** or **YouTube** links.', flags: 64 });

  await interaction.deferReply({ flags: 64 });

  const channel = await createChannel(
    interaction.guild, `gr-${nick}`, cfg.TICKET_CATEGORY_ID, interaction.user.id
  ).catch(async e => { await interaction.editReply(`Failed to create channel: ${e.message}`); return null; });
  if (!channel) return;

  const ruleInfo = RULES[rule] ? `${rule} — ${RULES[rule].name}` : rule;
  const embed = new EmbedBuilder().setColor(0xED4245).setTitle('Game Report')
    .addFields(
      { name: 'Opened by',       value: `<@${interaction.user.id}>`, inline: true },
      { name: 'Reported Player', value: reported,                    inline: true },
      { name: 'Rule',            value: ruleInfo,                    inline: true },
      { name: 'Evidence',        value: evidence,                    inline: false },
      { name: 'Description',     value: description,                 inline: false },
    )
    .setFooter({ text: 'Use /close or the button below to close this ticket' });

  const closeRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`ticket_close`).setLabel('Close Ticket').setStyle(ButtonStyle.Danger)
  );

  saveTicketMeta(channel.id, { type: 'gr', creatorId: interaction.user.id, creatorTag: interaction.user.tag, openedAt: new Date().toISOString(), channelId: channel.id, reportedUsername: reported });
  await channel.send({ content: `<@${interaction.user.id}> ${staffPing(interaction.guild)}`, embeds: [embed], components: [closeRow] });

  // Auto-lookup reported player
  await _reportLookup(channel, reported);

  recordAction(interaction.user.id, 'TICKET_CLOSED', `#${channel.name}`);
  await interaction.editReply({ content: `Report created: <#${channel.id}>` });
}

// Discord Report
async function handleDiscordReport(interaction) {
  const nick = getSafeNick(interaction.member);
  const dup  = dupCheck(interaction.guild, interaction.user.id, 'dr-');
  if (dup) return interaction.reply({ content: `You already have an open discord report: <#${dup.id}>`, flags: 64 });

  const modal = new ModalBuilder().setCustomId('modal_dr').setTitle('Discord Report');
  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('reported').setLabel('Discord username of reported user')
        .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(100)
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('evidence').setLabel('Evidence (screenshot link or description)')
        .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(300)
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('description').setLabel('What happened?')
        .setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(1000)
    ),
  );
  return interaction.showModal(modal);
}

async function submitDiscordReport(interaction) {
  const reported    = interaction.fields.getTextInputValue('reported').trim();
  const evidence    = interaction.fields.getTextInputValue('evidence').trim();
  const description = interaction.fields.getTextInputValue('description').trim();
  const nick        = getSafeNick(interaction.member);

  await interaction.deferReply({ flags: 64 });
  const channel = await createChannel(
    interaction.guild, `dr-${nick}`, cfg.TICKET_CATEGORY_ID, interaction.user.id
  ).catch(async e => { await interaction.editReply(`Failed: ${e.message}`); return null; });
  if (!channel) return;

  const embed = new EmbedBuilder().setColor(0xED4245).setTitle('Discord Report')
    .addFields(
      { name: 'Opened by',   value: `<@${interaction.user.id}>`, inline: true },
      { name: 'Reported',    value: reported,                    inline: true },
      { name: 'Evidence',    value: evidence,                    inline: false },
      { name: 'Description', value: description,                 inline: false },
    )
    .setFooter({ text: 'Use /close or the button below to close' });

  const closeRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('ticket_close').setLabel('Close Ticket').setStyle(ButtonStyle.Danger)
  );
  saveTicketMeta(channel.id, { type: 'dr', creatorId: interaction.user.id, creatorTag: interaction.user.tag, openedAt: new Date().toISOString(), channelId: channel.id });
  await channel.send({ content: `<@${interaction.user.id}> ${staffPing(interaction.guild)}`, embeds: [embed], components: [closeRow] });
  await interaction.editReply({ content: `Report created: <#${channel.id}>` });
}

// Appeal
async function handleAppeal(interaction) {
  const member = interaction.member;
  const nick   = getSafeNick(member);

  // Only allow appeals for yourself — check that they provide their own Roblox name
  const dup = dupCheck(interaction.guild, interaction.user.id, 'appeal-');
  if (dup) return interaction.reply({ content: `You already have an open appeal: <#${dup.id}>`, flags: 64 });

  const modal = new ModalBuilder().setCustomId('modal_appeal').setTitle('Ban Appeal');
  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('roblox_username').setLabel('Your Roblox Username')
        .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(50)
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('appeal_reason').setLabel('Why should this be overturned?')
        .setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(1000)
    ),
  );
  return interaction.showModal(modal);
}

async function submitAppeal(interaction) {
  const robloxUsername = interaction.fields.getTextInputValue('roblox_username').trim();
  const appealReason   = interaction.fields.getTextInputValue('appeal_reason').trim();
  const member         = interaction.member;
  const nick           = getSafeNick(member);

  // Verify: the Roblox username they provide should match their server nickname
  const nickBase = (member.nickname || '').split(/[\s(]/)[0].trim().toLowerCase();
  const isVerified = nickBase.length > 0 && nickBase === robloxUsername.toLowerCase();

  // If nickname doesn't match, block them
  if (!isVerified && member.nickname) {
    return interaction.reply({
      content: `You can only appeal for your own account. Your server nickname shows **${member.nickname}** — please enter the correct Roblox username.`,
      flags: 64,
    });
  }

  await interaction.deferReply({ flags: 64 });

  const safeUser = robloxUsername.toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 20);
  const channel  = await createChannel(
    interaction.guild, `appeal-${safeUser}`, cfg.TICKET_CATEGORY_ID, interaction.user.id
  ).catch(async e => { await interaction.editReply(`Failed: ${e.message}`); return null; });
  if (!channel) return;

  const embed = new EmbedBuilder().setColor(0x5865F2).setTitle('Ban Appeal')
    .addFields(
      { name: 'Opened by', value: `<@${interaction.user.id}>`, inline: true },
      { name: 'Roblox',    value: robloxUsername,               inline: true },
      { name: 'Reason',    value: appealReason.slice(0, 1024),  inline: false },
    )
    .setFooter({ text: 'Use /close or the button below to close' });

  const closeRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('ticket_close').setLabel('Close Ticket').setStyle(ButtonStyle.Danger)
  );

  saveTicketMeta(channel.id, { type: 'appeal', creatorId: interaction.user.id, creatorTag: interaction.user.tag, openedAt: new Date().toISOString(), channelId: channel.id, robloxUsername, identityVerified: isVerified });
  await channel.send({ content: `<@${interaction.user.id}> ${staffPing(interaction.guild)}`, embeds: [embed], components: [closeRow] });
  await _appealLookup(channel, robloxUsername, interaction.user, isVerified);
  await interaction.editReply({ content: `Appeal created: <#${channel.id}>` });
}

// CC Application
async function handleCC(interaction) {
  if (!getCCOpen()) {
    return interaction.reply({ embeds: [new EmbedBuilder().setColor(0xED4245).setTitle('Content Creator Applications — Closed').setDescription('Content creator applications are currently closed until further notice.\n\nWe are no longer accepting content creator applications.')], flags: 64 });
  }
  const dup = dupCheck(interaction.guild, interaction.user.id, 'cc-');
  if (dup) return interaction.reply({ content: `You already have an open CC application: <#${dup.id}>`, flags: 64 });

  const minViews = (cfg.CC_VIDEO_MIN_VIEWS || 10000).toLocaleString();
  const modal = new ModalBuilder().setCustomId('modal_cc').setTitle('Content Creator Application');
  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('channel_link').setLabel('Your YouTube Channel Link')
        .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(300)
        .setPlaceholder('https://youtube.com/@YourChannel')
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('video_link').setLabel(`Video About The Game (${minViews}+ views required)`)
        .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(300)
        .setPlaceholder('https://youtube.com/watch?v=...')
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('about').setLabel('Tell us about your content')
        .setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(500)
    ),
  );
  return interaction.showModal(modal);
}

async function submitCC(interaction) {
  const channelLink = interaction.fields.getTextInputValue('channel_link').trim();
  const videoLink   = interaction.fields.getTextInputValue('video_link').trim();
  const about       = interaction.fields.getTextInputValue('about').trim();
  const nick        = getSafeNick(interaction.member);

  if (!/youtube\.com|youtu\.be/i.test(channelLink)) {
    return interaction.reply({ content: 'Please provide a valid **YouTube channel** link.', flags: 64 });
  }
  const videoId = yt.extractVideoId(videoLink);
  if (!videoId) {
    return interaction.reply({ content: 'Please provide a valid **YouTube video** link.', flags: 64 });
  }

  await interaction.deferReply({ flags: 64 });

  // Pre-check views if API key is configured
  if (cfg.YOUTUBE_API_KEY) {
    try {
      const videoInfo = await yt.getVideoInfo(videoId);
      if (!videoInfo) {
        return interaction.editReply('Your video could not be found. Make sure the video is **public**.');
      }
      const minViews = cfg.CC_VIDEO_MIN_VIEWS || 10000;
      if (videoInfo.views < minViews) {
        return interaction.editReply(
          `Your video needs at least **${minViews.toLocaleString()} views** to qualify.\n` +
          `**[${videoInfo.title}](https://youtu.be/${videoId})** currently has **${videoInfo.views.toLocaleString()} views**.`
        );
      }
    } catch (e) {
      console.error('[CC] YouTube pre-check failed:', e.message);
      // Don't block application if API fails — staff will verify manually
    }
  }

  const ccCatId = cfg.ADMIN_TICKET_CATEGORY_ID || cfg.TICKET_CATEGORY_ID;
  const channel = await createChannel(
    interaction.guild, `cc-${nick}`, ccCatId, interaction.user.id
  ).catch(async e => { await interaction.editReply(`Failed: ${e.message}`); return null; });
  if (!channel) return;

  const embed = new EmbedBuilder().setColor(0x5865F2).setTitle('Content Creator Application')
    .addFields(
      { name: 'Applicant',       value: `<@${interaction.user.id}>`, inline: true },
      { name: 'Channel',         value: channelLink,                  inline: false },
      { name: 'Submitted Video', value: videoLink,                    inline: false },
      { name: 'About',           value: about,                        inline: false },
    )
    .setFooter({ text: 'Content Creator Program • 1.8 Arena' });

  const closeRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('ticket_close').setLabel('Close Ticket').setStyle(ButtonStyle.Danger)
  );
  saveTicketMeta(channel.id, { type: 'cc', creatorId: interaction.user.id, creatorTag: interaction.user.tag, openedAt: new Date().toISOString(), channelId: channel.id });
  // Ping senior staff only — do NOT ping admin in CC tickets
  await channel.send({ content: `<@${interaction.user.id}> ${staffPing(interaction.guild, 3, 3)}`, embeds: [embed], components: [closeRow] });
  await _ccLookup(channel, channelLink, videoLink);
  await interaction.editReply({ content: `Application submitted: <#${channel.id}>` });
}

// Art Request
async function handleArt(interaction) {
  const dup = dupCheck(interaction.guild, interaction.user.id, 'art-');
  if (dup) return interaction.reply({ content: `You already have an open art request: <#${dup.id}>`, flags: 64 });

  const modal = new ModalBuilder().setCustomId('modal_art').setTitle('Fanart Posting Request');
  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('art_link').setLabel('Link to your artwork')
        .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(300)
        .setPlaceholder('Direct image link or Imgur/etc.')
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('description').setLabel('Brief description of the artwork')
        .setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(500)
    ),
  );
  return interaction.showModal(modal);
}

async function submitArt(interaction) {
  const artLink     = interaction.fields.getTextInputValue('art_link').trim();
  const description = interaction.fields.getTextInputValue('description').trim();
  const nick        = getSafeNick(interaction.member);

  await interaction.deferReply({ flags: 64 });
  const artCatId = cfg.ADMIN_TICKET_CATEGORY_ID || cfg.TICKET_CATEGORY_ID;
  const channel = await createChannel(
    interaction.guild, `art-${nick}`, artCatId, interaction.user.id
  ).catch(async e => { await interaction.editReply(`Failed: ${e.message}`); return null; });
  if (!channel) return;

  const embed = new EmbedBuilder().setColor(0x5865F2).setTitle('Fanart Posting Request')
    .addFields(
      { name: 'Submitted by', value: `<@${interaction.user.id}>`, inline: true },
      { name: 'Artwork Link', value: artLink,                      inline: false },
      { name: 'Description',  value: description,                  inline: false },
    )
    .setFooter({ text: 'Use /close or the button below to close' });

  const closeRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('ticket_close').setLabel('Close Ticket').setStyle(ButtonStyle.Danger)
  );
  saveTicketMeta(channel.id, { type: 'art', creatorId: interaction.user.id, creatorTag: interaction.user.tag, openedAt: new Date().toISOString(), channelId: channel.id });
  await channel.send({ content: `<@${interaction.user.id}> ${staffPing(interaction.guild, categoryLevel(artCatId))}`, embeds: [embed], components: [closeRow] });
  await interaction.editReply({ content: `Request submitted: <#${channel.id}>` });
}

// ── CC YouTube lookup ──────────────────────────────────────────────────────────
async function _ccLookup(channel, channelLink, videoLink) {
  if (!cfg.YOUTUBE_API_KEY) {
    await channel.send({ embeds: [new EmbedBuilder().setColor(0xFEE75C)
      .setDescription('Ignore this message, reminder to myself to setup YouTube API key.')] }).catch(() => {});
    return;
  }

  const loadMsg = await channel.send('Fetching YouTube channel & video data...').catch(() => null);
  if (!loadMsg) return;

  try {
    const videoId   = yt.extractVideoId(videoLink);
    if (!videoId) return loadMsg.edit('Could not read video ID — staff please verify manually.');

    const videoInfo = await yt.getVideoInfo(videoId);
    if (!videoInfo) return loadMsg.edit('Could not fetch video info — staff please verify manually.');

    // Prefer the provided channel URL; fall back to the video's channel ID
    let channelInfo = await yt.getChannelByUrl(channelLink).catch(() => null);
    if (!channelInfo) channelInfo = await yt.getChannelById(videoInfo.channelId).catch(() => null);

    const minViews  = cfg.CC_VIDEO_MIN_VIEWS || 10000;
    const meetsReq  = videoInfo.views >= minViews;
    const chanUrl   = channelInfo
      ? `https://www.youtube.com/${channelInfo.handle || 'channel/' + channelInfo.id}`
      : channelLink;

    const subsDisplay = channelInfo
      ? (channelInfo.hiddenSubs ? 'Hidden' : channelInfo.subscribers.toLocaleString())
      : 'N/A';

    const embed = new EmbedBuilder()
      .setColor(meetsReq ? 0x57F287 : 0xED4245)
      .setTitle('YouTube Verification')
      .setThumbnail(channelInfo?.thumbnail || videoInfo.thumbnail)
      .addFields(
        { name: 'Channel',        value: channelInfo ? `[${channelInfo.title}](${chanUrl})` : channelLink, inline: true },
        { name: 'Subscribers',    value: subsDisplay,                                                      inline: true },
        { name: 'Total Videos',   value: channelInfo ? channelInfo.videos.toLocaleString() : 'N/A',        inline: true },
        { name: 'Submitted Video',value: `[${videoInfo.title}](https://youtu.be/${videoInfo.id})`,         inline: false },
        { name: 'Views',          value: videoInfo.views.toLocaleString(),                                 inline: true },
        { name: 'Likes',          value: videoInfo.likes.toLocaleString(),                                 inline: true },
        { name: 'Comments',       value: videoInfo.comments.toLocaleString(),                              inline: true },
        {
          name:  'View Requirement',
          value: meetsReq
            ? `✅ Meets ${minViews.toLocaleString()} view requirement`
            : `❌ Does not meet requirement — needs ${minViews.toLocaleString()} views, has ${videoInfo.views.toLocaleString()}`,
          inline: false,
        },
      )
      .setImage(videoInfo.thumbnail)
      .setTimestamp();

    await loadMsg.edit({ content: '', embeds: [embed] });
  } catch (e) {
    await loadMsg.edit(`YouTube data fetch failed: ${e.message} — staff please verify manually.`);
  }
}

// ── Close ──────────────────────────────────────────────────────────────────────
async function closeTicket(interaction, channel) {
  if (!channel) channel = interaction.channel;
  const validNames = ['gr-', 'dr-', 'appeal-', 'cc-', 'art-'];
  if (!validNames.some(p => channel.name.startsWith(p))) {
    return interaction.reply({ content: 'This command can only be used inside a ticket channel.', flags: 64 });
  }

  const meta      = loadTicketMeta(channel.id);
  const creatorId = meta?.creatorId || _creatorFromTopic(channel);
  const canClose  = cfg.isStaff(interaction.member) || (creatorId && interaction.user.id === creatorId);
  if (!canClose) return interaction.reply({ content: 'Only the ticket creator or staff can close this.', flags: 64 });

  await interaction.reply({ content: 'Saving transcript and closing...' });

  const ticketMeta = {
    ...(meta || {}),
    number:     meta?.number || '?',
    type:       meta?.type   || channel.name.split('-')[0],
    creatorTag: meta?.creatorTag || 'Unknown',
    creatorId,
    openedAt:   meta?.openedAt || channel.createdAt?.toISOString() || new Date().toISOString(),
    closedBy:   interaction.user.tag,
  };

  recordAction(interaction.user.id, 'TICKET_CLOSED', `#${channel.name}`);

  try { await generateAndPostTranscript(interaction.client, channel, ticketMeta, ticketLogChannel(ticketMeta.type)); } catch {}

  if (creatorId) {
    try {
      const user = await interaction.client.users.fetch(creatorId);
      await user.send({ embeds: [new EmbedBuilder().setColor(0x5865F2).setTitle('Ticket Resolved')
        .setDescription(`Your ticket **${channel.name}** has been resolved and closed.`).setTimestamp()] });
    } catch {}
  }

  deleteTicketMeta(channel.id);
  setTimeout(async () => { try { await channel.delete('Ticket closed'); } catch {} }, 4000);
}

// ── Appeal auto-lookup ─────────────────────────────────────────────────────────
async function _appealLookup(channel, robloxUsername, creator, identityVerified) {
  const loadMsg = await channel.send('Fetching game ban record...');
  try {
    const basic = await roblox.getUserByName(robloxUsername).catch(() => null);
    const user  = basic ? await roblox.getUserById(basic.id).catch(() => null) : null;
    if (!user) return loadMsg.edit(`Could not find Roblox user \`${robloxUsername}\`. Staff please verify manually.`);

    const [avatarUrl, banData, stats, restriction] = await Promise.all([
      roblox.getAvatar(user.id).catch(() => null),
      roblox.getBanData(user.id).catch(() => ({ active: null, history: [] })),
      roblox.getPlayerStats(user.id).catch(() => null),
      roblox.getUserRestriction(user.id).catch(() => null),
    ]);

    // Platform restriction takes priority; DataStore is fallback
    const platformBan = restriction?.gameJoinRestriction?.active ? restriction.gameJoinRestriction : null;
    const activeBan   = banData?.active && isActiveBan(banData.active) ? banData.active : null;
    const isBanned    = !!(platformBan || activeBan);
    const history     = (banData?.history || []).filter(b => !b._hidden);

    const descText = identityVerified
      ? `Identity confirmed via RoVer — nickname matches **[${user.name}](https://www.roblox.com/users/${user.id}/profile)**.`
      : `Staff note: appellant claims to be **[${user.name}](https://www.roblox.com/users/${user.id}/profile)**. Verify identity before acting.`;

    const embed = new EmbedBuilder()
      .setColor(isBanned ? 0xED4245 : 0x57F287)
      .setTitle('Account Lookup')
      .setThumbnail(avatarUrl)
      .setURL(`https://www.roblox.com/users/${user.id}/profile`)
      .setDescription(descText)
      .addFields(
        { name: 'Username', value: `[${user.name}](https://www.roblox.com/users/${user.id}/profile)`, inline: true },
        { name: 'User ID',  value: `\`${user.id}\``, inline: true },
      );

    if (platformBan) {
      // Duration parsing: "604800s" → human readable
      const durSecs  = platformBan.duration ? parseInt(platformBan.duration) : null;
      const startTs  = platformBan.startTime ? Math.floor(new Date(platformBan.startTime).getTime() / 1000) : null;
      const expireTs = durSecs && startTs ? startTs + durSecs : null;
      embed.addFields({ name: 'Platform Ban (User Restrictions)', value: [
        `Status: **Active**`,
        platformBan.privateReason ? `Reason: ${platformBan.privateReason}` : null,
        startTs  ? `Issued: <t:${startTs}:F>` : null,
        expireTs ? `Expires: <t:${expireTs}:F>` : `Expires: **Permanent**`,
      ].filter(Boolean).join('\n') });
    } else if (activeBan) {
      const rule  = RULES[activeBan.rule];
      const tsExp = activeBan.permanent ? null : Math.floor(new Date(activeBan.expires).getTime() / 1000);
      embed.addFields({ name: 'Active Ban (DataStore record)', value: [
        `Rule: ${activeBan.rule} — ${rule?.name || 'Unknown'}`,
        `Reason: ${activeBan.reason || 'N/A'}`,
        `Issued by: ${activeBan.bannedBy || 'N/A'}`,
        `Expires: ${activeBan.permanent ? 'Permanent' : `<t:${tsExp}:F>`}`,
      ].join('\n') });
    } else {
      embed.addFields({ name: 'Ban Status', value: 'No active ban found.' });
    }

    if (history.length) {
      const lines = history.slice(-5).reverse().map(b => {
        const ts  = Math.floor(new Date(b.bannedAt).getTime() / 1000);
        const app = b.appealedBy ? ` — Appealed by \`${b.appealedBy}\`` : '';
        return `Rule ${b.rule} · ${b.permanent ? 'Permanent' : b.duration} · <t:${ts}:d>${app}`;
      });
      embed.addFields({ name: `Ban History (${history.length})`, value: lines.join('\n') });
    }

    if (stats) {
      const parts = [
        stats.level != null ? `Level ${stats.level}` : null,
        stats.coins != null ? `${stats.coins?.toLocaleString()} coins` : null,
        stats.lifetimeKills != null ? `${stats.lifetimeKills?.toLocaleString()} kills` : null,
      ].filter(Boolean);
      if (parts.length) embed.addFields({ name: 'Account Stats', value: parts.join('  ·  ') });
    }

    embed.setTimestamp();
    await loadMsg.edit({ content: '', embeds: [embed] });
    if (!isBanned) {
      await channel.send({ embeds: [new EmbedBuilder().setColor(0xFEE75C)
        .setDescription(`No active ban found for **${user.name}**. This may be a Discord ban appeal or the ban has already expired.`)] });
    }
  } catch (e) {
    await loadMsg.edit(`Auto-lookup failed: ${e.message}. Staff will check manually.`);
  }
}

// ── Report auto-lookup ─────────────────────────────────────────────────────────
async function _reportLookup(channel, robloxUsername) {
  const loadMsg = await channel.send('Fetching reported player record...');
  try {
    const basic = await roblox.getUserByName(robloxUsername).catch(() => null);
    const user  = basic ? await roblox.getUserById(basic.id).catch(() => null) : null;
    if (!user) return loadMsg.edit(`Could not find Roblox user \`${robloxUsername}\`.`);

    const [avatarUrl, banData, stats] = await Promise.all([
      roblox.getAvatar(user.id).catch(() => null),
      roblox.getBanData(user.id).catch(() => ({ active: null, history: [] })),
      roblox.getPlayerStats(user.id).catch(() => null),
    ]);

    const activeBan = banData?.active && isActiveBan(banData.active) ? banData.active : null;
    const history   = (banData?.history || []).filter(b => !b._hidden);

    const embed = new EmbedBuilder().setColor(0x5865F2).setTitle('Reported Player Info')
      .setThumbnail(avatarUrl)
      .setURL(`https://www.roblox.com/users/${user.id}/profile`)
      .addFields(
        { name: 'Username', value: `[${user.name}](https://www.roblox.com/users/${user.id}/profile)`, inline: true },
        { name: 'User ID',  value: `\`${user.id}\``, inline: true },
      );

    if (activeBan) embed.addFields({ name: 'Currently Banned', value: `Rule ${activeBan.rule}` });
    if (history.length) embed.addFields({ name: 'Prior Bans', value: `${history.length} on record` });

    if (stats) {
      const statParts = [
        stats.rank          != null ? `**Rank:** ${stats.rank}` : null,
        stats.level         != null ? `**Level:** ${stats.level}` : null,
        stats.coins         != null ? `**Coins:** ${stats.coins?.toLocaleString()}` : null,
        stats.wins          != null ? `**Wins:** ${stats.wins?.toLocaleString()}` : null,
        stats.lifetimeKills != null ? `**Kills:** ${stats.lifetimeKills?.toLocaleString()}` : null,
      ].filter(Boolean);
      if (statParts.length) embed.addFields({ name: 'Stats', value: statParts.join('  ·  '), inline: false });
    }

    embed.setTimestamp();
    await loadMsg.edit({ content: '', embeds: [embed] });
  } catch (e) {
    await loadMsg.edit(`Auto-lookup failed: ${e.message}`);
  }
}

function _creatorFromTopic(channel) {
  const m = (channel.topic || '').match(/CreatorID:\s*(\d+)/);
  if (m) return m[1];
  for (const [id, ow] of channel.permissionOverwrites.cache) {
    if (ow.type === 1 && id !== channel.guild.members.me?.id) return id;
  }
  return null;
}

module.exports = {
  getCCOpen, loadState, saveState,
  buildGameReportPanel,
  buildDiscordReportPanel,
  buildAppealPanel,
  buildOtherTicketsPanel,
  handleGameReport,
  handleDiscordReport,
  handleAppeal,
  handleCC,
  handleArt,
  submitGameReport,
  submitDiscordReport,
  submitAppeal,
  submitCC,
  submitArt,
  closeTicket,
};
