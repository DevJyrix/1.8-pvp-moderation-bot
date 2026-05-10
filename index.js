require('dotenv').config();
const {
  Client, GatewayIntentBits, EmbedBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, StringSelectMenuOptionBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle,
  PermissionFlagsBits, InteractionType, REST, Routes,
  SlashCommandBuilder, Events,
} = require('discord.js');

const config   = require('./config');
const bloxlink = require('./bloxlink');
const roblox   = require('./roblox');
const { RULES, getBanDuration, banExpiry, isActiveBan } = require('./rules');
const { checkRaid, resetLockout }  = require('./antiraid');
const { logAction }                = require('./logger');
const { buildStatsEmbed }          = require('./statsEmbed');
const tickets = require('./tickets');
const {
  buildGameReportPanel, buildDiscordReportPanel, buildAppealPanel, buildOtherTicketsPanel,
  handleGameReport, handleDiscordReport, handleAppeal, handleCC, handleArt,
  handleBusiness,
  submitGameReport, submitDiscordReport, submitAppeal, submitCC, submitArt, submitBusiness,
  closeTicket, handleCloseReason, getCCOpen, loadState, saveState, getDMToggle, setDMToggle,
  loadTicketMeta,
} = tickets;
const { addInfraction, removeInfraction, clearWarnsAndNotes, buildFullInfractionEmbed } = require('./infractions');
const { recordAction, buildStatsEmbed: buildModStatsEmbed, buildModStatsRow } = require('./modstats');
const music = require('./music');
const apps  = require('./apps');

// ─── Client ────────────────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessageReactions,
  ],
});

// Tracks messages per user since bot start (for application embeds)
const msgCountMap = new Map();

// Tracks the stats-embed message to auto-refresh after ban/unban/kick actions
// key: robloxUserId (string) → { messageId, channelId }
const statsEmbedCache = new Map();

// Resolves a Discord user's linked Roblox username via Bloxlink for log display
async function resolveStaffRoblox(discordUser, guild) {
  const base = { tag: discordUser.tag, id: discordUser.id };
  if (!guild) return base;
  const linked = await bloxlink.getRobloxFromDiscord(discordUser.id, guild.id).catch(() => null);
  if (linked?.name) base.robloxName = linked.name;
  return base;
}

// ─── Slash commands ────────────────────────────────────────────────────────────
const slashDefs = [
  new SlashCommandBuilder()
    .setName('close')
    .setDescription('Close the current support ticket'),
  new SlashCommandBuilder().setName('gamereportpanel').setDescription('Post the game report panel').setDefaultMemberPermissions(0),
  new SlashCommandBuilder().setName('discordreportpanel').setDescription('Post the discord report panel').setDefaultMemberPermissions(0),
  new SlashCommandBuilder().setName('appealpanel').setDescription('Post the appeals panel').setDefaultMemberPermissions(0),
  new SlashCommandBuilder().setName('otherpanel').setDescription('Post the other tickets panel').setDefaultMemberPermissions(0),
  new SlashCommandBuilder().setName('infopanel').setDescription('Post the server info/channels panel').setDefaultMemberPermissions(0),
  new SlashCommandBuilder()
    .setName('infractions')
    .setDescription('View infraction history for a user')
    .addUserOption(o => o.setName('user').setDescription('Discord user').setRequired(true))
    .addStringOption(o => o.setName('roblox').setDescription('Roblox username (optional)').setRequired(false)),
  new SlashCommandBuilder()
    .setName('warn')
    .setDescription('Issue a formal warning (Senior Staff+)')
    .addUserOption(o => o.setName('user').setDescription('User to warn').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Reason').setRequired(true)),
  new SlashCommandBuilder()
    .setName('note')
    .setDescription("Add a staff note to a user's record (Senior Staff+)")
    .addUserOption(o => o.setName('user').setDescription('User').setRequired(true))
    .addStringOption(o => o.setName('note').setDescription('Note text').setRequired(true)),
  new SlashCommandBuilder()
    .setName('removewarn')
    .setDescription("Remove a specific infraction by index from a user's record (Senior Staff+)")
    .addUserOption(o => o.setName('user').setDescription('Discord user').setRequired(true))
    .addIntegerOption(o => o.setName('index').setDescription('Infraction index number shown in /infractions').setRequired(true).setMinValue(1)),
  new SlashCommandBuilder()
    .setName('clearwarns')
    .setDescription('Clear all warnings and notes from a user (Senior Staff+)')
    .addUserOption(o => o.setName('user').setDescription('Discord user').setRequired(true)),
  new SlashCommandBuilder().setName('play').setDescription('Play a song from YouTube').addStringOption(o => o.setName('query').setDescription('Song name or YouTube URL').setRequired(true)),
  new SlashCommandBuilder().setName('skip').setDescription('Skip the current song'),
  new SlashCommandBuilder().setName('pause').setDescription('Pause the current song'),
  new SlashCommandBuilder().setName('resume').setDescription('Resume the paused song'),
  new SlashCommandBuilder().setName('stop').setDescription('Stop music and clear queue'),
  new SlashCommandBuilder().setName('leave').setDescription('Disconnect from voice channel'),
  new SlashCommandBuilder().setName('queue').setDescription('Show the current queue'),
  new SlashCommandBuilder().setName('nowplaying').setDescription('Show the currently playing song'),
  new SlashCommandBuilder().setName('loop').setDescription('Toggle loop mode for the current song'),
  new SlashCommandBuilder()
    .setName('resetlockout')
    .setDescription('Reset anti-raid lockout for a staff member (Admin only)')
    .addUserOption(o => o.setName('user').setDescription('Staff member to unlock').setRequired(true)),
  new SlashCommandBuilder()
    .setName('gamestats')
    .setDescription('Show game statistics (Admin only)')
    .setDefaultMemberPermissions(0),
  new SlashCommandBuilder()
    .setName('tickettoggle')
    .setDescription('Toggle close-DM notifications for a ticket type (Senior Staff+)')
    .setDefaultMemberPermissions(0)
    .addStringOption(o => o
      .setName('type')
      .setDescription('Ticket type')
      .setRequired(true)
      .addChoices(
        { name: 'Game Report',      value: 'gr'     },
        { name: 'Discord Report',   value: 'dr'     },
        { name: 'Appeal',           value: 'appeal' },
        { name: 'Content Creator',  value: 'cc'     },
      )
    )
    .addStringOption(o => o
      .setName('dm')
      .setDescription('Enable or disable DMs to the ticket creator when closed by staff')
      .setRequired(true)
      .addChoices(
        { name: 'On',  value: 'on'  },
        { name: 'Off', value: 'off' },
      )
    ),
  new SlashCommandBuilder()
    .setName('groupstats')
    .setDescription('Check Roblox group member count and growth (Admin only)')
    .setDefaultMemberPermissions(0),
  new SlashCommandBuilder()
    .setName('suggestions')
    .setDescription('Suggestions tools (Admin only)')
    .setDefaultMemberPermissions(0)
    .addStringOption(o => o
      .setName('action')
      .setDescription('What to do')
      .setRequired(false)
      .addChoices(
        { name: 'Top voted (default)',               value: 'top'      },
        { name: 'Re-react all (clear + add 👍👎)',   value: 'rereact'  },
      )),
  new SlashCommandBuilder()
    .setName('apps')
    .setDescription('Manage applications (Admin only)')
    .setDefaultMemberPermissions(0)
    .addStringOption(o => o
      .setName('action')
      .setDescription('What to do')
      .setRequired(true)
      .addChoices(
        { name: 'Open',              value: 'open'  },
        { name: 'Close',             value: 'close' },
        { name: 'Post/refresh panel', value: 'setup' },
      )
    )
    .addStringOption(o => o
      .setName('type')
      .setDescription('Which application type (leave blank for all)')
      .setRequired(false)
      .addChoices(
        { name: 'Game Tester',    value: 'tester'        },
        { name: 'Discord Staff',  value: 'discord_staff' },
        { name: 'Game Staff',     value: 'game_staff'    },
        { name: 'All',            value: 'all'           },
      )
    ),
].map(c => c.toJSON());

// ─── Ready ─────────────────────────────────────────────────────────────────────
client.once(Events.ClientReady, async () => {
  console.log(`\n  Bot online: ${client.user.tag}`);

  // Custom status with game link button
  const gameUrl = process.env.ROBLOX_GAME_URL || `https://www.roblox.com/games/${process.env.ROBLOX_PLACE_ID || process.env.ROBLOX_UNIVERSE_ID}`;
  client.user.setPresence({
    status: 'online',
    activities: [{
      name: '1.8 Arena',
      type: 0, // Playing
      url: gameUrl, // Shows "Play" button on Discord — only works for Twitch/YouTube URLs natively
                    // but custom URL shows in the activity detail
    }],
  });
  try {
    const rest = new REST({ version: '10' }).setToken(config.DISCORD_TOKEN);
    await rest.put(Routes.applicationCommands(client.user.id), { body: slashDefs });
    console.log('  Slash commands registered');
  } catch (e) { console.error('Slash registration failed:', e.message); }
});

// ─── Helpers ───────────────────────────────────────────────────────────────────

async function resolveRoblox(q) {
  if (/^\d+$/.test(q)) return roblox.getUserById(q);
  const basic = await roblox.getUserByName(q);
  if (!basic) return null;
  return roblox.getUserById(basic.id);
}

async function resolveDiscordMember(guild, arg, mentionedMember) {
  if (mentionedMember) return mentionedMember;
  if (!arg) return null;
  if (/^\d{16,20}$/.test(arg)) return guild.members.fetch(arg).catch(() => null);
  const lower = arg.toLowerCase();
  let found = guild.members.cache.find(m =>
    m.user.tag.toLowerCase() === lower ||
    m.user.username.toLowerCase() === lower ||
    m.displayName.toLowerCase() === lower
  );
  if (found) return found;
  await guild.members.fetch().catch(() => {});
  return guild.members.cache.find(m =>
    m.user.tag.toLowerCase() === lower ||
    m.user.username.toLowerCase() === lower ||
    m.displayName.toLowerCase() === lower
  ) || null;
}

async function resolveBannedUser(guild, arg) {
  if (/^\d{16,20}$/.test(arg)) return guild.bans.fetch(arg).catch(() => null);
  try {
    const bans  = await guild.bans.fetch();
    const lower = arg.toLowerCase();
    return bans.find(b =>
      b.user.tag.toLowerCase() === lower || b.user.username.toLowerCase() === lower
    ) || null;
  } catch { return null; }
}

function statsRow(userId, isBanned, isAdminUser = false) {
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`gban_${userId}`).setLabel('Game Ban').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`ungban_${userId}`).setLabel('Game Unban').setStyle(ButtonStyle.Secondary).setDisabled(!isBanned),
    new ButtonBuilder().setCustomId(`gkick_${userId}`).setLabel('Game Kick').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`refresh_${userId}`).setLabel('Refresh').setStyle(ButtonStyle.Secondary),
  );
  if (!isAdminUser) return [row1];
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`changestats_${userId}`).setLabel('Change Stats').setStyle(ButtonStyle.Secondary),
  );
  return [row1, row2];
}

function ruleMenu(userId, isAdmin) {
  const opts = Object.entries(RULES).map(([key, r]) =>
    new StringSelectMenuOptionBuilder()
      .setLabel(`${key} — ${r.name}`)
      .setDescription(r.category)
      .setValue(`grule_${userId}_${key}`)
  );
  // Admins get a Custom option that lets them set their own reason and duration
  if (isAdmin) {
    opts.push(
      new StringSelectMenuOptionBuilder()
        .setLabel('Custom — Admin Override')
        .setDescription('Set a custom reason and ban duration (Admin only)')
        .setValue(`grule_${userId}_CUSTOM`)
    );
  }
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`grule_select_${userId}`)
      .setPlaceholder('Select rule violated...')
      .addOptions(opts)
  );
}

// Safe role mention — works in message content AND embed values (not field names)
function rm(id) {
  return id ? `<@&${id}>` : '`—`';
}

