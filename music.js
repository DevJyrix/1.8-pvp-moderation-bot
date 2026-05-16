// music.js — YouTube audio via bundled Lavalink (started by start.js)

const { Shoukaku, Connectors, LoadType } = require('shoukaku');
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');

// ── Node config ──────────────────────────────────────────────────────────────
function buildNodes() {
  return [{
    name:   'lavalink',
    url:    `${process.env.LAVALINK_HOST || 'localhost'}:${process.env.LAVALINK_PORT || '2333'}`,
    auth:   process.env.LAVALINK_AUTH || 'youshallnotpass',
    secure: process.env.LAVALINK_SECURE === 'true',
  }];
}

// ── State ─────────────��─────────────────────────────────���─────────────────────
let shoukaku = null;

const nodeStatus = {
  connecting: new Set(),
  connected:  new Set(),
  failed:     new Set(),
};

function totalNodes() { return nodeStatus.connecting.size + nodeStatus.connected.size + nodeStatus.failed.size; }
function allFailed()  { return nodeStatus.failed.size > 0 && nodeStatus.connected.size === 0 && nodeStatus.connecting.size === 0; }

function init(discordClient) {
  const nodes = buildNodes();
  nodes.forEach(n => nodeStatus.connecting.add(n.name));

  shoukaku = new Shoukaku(new Connectors.DiscordJS(discordClient), nodes, {
    moveOnDisconnect: false,
    resumable:        false,
    reconnectTries:   2,
    reconnectInterval: 5,
    restTimeout:      15000,
  });

  shoukaku.on('ready', name => {
    nodeStatus.connecting.delete(name);
    nodeStatus.failed.delete(name);
    nodeStatus.connected.add(name);
    console.log(`[Lavalink] Connected to ${name}`);
  });

  shoukaku.on('error', (name, e) => {
    nodeStatus.connecting.delete(name);
    nodeStatus.connected.delete(name);
    nodeStatus.failed.add(name);
    console.error(`[Lavalink:${name}] ${e.message}`);
  });

  shoukaku.on('disconnect', name => {
    nodeStatus.connected.delete(name);
    nodeStatus.connecting.add(name);
    console.warn(`[Lavalink] ${name} disconnected`);
  });

  setTimeout(() => {
    if (nodeStatus.connected.size === 0) {
      console.error('[Lavalink] No nodes connected after 30s — check Lavalink startup logs.');
    }
  }, 30_000);
}

function getNode() {
  const node = shoukaku?.getIdealNode();
  if (node) return node;

  if (allFailed()) throw new Error('Music service failed to start — check the logs.');
  throw new Error('Music service is still starting up — please try again in a few seconds.');
}

