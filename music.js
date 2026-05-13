/**
 * music.js — YouTube audio player
 * Uses yt-dlp + FFmpeg for streaming. Includes song picker UI.
 */

const {
  joinVoiceChannel, createAudioPlayer, createAudioResource,
  AudioPlayerStatus, VoiceConnectionStatus, entersState,
} = require('@discordjs/voice');
const YTDlpWrap = require('yt-dlp-wrap').default || require('yt-dlp-wrap');
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');
const { spawn, execFileSync } = require('child_process');
const path = require('path');
const fs   = require('fs');

// ffmpeg — prefer ffmpeg-static, fall back to system install
let ffmpegPath;
try {
  ffmpegPath = require('ffmpeg-static');
  if (!ffmpegPath || !fs.existsSync(ffmpegPath)) throw new Error();
} catch {
  ffmpegPath = 'ffmpeg';
}

// ── yt-dlp binary ─────────────────────────────────────────────────────────────
const BIN_DIR  = path.join(__dirname, 'bin');
fs.mkdirSync(BIN_DIR, { recursive: true });
const BIN_PATH = path.join(BIN_DIR, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
let YTDLP_BIN  = null;

async function ensureYtdlp() {
  if (YTDLP_BIN) return;
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    const p = execFileSync(cmd, ['yt-dlp'], { encoding: 'utf8' }).trim().split('\n')[0];
    if (p && fs.existsSync(p)) { YTDLP_BIN = p; return; }
  } catch {}
  if (fs.existsSync(BIN_PATH)) { YTDLP_BIN = BIN_PATH; return; }
  console.log('[music] Downloading yt-dlp binary...');
  try {
    await YTDlpWrap.downloadFromGithub(BIN_PATH);
    if (process.platform !== 'win32') fs.chmodSync(BIN_PATH, '755');
    YTDLP_BIN = BIN_PATH;
    console.log('[music] yt-dlp ready at', BIN_PATH);
  } catch (e) {
    console.error('[music] Failed to download yt-dlp:', e.message);
  }
}

// Ensure Node.js is in PATH so yt-dlp can use it for n-challenge solving
const YTDLP_ENV = {
  ...process.env,
  PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH || ''}`,
};

// ── yt-dlp options ────────────────────────────────────────────────────────────
const YTDLP_BASE = [
  '--format', 'bestaudio[ext=webm]/bestaudio[ext=m4a]/bestaudio/best',
  '--no-playlist',
  '--no-check-certificate',
  '--extractor-args', 'youtube:player_client=web_embedded,tv,mweb',
  '--age-limit', '25',
];

// Detect which browser is installed so we can pull YouTube cookies automatically.
// This bypasses bot-detection without any manual setup from the user.
function detectBrowser() {
  const isWin = process.platform === 'win32';
  const isMac = process.platform === 'darwin';
  const local   = process.env.LOCALAPPDATA || '';
  const roaming = process.env.APPDATA || '';
  const home    = process.env.HOME || '';

  if (isWin) {
    if (fs.existsSync(path.join(local,   'Google/Chrome/User Data')))    return 'chrome';
    if (fs.existsSync(path.join(local,   'Microsoft/Edge/User Data')))   return 'edge';
    if (fs.existsSync(path.join(local,   'BraveSoftware/Brave-Browser/User Data'))) return 'brave';
    const ffDir = path.join(roaming, 'Mozilla/Firefox/Profiles');
    if (fs.existsSync(ffDir)) return 'firefox';
  } else if (isMac) {
    if (fs.existsSync(path.join(home, 'Library/Application Support/Google/Chrome'))) return 'chrome';
    if (fs.existsSync(path.join(home, 'Library/Application Support/Firefox')))       return 'firefox';
  } else {
    if (fs.existsSync(path.join(home, '.config/google-chrome'))) return 'chrome';
    if (fs.existsSync(path.join(home, '.mozilla/firefox')))      return 'firefox';
  }
  return null;
}

// Cookie priority:
//   1. cookies.txt file in bot folder (manual export)
//   2. YOUTUBE_COOKIES env var (Railway / server deployments — paste file contents there)
//   3. Browser auto-detect (local Windows/Mac dev machine)
const COOKIES_FILE = path.join(__dirname, 'cookies.txt');
const TEMP_COOKIES = path.join(require('os').tmpdir(), 'arena-bot-yt-cookies.txt');

if (fs.existsSync(COOKIES_FILE)) {
  YTDLP_BASE.push('--cookies', COOKIES_FILE);
  console.log('[music] Auth: cookies.txt');
} else if (process.env.YOUTUBE_COOKIES) {
  fs.writeFileSync(TEMP_COOKIES, process.env.YOUTUBE_COOKIES, 'utf8');
  YTDLP_BASE.push('--cookies', TEMP_COOKIES);
  console.log('[music] Auth: YOUTUBE_COOKIES env var');
} else {
  const browser = detectBrowser();
  if (browser) {
    YTDLP_BASE.push('--cookies-from-browser', browser);
    console.log(`[music] Auth: browser cookies (${browser})`);
  } else {
    console.log('[music] Auth: none — some videos may be blocked on server IPs');
  }
}

const YTDLP_ARGS      = [...YTDLP_BASE, '--get-url'];
const YTDLP_INFO_ARGS = [...YTDLP_BASE, '--dump-json'];

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmtDuration(secs) {
  if (!secs) return 'Live';
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`
    : `${m}:${String(s).padStart(2,'0')}`;
}