// ─── Info panel ─────────────────────────────────────────────────────────────
async function postInfoPanel(channel, guild) {
  const ch = (id) => id ? `<#${id}>` : '`not configured`';

  // Message 1: Support Guide with redirect buttons
  const guideEmbed = new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle('✅  Support System Guide')
    .setThumbnail(guild.iconURL({ dynamic: true }))
    .setDescription(
      '**Welcome to 1.8 Arena Support!**\n\n' +
      'To streamline and speed up our support process, we have a dedicated system for each type of request. ' +
      'Head to the appropriate channel below.'
    )
    .addFields(
      {
        name: '🎮  Game Reports',
        value: `• Have you witnessed someone breaking the rules of the game?\nHead over to ${ch(config.GAME_REPORT_CHANNEL_ID)} and click the red **Report Player** button to file a report. Then follow the instructions in your ticket channel.`,
        inline: false,
      },
      {
        name: '💬  Discord Reports',
        value: `• Did someone break a rule in our Discord server or in your DMs?\nHead over to ${ch(config.DISCORD_REPORT_CHANNEL_ID)} and click the red **Report User** button, then follow the instructions in your ticket channel.`,
        inline: false,
      },
      {
        name: '⚖️  Appeals',
        value: `• Do you think you have been unfairly banned?\nHead over to ${ch(config.APPEAL_CHANNEL_ID)} to appeal your punishment. This channel is for game appeals only.`,
        inline: false,
      },
      {
        name: '🎬  Content Creators',
        value: `• Do you create content for 1.8 Arena?\nHead over to ${ch(config.OTHER_TICKET_CHANNEL_ID)} and submit your application by clicking the **Apply for CC** option!`,
        inline: false,
      },
      {
        name: '📩  Other Concerns',
        value: `• Have an issue that does not match any of the above?\nHead to ${ch(config.OTHER_TICKET_CHANNEL_ID)} and create a ticket from the dropdown based on your reason.`,
        inline: false,
      },
    );

  // Channel redirect buttons
  const btnRow = [];
  if (config.GAME_REPORT_CHANNEL_ID)    btnRow.push(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Game Report').setEmoji('🎮').setURL(`https://discord.com/channels/${guild.id}/${config.GAME_REPORT_CHANNEL_ID}`));
  if (config.DISCORD_REPORT_CHANNEL_ID) btnRow.push(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Discord Report').setEmoji('💬').setURL(`https://discord.com/channels/${guild.id}/${config.DISCORD_REPORT_CHANNEL_ID}`));
  if (config.APPEAL_CHANNEL_ID)         btnRow.push(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Appeals').setEmoji('⚖️').setURL(`https://discord.com/channels/${guild.id}/${config.APPEAL_CHANNEL_ID}`));
  if (config.OTHER_TICKET_CHANNEL_ID)   btnRow.push(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Apply for CC').setEmoji('🎬').setURL(`https://discord.com/channels/${guild.id}/${config.OTHER_TICKET_CHANNEL_ID}`));
  if (config.OTHER_TICKET_CHANNEL_ID)   btnRow.push(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Other options').setEmoji('📩').setURL(`https://discord.com/channels/${guild.id}/${config.OTHER_TICKET_CHANNEL_ID}`));

  const components = btnRow.length ? [new ActionRowBuilder().addComponents(btnRow.slice(0,5))] : [];
  await channel.send({ embeds: [guideEmbed], components });

  // Message 2: Staff Roles
  const staffEmbed = new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle('__Roles Information__')
    .addFields(
      {
        name: '👑  Staff Roles',
        value: [
          '<@&1490849179344441396> — Owner of the server with full control over all systems and decisions.',
          '<@&1499483842707456010> — Manages the server, staff team, and overall operations. Responsible for major decisions and structure.',
          '<@&1499485348579770388> — Experienced staff members who guide and support the moderation team. They act as leaders above regular staff.',
          '<@&1499483720048967761> — Moderators who handle reports, enforce rules, and keep the server safe and organized.',
          '<@&1499483723731697826> — Staff responsible for in-game moderation and handling rule violations within the game.',
          '<@&1499493323927191652> — Tests updates and reports bugs before releases to improve game quality.',
        ].join('\n'),
        inline: false,
      },
      {
        name: '🌟  Community Roles',
        value: [
          '<@&1499672294354583743> — Helped contributing to the game in some shape or form.',
          '<@&1499537134892351571> — Former staff members who are no longer actively moderating. Please avoid pinging them for support.',
          '<@&1499495574091731045> — Members who create content (videos, media, etc.) for the community.',
          '<@&1499495615405756608> — Trusted and respected members of the community. This role is limited and only given when deserved.',
          '<@&1499672302332280912> — Helped find and fix a major game-breaking bug or multiple bugs.',
          '<@&1490849448232747018> — Default role for all members of the server after verifying.',
        ].join('\n'),
        inline: false,
      },
      {
        name: '🔔  Notification Roles',
        value: [
          '<@&1499536832650547362> — Get notified about important announcements and updates.',
          '<@&1499536825465962577> — Get pinged for giveaways and events.',
          '<@&1499537181591605298> — Get notified when chat needs activity.',
          '<@&1499536835364520067> — Get notified about development updates and progress.',
        ].join('\n'),
        inline: false,
      },
    );

  await channel.send({ embeds: [staffEmbed] });

  // Message 3: Ping role toggle buttons
  const pingEmbed = new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle('🔔  Notification Role Toggles')
    .setDescription('Click the buttons below to add or remove notification roles. These roles control which pings you receive.');

  const pingRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('pingrole_1499536832650547362').setLabel('Announcements').setStyle(ButtonStyle.Secondary).setEmoji('📢'),
    new ButtonBuilder().setCustomId('pingrole_1499536825465962577').setLabel('Giveaways').setStyle(ButtonStyle.Secondary).setEmoji('🎉'),
    new ButtonBuilder().setCustomId('pingrole_1499537181591605298').setLabel('Chat Ping').setStyle(ButtonStyle.Secondary).setEmoji('💬'),
    new ButtonBuilder().setCustomId('pingrole_1499536835364520067').setLabel('Dev Updates').setStyle(ButtonStyle.Secondary).setEmoji('⚙️'),
  );

  await channel.send({ embeds: [pingEmbed], components: [pingRow] });
}

function buildInfoPanel(guild) { return null; }

// ─── Stat change logger ───────────────────────────────────────────────────────
async function logStatChange(client, robloxUser, staffTag, field, value, action) {
  const cfg = require('./config');
  const channelId = cfg.STATS_LOG_CHANNEL_ID;
  if (!client || !channelId) return;
  try {
    const ch = await client.channels.fetch(channelId);
    if (!ch) return;
    const embed = new EmbedBuilder()
      .setColor(action === 'reset' ? 0xED4245 : 0x5865F2)
      .setTitle(action === 'reset' ? 'Stats Reset' : 'Stat Changed')
      .addFields(
        { name: 'Player',    value: `[${robloxUser.name}](https://www.roblox.com/users/${robloxUser.id}/profile)`, inline: true },
        { name: 'Changed by',value: staffTag, inline: true },
        { name: 'Field',     value: field,    inline: true },
        { name: 'New Value', value: value,    inline: true },
      )
      .setTimestamp();
    await ch.send({ embeds: [embed] });
  } catch (e) { console.error('[logStatChange]', e.message); }
}

// ─── Message commands ──────────────────────────────────────────────────────────
client.on('messageCreate', async (msg) => {
  if (msg.author.bot || !msg.guild) return;
  // Track message counts for application embeds
  msgCountMap.set(msg.author.id, (msgCountMap.get(msg.author.id) || 0) + 1);

  const member = msg.member;
  const args   = msg.content.trim().split(/\s+/);
  const cmd    = args[0]?.toLowerCase();
  if (!cmd?.startsWith('.')) return;

  // ── .checkstats / .stats / .check — all staff
  if (cmd === '.checkstats' || cmd === '.stats' || cmd === '.check') {
    if (!config.isStaff(member)) return;
    if (!args[1]) return msg.reply('Usage: `.checkstats <RobloxUsername or UserID>`');
    const loading = await msg.reply('Fetching...');
    try {
      const user = await resolveRoblox(args[1]);
      if (!user) return loading.edit(`No Roblox user found for \`${args[1]}\``);
      const { embed, isBanned } = await buildStatsEmbed(user, msg.author);
      await loading.edit({ content: '', embeds: [embed], components: statsRow(user.id, isBanned, config.isAdmin(member)) });
    } catch (e) { console.error('[checkstats]', e); loading.edit(`Error: ${e.message}`); }
    return;
  }

  // ── .ban — Discord Staff / Senior / Admin
  if (cmd === '.ban') {
    if (!config.canUseDiscordCommands(member) && !config.isAdmin(member)) return;
    const target = await resolveDiscordMember(msg.guild, args[1], msg.mentions.members.first());
    if (!target) return msg.reply('User not found. Usage: `.ban @user [reason]` or `.ban <userID> [reason]`');
    if (target.id === msg.author.id) return msg.reply('You cannot ban yourself.');
    if (!config.canAction(member, target)) return msg.reply('You cannot action someone with equal or higher rank.');
    const reason = args.slice(2).join(' ') || 'No reason provided';
    const raid   = checkRaid(msg.author.id);
    if (!raid.allowed) return msg.reply(raid.reason);
    try {
      await target.ban({ reason: `${msg.author.tag}: ${reason}`, deleteMessageSeconds: 604800 });
      addInfraction(target.id, { action: 'BAN', staff: msg.author.tag, reason });
      recordAction(msg.author.id, 'BAN', target.user.tag);
      await msg.reply({ embeds: [new EmbedBuilder().setColor(0xED4245).setTitle('User Banned')
        .setDescription(`<@${target.id}> has been banned.\nReason: ${reason}`)
        .setTimestamp()] });
      const staffObj = await resolveStaffRoblox(msg.author, msg.guild);
      await logAction(client, { action: 'BAN', target: { username: target.user.tag, discordId: target.id }, staff: staffObj, reason });
    } catch (e) { msg.reply(`Error: ${e.message}`); }
    return;
  }

  // ── .unban
  if (cmd === '.unban') {
    if (!config.canUseDiscordCommands(member) && !config.isAdmin(member)) return;
    if (!args[1]) return msg.reply('Usage: `.unban <userID or username> [reason]`');
    const reason = args.slice(2).join(' ') || 'No reason provided';
    try {
      const ban = await resolveBannedUser(msg.guild, args[1]);
      if (!ban) return msg.reply(`No active Discord ban found for \`${args[1]}\`.`);
      await msg.guild.members.unban(ban.user.id, `${msg.author.tag}: ${reason}`);
      addInfraction(ban.user.id, { action: 'UNBAN', staff: msg.author.tag, reason });
      recordAction(msg.author.id, 'UNBAN', ban.user.tag);
      await msg.reply({ embeds: [new EmbedBuilder().setColor(0x57F287).setTitle('User Unbanned')
        .setDescription(`<@${ban.user.id}> has been unbanned.\nReason: ${reason}`)
        .setTimestamp()] });
      const staffObj = await resolveStaffRoblox(msg.author, msg.guild);
      await logAction(client, { action: 'UNBAN', target: { username: ban.user.tag, discordId: ban.user.id }, staff: staffObj, reason });
    } catch (e) { msg.reply(`Error: ${e.message}`); }
    return;
  }

  // ── .gban — Game Staff / Senior / Admin
  // Usage: .gban <user> <Rule>    [reason]   e.g. .gban 0_1uv A1 test
  //        .gban <user> <1d|7d|perm> [reason]  e.g. .gban 0_1uv 3d evading
  if (cmd === '.gban') {
    if (!config.canUseGameCommands(member) && !config.isAdmin(member)) return;
    if (!args[1] || !args[2]) return msg.reply(
      `Usage: \`.gban <RobloxUser> <Rule|Duration> [reason]\`\n` +
      `Rules: ${Object.keys(RULES).join(', ')}\n` +
      `Duration examples: \`1d\`, \`7d\`, \`30d\`, \`perm\``
    );
    const ruleCode = args[2].toUpperCase();
    const isRule   = !!RULES[ruleCode];
    let customDur  = null;
    if (!isRule) {
      customDur = parseGameDuration(args[2]);
      if (!customDur) return msg.reply(
        `Invalid rule or duration. Rules: ${Object.keys(RULES).join(', ')}\n` +
        `Duration examples: \`1d\`, \`7d\`, \`30d\`, \`perm\``
      );
    }
    const raid = checkRaid(msg.author.id);
    if (!raid.allowed) return msg.reply(raid.reason);
    const loading = await msg.reply('Processing...');
    try {
      const user   = await resolveRoblox(args[1]);
      if (!user) return loading.edit(`No Roblox user found for \`${args[1]}\``);
      const reason = args.slice(3).join(' ') || 'No reason provided';
      if (isRule) {
        await executeGameBan(user, ruleCode, msg.author, reason, loading);
      } else {
        await executeGameBan(user, 'CUSTOM', msg.author, reason, loading, {
          label: customDur.label, days: customDur.days, permanent: customDur.permanent,
        });
      }
    } catch (e) { loading.edit(`Error: ${e.message}`); }
    return;
  }

  // ── .ungban — Game Staff / Senior / Admin
  if (cmd === '.ungban') {
    if (!config.canUseGameCommands(member) && !config.isAdmin(member)) return;
    if (!args[1]) return msg.reply('Usage: `.ungban <RobloxUser or UserID> [reason]`');
    const loading = await msg.reply('Processing...');
    try {
      const user = await resolveRoblox(args[1]);
      if (!user) return loading.edit('No Roblox user found.');
      await executeGameUnban(user, msg.author, args.slice(2).join(' ') || 'No reason provided', loading);
    } catch (e) { loading.edit(`Error: ${e.message}`); }
    return;
  }

  // ── .mute — Discord Staff / Senior / Admin
  if (cmd === '.mute') {
    if (!config.canUseDiscordCommands(member) && !config.isAdmin(member)) return;
    const target = await resolveDiscordMember(msg.guild, args[1], msg.mentions.members.first());
    if (!target || !args[2]) return msg.reply('Usage: `.mute @user <duration> [reason]`  e.g. `5m`, `1h`, `7d`');
    if (!config.canAction(member, target)) return msg.reply('You cannot action someone with equal or higher rank.');
    const ms = parseDuration(args[2]);
    if (!ms || ms > 28 * 86400000) return msg.reply('Invalid duration. Max 28d. Examples: `5m`, `1h`, `7d`.');
    const reason = args.slice(3).join(' ') || 'No reason provided';
    try {
      await target.timeout(ms, `${msg.author.tag}: ${reason}`);
      addInfraction(target.id, { action: 'MUTE', duration: args[2], staff: msg.author.tag, reason });
      recordAction(msg.author.id, 'MUTE', target.user.tag);
      await msg.reply({ embeds: [new EmbedBuilder().setColor(0xEB459E).setTitle('User Muted')
        .setDescription(`<@${target.id}> has been muted for **${args[2]}**.\nReason: ${reason}`)
        .setTimestamp()] });
      const staffObjMute = await resolveStaffRoblox(msg.author, msg.guild);
      await logAction(client, { action: 'MUTE', target: { username: target.user.tag, discordId: target.id }, staff: staffObjMute, duration: args[2], reason });
    } catch (e) { msg.reply(`Error: ${e.message}`); }
    return;
  }

  // ── .unmute
  if (cmd === '.unmute') {
    if (!config.canUseDiscordCommands(member) && !config.isAdmin(member)) return;
    const target = await resolveDiscordMember(msg.guild, args[1], msg.mentions.members.first());
    if (!target) return msg.reply('Usage: `.unmute @user` or `.unmute <userID>`');
    if (!config.canAction(member, target)) return msg.reply('You cannot action someone with equal or higher rank.');
    try {
      await target.timeout(null, `Removed by ${msg.author.tag}`);
      addInfraction(target.id, { action: 'UNMUTE', staff: msg.author.tag });
      recordAction(msg.author.id, 'UNMUTE', target.user.tag);
      await msg.reply(`Timeout removed for ${target.user.tag}.`);
      const staffObjUnmute = await resolveStaffRoblox(msg.author, msg.guild);
      await logAction(client, { action: 'UNMUTE', target: { username: target.user.tag, discordId: target.id }, staff: staffObjUnmute });
    } catch (e) { msg.reply(`Error: ${e.message}`); }
    return;
  }

  // ── .kick
  if (cmd === '.kick') {
    if (!config.canUseDiscordCommands(member) && !config.isAdmin(member)) return;
    const target = await resolveDiscordMember(msg.guild, args[1], msg.mentions.members.first());
    if (!target) return msg.reply('Usage: `.kick @user [reason]` or `.kick <userID> [reason]`');
    if (!config.canAction(member, target)) return msg.reply('You cannot action someone with equal or higher rank.');
    const reason = args.slice(2).join(' ') || 'No reason provided';
    try {
      await target.kick(`${msg.author.tag}: ${reason}`);
      addInfraction(target.id, { action: 'KICK', staff: msg.author.tag, reason });
      recordAction(msg.author.id, 'KICK', target.user.tag);
      await msg.reply({ embeds: [new EmbedBuilder().setColor(0xFEE75C).setTitle('User Kicked')
        .setDescription(`<@${target.id}> has been kicked.\nReason: ${reason}`)
        .setTimestamp()] });
      const staffObjKickD = await resolveStaffRoblox(msg.author, msg.guild);
      await logAction(client, { action: 'KICK', target: { username: target.user.tag, discordId: target.id }, staff: staffObjKickD, reason });
    } catch (e) { msg.reply(`Error: ${e.message}`); }
    return;
  }

  // ── .infractions
  if (cmd === '.infractions') {
    if (!config.isStaff(member)) return;
    const target = await resolveDiscordMember(msg.guild, args[1], msg.mentions.members.first());
    if (!target) return msg.reply('Usage: `.infractions @user [RobloxUsername]`');
    try {
      const embed = await buildFullInfractionEmbed(target.id, args[2] || null, client, target);
      await msg.reply({ embeds: [embed] });
    } catch (e) { msg.reply(`Error: ${e.message}`); }
    return;
  }

  // ── .modstats
  if (cmd === '.modstats') {
    if (!config.isStaff(member)) return;
    const target = msg.mentions.members.first() || member;
    if (target.id !== msg.author.id && !config.isSenior(member)) {
      return msg.reply('You can only view your own stats. Senior Staff+ can view others.');
    }
    const embed = buildModStatsEmbed(target.user.tag, target.id, 'month');
    const row   = buildModStatsRow(target.id);
    await msg.reply({ embeds: [embed], components: [row] });
    return;
  }

  // ── .resetlockout — Admin
  if (cmd === '.resetlockout') {
    if (!config.isAdmin(member)) return;
    const target = await resolveDiscordMember(msg.guild, args[1], msg.mentions.members.first());
    if (!target) return msg.reply('Usage: `.resetlockout @user`');
    resetLockout(target.id);
    msg.reply(`Anti-raid lockout cleared for ${target.user.tag}.`);
    return;
  }

  // ── .setstats — Admin
  if (cmd === '.setstats') {
    if (!config.isAdmin(member)) return;
    if (!args[1] || !args[2] || !args[3]) {
      return msg.reply(
        'Usage: `.setstats <RobloxUser> <field> <value>`\n' +
        '**Fields:** `level` `progress` `maxProgress` `rank` `coins` ' +
        '`killstreak` `lifetimeKills` `highestKillstreak` `wins` `losses` `playtime` `clicksPerSecond`\n' +
        'Example: `.setstats PlayerName level 10`'
      );
    }
    const loading = await msg.reply('Updating stats...');
    try {
      const user = await resolveRoblox(args[1]);
      if (!user) return loading.edit(`No Roblox user found for \`${args[1]}\``);
      const field    = args[2];
      const rawValue = args.slice(3).join(' ').replace(/^"|"$/g, '');
      const numFields = new Set(['level','progress','maxProgress','coins','killstreak','lifetimeKills','highestKillstreak','wins','losses','playtime','clicksPerSecond']);
      const strFields = new Set(['rank','rankName']);
      let value;
      if (numFields.has(field)) {
        value = parseFloat(rawValue);
        if (isNaN(value)) return loading.edit(`\`${field}\` must be a number. Got: \`${rawValue}\``);
      } else if (strFields.has(field)) {
        value = rawValue;
      } else {
        return loading.edit(`Unknown field \`${field}\`. Valid: ${[...numFields, ...strFields].join(', ')}`);
      }
      const current = (await roblox.getPlayerStats(user.id)) || {};
      current[field] = value;
      // Write back using ProfileStore key format
      await roblox.savePlayerStats(user.id, current);
      const embed = new EmbedBuilder().setColor(0x57F287).setTitle('Stat Updated')
        .addFields(
          { name: 'Player', value: `[${user.name}](https://www.roblox.com/users/${user.id}/profile)`, inline: true },
          { name: 'Field',  value: field,         inline: true },
          { name: 'Value',  value: String(value), inline: true },
          { name: 'Note',   value: 'Player must be **offline** and **rejoin** for changes to appear in-game (ProfileStore caches data while the player is online).', inline: false },
        ).setTimestamp();
      await loading.edit({ content: '', embeds: [embed] });
      // Log to stats channel specifically
      await logStatChange(client, user, msg.author.tag, field, String(value), 'set');
    } catch (e) { console.error('[setstats]', e); loading.edit(`Error: ${e.message}`); }
    return;
  }

  // ── .resetstats — Admin
  if (cmd === '.resetstats') {
    if (!config.isAdmin(member)) return;
    if (!args[1]) return msg.reply('Usage: `.resetstats <RobloxUser>`');
    const loading = await msg.reply('Resetting stats...');
    try {
      const user = await resolveRoblox(args[1]);
      if (!user) return loading.edit(`No Roblox user found for \`${args[1]}\``);
      const blank = { level:1, progress:0, maxProgress:5000, rank:'Unranked', coins:0, killstreak:0, lifetimeKills:0, highestKillstreak:0, wins:0, losses:0, playtime:0, clicksPerSecond:0 };
      await roblox.savePlayerStats(user.id, blank);
      await loading.edit({ content: '', embeds: [new EmbedBuilder().setColor(0xED4245).setTitle('Stats Reset')
        .setDescription(`All stats for **[${user.name}](https://www.roblox.com/users/${user.id}/profile)** have been reset to defaults.`)
        .addFields({ name: 'Reset by', value: msg.author.tag, inline: true }, { name: 'Player', value: user.name, inline: true })
        .setTimestamp()] });
      await logStatChange(client, user, msg.author.tag, 'ALL', 'defaults', 'reset');
    } catch (e) { console.error('[resetstats]', e); loading.edit(`Error: ${e.message}`); }
    return;
  }

  // ── .debugstats — Admin: raw DataStore diagnostic
  if (cmd === '.debugstats') {
    if (!config.isAdmin(member)) return;
    if (!args[1]) return msg.reply('Usage: `.debugstats <RobloxUser>`');
    const loading = await msg.reply('Running DataStore diagnostic...');
    try {
      const axios  = require('axios');
      const uniId  = process.env.ROBLOX_UNIVERSE_ID;
      const apiKey = process.env.ROBLOX_API_KEY;
      const dsName = config.PROFILESTORE_NAME;
      const prefix = config.PROFILESTORE_KEY_PREFIX;

      const lines = [
        `**Universe:** \`${uniId || 'NOT SET'}\``,
        `**API Key:** ${apiKey ? '✅ set' : '❌ NOT SET'}`,
        `**Configured DataStore:** \`${dsName}\`  key prefix: \`${prefix}\``,
        '',
      ];

      // List all DataStores in the universe so we can see the real names
      try {
        const dsListRes = await axios.get(
          `https://apis.roblox.com/datastores/v1/universes/${uniId}/standard-datastores`,
          { headers: { 'x-api-key': apiKey }, params: { limit: 20 } }
        );
        const names = (dsListRes.data.datastores || []).map(d => `\`${d.name}\``).join(', ');
        lines.push(`**DataStores in this universe:** ${names || '(none found)'}`);
      } catch (e) {
        lines.push(`**DataStore list error:** \`${e.response?.status} ${e.message}\``);
      }

      // Resolve user and try the configured key
      const user = await resolveRoblox(args[1]);
      if (!user) { lines.push(`\n❌ Roblox user not found: \`${args[1]}\``); return loading.edit(lines.join('\n')); }

      const key = `${prefix}${user.id}`;
      lines.push(`\n**Looking up** \`${key}\` in \`${dsName}\`:`);

      try {
        const raw = await roblox.dsGet(dsName, key);
        if (raw === null) {
          lines.push(`⚠️ Returned null — wrong DataStore name or key, or player hasn't played yet`);
          // Try bare userId as fallback key
          const rawBare = await roblox.dsGet(dsName, String(user.id)).catch(() => null);
          if (rawBare) lines.push(`✅ Found data under bare key \`${user.id}\` — set PROFILESTORE_KEY_PREFIX to empty`);
        } else {
          const preview = JSON.stringify(raw).slice(0, 500);
          lines.push(`✅ **Found data:**\n\`\`\`json\n${preview}\n\`\`\``);
        }
      } catch (e) {
        lines.push(`❌ Error: \`${e.response?.status || ''} ${e.message}\``);
      }

      await loading.edit(lines.join('\n'));
    } catch (e) { loading.edit(`Error: ${e.message}`); }
    return;
  }

  // ── .clearbans <RobloxUser>  (Senior Staff+)
  if (cmd === '.clearbans') {
    if (!config.isSenior(member) && !config.isAdmin(member)) return;
    if (!args[1]) return msg.reply('Usage: `.clearbans <RobloxUser>`');
    const loading = await msg.reply('Clearing ban history...');
    try {
      const user = await resolveRoblox(args[1]);
      if (!user) return loading.edit(`No Roblox user found for \`${args[1]}\``);
      const banData = await roblox.getBanData(user.id);
      const count   = (banData.history || []).length;
      banData.history = [];
      banData.active  = null;
      await roblox.saveBanData(user.id, banData).catch(e => console.error('[clearbans] DS write:', e.message));
      await roblox.unrestrictUser(user.id).catch(e => console.error('[clearbans] unrestrict:', e.message));
      await loading.edit({ content: '', embeds: [new EmbedBuilder().setColor(0xED4245).setTitle('Ban History Cleared')
        .setDescription(`All ban records for **[${user.name}](https://www.roblox.com/users/${user.id}/profile)** have been wiped.`)
        .addFields(
          { name: 'Player',    value: user.name,       inline: true },
          { name: 'Cleared by', value: msg.author.tag, inline: true },
          { name: 'Removed',   value: `${count} record(s)`, inline: true },
        ).setTimestamp()] });
      await logAction(client, { action: 'NOTE', target: { username: user.name, robloxId: user.id }, staff: { tag: msg.author.tag, id: msg.author.id }, extra: `Ban history wiped (${count} records removed)` });
    } catch (e) { loading.edit(`Error: ${e.message}`); }
    return;
  }


  // ── .purge <amount> [#channel]  (Admin)
  if (cmd === '.purge') {
    if (!config.isAdmin(member)) return;
    const amount = parseInt(args[1]);
    if (isNaN(amount) || amount < 1 || amount > 100) {
      return msg.reply('Usage: `.purge <1-100> [#channel]`');
    }
    // Target channel: mentioned channel or current channel
    const targetChannel = msg.mentions.channels.first() || msg.channel;
    try {
      // Delete the command message first so it doesn't count toward the bulk delete
      await msg.delete().catch(() => {});
      const deleted = await targetChannel.bulkDelete(amount, true); // true = skip messages >14 days
      const confirm = await targetChannel.send({
        embeds: [new EmbedBuilder().setColor(0x5865F2).setTitle('Messages Purged')
          .addFields(
            { name: 'Deleted',   value: `${deleted.size} message(s)`, inline: true },
            { name: 'Channel',   value: `<#${targetChannel.id}>`,     inline: true },
            { name: 'By',        value: msg.author.tag,               inline: true },
          ).setTimestamp()]
      });
      // Auto-delete the confirmation after 4 seconds
      setTimeout(() => confirm.delete().catch(() => {}), 4000);
      await logAction(client, { action: 'NOTE', target: { username: `#${targetChannel.name}` , isChannel: true }, staff: { tag: msg.author.tag, id: msg.author.id }, extra: `Purged ${deleted.size} messages` });
    } catch (e) { msg.channel.send(`Error: ${e.message}`).then(m => setTimeout(() => m.delete().catch(() => {}), 5000)); }
    return;
  }

  // ── .lock [#channel] [reason]  (Admin)
  if (cmd === '.lock') {
    if (!config.isAdmin(member)) return;
    const targetChannel = msg.mentions.channels.first() || msg.channel;
    const reason = args.slice(msg.mentions.channels.first() ? 2 : 1).join(' ') || 'No reason provided';
    try {
      await targetChannel.permissionOverwrites.edit(msg.guild.roles.everyone, {
        SendMessages: false,
        AddReactions: false,
      }, { reason: `Locked by ${msg.author.tag}: ${reason}` });
      await targetChannel.send({
        embeds: [new EmbedBuilder().setColor(0xED4245).setTitle('Channel Locked')
          .addFields(
            { name: 'Channel', value: `<#${targetChannel.id}>`, inline: true },
            { name: 'By',      value: msg.author.tag,           inline: true },
            { name: 'Reason',  value: reason,                   inline: false },
          ).setTimestamp()]
      });
      if (targetChannel.id !== msg.channel.id) await msg.reply(`<#${targetChannel.id}> has been locked.`);
      await logAction(client, { action: 'NOTE', target: { username: `#${targetChannel.name}` , isChannel: true }, staff: { tag: msg.author.tag, id: msg.author.id }, extra: `Channel locked: ${reason}` });
    } catch (e) { msg.reply(`Error: ${e.message}`); }
    return;
  }

  // ── .unlock [#channel] [reason]  (Admin)
  if (cmd === '.unlock') {
    if (!config.isAdmin(member)) return;
    const targetChannel = msg.mentions.channels.first() || msg.channel;
    const reason = args.slice(msg.mentions.channels.first() ? 2 : 1).join(' ') || 'No reason provided';
    try {
      await targetChannel.permissionOverwrites.edit(msg.guild.roles.everyone, {
        SendMessages: null, // null = reset to default (inherit)
        AddReactions: null,
      }, { reason: `Unlocked by ${msg.author.tag}: ${reason}` });
      await targetChannel.send({
        embeds: [new EmbedBuilder().setColor(0x57F287).setTitle('Channel Unlocked')
          .addFields(
            { name: 'Channel', value: `<#${targetChannel.id}>`, inline: true },
            { name: 'By',      value: msg.author.tag,           inline: true },
            { name: 'Reason',  value: reason,                   inline: false },
          ).setTimestamp()]
      });
      if (targetChannel.id !== msg.channel.id) await msg.reply(`<#${targetChannel.id}> has been unlocked.`);
      await logAction(client, { action: 'NOTE', target: { username: `#${targetChannel.name}` , isChannel: true }, staff: { tag: msg.author.tag, id: msg.author.id }, extra: `Channel unlocked: ${reason}` });
    } catch (e) { msg.reply(`Error: ${e.message}`); }
    return;
  }

  // ── .setslowmode <seconds> [#channel]  (Admin)
  //    0 = off, max 21600 (6 hours)
  if (cmd === '.setslowmode') {
    if (!config.isAdmin(member)) return;
    const seconds = parseInt(args[1]);
    if (isNaN(seconds) || seconds < 0 || seconds > 21600) {
      return msg.reply('Usage: `.setslowmode <0-21600> [#channel]`  — 0 disables slowmode, max 21600 (6h)');
    }
    const targetChannel = msg.mentions.channels.first() || msg.channel;
    try {
      await targetChannel.setRateLimitPerUser(seconds, `Set by ${msg.author.tag}`);
      const label = seconds === 0 ? 'Disabled' : seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.floor(seconds/60)}m ${seconds%60}s`.replace(' 0s','') : `${Math.floor(seconds/3600)}h ${Math.floor((seconds%3600)/60)}m`.replace(' 0m','');
      await msg.reply({
        embeds: [new EmbedBuilder().setColor(0x5865F2).setTitle('Slowmode Updated')
          .addFields(
            { name: 'Channel',  value: `<#${targetChannel.id}>`, inline: true },
            { name: 'Slowmode', value: label,                    inline: true },
            { name: 'By',       value: msg.author.tag,           inline: true },
          ).setTimestamp()]
      });
      await logAction(client, { action: 'NOTE', target: { username: `#${targetChannel.name}` , isChannel: true }, staff: { tag: msg.author.tag, id: msg.author.id }, extra: `Slowmode set to ${label}` });
    } catch (e) { msg.reply(`Error: ${e.message}`); }
    return;
  }



  // ── .dutypanel  — post a button panel for staff to go on/off duty
  if (cmd === '.dutypanel') {
    if (!config.isSenior(member) && !config.isAdmin(member)) return;
    const cfg = require('./config');
    const dutyRoleId = cfg.STAFF_DUTY_ROLE_ID;
    if (!dutyRoleId) return msg.reply('No Staff Duty role configured. Add `STAFF_DUTY_ROLE_ID` to your .env.');

    const embed = new EmbedBuilder()
      .setColor(0x5865F2)
      .setTitle('Staff Duty')
      .setDescription(
        'Click the button below to toggle your duty status.\n\n' +
        'When on duty you will be pinged for new support tickets.\n' +
        'Go off duty when you are not available to handle tickets.'
      )
      .setTimestamp();

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('duty_toggle')
        .setLabel('Toggle Duty')
        .setStyle(ButtonStyle.Primary),
    );

    await msg.channel.send({ embeds: [embed], components: [row] });
    await msg.delete().catch(() => {});
    return;
  }

  // ── .duty on/off  — toggle staff duty (controls ticket pings)
  if (cmd === '.duty') {
    if (!config.isStaff(member)) return;
    const cfg = require('./config');
    const dutyRoleId = cfg.STAFF_DUTY_ROLE_ID;
    if (!dutyRoleId) return msg.reply('No Staff Duty role configured. Add `STAFF_DUTY_ROLE_ID` to your .env file.');

    const toggle = (args[1] || '').toLowerCase();
    if (!['on', 'off'].includes(toggle)) return msg.reply('Usage: `.duty on` or `.duty off`');

    try {
      const dutyRole = await msg.guild.roles.fetch(dutyRoleId);
      if (!dutyRole) return msg.reply('Staff Duty role not found. Check your `STAFF_DUTY_ROLE_ID` in .env.');

      if (toggle === 'on') {
        await member.roles.add(dutyRole, 'Staff duty activated');
        await msg.reply({ embeds: [new EmbedBuilder().setColor(0x57F287).setTitle('On Duty')
          .setDescription(`${msg.author.tag} is now **on duty** and will be pinged for new tickets.`)
          .setTimestamp()] });
      } else {
        await member.roles.remove(dutyRole, 'Staff duty deactivated');
        await msg.reply({ embeds: [new EmbedBuilder().setColor(0x888888).setTitle('Off Duty')
          .setDescription(`${msg.author.tag} is now **off duty** and will not be pinged for tickets.`)
          .setTimestamp()] });
      }
    } catch (e) { msg.reply(`Error: ${e.message}`); }
    return;
  }

  // ── .gkick <RobloxUser> <reason>  — kick from game via MessagingService
  if (cmd === '.gkick') {
    if (!config.canUseGameCommands(member) && !config.isAdmin(member)) return;
    if (!args[1]) return msg.reply('Usage: `.gkick <RobloxUser> <reason>`');
    const reason  = args.slice(2).join(' ') || 'Kicked by staff';
    const loading = await msg.reply('Processing...');
    try {
      const user = await resolveRoblox(args[1]);
      if (!user) return loading.edit(`No Roblox user found for \`${args[1]}\``);
      await executeGameKick(user, msg.author, reason, loading);
    } catch (e) { loading.edit(`Error: ${e.message}`); }
    return;
  }

  // ── .close — re-post the close button inside a ticket (for staff convenience)
  if (cmd === '.close') {
    if (!config.isStaff(member)) return;
    const meta = loadTicketMeta(msg.channel.id);
    if (!meta) return msg.reply({ content: 'This command can only be used inside a ticket channel.', flags: 64 });
    const closeRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('ticket_close').setLabel('Close Ticket').setStyle(ButtonStyle.Danger)
    );
    await msg.channel.send({ content: `Close this ticket using the button below:`, components: [closeRow] });
    await msg.delete().catch(() => null);
    return;
  }

  // ── .escalate <senior|admin> [reason]  — move ticket to a restricted category
  if (cmd === '.escalate') {
    if (!config.isStaff(member)) return;
    const tier   = (args[1] || '').toLowerCase();
    const reason = args.slice(2).join(' ') || 'No reason provided';

    if (!['senior', 'admin'].includes(tier)) {
      return msg.reply('Usage: `.escalate <senior|admin> [reason]`');
    }
    if (tier === 'admin' && !config.isAdmin(member)) {
      return msg.reply('Only Admins can escalate to the admin category.');
    }

    // Must be inside a ticket channel
    const isTicket = /^(gr-|dr-|appeal-|cc-|art-|biz-)/.test(msg.channel.name);
    if (!isTicket) return msg.reply('This command can only be used inside a ticket channel.');

    const cfg        = require('./config');
    const categoryId = tier === 'admin' ? cfg.ADMIN_TICKET_CATEGORY_ID : cfg.SENIOR_TICKET_CATEGORY_ID;
    if (!categoryId) return msg.reply(`No ${tier} ticket category configured. Add \`${tier.toUpperCase()}_TICKET_CATEGORY_ID\` to your .env file.`);

    try {
      await msg.channel.setParent(categoryId, { lockPermissions: false });

      // Remove all non-senior/admin staff role overwrites so lower staff can't see it
      const R = config.ROLES;
      const restrictedIds = tier === 'admin'
        ? [R.ADMIN.id].filter(Boolean)
        : [R.SENIOR_STAFF.id, R.ADMIN.id].filter(Boolean);
      const removeIds = [R.GAME_STAFF.id, R.DISCORD_STAFF.id].filter(Boolean);

      for (const id of removeIds) {
        if (id && msg.channel.permissionOverwrites.cache.has(id)) {
          await msg.channel.permissionOverwrites.delete(id);
        }
      }

      await msg.channel.send({ embeds: [new EmbedBuilder()
        .setColor(tier === 'admin' ? 0xED4245 : 0xFEE75C)
        .setTitle(`Ticket Escalated — ${tier === 'admin' ? 'Admin' : 'Senior Staff'}`)
        .addFields(
          { name: 'Escalated by', value: msg.author.tag, inline: true },
          { name: 'Tier',         value: tier === 'admin' ? 'Admin only' : 'Senior Staff+', inline: true },
          { name: 'Reason',       value: reason, inline: false },
        ).setTimestamp()] });

      await logAction(client, { action: 'NOTE', target: { username: `#${msg.channel.name}` , isChannel: true }, staff: { tag: msg.author.tag, id: msg.author.id }, extra: `Ticket escalated to ${tier}: ${reason}` });
    } catch (e) { msg.reply(`Error: ${e.message}`); }
    return;
  }

  // ── .rules  — posts the full rules embed in the current channel
  if (cmd === '.rules') {
    if (!config.isAdmin(member)) return;
    const embed = new EmbedBuilder()
      .setColor(0x5865F2)
      .setTitle('1.8 Arena — Server Rules')
      .setDescription('Punishments depend on the severity of the offense and repeated violations.')
      .addFields(
        {
          name: 'A. Minor Offenses',
          value: [
            '**A.1 Autoclicker**',
            'Using autoclickers, macros, or minor third-party software that gives an unfair gameplay advantage.',
            '',
            '**A.2 Toxicity**',
            'Excessive trash talk, harassment, disrespect, arguments, or repeated negative behavior in chat.',
            '',
            '**Punishment:** 1st: 1 Day · 2nd: 3 Days · 3rd: 7 Days · 4th: 30 Days',
            '*Further offenses may result in a permanent ban.*',
          ].join('\n'),
        },
        {
          name: 'B. Moderate Offenses',
          value: [
            '**B.1 Stat Farming**',
            'Boosting kills, wins, stats, or progression unfairly through alt accounts, arranged farming, or abuse of game systems.',
            '',
            '**B.2 Repeated Abuse of Glitches**',
            'Intentionally using game bugs multiple times for currency, rewards, progression, or unfair competitive advantage.',
            '',
            '**B.3 Ban Evasion Attempts**',
            'Creating alternate Roblox or Discord accounts to bypass bans, kicks, mutes, or other punishments.',
            '',
            '**Punishment:** 1st: 7 Days · 2nd: 30 Days · 3rd: Permanent Ban',
          ].join('\n'),
        },
        {
          name: 'C. Severe Offenses',
          value: [
            '**C.1 Exploiting**',
            'Using scripts, executors, cheats, hacks, injectors, or any external software to gain an unfair advantage.',
            '',
            '**C.2 Major Bug Abuse**',
            "Abusing serious glitches that heavily impact the game's economy, progression, leaderboard, or competitive fairness.",
            '',
            '**Punishment: Immediate Permanent Ban**',
            '*These punishments are strict and may not be appealable depending on severity.*',
          ].join('\n'),
        },
        {
          name: 'General Conduct',
          value: [
            '• Respect all players and staff',
            '• No discrimination, slurs, or hate speech',
            '• No advertising or self-promotion',
            '• No spamming or flooding chat',
            '• Staff decisions are final — disputes go through the ticket system',
          ].join('\n'),
        },
        {
          name: 'Appeals',
          value: 'If you believe a punishment was issued unfairly, open a **Ban Appeal** ticket in the support channel. Ban appeals are reviewed on a case-by-case basis.',
        },
      )
      .setFooter({ text: '1.8 Arena — Rules are subject to change. Last updated by ' + msg.author.tag })
      .setTimestamp();

    await msg.channel.send({ embeds: [embed] });
    await msg.delete().catch(() => {});
    return;
  }


  // ── .serverinfo — list all channel and role IDs (Admin only)
  if (cmd === '.serverinfo') {
    if (!config.isAdmin(member)) return;
    const loading = await msg.reply('Fetching server info...');

    // Channels
    const channels = msg.guild.channels.cache
      .filter(c => [0,2,5,13,15].includes(c.type)) // text, voice, announcement, stage, forum
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(c => `\`${c.id}\`  #${c.name}  (${['Text','','Voice','','','Announcement','','','','','','','','Stage','','Forum'][c.type] || c.type})`);

    // Roles
    const roles = msg.guild.roles.cache
      .filter(r => r.id !== msg.guild.roles.everyone.id)
      .sort((a, b) => b.position - a.position)
      .map(r => `\`${r.id}\`  @${r.name}`);

    // Split into chunks to stay under Discord's 2000 char limit
    const chunkStr = (lines, header) => {
      const chunks = [];
      let current = header + '\n';
      for (const line of lines) {
        if (current.length + line.length + 1 > 1900) {
          chunks.push(current);
          current = '';
        }
        current += line + '\n';
      }
      if (current.trim()) chunks.push(current);
      return chunks;
    };

    const channelChunks = chunkStr(channels, '**Channels:**');
    const roleChunks    = chunkStr(roles,    '**Roles:**');

    await loading.edit(channelChunks[0] || 'No channels found.');
    for (const chunk of [...channelChunks.slice(1), ...roleChunks]) {
      await msg.channel.send(chunk);
    }
    return;
  }


  // ── .togglecc — Admin: toggle CC applications open/closed
  if (cmd === '.togglecc') {
    if (!config.isAdmin(member)) return;
    const state = loadState();
    state.ccAppsOpen = !getCCOpen();
    saveState(state);
    const isOpen = state.ccAppsOpen;
    await msg.reply({ embeds: [new EmbedBuilder()
      .setColor(isOpen ? 0x57F287 : 0xED4245)
      .setTitle(`Content Creator Applications — ${isOpen ? 'Open' : 'Closed'}`)
      .setDescription(isOpen
        ? 'Content creator applications are now **open**. Users can submit applications.'
        : 'Content creator applications are now **closed**. Users will see a closed message.')
      .setTimestamp()] });
    return;
  }

  // ── .modhelp / .help — shows only commands the caller has access to
  if (cmd === '.modhelp' || cmd === '.help') {
    if (!config.isStaff(member)) return;
    const level     = config.getMemberLevel(member);
    const isGame    = level === 1 || level >= 3;
    const isDisc    = level === 2 || level >= 3;
    const isSen     = level >= 3;
    const isAdm     = level >= 4;

    const sections = [];

    if (isGame) sections.push({
      name: '🎮  Game Moderation',
      value: [
        '`.checkstats` or `.stats` or `.check` — Player stats & ban history.',
        '`.gban <roblox> <rule> [reason]` — Apply a game ban.',
        '`.ungban <roblox> [reason]` — Remove a game ban.',
        '`.gkick <roblox> <reason>` — Kick a player from the game.',
        '`.clearbans <roblox>` — Wipe game ban history.',
      ].join('\n'),
    });

    if (isDisc) sections.push({
      name: '🔨  Discord Moderation',
      value: [
        '`.ban <user> [reason]` — Ban from the server.',
        '`.unban <user/id> [reason]` — Unban from the server.',
        '`.mute <user> <duration> [reason]` — Timeout (`5m` `1h` `7d`).',
        '`.unmute <user>` — Remove timeout.',
        '`.kick <user> [reason]` — Kick from the server.',
      ].join('\n'),
    });

    sections.push({
      name: '📋  General',
      value: [
        '`.duty on/off` — Toggle staff duty (controls ticket pings).',
        '`.infractions <user> [roblox]` — Full infraction history.',
        '`.modstats` — Your moderation statistics.',
        '`.escalate <senior|admin> [reason]` — Move ticket to higher category.',
        '`/close` — Close the current ticket.',
        '`/infractions @user` — Infraction history (slash version).',
      ].join('\n'),
    });

    if (isSen) sections.push({
      name: '⭐  Senior Staff',
      value: [
        '`/warn @user <reason>` — Formal warning (DMs user).',
        '`/note @user <note>` — Add private staff note.',
        '`/removewarn @user <index>` — Remove one infraction by index.',
        '`/clearwarns @user` — Clear all warns & notes.',
        '`.modstats @user` — View another staff member\'s stats.',
        '`.dutypanel` — Post the staff duty panel.',
      ].join('\n'),
    });

    if (isAdm) sections.push(
      {
        name: '👑  Admin',
        value: [
          '`.setstats <roblox> <field> <value>` — Override a game stat.',
          '`.resetstats <roblox>` — Reset all game stats to defaults.',
          '`.resetlockout @user` — Clear anti-raid lockout.',
          '`.togglecc` — Toggle CC applications open/closed.',
          '`.rules` — Post rules embed.',
          '`.serverinfo` — List all channel and role IDs.',
        ].join('\n'),
      },
      {
        name: '🔧  Channel Tools',
        value: [
          '`.purge <1-100> [#channel]` — Bulk delete messages.',
          '`.lock [#channel] [reason]` — Lock a channel.',
          '`.unlock [#channel] [reason]` — Unlock a channel.',
          '`.setslowmode <seconds> [#channel]` — Set slowmode.',
        ].join('\n'),
      },
      {
        name: '📢  Panels (slash only, admin)',
        value: '`/gamereportpanel` `/discordreportpanel` `/appealpanel` `/otherpanel` `/infopanel`',
      },
      {
        name: '⚖️  Rule Codes',
        value: Object.entries(RULES).map(([k, r]) => `\`${k}\` — ${r.name}`).join('\n'),
      },
    );

    const embed = new EmbedBuilder()
      .setColor(0x5865F2)
      .setTitle('📖  Command Help')
      .setDescription('Here is a list of all the available commands you can use:')
      .addFields(sections)
      .setFooter({ text: 'Accepts @mention, user ID, or username  •  Lower roles cannot action higher roles' })
      .setTimestamp();

    await msg.reply({ embeds: [embed] });
    return;
  }

});