// ── Helpers ──────��────────────────────────────────────────────────────────────
function fmtDuration(secs) {
  if (!secs) return 'Live';
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`
    : `${m}:${String(s).padStart(2,'0')}`;
}

async function resolveTopTracks(query, n = 5) {
  const node = getNode();
  const isUrl = /^https?:\/\//i.test(query);
  const identifier = isUrl ? query : `ytsearch:${query}`;

  const result = await node.rest.resolve(identifier);
  if (!result || result.loadType === LoadType.EMPTY)
    throw new Error('No results found.');
  if (result.loadType === LoadType.ERROR)
    throw new Error(result.data?.message || 'Search failed.');

  let raw = [];
  if      (result.loadType === LoadType.SEARCH)   raw = Array.isArray(result.data) ? result.data : [];
  else if (result.loadType === LoadType.TRACK)    raw = result.data ? [result.data] : [];
  else if (result.loadType === LoadType.PLAYLIST) raw = result.data?.tracks || [];

  raw = raw.slice(0, n);
  if (!raw.length) throw new Error('No results found.');

  return raw.map(t => ({
    encoded:   t.encoded,
    url:       t.info.uri,
    title:     t.info.title,
    duration:  fmtDuration(Math.floor((t.info.length || 0) / 1000)),
    thumbnail: t.info.artworkUrl || null,
    channel:   t.info.author || 'Unknown',
  }));
}

// ── Per-guild state ──────────���────────────────────────────────────────────────
const queues            = new Map();
const pendingSelections = new Map();

function getQueue(guildId) { return queues.get(guildId) || null; }

function destroyQueue(guildId) {
  const q = queues.get(guildId);
  if (!q) return;
  queues.delete(guildId);
  try { shoukaku?.leaveVoiceChannel(guildId); } catch {}
}

async function playNext(guildId) {
  const q = queues.get(guildId);
  if (!q) return;

  if (!q.tracks.length) {
    if (q.loop && q.current) {
      q.tracks.push({ ...q.current });
    } else {
      q.current = null;
      setTimeout(() => {
        const s = queues.get(guildId);
        if (s && !s.current && !s.tracks.length) {
          destroyQueue(guildId);
          s.textChannel?.send({
            embeds: [new EmbedBuilder().setColor(0x5865F2).setDescription('Queue finished — disconnecting.')]
          }).catch(() => {});
        }
      }, 5 * 60 * 1000);
      return;
    }
  }

  const track = q.tracks.shift();
  q.current   = track;

  try {
    await q.player.playTrack({ track: { encoded: track.encoded } });
    q.textChannel?.send({
      embeds: [new EmbedBuilder().setColor(0x5865F2).setTitle('Now Playing')
        .setDescription(`[${track.title}](${track.url})`)
        .addFields(
          { name: 'Duration',     value: track.duration,    inline: true },
          { name: 'Requested by', value: track.requestedBy, inline: true },
        )
        .setThumbnail(track.thumbnail).setTimestamp()
      ]
    }).catch(() => {});
  } catch (e) {
    console.error('[music] Playback error:', e.message);
    q.textChannel?.send(`Could not play **${track.title}**: ${e.message}`).catch(() => {});
    playNext(guildId);
  }
}

async function setupQueue(interaction, vcChannel) {
  const existing = getQueue(interaction.guild.id);
  if (existing) return existing;

  const player = await shoukaku.joinVoiceChannel({
    guildId:   interaction.guild.id,
    channelId: vcChannel.id,
    shardId:   interaction.guild.shardId || 0,
    deaf:      true,
  });

  const q = { player, tracks: [], current: null, textChannel: interaction.channel, loop: false };
  queues.set(interaction.guild.id, q);

  const guildId = interaction.guild.id;

  player.on('end', data => {
    if (data?.reason === 'replaced') return;
    playNext(guildId);
  });
  player.on('exception', ex => {
    console.error('[Lavalink] Track exception:', ex?.exception?.message || ex);
    const q2 = queues.get(guildId);
    if (q2) q2.textChannel?.send(`Playback error: ${ex?.exception?.message || 'unknown'}`).catch(() => {});
    playNext(guildId);
  });
  player.on('stuck', () => {
    console.warn('[Lavalink] Track stuck, skipping');
    playNext(guildId);
  });
  player.on('closed', () => {
    const q2 = queues.get(guildId);
    if (q2) {
      q2.textChannel?.send({
        embeds: [new EmbedBuilder().setColor(0x5865F2).setDescription('Disconnected from voice channel.')]
      }).catch(() => {});
    }
    destroyQueue(guildId);
  });

  return q;
}

async function enqueueAndPlay(interaction, track, vcChannel) {
  const q = await setupQueue(interaction, vcChannel);
  q.tracks.push(track);
  const wasIdle = !q.current;
  if (wasIdle) playNext(interaction.guild.id);
  return { wasIdle, position: q.tracks.length };
}

function makeAddedEmbed(track, position) {
  return new EmbedBuilder().setColor(0x5865F2).setTitle('Added to Queue')
    .setDescription(`[${track.title}](${track.url})`)
    .addFields(
      { name: 'Duration', value: track.duration,   inline: true },
      { name: 'Position', value: `#${position}`,   inline: true },
    ).setThumbnail(track.thumbnail);
}

// ── Slash handlers ───────────────────��────────────────────────────────────────