function parseYtdlpError(stderr) {
  if (stderr.includes('Sign in to confirm') || stderr.includes('confirm you\'re not a bot'))
    return 'YouTube blocked this request (bot detection). Make sure you\'re logged into YouTube in your browser and restart the bot.';
  if (stderr.includes('DRM protected'))
    return 'YouTube blocked this video (bot detection). Make sure you\'re logged into YouTube in your browser and restart the bot.';
  if (stderr.includes('Private video'))
    return 'This video is private.';
  if (stderr.includes('not available') || stderr.includes('unavailable'))
    return 'This video is not available in this region or has been removed.';
  return null;
}

async function ytdlpJson(args) {
  return new Promise((resolve, reject) => {
    let out = '', err = '';
    const proc = spawn(YTDLP_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'], env: YTDLP_ENV });
    proc.stdout.on('data', d => out += d.toString());
    proc.stderr.on('data', d => err += d.toString());
    proc.on('close', code => {
      if (code !== 0) {
        const friendly = parseYtdlpError(err);
        if (friendly) return reject(new Error(friendly));
        const detail = err.trim() ? ': ' + err.trim().split('\n').slice(-3).join(' | ') : '';
        return reject(new Error(`yt-dlp exited with code ${code}${detail}`));
      }
      try { resolve(JSON.parse(out.trim())); }
      catch { reject(new Error('Failed to parse yt-dlp output')); }
    });
    proc.on('error', reject);
  });
}

async function getDirectUrl(trackUrl) {
  await ensureYtdlp();
  return new Promise((resolve, reject) => {
    let out = '', err = '';
    const proc = spawn(YTDLP_BIN, [...YTDLP_ARGS, trackUrl], { stdio: ['ignore', 'pipe', 'pipe'], env: YTDLP_ENV });
    proc.stdout.on('data', d => out += d.toString());
    proc.stderr.on('data', d => err += d.toString());
    proc.on('close', code => {
      const url = out.trim().split('\n')[0];
      if (code !== 0 || !url) {
        const friendly = parseYtdlpError(err);
        if (friendly) return reject(new Error(friendly));
        const detail = err.trim() ? ': ' + err.trim().split('\n').slice(-3).join(' | ') : '';
        return reject(new Error(`yt-dlp failed to get stream URL${detail}`));
      }
      resolve(url);
    });
    proc.on('error', reject);
  });
}

// Returns up to n track info objects for a query (or 1 for a direct URL)
async function resolveTopTracks(query, n = 5) {
  await ensureYtdlp();
  const isUrl = /^https?:\/\//i.test(query);
  const searchQuery = isUrl ? query : `ytsearch${n}:${query}`;
  const info = await ytdlpJson([...YTDLP_INFO_ARGS, searchQuery]);
  const entries = info.entries ? info.entries.slice(0, n) : (info.id ? [info] : []);
  if (!entries.length) throw new Error('No results found.');
  return entries.map(v => ({
    url:      v.webpage_url || v.url,
    title:    v.title,
    duration: fmtDuration(v.duration),
    thumbnail: v.thumbnail || null,
    channel:  v.channel || v.uploader || 'Unknown',
  }));
}

// ── Per-guild state ───────────────────────────────────────────────────────────
const queues           = new Map(); // guildId → queue
const pendingSelections = new Map(); // userId  → { tracks, vcId, guildId, expiresAt }

function getQueue(guildId) { return queues.get(guildId) || null; }

function destroyQueue(guildId) {
  const q = queues.get(guildId);
  if (!q) return;
  if (q.ytdlpProc)  { try { q.ytdlpProc.kill('SIGKILL');  } catch {} }
  if (q.ffmpegProc) { try { q.ffmpegProc.kill('SIGKILL'); } catch {} }
  try { q.player.stop(true); }    catch {}
  try { q.connection.destroy(); } catch {}
  queues.delete(guildId);
}

async function playNext(guildId) {
  const q = queues.get(guildId);
  if (!q) return;

  if (!q.tracks.length) {
    // Re-queue current track when loop is on
    if (q.loop && q.current) {
      q.tracks.push(q.current);
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
    if (q.ytdlpProc)  { try { q.ytdlpProc.kill('SIGKILL');  } catch {} q.ytdlpProc  = null; }
    if (q.ffmpegProc) { try { q.ffmpegProc.kill('SIGKILL'); } catch {} q.ffmpegProc = null; }

    const directUrl = await getDirectUrl(track.url);

    const ffmpegProc = spawn(ffmpegPath, [
      '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
      '-i', directUrl, '-vn',
      '-c:a', 'libopus', '-b:a', '128k', '-ar', '48000', '-ac', '2',
      '-f', 'ogg', 'pipe:1',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    ffmpegProc.stderr.on('data', d => {
      const m = d.toString();
      if (!m.includes('size=') && !m.includes('time=')) console.error('[ffmpeg]', m.trim());
    });
    ffmpegProc.on('error', err => console.error('[ffmpeg] spawn error:', err.message));
    q.ffmpegProc = ffmpegProc;

    const resource = createAudioResource(ffmpegProc.stdout, {
      inputType: require('@discordjs/voice').StreamType.OggOpus,
    });
    q.player.play(resource);

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

// ── Queue helper ──────────────────────────────────────────────────────────────

function setupQueue(interaction, vcChannel) {
  const existing = getQueue(interaction.guild.id);
  if (existing) return existing;

  const connection = joinVoiceChannel({
    channelId:      vcChannel.id,
    guildId:        interaction.guild.id,
    adapterCreator: interaction.guild.voiceAdapterCreator,
  });
  interaction.guild.members.me.voice.setDeaf(true).catch(() => {});

  const player = createAudioPlayer();
  const q = {
    connection, player,
    tracks: [], current: null,
    textChannel: interaction.channel,
    ytdlpProc: null, ffmpegProc: null,
    loop: false,
  };
  queues.set(interaction.guild.id, q);
  connection.subscribe(player);

  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    try {
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5000),
      ]);
    } catch { destroyQueue(interaction.guild.id); }
  });

  player.on(AudioPlayerStatus.Idle, () => playNext(interaction.guild.id));
  player.on('error', err => {
    console.error('[music] Player error:', err.message);
    playNext(interaction.guild.id);
  });

  return q;
}

function enqueueAndPlay(interaction, track, vcChannel) {
  const q = setupQueue(interaction, vcChannel);
  q.tracks.push(track);
  const wasIdle = q.player.state.status === AudioPlayerStatus.Idle;
  if (wasIdle) playNext(interaction.guild.id);
  return { wasIdle, position: q.tracks.length };
}

function makeAddedEmbed(track, position) {
  return new EmbedBuilder().setColor(0x5865F2).setTitle('Added to Queue')
    .setDescription(`[${track.title}](${track.url})`)
    .addFields(
      { name: 'Duration', value: track.duration,    inline: true },
      { name: 'Position', value: `#${position}`,    inline: true },
    ).setThumbnail(track.thumbnail);
}

// ── Slash handlers ────────────────────────────────────────────────────────────

async function handlePlay(interaction) {
  const query = interaction.options.getString('query', true).trim();
  const vc    = interaction.member.voice?.channel;
  if (!vc) return interaction.reply({ content: 'Join a voice channel first.', flags: 64 });
  const perms = vc.permissionsFor(interaction.client.user);
  if (!perms.has('Connect') || !perms.has('Speak'))
    return interaction.reply({ content: 'I need Connect and Speak permissions in your voice channel.', flags: 64 });

  await interaction.deferReply();
  await ensureYtdlp();
  if (!YTDLP_BIN)
    return interaction.editReply('yt-dlp not found. Install it or place the binary at: `' + BIN_PATH + '`');

  const isUrl = /^https?:\/\//i.test(query);
  let tracks;
  try {
    tracks = await resolveTopTracks(query, isUrl ? 1 : 5);
  } catch (e) {
    return interaction.editReply(`Nothing found for **${query}**: ${e.message}`);
  }

  // Direct URL or only one result — skip the picker
  if (isUrl || tracks.length === 1) {
    const track = { ...tracks[0], requestedBy: interaction.user.tag };
    const { wasIdle, position } = enqueueAndPlay(interaction, track, vc);
    return interaction.editReply({
      embeds: [wasIdle
        ? new EmbedBuilder().setColor(0x5865F2).setDescription(`Starting **[${track.title}](${track.url})**`)
        : makeAddedEmbed(track, position)
      ],
    });
  }

  // Multiple results — show numbered picker
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
  const { wasIdle, position } = enqueueAndPlay(interaction, track, vc);

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
  if (q.ytdlpProc)  { try { q.ytdlpProc.kill('SIGKILL');  } catch {} q.ytdlpProc  = null; }
  if (q.ffmpegProc) { try { q.ffmpegProc.kill('SIGKILL'); } catch {} q.ffmpegProc = null; }
  q.player.stop();
  return interaction.reply({ embeds: [new EmbedBuilder().setColor(0x5865F2).setDescription(`Skipped **${title}**`)] });
}

async function handlePause(interaction) {
  const q = getQueue(interaction.guild.id);
  if (!q?.current) return interaction.reply({ content: 'Nothing is playing.', flags: 64 });
  if (q.player.state.status !== AudioPlayerStatus.Playing)
    return interaction.reply({ content: 'Already paused.', flags: 64 });
  q.player.pause();
  return interaction.reply({ embeds: [new EmbedBuilder().setColor(0x5865F2).setDescription('Paused.')] });
}

async function handleResume(interaction) {
  const q = getQueue(interaction.guild.id);
  if (!q?.current) return interaction.reply({ content: 'Nothing is playing.', flags: 64 });
  if (q.player.state.status !== AudioPlayerStatus.Paused)
    return interaction.reply({ content: 'Not paused.', flags: 64 });
  q.player.unpause();
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

ensureYtdlp().catch(console.error);

module.exports = {
  handlePlay, handleMusicButton,
  handleSkip, handlePause, handleResume,
  handleStop, handleLeave, handleQueue, handleNowPlaying, handleLoop,
};