// ─── Game ban ──────────────────────────────────────────────────────────────────
// opts: { evidence, label, days, permanent } — used for custom bans
async function executeGameBan(robloxUser, ruleCode, staffUser, reason, replyMsg, opts = {}) {
  const userId  = robloxUser.id;
  const banData = await roblox.getBanData(userId);
  const history = banData.history || [];

  const effectivePrior = history.filter(b => !b.appealedBy).length;

  let label, days, permanent;
  if (ruleCode === 'CUSTOM' && opts.label !== undefined) {
    // Custom admin ban — duration provided directly
    label     = opts.label;
    days      = opts.days;
    permanent = opts.permanent;
  } else {
    ({ label, days } = getBanDuration(ruleCode, effectivePrior));
    permanent = days === -1;
  }

  const expires  = banExpiry(days);
  const bannedAt = new Date().toISOString();
  const evidence = opts.evidence || null;

  const entry = { rule: ruleCode, reason, duration: label, permanent, bannedBy: staffUser.tag, bannedAt, expires, ...(evidence ? { evidence } : {}) };
  history.push(entry);
  banData.history = history;
  banData.active  = entry;

  // DataStore write for ban history (non-fatal — User Restrictions is the real enforcer)
  let dsWriteWarning = null;
  try {
    await roblox.saveBanData(userId, banData);
  } catch (e) {
    console.error('[gban] DS write failed:', e.message);
    dsWriteWarning = e.message.includes('403')
      ? 'Ban history not saved (DataStore 403 — API key needs `universe-datastores.objects:write`). Player IS banned via User Restrictions.'
      : `Ban history not saved: ${e.message}`;
  }

  const ruleDisplay = ruleCode === 'CUSTOM' ? 'Custom (Admin Override)' : `${ruleCode} — ${(RULES[ruleCode]?.name || 'Custom')}`;

  // Platform-level ban via Open Cloud User Restrictions API
  let restrictError = null;
  try {
    const ruleName = RULES[ruleCode]?.name || ruleCode;
    const displayName = ruleCode === 'CUSTOM' ? 'Rule violation' : ruleName;
    await roblox.restrictUser(userId, {
      days, permanent,
      privateReason: `Rule ${ruleCode} — ${ruleName}. Banned by ${staffUser.tag}. ${reason}`.slice(0, 1000),
      displayReason:  `Banned for ${displayName}${permanent ? ' permanently' : ` for ${label}`}.`,
    });
  } catch (e) {
    restrictError = e;
    const status = e.response?.status;
    console.error('[gban] User Restrictions API failed:', status, e.message);
    if (status === 403) console.warn('[gban] Add universe-user-restrictions:write to your API key at create.roblox.com/credentials');
  }

  const embed = new EmbedBuilder()
    .setColor(restrictError ? 0xFEE75C : 0xED4245)
    .setTitle(restrictError ? 'Game Ban — Partial (history only)' : 'Game Ban Applied')
    .setURL(`https://www.roblox.com/users/${userId}/profile`)
    .addFields(
      { name: 'Player',   value: `[${robloxUser.name}](https://www.roblox.com/users/${userId}/profile)`, inline: true },
      { name: 'Rule',     value: ruleDisplay, inline: true },
      { name: 'Duration', value: permanent ? 'Permanent' : label, inline: true },
      { name: 'Offense',  value: ruleCode === 'CUSTOM' ? 'Custom' : `#${effectivePrior + 1}`, inline: true },
      { name: 'Reason',   value: reason, inline: false },
      ...(expires ? [{ name: 'Expires', value: `<t:${Math.floor(new Date(expires).getTime()/1000)}:F>`, inline: false }] : []),
      ...(evidence ? [{ name: 'Evidence (staff only)', value: evidence, inline: false }] : []),
      ...(restrictError ? [{ name: '⚠️ User Restrictions API', value: `${restrictError.response?.status === 403 ? 'Add `universe-user-restrictions:write` to API key at create.roblox.com/credentials' : restrictError.message}`, inline: false }] : []),
      ...(dsWriteWarning ? [{ name: '⚠️ History', value: dsWriteWarning, inline: false }] : []),
    ).setTimestamp();

  if (replyMsg) await replyMsg.edit({ content: '', embeds: [embed], components: [] });
  recordAction(staffUser.id, 'GBAN', robloxUser.name);
  const staffObj = await resolveStaffRoblox(staffUser, client.guilds.cache.first());
  await logAction(client, { action: 'GBAN', target: { username: robloxUser.name, robloxId: userId }, staff: staffObj, rule: ruleCode, duration: label, reason, permanent, extra: evidence ? `Evidence: ${evidence}` : null });

  // Kick the player immediately if they are currently in-game
  await roblox.publishMessage('ModAction', {
    action: 'ban',
    userId: String(userId),
    reason: `${ruleCode === 'CUSTOM' ? 'Rule violation' : (RULES[ruleCode]?.name || ruleCode)}: ${reason}`,
    duration: permanent ? 'Permanent' : label,
  });
}