async function handlePlay(interaction) {
  const query = interaction.options.getString('query', true).trim();
  const vc    = interaction.member.voice?.channel;
  if (!vc) return interaction.reply({ content: 'Join a voice channel first.', flags: 64 });
  const perms = vc.permissionsFor(interaction.client.user);
  if (!perms.has('Connect') || !perms.has('Speak'))
    return interaction.reply({ content: 'I need Connect and Speak permissions in your voice channel.', flags: 64 });

  await interaction.deferReply();

  // Give a meaningful status based on node connection state
  if (!shoukaku?.getIdealNode()) {
    if (allFailed()) return interaction.editReply('Music service failed to start — check the bot logs.');
    return interaction.editReply('Music service is still starting up — please try again in a few seconds.');
  }

  const isUrl = /^https?:\/\//i.test(query);
  let tracks;
  try {
    tracks = await resolveTopTracks(query, isUrl ? 1 : 5);
  } catch (e) {
    return interaction.editReply(`Nothing found for **${query}**: ${e.message}`);
  }

  // Direct URL or single result — play immediately
  if (isUrl || tracks.length === 1) {
    const track = { ...tracks[0], requestedBy: interaction.user.tag };
    const { wasIdle, position } = await enqueueAndPlay(interaction, track, vc);
    return interaction.editReply({
      embeds: [wasIdle
        ? new EmbedBuilder().setColor(0x5865F2).setDescription(`Starting **[${track.title}](${track.url})**`)
        : makeAddedEmbed(track, position)
      ],
    });
  }

  // Multiple search results — show numbered picker
  const embed = new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle(`Search results for: ${query}`)
    .setDescription(
      tracks.map((t, i) => `**${i + 1}.** [${t.title}](${t.url})\n└ ${t.channel} · ${t.duration}`).join('\n\n')
    )
    .setFooter({ text: 'Select a track within 30 seconds' });

  const row1 = new ActionRowBuilder().addComponents(
    ...tracks.map((_, i) =>
      new ButtonBuilder()
        .setCustomId(`music_select_${interaction.user.id}_${i}`)
        .setLabel(`${i + 1}`)
        .setStyle(ButtonStyle.Primary)
    )
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`music_cancel_${interaction.user.id}`)
      .setLabel('Cancel')
      .setStyle(ButtonStyle.Secondary)
  );

  pendingSelections.set(interaction.user.id, {
    tracks,
    vcId:      vc.id,
    guildId:   interaction.guild.id,
    expiresAt: Date.now() + 30_000,
  });

  await interaction.editReply({ embeds: [embed], components: [row1, row2] });

  setTimeout(() => {
    if (!pendingSelections.has(interaction.user.id)) return;
    pendingSelections.delete(interaction.user.id);
    interaction.editReply({
      embeds: [EmbedBuilder.from(embed).setFooter({ text: 'Selection timed out.' })],
      components: [],
    }).catch(() => {});
  }, 30_000);
}

async function handleMusicButton(interaction) {
  const { customId } = interaction;
  const userId = interaction.user.id;

  if (customId === `music_cancel_${userId}`) {
    pendingSelections.delete(userId);
    return interaction.update({
      embeds: [new EmbedBuilder().setColor(0x5865F2).setDescription('Cancelled.')],
      components: [],
    });
  }

  const match = customId.match(/^music_select_(.+)_(\d+)$/);
  if (!match || match[1] !== userId)
    return interaction.reply({ content: "That's not your search.", flags: 64 });

  const pending = pendingSelections.get(userId);
  if (!pending || Date.now() > pending.expiresAt) {
    pendingSelections.delete(userId);
    return interaction.update({
      embeds: [new EmbedBuilder().setColor(0x5865F2).setDescription('This selection has expired.')],
      components: [],
    });
  }

  const idx       = parseInt(match[2], 10);
  const trackInfo = pending.tracks[idx];
  if (!trackInfo) return interaction.update({ components: [] });
  pendingSelections.delete(userId);

  const vc = interaction.member.voice?.channel;
  if (!vc) {
    return interaction.update({
      embeds: [new EmbedBuilder().setColor(0xFF0000).setDescription('Join a voice channel first.')],
      components: [],
    });
  }

  await interaction.update({
    embeds: [new EmbedBuilder().setColor(0x5865F2).setDescription(`Loading **${trackInfo.title}**…`)],
    components: [],
  });

  const track = { ...trackInfo, requestedBy: interaction.user.tag };
  const { wasIdle, position } = await enqueueAndPlay(interaction, track, vc);
  return interaction.editReply({
    embeds: [wasIdle
      ? new EmbedBuilder().setColor(0x5865F2).setDescription(`Starting **[${track.title}](${track.url})**`)
      : makeAddedEmbed(track, position)
    ],
  });
}