// ─── Game unban ────────────────────────────────────────────────────────────────
async function executeGameUnban(robloxUser, staffUser, reason, replyMsg) {
  const userId = robloxUser.id;

  const [banData, restriction] = await Promise.all([
    roblox.getBanData(userId).catch(() => ({ active: null, history: [] })),
    roblox.getUserRestriction(userId).catch(() => null),
  ]);

  const platformActive = !!restriction?.gameJoinRestriction?.active;
  const dsActive       = banData.active && isActiveBan(banData.active);

  if (!platformActive && !dsActive) {
    return replyMsg?.edit(`No active game ban found for **${robloxUser.name}**.`);
  }

  // Update DataStore record if it has an active ban entry
  if (dsActive) {
    const history = banData.history || [];
    const lastBan = [...history].reverse().find(b => b.bannedAt === banData.active.bannedAt);
    if (lastBan) { lastBan.appealedBy = staffUser.tag; lastBan.appealedAt = new Date().toISOString(); }
    banData.active  = null;
    banData.history = history;
    await roblox.saveBanData(userId, banData).catch(e => console.error('[ungban] DS write failed:', e.message));
  }

  // Lift platform-level restriction
  try {
    await roblox.unrestrictUser(userId);
  } catch (e) {
    const status = e.response?.status;
    console.error('[ungban] User Restrictions API failed:', status, e.message);
    if (replyMsg) await replyMsg.edit({ content: `Failed to lift platform ban (${status}): ${e.message}`, embeds: [], components: [] });
    return;
  }

  const embed = new EmbedBuilder().setColor(0x57F287).setTitle('Game Ban Removed')
    .addFields(
      { name: 'Player', value: `[${robloxUser.name}](https://www.roblox.com/users/${userId}/profile)`, inline: true },
      { name: 'By',     value: staffUser.tag, inline: true },
      { name: 'Reason', value: reason, inline: false },
    ).setTimestamp();

  if (replyMsg) await replyMsg.edit({ content: '', embeds: [embed], components: [] });
  recordAction(staffUser.id, 'UNGBAN', robloxUser.name);
  const staffObjUngban = await resolveStaffRoblox(staffUser, client.guilds.cache.first());
  await logAction(client, { action: 'UNGBAN', target: { username: robloxUser.name, robloxId: userId }, staff: staffObjUngban, reason });

  await roblox.publishMessage('ModAction', { action: 'unban', userId: String(userId) });
}

// ─── Game kick ────────────────────────────────────────────────────────────────
async function executeGameKick(robloxUser, staffUser, reason, replyMsg) {
  const userId = robloxUser.id;

  // Publish live kick signal using KickUser topic (hooked up in-game)
  await roblox.publishMessage('KickUser', { playerName: robloxUser.name });

  const embed = new EmbedBuilder().setColor(0xFEE75C).setTitle('Game Kick')
    .setURL(`https://www.roblox.com/users/${userId}/profile`)
    .addFields(
      { name: 'Player', value: `[${robloxUser.name}](https://www.roblox.com/users/${userId}/profile)`, inline: true },
      { name: 'By',     value: staffUser.tag, inline: true },
      { name: 'Reason', value: reason, inline: false },
      { name: 'Note',   value: 'Player will be kicked from their current server. No ban applied.', inline: false },
    ).setTimestamp();

  if (replyMsg) await replyMsg.edit({ content: '', embeds: [embed], components: [] });
  recordAction(staffUser.id, 'GKICK', robloxUser.name);
  const staffObjKick = await resolveStaffRoblox(staffUser, client.guilds.cache.first());
  await logAction(client, { action: 'GKICK', target: { username: robloxUser.name, robloxId: userId }, staff: staffObjKick, reason });
}