async function handleSkip(interaction) {
  const q = getQueue(interaction.guild.id);
  if (!q?.current) return interaction.reply({ content: 'Nothing is playing.', flags: 64 });
  const title = q.current.title;
  await q.player.stopTrack();
  return interaction.reply({ embeds: [new EmbedBuilder().setColor(0x5865F2).setDescription(`Skipped **${title}**`)] });
}

async function handlePause(interaction) {
  const q = getQueue(interaction.guild.id);
  if (!q?.current) return interaction.reply({ content: 'Nothing is playing.', flags: 64 });
  if (q.player.paused) return interaction.reply({ content: 'Already paused.', flags: 64 });
  await q.player.setPaused(true);
  return interaction.reply({ embeds: [new EmbedBuilder().setColor(0x5865F2).setDescription('Paused.')] });
}

async function handleResume(interaction) {
  const q = getQueue(interaction.guild.id);
  if (!q?.current) return interaction.reply({ content: 'Nothing is playing.', flags: 64 });
  if (!q.player.paused) return interaction.reply({ content: 'Not paused.', flags: 64 });
  await q.player.setPaused(false);
  return interaction.reply({ embeds: [new EmbedBuilder().setColor(0x5865F2).setDescription('Resumed.')] });
}

async function handleStop(interaction) {
  if (!getQueue(interaction.guild.id))
    return interaction.reply({ content: 'Not in a voice channel.', flags: 64 });
  destroyQueue(interaction.guild.id);
  return interaction.reply({ embeds: [new EmbedBuilder().setColor(0x5865F2).setDescription('Stopped and cleared the queue.')] });
}

async function handleLeave(interaction) {
  if (!getQueue(interaction.guild.id))
    return interaction.reply({ content: 'Not in a voice channel.', flags: 64 });
  destroyQueue(interaction.guild.id);
  return interaction.reply({ embeds: [new EmbedBuilder().setColor(0x5865F2).setDescription('Left voice channel.')] });
}

async function handleQueue(interaction) {
  const q = getQueue(interaction.guild.id);
  if (!q?.current && !q?.tracks?.length)
    return interaction.reply({ content: 'Queue is empty.', flags: 64 });
  const lines = [];
  if (q.current) lines.push(`**Now Playing:** [${q.current.title}](${q.current.url}) (${q.current.duration})`);
  if (q.tracks.length) {
    lines.push('\n**Up Next:**');
    q.tracks.slice(0, 10).forEach((t, i) => lines.push(`${i + 1}. [${t.title}](${t.url}) — ${t.duration}`));
    if (q.tracks.length > 10) lines.push(`...and ${q.tracks.length - 10} more`);
  }
  return interaction.reply({ embeds: [new EmbedBuilder().setColor(0x5865F2).setTitle('Queue').setDescription(lines.join('\n'))] });
}

async function handleNowPlaying(interaction) {
  const q = getQueue(interaction.guild.id);
  if (!q?.current) return interaction.reply({ content: 'Nothing is playing.', flags: 64 });
  const t = q.current;
  return interaction.reply({
    embeds: [new EmbedBuilder().setColor(0x5865F2).setTitle('Now Playing')
      .setDescription(`[${t.title}](${t.url})`)
      .addFields(
        { name: 'Duration',     value: t.duration,    inline: true },
        { name: 'Requested by', value: t.requestedBy, inline: true },
        { name: 'Queue',        value: `${q.tracks.length} track(s) remaining`, inline: true },
      )
      .setThumbnail(t.thumbnail)
    ]
  });
}

async function handleLoop(interaction) {
  const q = getQueue(interaction.guild.id);
  if (!q?.current) return interaction.reply({ content: 'Nothing is playing.', flags: 64 });
  q.loop = !q.loop;
  return interaction.reply({
    embeds: [new EmbedBuilder().setColor(0x5865F2)
      .setDescription(q.loop ? 'Loop enabled — current track will repeat.' : 'Loop disabled.')
    ]
  });
}

module.exports = {
  init,
  handlePlay, handleMusicButton,
  handleSkip, handlePause, handleResume,
  handleStop, handleLeave, handleQueue, handleNowPlaying, handleLoop,
};