// ─── Interactions ──────────────────────────────────────────────────────────────
client.on(Events.InteractionCreate, async (interaction) => {

  // Music commands — available to everyone
  const musicCmds = ['play','skip','pause','resume','stop','leave','queue','nowplaying','loop'];
  if (interaction.isChatInputCommand() && musicCmds.includes(interaction.commandName)) {
    try {
      const handlers = {
        play: music.handlePlay, skip: music.handleSkip,
        pause: music.handlePause, resume: music.handleResume,
        stop: music.handleStop, leave: music.handleLeave,
        queue: music.handleQueue, nowplaying: music.handleNowPlaying,
        loop: music.handleLoop,
      };
      return await handlers[interaction.commandName](interaction);
    } catch (e) {
      console.error('[music]', e.message);
      const reply = interaction.deferred ? interaction.editReply : interaction.reply.bind(interaction);
      return reply({ content: `Music error: ${e.message}`, flags: 64 }).catch(() => {});
    }
  }

  // /close
  if (interaction.isChatInputCommand() && interaction.commandName === 'close') {
    return closeTicket(interaction, interaction.channel);
  }

  // Panel commands
  const panelCmds = ['gamereportpanel','discordreportpanel','appealpanel','otherpanel','infopanel'];
  if (interaction.isChatInputCommand() && panelCmds.includes(interaction.commandName)) {
    if (!config.isAdmin(interaction.member)) return interaction.reply({ content: 'Admin only.', flags: 64 });
    const name = interaction.commandName;
    if (name === 'gamereportpanel')    await interaction.channel.send(buildGameReportPanel());
    if (name === 'discordreportpanel') await interaction.channel.send(buildDiscordReportPanel());
    if (name === 'appealpanel')        await interaction.channel.send(buildAppealPanel());
    if (name === 'otherpanel')         await interaction.channel.send(buildOtherTicketsPanel());
    if (name === 'infopanel')          await postInfoPanel(interaction.channel, interaction.guild);
    return interaction.reply({ content: 'Panel posted.', flags: 64 });
  }

  // /infractions
  if (interaction.isChatInputCommand() && interaction.commandName === 'infractions') {
    if (!config.isStaff(interaction.member)) return interaction.reply({ content: 'Staff only.', flags: 64 });
    await interaction.deferReply();
    try {
      const targetUser   = interaction.options.getUser('user');
      const targetMember = await interaction.guild.members.fetch(targetUser.id).catch(() => null);
      const embed = await buildFullInfractionEmbed(
        targetUser.id,
        interaction.options.getString('roblox') || null,
        client,
        targetMember
      );
      return interaction.editReply({ embeds: [embed] });
    } catch (e) { return interaction.editReply(`Error: ${e.message}`); }
  }

  // /warn
  if (interaction.isChatInputCommand() && interaction.commandName === 'warn') {
    if (!config.isSenior(interaction.member)) return interaction.reply({ content: 'Senior Staff+ only.', flags: 64 });
    const target = interaction.options.getMember('user');
    const reason = interaction.options.getString('reason');
    if (!target) return interaction.reply({ content: 'User not found.', flags: 64 });
    if (!config.canAction(interaction.member, target)) return interaction.reply({ content: 'You cannot action someone with equal or higher rank.', flags: 64 });
    addInfraction(target.id, { action: 'WARN', staff: interaction.user.tag, reason });
    recordAction(interaction.user.id, 'WARN', target.user.tag);
    await interaction.reply({ embeds: [new EmbedBuilder().setColor(0xFEE75C).setTitle('Formal Warning')
      .addFields({ name: 'User', value: `${target.user.tag} (\`${target.id}\`)`, inline: true }, { name: 'Moderator', value: interaction.user.tag, inline: true }, { name: 'Reason', value: reason })
      .setTimestamp()] });
    try {
      await target.send({ embeds: [new EmbedBuilder().setColor(0xFEE75C).setTitle('Formal Warning — 1.8 Arena')
        .addFields({ name: 'Reason', value: reason }, { name: 'Issued by', value: interaction.user.tag })
        .setFooter({ text: 'Further violations may result in a mute or ban.' }).setTimestamp()] });
    } catch {}
    await logAction(client, { action: 'WARN', target: { username: target.user.tag }, staff: { tag: interaction.user.tag, id: interaction.user.id }, reason });
    return;
  }

  // /note
  if (interaction.isChatInputCommand() && interaction.commandName === 'note') {
    if (!config.isSenior(interaction.member)) return interaction.reply({ content: 'Senior Staff+ only.', flags: 64 });
    const target = interaction.options.getMember('user');
    const note   = interaction.options.getString('note');
    if (!target) return interaction.reply({ content: 'User not found.', flags: 64 });
    addInfraction(target.id, { action: 'NOTE', staff: interaction.user.tag, reason: note });
    await interaction.reply({ content: `Note added to ${target.user.tag}'s record.`, flags: 64 });
    await logAction(client, { action: 'NOTE', target: { username: target.user.tag }, staff: { tag: interaction.user.tag, id: interaction.user.id }, extra: note });
    return;
  }

  // /removewarn — remove one infraction by index
  if (interaction.isChatInputCommand() && interaction.commandName === 'removewarn') {
    if (!config.isSenior(interaction.member)) return interaction.reply({ content: 'Senior Staff+ only.', flags: 64 });
    const targetUser = interaction.options.getUser('user');
    const idx        = interaction.options.getInteger('index');
    const removed    = removeInfraction(targetUser.id, idx);
    if (!removed) {
      return interaction.reply({ content: `No infraction found at index #${idx} for that user. Check \`/infractions\` for valid indices.`, flags: 64 });
    }
    const ts = Math.floor(new Date(removed.timestamp).getTime() / 1000);
    await interaction.reply({ embeds: [new EmbedBuilder().setColor(0x57F287).setTitle('Infraction Removed')
      .addFields(
        { name: 'User',    value: `<@${targetUser.id}>`, inline: true },
        { name: 'Removed by', value: interaction.user.tag, inline: true },
        { name: 'Removed Entry', value: `#${idx} — **${removed.action}** by \`${removed.staff}\` on <t:${ts}:d>${removed.reason ? `\n↳ ${removed.reason}` : ''}`, inline: false },
      ).setTimestamp()] });
    await logAction(client, { action: 'NOTE', target: { username: targetUser.username }, staff: { tag: interaction.user.tag, id: interaction.user.id }, extra: `Removed infraction #${idx}: ${removed.action} — ${removed.reason || 'no reason'}` });
    return;
  }

  // /clearwarns — remove all warns and notes
  if (interaction.isChatInputCommand() && interaction.commandName === 'clearwarns') {
    if (!config.isSenior(interaction.member)) return interaction.reply({ content: 'Senior Staff+ only.', flags: 64 });
    const targetUser = interaction.options.getUser('user');
    const count      = clearWarnsAndNotes(targetUser.id);
    await interaction.reply({ embeds: [new EmbedBuilder().setColor(0x57F287).setTitle('Warns & Notes Cleared')
      .addFields(
        { name: 'User',       value: `<@${targetUser.id}>`, inline: true },
        { name: 'Cleared by', value: interaction.user.tag, inline: true },
        { name: 'Removed',    value: `${count} warn/note entry(ies)`, inline: true },
      ).setTimestamp()] });
    await logAction(client, { action: 'NOTE', target: { username: targetUser.username }, staff: { tag: interaction.user.tag, id: interaction.user.id }, extra: `Cleared ${count} warn/note entries` });
    return;
  }

  // /gamestats — fetch live game data from Roblox Open Cloud + public API
  if (interaction.isChatInputCommand() && interaction.commandName === 'gamestats') {
    if (!config.isAdmin(interaction.member)) return interaction.reply({ content: 'Admin only.', flags: 64 });
    await interaction.deferReply({ flags: 64 });
    try {
      const axios   = require('axios');
      const apiKey  = process.env.ROBLOX_API_KEY;
      let   placeId = process.env.ROBLOX_PLACE_ID;
      let   uniId   = process.env.ROBLOX_UNIVERSE_ID;

      // Resolve universe ID from place ID via Open Cloud if needed
      if (placeId && (!uniId || uniId === placeId)) {
        try {
          const uniRes = await axios.get(
            `https://apis.roblox.com/universes/v1/places/${placeId}/universe`,
            apiKey ? { headers: { 'x-api-key': apiKey } } : {}
          );
          uniId = String(uniRes.data.universeId);
        } catch (e) {
          console.warn('[gamestats] Place→Universe lookup failed:', e.response?.status, e.message);
        }
      }

      if (!uniId) return interaction.editReply('Set `ROBLOX_UNIVERSE_ID` or `ROBLOX_PLACE_ID` in your Railway environment variables.');

      const gameUrl = process.env.ROBLOX_GAME_URL || `https://www.roblox.com/games/${placeId || uniId}`;

      const [gamesRes, thumbRes, voteRes] = await Promise.all([
        axios.get(`https://games.roblox.com/v1/games?universeIds=${uniId}`).catch(() => null),
        axios.get(`https://thumbnails.roblox.com/v1/games/icons?universeIds=${uniId}&size=512x512&format=Png&isCircular=false`).catch(() => null),
        axios.get(`https://games.roblox.com/v1/games/votes?universeIds=${uniId}`).catch(() => null),
      ]);

      const game     = gamesRes?.data?.data?.[0];
      const thumbUrl = thumbRes?.data?.data?.[0]?.imageUrl || null;
      const votes    = voteRes?.data?.data?.[0];

      if (!game) return interaction.editReply('Could not fetch game data. Check `ROBLOX_UNIVERSE_ID` is correct.');

      const upvotes   = votes?.upVotes   ?? 0;
      const downvotes = votes?.downVotes ?? 0;
      const total     = upvotes + downvotes;
      const rating    = total > 0 ? `${Math.round((upvotes / total) * 100)}%` : 'N/A';

      const updated = new Date(game.updated).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
      const created = new Date(game.created).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

      const embed = new EmbedBuilder()
        .setColor(0x00B06F)
        .setTitle(game.name)
        .setURL(gameUrl)
        .setDescription(game.description?.slice(0, 200) || 'No description.')
        .setThumbnail(thumbUrl)
        .addFields(
          { name: 'Active Players', value: (game.playing ?? 0).toLocaleString(),           inline: true },
          { name: 'Total Visits',   value: (game.visits  ?? 0).toLocaleString(),           inline: true },
          { name: 'Favourites',     value: (game.favoritedCount ?? 0).toLocaleString(),    inline: true },
          { name: 'Rating',         value: `${rating}  (${upvotes.toLocaleString()} 👍 / ${downvotes.toLocaleString()} 👎)`, inline: false },
          { name: 'Max Players',    value: `${game.maxPlayers}`,                           inline: true },
          { name: 'Genre',          value: game.genre || 'N/A',                            inline: true },
          { name: 'Created',        value: created,                                        inline: true },
          { name: 'Last Updated',   value: updated,                                        inline: true },
          { name: 'Universe ID',    value: `\`${uniId}\``,                                inline: true },
          { name: 'Place ID',       value: placeId ? `\`${placeId}\`` : 'N/A',            inline: true },
        )
        .setFooter({ text: 'Roblox Open Cloud + Games API' })
        .setTimestamp();

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Play Now').setURL(gameUrl),
      );

      return interaction.editReply({ embeds: [embed], components: [row] });
    } catch (e) {
      console.error('[gamestats]', e.message);
      return interaction.editReply(`Error fetching game stats: ${e.message}`);
    }
  }

  // /resetlockout
  if (interaction.isChatInputCommand() && interaction.commandName === 'resetlockout') {
    if (!config.isAdmin(interaction.member)) return interaction.reply({ content: 'Admin only.', flags: 64 });
    const target = interaction.options.getMember('user');
    if (!target) return interaction.reply({ content: 'User not found.', flags: 64 });
    resetLockout(target.id);
    return interaction.reply({ content: `Lockout cleared for ${target.user.tag}.`, flags: 64 });
  }

  // Ping role toggle buttons — anyone can click these
  if (interaction.isButton() && interaction.customId.startsWith('pingrole_')) {
    const roleId = interaction.customId.split('_')[1];
    try {
      const role = await interaction.guild.roles.fetch(roleId).catch(() => null);
      if (!role) return interaction.reply({ content: 'Role not found.', flags: 64 });
      const hasDuty = interaction.member.roles.cache.has(roleId);
      if (hasDuty) {
        await interaction.member.roles.remove(role);
        return interaction.reply({ content: `Removed the **${role.name}** role.`, flags: 64 });
      } else {
        await interaction.member.roles.add(role);
        return interaction.reply({ content: `Added the **${role.name}** role.`, flags: 64 });
      }
    } catch (e) { return interaction.reply({ content: `Error: ${e.message}`, flags: 64 }); }
  }

  // Duty toggle button — staff click to go on/off duty
  if (interaction.isButton() && interaction.customId === 'duty_toggle') {
    if (!config.isStaff(interaction.member)) {
      return interaction.reply({ content: 'Staff only.', flags: 64 });
    }
    const cfg = require('./config');
    const dutyRoleId = cfg.STAFF_DUTY_ROLE_ID;
    if (!dutyRoleId) return interaction.reply({ content: 'No duty role configured.', flags: 64 });
    try {
      const dutyRole = await interaction.guild.roles.fetch(dutyRoleId);
      const hasDuty  = interaction.member.roles.cache.has(dutyRoleId);
      if (hasDuty) {
        await interaction.member.roles.remove(dutyRole, 'Off duty');
        await interaction.reply({ content: 'You are now **off duty** and will not be pinged for tickets.', flags: 64 });
      } else {
        await interaction.member.roles.add(dutyRole, 'On duty');
        await interaction.reply({ content: 'You are now **on duty** and will be pinged for new tickets.', flags: 64 });
      }
    } catch (e) { interaction.reply({ content: `Error: ${e.message}`, flags: 64 }); }
    return;
  }

  // Ticket buttons
  if (interaction.isButton() && interaction.customId === 'ticket_gr')     return handleGameReport(interaction);
  if (interaction.isButton() && interaction.customId === 'ticket_dr')     return handleDiscordReport(interaction);
  if (interaction.isButton() && interaction.customId === 'ticket_appeal') return handleAppeal(interaction);
  if (interaction.isButton() && interaction.customId === 'ticket_close')  return closeTicket(interaction, interaction.channel);

  // Ticket close (old style with suffix)
  if (interaction.isButton() && interaction.customId.startsWith('ticket_close_')) {
    return closeTicket(interaction, interaction.channel);
  }

  // Other tickets dropdown
  if (interaction.isStringSelectMenu() && interaction.customId === 'ticket_other_select') {
    const val = interaction.values[0];
    if (val === 'cc')             return handleCC(interaction);
    if (val === 'staff_game')     return apps.showAppModal(interaction, 'game_staff');
    if (val === 'staff_discord')  return apps.showAppModal(interaction, 'discord_staff');
    if (val === 'business')       return handleBusiness(interaction);
    return;
  }

  // Ticket close reason select menu
  if (interaction.isStringSelectMenu() && interaction.customId.startsWith('ticket_close_reason_')) {
    return handleCloseReason(interaction);
  }

  // Ticket modal submits
  if (interaction.type === InteractionType.ModalSubmit) {
    if (interaction.customId === 'modal_gr')       return submitGameReport(interaction);
    if (interaction.customId === 'modal_dr')       return submitDiscordReport(interaction);
    if (interaction.customId === 'modal_appeal')   return submitAppeal(interaction);
    if (interaction.customId === 'modal_cc')       return submitCC(interaction);
    if (interaction.customId === 'modal_art')      return submitArt(interaction);
    if (interaction.customId === 'modal_business') return submitBusiness(interaction);
  }

  // Stats — Game Ban button
  if (interaction.isButton() && interaction.customId.startsWith('gban_')) {
    if (!config.canUseGameCommands(interaction.member) && !config.isAdmin(interaction.member)) {
      return interaction.reply({ content: 'Game Staff only.', flags: 64 });
    }
    const userId = interaction.customId.split('_')[1];
    // Cache the stats embed message so we can refresh it after the ban
    if (interaction.message) statsEmbedCache.set(userId, { messageId: interaction.message.id, channelId: interaction.channelId });
    return interaction.reply({ content: 'Select rule violated:', components: [ruleMenu(userId, config.isAdmin(interaction.member))], flags: 64 });
  }

  // Stats — Game Unban button
  if (interaction.isButton() && interaction.customId.startsWith('ungban_')) {
    if (!config.canUseGameCommands(interaction.member) && !config.isAdmin(interaction.member)) {
      return interaction.reply({ content: 'Game Staff only.', flags: 64 });
    }
    const userId = interaction.customId.split('_')[1];
    await interaction.deferReply({ flags: 64 });
    try {
      const user = await roblox.getUserById(userId);
      await executeGameUnban(user, interaction.user, 'Unbanned via panel', null);
      const { embed } = await buildStatsEmbed(user, interaction.user);
      // Update the original stats message — unban just completed so ban is lifted
      try { await interaction.message.edit({ embeds: [embed], components: statsRow(userId, false) }); } catch {}
      await interaction.editReply({ content: `Game ban removed for **${user.name}**.` });
    } catch (e) {
      console.error('[ungban panel]', e.message);
      await interaction.editReply({ content: `Error: ${e.message}` });
    }
    return;
  }

  // Stats — Game Kick button
  if (interaction.isButton() && interaction.customId.startsWith('gkick_')) {
    if (!config.canUseGameCommands(interaction.member) && !config.isAdmin(interaction.member)) {
      return interaction.reply({ content: 'Game Staff only.', flags: 64 });
    }
    const userId = interaction.customId.split('_')[1];
    if (interaction.message) statsEmbedCache.set(userId, { messageId: interaction.message.id, channelId: interaction.channelId });
    // Show a modal to enter kick reason
    const modal = new ModalBuilder()
      .setCustomId(`gkick_modal_${userId}`)
      .setTitle('Game Kick');
    modal.addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('kick_reason')
        .setLabel('Reason for kick')
        .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(200)
        .setPlaceholder('e.g. Suspected exploiting, monitoring in progress')
    ));
    return interaction.showModal(modal);
  }

  // Stats — Refresh button
  if (interaction.isButton() && interaction.customId.startsWith('refresh_')) {
    const userId = interaction.customId.split('_')[1];
    await interaction.deferUpdate();
    try {
      const user = await roblox.getUserById(userId);
      const { embed, isBanned } = await buildStatsEmbed(user, interaction.user);
      await interaction.editReply({ embeds: [embed], components: statsRow(userId, isBanned) });
    } catch (e) { interaction.followUp({ content: `Error: ${e.message}`, flags: 64 }); }
    return;
  }

  // Rule select menu
  if (interaction.isStringSelectMenu() && interaction.customId.startsWith('grule_select_')) {
    if (!config.canUseGameCommands(interaction.member) && !config.isAdmin(interaction.member)) return;
    const selParts = interaction.values[0].split('_');
    const userId   = selParts[1];
    const ruleCode = selParts[2];
    const raid = checkRaid(interaction.user.id);
    if (!raid.allowed) return interaction.reply({ content: raid.reason, flags: 64 });

    if (ruleCode === 'CUSTOM') {
      // Admin-only custom ban modal — lets them set their own reason and duration
      if (!config.isAdmin(interaction.member)) {
        return interaction.reply({ content: 'Custom bans are Admin only.', flags: 64 });
      }
      const modal = new ModalBuilder()
        .setCustomId(`gban_modal_${userId}_CUSTOM`)
        .setTitle('Custom Ban — Admin Override');
      modal.addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('ban_reason')
            .setLabel('Reason').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(500)
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('ban_duration')
            .setLabel('Duration (e.g. 1d, 7d, 30d, permanent)')
            .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(20)
            .setPlaceholder('Examples: 1d  7d  30d  permanent')
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('ban_evidence')
            .setLabel('Evidence link (staff only, optional)')
            .setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(300)
        ),
      );
      return interaction.showModal(modal);
    }

    // Standard rule ban modal
    const modal = new ModalBuilder()
      .setCustomId(`gban_modal_${userId}_${ruleCode}`)
      .setTitle(`Ban — Rule ${ruleCode}: ${RULES[ruleCode]?.name}`);
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('ban_reason')
          .setLabel('Reason (optional)').setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(500)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('ban_evidence')
          .setLabel('Evidence link (staff only, optional)')
          .setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(300)
          .setPlaceholder('https://medal.tv/... or https://youtube.com/...')
      ),
    );
    return interaction.showModal(modal);
  }

  // Game ban modal submit
  if (interaction.type === InteractionType.ModalSubmit && interaction.customId.startsWith('gban_modal_')) {
    const withoutPrefix  = interaction.customId.slice('gban_modal_'.length);
    const lastUnderscore = withoutPrefix.lastIndexOf('_');
    const userId   = withoutPrefix.slice(0, lastUnderscore);
    const ruleCode = withoutPrefix.slice(lastUnderscore + 1);
    const reason   = interaction.fields.getTextInputValue('ban_reason') || 'No reason provided';
    const evidence = interaction.fields.getTextInputValue('ban_evidence')?.trim() || null;

    await interaction.deferReply({ flags: 64 });
    try {
      const user = await roblox.getUserById(userId);

      if (ruleCode === 'CUSTOM') {
        // Parse custom duration
        const durStr = interaction.fields.getTextInputValue('ban_duration')?.trim().toLowerCase() || '1d';
        let days;
        if (durStr === 'permanent' || durStr === 'perm') {
          days = -1;
        } else {
          const m = durStr.match(/^(\d+)d?$/);
          days = m ? parseInt(m[1]) : 1;
        }
        const label     = days === -1 ? 'Permanent' : `${days} Day${days === 1 ? '' : 's'}`;
        const permanent = days === -1;
        await executeGameBan(user, 'CUSTOM', interaction.user, reason, null, { label, days, permanent, evidence });
        await interaction.editReply({ content: `**${user.name}** has been given a custom ban: ${label}.` });
      } else {
        await executeGameBan(user, ruleCode, interaction.user, reason, null, { evidence });
        await interaction.editReply({ content: `**${user.name}** has been game-banned for rule \`${ruleCode}\` — ${RULES[ruleCode]?.name}.` });
      }

      // Refresh stats embed via cache
      try {
        const { embed } = await buildStatsEmbed(user, interaction.user);
        const cached = statsEmbedCache.get(userId);
        if (cached) {
          const ch  = await client.channels.fetch(cached.channelId).catch(() => null);
          const msg = ch ? await ch.messages.fetch(cached.messageId).catch(() => null) : null;
          if (msg) await msg.edit({ embeds: [embed], components: statsRow(userId, true) });
        }
      } catch {}
    } catch (e) {
      console.error('[gban modal]', e.message);
      await interaction.editReply({ content: `Error: ${e.message}` });
    }
    return;
  }

  // Game kick modal submit
  if (interaction.type === InteractionType.ModalSubmit && interaction.customId.startsWith('gkick_modal_')) {
    const userId = interaction.customId.slice('gkick_modal_'.length);
    const reason = interaction.fields.getTextInputValue('kick_reason');
    await interaction.deferReply({ flags: 64 });
    try {
      const user = await roblox.getUserById(userId);
      await executeGameKick(user, interaction.user, reason, null);
      // Refresh stats embed via cache
      try {
        const { embed, isBanned } = await buildStatsEmbed(user, interaction.user);
        const cached = statsEmbedCache.get(userId);
        if (cached) {
          const ch  = await client.channels.fetch(cached.channelId).catch(() => null);
          const msg = ch ? await ch.messages.fetch(cached.messageId).catch(() => null) : null;
          if (msg) await msg.edit({ embeds: [embed], components: statsRow(userId, isBanned) });
        }
      } catch {}
      await interaction.editReply({ content: `**${user.name}** has been game-kicked. Reason: ${reason}` });
    } catch (e) { await interaction.editReply({ content: `Error: ${e.message}` }); }
    return;
  }

  // Change Stats button (admin only)
  if (interaction.isButton() && interaction.customId.startsWith('changestats_')) {
    if (!config.isAdmin(interaction.member)) {
      return interaction.reply({ content: 'Admin only.', flags: 64 });
    }
    const userId = interaction.customId.split('_')[1];
    const modal = new ModalBuilder()
      .setCustomId(`changestats_modal_${userId}`)
      .setTitle('Change Player Stat');
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('stat_field')
          .setLabel('Field name')
          .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(30)
          .setPlaceholder('level, coins, rank, lifetimeKills, wins, etc.')
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('stat_value')
          .setLabel('New value')
          .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(100)
      ),
    );
    return interaction.showModal(modal);
  }

  // Change Stats modal submit
  if (interaction.type === InteractionType.ModalSubmit && interaction.customId.startsWith('changestats_modal_')) {
    if (!config.isAdmin(interaction.member)) return interaction.reply({ content: 'Admin only.', flags: 64 });
    const userId   = interaction.customId.slice('changestats_modal_'.length);
    const field    = interaction.fields.getTextInputValue('stat_field').trim();
    const rawValue = interaction.fields.getTextInputValue('stat_value').trim();
    await interaction.deferReply({ flags: 64 });
    try {
      const user    = await roblox.getUserById(userId);
      const current = (await roblox.getPlayerStats(userId)) || {};
      const numFields = new Set(['level','progress','maxProgress','coins','killstreak','lifetimeKills','highestKillstreak','wins','losses','playtime','clicksPerSecond','experience']);
      const value   = numFields.has(field) ? parseFloat(rawValue) : rawValue;
      if (numFields.has(field) && isNaN(value)) {
        return interaction.editReply(`\`${field}\` must be a number.`);
      }
      current[field] = value;
      await roblox.savePlayerStats(userId, current);
      await logStatChange(client, user, interaction.user.tag, field, String(value), 'set');
      // Refresh the stats embed
      try {
        const { embed, isBanned } = await buildStatsEmbed(user, interaction.user);
        const original = await interaction.message?.fetch().catch(() => null);
        if (original) await original.edit({ embeds: [embed], components: statsRow(userId, isBanned, true) });
      } catch {}
      await interaction.editReply({ content: `**${field}** updated to **${value}** for ${user.name}.\n-# Player must be offline and rejoin for changes to appear in-game.` });
    } catch (e) { await interaction.editReply(`Error: ${e.message}`); }
    return;
  }

  // Modstats buttons
  if (interaction.isButton() && interaction.customId.startsWith('modstats_')) {
    const parts = interaction.customId.split('_');
    const scope = parts[1];
    const modId = parts[2];
    await interaction.deferUpdate();
    try {
      const modUser = await client.users.fetch(modId);
      const embed   = buildModStatsEmbed(modUser.tag, modId, scope);
      const row     = buildModStatsRow(modId);
      await interaction.editReply({ embeds: [embed], components: [row] });
    } catch (e) { interaction.followUp({ content: `Error: ${e.message}`, flags: 64 }); }
    return;
  }

  // ── /tickettoggle ──────────────────────────────────────────────────────────
  if (interaction.isChatInputCommand() && interaction.commandName === 'tickettoggle') {
    if (!config.isSenior(interaction.member)) return interaction.reply({ content: 'Senior Staff+ only.', flags: 64 });
    const type    = interaction.options.getString('type');
    const enabled = interaction.options.getString('dm') === 'on';
    setDMToggle(type, enabled);
    const TYPE_NAMES = { gr: 'Game Report', dr: 'Discord Report', appeal: 'Appeal', cc: 'Content Creator' };
    return interaction.reply({
      embeds: [new EmbedBuilder()
        .setColor(enabled ? 0x57F287 : 0xED4245)
        .setTitle('Ticket DM Toggle Updated')
        .addFields(
          { name: 'Ticket Type', value: TYPE_NAMES[type] || type, inline: true },
          { name: 'Close DMs',   value: enabled ? '**On** — creator will be DM\'d when staff close their ticket' : '**Off** — no DM sent on close', inline: false },
        )
        .setFooter({ text: 'Changed by ' + interaction.user.tag })
        .setTimestamp()
      ],
      flags: 64,
    });
  }

  // ── /groupstats ────────────────────────────────────────────────────────────
  if (interaction.isChatInputCommand() && interaction.commandName === 'groupstats') {
    if (!config.isAdmin(interaction.member)) return interaction.reply({ content: 'Admin only.', flags: 64 });
    await interaction.deferReply({ flags: 64 });

    const GROUP_ID = 776529291;
    try {
      const { name, memberCount } = await roblox.getGroupInfo(GROUP_ID);
      const now   = new Date().toISOString();
      const state = loadState();
      const snap  = state.groupSnapshot || {};
      const last  = snap.last  || null;
      const first = snap.first || null;

      snap.last = { count: memberCount, timestamp: now };
      if (!snap.first) snap.first = { count: memberCount, timestamp: now };
      state.groupSnapshot = snap;
      saveState(state);

      const fmtDelta = n => (n >= 0 ? '+' : '') + n.toLocaleString();

      // Returns a Discord timestamp for when `target` members will be reached
      // given a rate of `perMs` members/ms. Returns '—' if rate <= 0 or already passed.
      function eta(current, target, perMs) {
        if (current >= target) return '✅ Already reached';
        if (perMs <= 0) return '—';
        const msLeft = (target - current) / perMs;
        return `<t:${Math.floor((Date.now() + msLeft) / 1000)}:R>`;
      }

      const embed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle(`${name} — Group Stats`)
        .setURL(`https://www.roblox.com/groups/${GROUP_ID}`)
        .addFields({ name: 'Members', value: memberCount.toLocaleString(), inline: true });

      if (last) {
        const growth  = memberCount - last.count;
        const msAgo   = Date.now() - new Date(last.timestamp).getTime();
        const perMs   = msAgo > 0 ? growth / msAgo : 0;
        const perHour = perMs * 3600000;
        const perDay  = perMs * 86400000;

        embed.addFields(
          { name: 'Since Last Fetch', value: fmtDelta(growth),                                                      inline: true },
          { name: 'Last Fetched',     value: `<t:${Math.floor(new Date(last.timestamp).getTime()/1000)}:R>`,        inline: true },
          { name: '​',           value: '​',                                                               inline: true },
          { name: 'Avg / Hour',       value: `${fmtDelta(Math.round(perHour))}/hr`,                                 inline: true },
          { name: 'Avg / Day',        value: `${fmtDelta(Math.round(perDay))}/day`,                                 inline: true },
          { name: '​',           value: '​',                                                               inline: true },
          { name: 'ETA — 100k',       value: eta(memberCount, 100_000,   perMs),                                    inline: true },
          { name: 'ETA — 1M',         value: eta(memberCount, 1_000_000, perMs),                                    inline: true },
          { name: '​',           value: '​',                                                               inline: true },
        );
      } else {
        embed.addFields({ name: 'Growth', value: 'No previous snapshot — run again later to see growth.' });
      }

      if (first && first.timestamp !== snap.last.timestamp) {
        const totalGrowth = memberCount - first.count;
        const msTotal     = Date.now() - new Date(first.timestamp).getTime();
        const avgDay      = msTotal > 0 ? ((totalGrowth / msTotal) * 86400000).toFixed(1) : '—';
        embed.addFields(
          { name: 'Total Growth (tracked)', value: fmtDelta(totalGrowth),                                                inline: true },
          { name: 'Avg Daily (all-time)',    value: `${avgDay}/day`,                                                     inline: true },
          { name: 'Tracking Since',          value: `<t:${Math.floor(new Date(first.timestamp).getTime()/1000)}:D>`,    inline: true },
        );
      }

      embed.setTimestamp().setFooter({ text: `Group ID: ${GROUP_ID} • ETAs based on growth since last fetch` });
      return interaction.editReply({ embeds: [embed] });
    } catch (e) {
      return interaction.editReply({ content: `Failed to fetch group stats: ${e.message}` });
    }
  }

  // ── /suggestions ──────────────────────────────────────────────────────────
  if (interaction.isChatInputCommand() && interaction.commandName === 'suggestions') {
    if (!config.isAdmin(interaction.member)) {
      return interaction.reply({ content: 'Admin only.', flags: 64 });
    }
    await interaction.deferReply({ flags: 64 });
    try {
      const forum = await client.channels.fetch(config.SUGGESTIONS_CHANNEL_ID).catch(() => null);
      if (!forum) return interaction.editReply('Suggestions channel not found. Check SUGGESTIONS_CHANNEL_ID.');

      const action = interaction.options.getString('action') ?? 'top';

      // Fetch all threads (active + up to 100 archived)
      const { threads: active } = await forum.threads.fetchActive();
      const { threads: archived } = await forum.threads.fetchArchived({ limit: 100, fetchAll: false });
      const allThreads = [...active.values(), ...archived.values()];
      if (!allThreads.length) return interaction.editReply('No suggestion posts found.');

      // ── Re-react action ──────────────────────────────────────────────────
      if (action === 'rereact') {
        await interaction.editReply(`Found **${allThreads.length}** posts. Clearing and re-adding reactions…`);
        let done = 0, failed = 0;
        for (const thread of allThreads) {
          try {
            const msg = await thread.fetchStarterMessage().catch(() => null);
            if (!msg) { failed++; continue; }
            await msg.reactions.removeAll().catch(() => null);
            await msg.react('👍');
            await msg.react('👎');
            done++;
            // Brief pause to avoid hitting rate limits
            await new Promise(r => setTimeout(r, 600));
          } catch { failed++; }
        }
        return interaction.editReply(`Done. Re-reacted on **${done}** post${done === 1 ? '' : 's'}${failed ? ` (${failed} skipped)` : ''}.`);
      }

      // ── Top voted (default) ──────────────────────────────────────────────
      const scored = [];
      for (const thread of allThreads) {
        try {
          const msg = await thread.fetchStarterMessage().catch(() => null);
          if (!msg) continue;
          const up   = msg.reactions.cache.get('👍')?.count ?? 0;
          const down = msg.reactions.cache.get('👎')?.count ?? 0;
          scored.push({ thread, url: msg.url, up, down, score: up - down });
        } catch {}
      }

      if (!scored.length) return interaction.editReply('Could not read reactions on any posts.');

      scored.sort((a, b) => b.score - a.score);
      const top = scored.slice(0, 15);

      const lines = top.map((s, i) => {
        const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
        const name  = s.thread.name.length > 60 ? s.thread.name.slice(0, 57) + '…' : s.thread.name;
        return `${medal} [${name}](${s.url}) — 👍 **${s.up}** / 👎 **${s.down}**`;
      });

      const embed = new EmbedBuilder()
        .setColor(0xFEE75C)
        .setTitle('Top Suggestions')
        .setDescription(lines.join('\n'))
        .setFooter({ text: `${scored.length} total suggestions scanned` })
        .setTimestamp();

      return interaction.editReply({ embeds: [embed] });
    } catch (e) {
      console.error('[suggestions]', e);
      return interaction.editReply(`Error: ${e.message}`);
    }
  }

  // ── /apps slash command ────────────────────────────────────────────────────
  if (interaction.isChatInputCommand() && interaction.commandName === 'apps') {
    if (!config.isAdmin(interaction.member)) {
      return interaction.reply({ content: 'Admin only.', flags: 64 });
    }
    const action  = interaction.options.getString('action');
    const appType = interaction.options.getString('type') || 'all';

    if (action === 'setup') {
      const ch = await client.channels.fetch(config.APP_CHANNEL_ID).catch(() => null);
      if (!ch) return interaction.reply({ content: 'App channel not found. Check APP_CHANNEL_ID in config.', flags: 64 });
      await apps.postPanel(ch);
      return interaction.reply({ content: `✅ Application panel posted in <#${config.APP_CHANNEL_ID}>.`, flags: 64 });
    }

    if (action === 'open' || action === 'close') {
      const open = action === 'open';
      apps.setAppOpen(appType, open);
      await apps.refreshPanel(client);

      const TYPE_LABELS = { tester: 'Game Tester', discord_staff: 'Discord Staff', game_staff: 'Game Staff', all: 'All applications' };
      const label = TYPE_LABELS[appType] || appType;
      return interaction.reply({
        content: open ? `✅ **${label}** are now **open**.` : `🔒 **${label}** are now **closed**.`,
        flags: 64,
      });
    }
    return;
  }

  // ── Application buttons (open modal) ──────────────────────────────────────
  if (interaction.isButton() && interaction.customId.startsWith('app_open_')) {
    return apps.handleAppButton(interaction);
  }

  // ── Application modal submit ──────────────────────────────────────────────
  if (interaction.type === InteractionType.ModalSubmit && interaction.customId.startsWith('app_modal_')) {
    return apps.handleAppModal(interaction, client, msgCountMap);
  }

  // ── Accept / Deny buttons ─────────────────────────────────────────────────
  if (interaction.isButton() && interaction.customId.startsWith('app_accept_')) {
    return apps.handleAppAccept(interaction, client);
  }
  if (interaction.isButton() && interaction.customId.startsWith('app_deny_')) {
    return apps.handleAppDeny(interaction, client);
  }

  // ── Close app ticket button ───────────────────────────────────────────────
  if (interaction.isButton() && interaction.customId === 'close_app_ticket') {
    return apps.handleCloseAppTicket(interaction);
  }
});

// ─── Duration parser ────────────────────────────────────────────────────────────
function parseDuration(s) {
  const m = s.match(/^(\d+)(s|m|h|d)$/i);
  if (!m) return null;
  return parseInt(m[1]) * { s: 1000, m: 60000, h: 3600000, d: 86400000 }[m[2].toLowerCase()];
}

// Returns { days, label, permanent } for game bans, or null if unrecognised
function parseGameDuration(s) {
  const lower = s.toLowerCase().trim();
  if (lower === 'perm' || lower === 'permanent' || lower === 'perma') return { days: -1, label: 'Permanent', permanent: true };
  const m = lower.match(/^(\d+(?:\.\d+)?)(h|d|w)$/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  let days;
  switch (m[2]) {
    case 'h': days = n / 24; break;
    case 'd': days = n;      break;
    case 'w': days = n * 7;  break;
  }
  const unit = m[2] === 'h' ? `Hour${n !== 1 ? 's' : ''}` : m[2] === 'd' ? `Day${n !== 1 ? 's' : ''}` : `Week${n !== 1 ? 's' : ''}`;
  return { days, label: `${n} ${unit}`, permanent: false };
}

// ─── Suggestions forum ─────────────────────────────────────────────────────────
client.on(Events.ThreadCreate, async (thread, newlyCreated) => {
  if (!newlyCreated) return;
  if (thread.parentId !== config.SUGGESTIONS_CHANNEL_ID) return;
  try {
    await new Promise(r => setTimeout(r, 1500));
    const msg = await thread.fetchStarterMessage().catch(() => null);
    if (!msg) return;
    await msg.react('👍');
    await msg.react('👎');
  } catch (e) {
    console.error('[suggestions] Auto-react failed:', e.message);
  }
});

client.on('error', err => console.error('[Discord Client Error]', err));
process.on('unhandledRejection', (reason) => console.error('[Unhandled Rejection]', reason));

client.login(config.DISCORD_TOKEN);
