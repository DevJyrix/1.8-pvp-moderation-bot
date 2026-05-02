/**
 * music.js — YouTube audio player
 * Uses yt-dlp (same approach as the working Python bot) + FFmpeg for streaming.
 * yt-dlp bypasses YouTube bot detection that breaks ytdl-core and play-dl.
 *
 * Requires on first run: the bot will auto-download yt-dlp binary.
 */

const {
  joinVoiceChannel, createAudioPlayer, createAudioResource,
  AudioPlayerStatus, VoiceConnectionStatus, entersState,
} = require('@discordjs/voice');
const YTDlpWrap  = require('yt-dlp-wrap').default || require('yt-dlp-wrap');
// Use ffmpeg-static if available, otherwise fall back to system ffmpeg
let ffmpegPath;
try {
  ffmpegPath = require('ffmpeg-static');
  // ffmpeg-static returns null if binary wasn't downloaded
  if (!ffmpegPath) throw new Error('null');
  const fs2 = require('fs');
  if (!fs2.existsSync(ffmpegPath)) throw new Error('not found');
} catch {
  // Fall back to system ffmpeg (install from https://www.gyan.dev/ffmpeg/builds/)
  ffmpegPath = 'ffmpeg';
}
const { spawn }   = require('child_process');
const { EmbedBuilder } = require('discord.js');
const path = require('path');
const fs   = require('fs');

// ── yt-dlp binary setup ────────────────────────────────────────────────────────
const { execFileSync } = require('child_process');
const BIN_DIR  = path.join(__dirname, 'bin');
fs.mkdirSync(BIN_DIR, { recursive: true });
const BIN_PATH = path.join(BIN_DIR, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');

let YTDLP_BIN = null; // resolved on first use

async function ensureYtdlp() {
  if (YTDLP_BIN) return;

  // Prefer system yt-dlp (Railway nixpacks installs it here)
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    const p = execFileSync(cmd, ['yt-dlp'], { encoding: 'utf8' }).trim().split('\n')[0];
    if (p && fs.existsSync(p)) { YTDLP_BIN = p; return; }
  } catch {}

  // Use already-downloaded local binary
  if (fs.existsSync(BIN_PATH)) { YTDLP_BIN = BIN_PATH; return; }

  // Download binary as last resort
  console.log('[music] Downloading yt-dlp binary...');
  try {
    await YTDlpWrap.downloadFromGithub(BIN_PATH);
    if (process.platform !== 'win32') fs.chmodSync(BIN_PATH, '755');
    console.log('[music] yt-dlp downloaded successfully');
    YTDLP_BIN = BIN_PATH;
  } catch (e) {
    console.error('[music] Failed to download yt-dlp:', e.message);
    console.error('[music] Place yt-dlp binary at:', BIN_PATH);
  }
}

// ── yt-dlp options ─────────────────────────────────────────────────────────────
// mweb client works on datacenter IPs; no skip=dash,hls so all formats are available
const YTDLP_BASE = [
  '--format', 'bestaudio[ext=webm]/bestaudio[ext=m4a]/bestaudio/best',
  '--no-playlist',
  '--no-check-certificate',
  '--extractor-args', 'youtube:player_client=mweb',
  '--age-limit', '25',
];

const YTDLP_ARGS      = [...YTDLP_BASE, '--get-url'];
const YTDLP_INFO_ARGS = [...YTDLP_BASE, '--dump-json'];

// ── Helpers ────────────────────────────────────────────────────────────────────

function fmtDuration(secs) {
  if (!secs) return 'Live';
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  return `${m}:${String(s).padStart(2,'0')}`;
}

async function ytdlpJson(args) {
  return new Promise((resolve, reject) => {
    let out = '';
    let err = '';
    const proc = spawn(YTDLP_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    proc.stdout.on('data', d => out += d.toString());
    proc.stderr.on('data', d => err += d.toString());
    proc.on('close', code => {
      if (code !== 0) {
        const detail = err.trim() ? ': ' + err.trim().split('\n').slice(-3).join(' | ') : '';
        return reject(new Error(`yt-dlp exited with code ${code}${detail}`));
      }
      try { resolve(JSON.parse(out.trim())); }
      catch { reject(new Error('Failed to parse yt-dlp output')); }
    });
    proc.on('error', reject);
  });
}

async function resolveTrack(query) {
  await ensureYtdlp();

  // Determine if it's a URL or search query
  const isUrl = /^https?:\/\//i.test(query);
  const searchQuery = isUrl ? query : `ytsearch1:${query}`;

  const info = await ytdlpJson([...YTDLP_INFO_ARGS, searchQuery]);

  // ytsearch returns entries array; direct URL returns single object
  const video = info.entries ? info.entries[0] : info;
  if (!video) throw new Error('No results found.');

  return {
    url:         video.webpage_url || video.url,
    title:       video.title,
    duration:    fmtDuration(video.duration),
    thumbnail:   video.thumbnail || null,
    requestedBy: null,
  };
}

// Create a stream by piping yt-dlp output through ffmpeg
// This exactly mirrors how the Python bot handles it
function createStream(trackUrl) {
  // yt-dlp fetches the audio stream URL
  const ytdlpProc = spawn(YTDLP_BIN, [
    ...YTDLP_ARGS,
    '--extractor-args', 'youtube:skip=dash,hls;player_client=android,web',
    trackUrl,
  ], { stdio: ['ignore', 'pipe', 'ignore'] });

  // ffmpeg transcodes to opus/pcm for Discord
  const ffmpegProc = spawn(ffmpegPath, [
    '-reconnect', '1',
    '-reconnect_streamed', '1',
    '-reconnect_delay_max', '5',
    '-i', 'pipe:0',          // read from stdin
    '-vn',                    // no video
    '-b:a', '128k',
    '-ac', '2',
    '-f', 's16le',            // raw PCM output
    '-ar', '48000',           // Discord requires 48kHz
    'pipe:1',                 // output to stdout
  ], { stdio: ['pipe', 'pipe', 'ignore'] });

  // Pipe yt-dlp stdout → ffmpeg stdin
  // But yt-dlp --get-url just prints the URL, so we need a different approach:
  // Use yt-dlp to get the direct URL, then pass it to ffmpeg directly
  ytdlpProc.stdout.once('data', (urlBuf) => {
    const directUrl = urlBuf.toString().trim();
    ytdlpProc.kill();

    // Restart ffmpeg with the direct URL
    ffmpegProc.kill();
  });

  return { ytdlpProc, ffmpegProc };
}

// Better approach: get direct URL first, then stream with ffmpeg
async function getDirectUrl(trackUrl) {
  await ensureYtdlp();
  return new Promise((resolve, reject) => {
    let out = '';
    let err = '';
    const proc = spawn(YTDLP_BIN, [...YTDLP_ARGS, trackUrl], { stdio: ['ignore', 'pipe', 'pipe'] });
    proc.stdout.on('data', d => out += d.toString());
    proc.stderr.on('data', d => err += d.toString());
    proc.on('close', code => {
      const url = out.trim().split('\n')[0];
      if (code !== 0 || !url) {
        const detail = err.trim() ? ': ' + err.trim().split('\n').slice(-3).join(' | ') : '';
        return reject(new Error(`yt-dlp failed to get stream URL${detail}`));
      }
      resolve(url);
    });
    proc.on('error', reject);
  });
}

function createFfmpegStream(directUrl) {
  const proc = spawn(ffmpegPath, [
    '-reconnect', '1',
    '-reconnect_streamed', '1',
    '-reconnect_delay_max', '5',
    '-i', directUrl,
    '-vn',
    '-b:a', '128k',
    '-ac', '2',
    '-f', 's16le',
    '-ar', '48000',
    'pipe:1',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stderr.on('data', d => {
    const msg = d.toString();
    if (!msg.includes('size=') && !msg.includes('time=')) {
      console.error('[ffmpeg]', msg.trim());
    }
  });
  proc.on('error', err => console.error('[ffmpeg] spawn error:', err.message));
  return proc;
}

// ── Per-guild state ────────────────────────────────────────────────────────────
const queues = new Map();

function getQueue(guildId) { return queues.get(guildId) || null; }

function destroyQueue(guildId) {
  const q = queues.get(guildId);
  if (!q) return;
  if (q.ffmpegProc) { try { q.ffmpegProc.kill('SIGKILL'); } catch {} }
  try { q.player.stop(true); } catch {}
  try { q.connection.destroy(); } catch {}
  queues.delete(guildId);
}

async function playNext(guildId) {
  const q = queues.get(guildId);
  if (!q) return;

  if (!q.tracks.length) {
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

  const track = q.tracks.shift();
  q.current   = track;

  try {
    // Get direct audio URL via yt-dlp
    const directUrl = await getDirectUrl(track.url);

    // Kill any previous ffmpeg process
    if (q.ffmpegProc) { try { q.ffmpegProc.kill('SIGKILL'); } catch {} }

    // Stream through ffmpeg
    const ffmpegProc = createFfmpegStream(directUrl);
    q.ffmpegProc = ffmpegProc;

    const resource = createAudioResource(ffmpegProc.stdout, {
      inputType: require('@discordjs/voice').StreamType.Raw,
    });

    q.player.play(resource);

    q.textChannel?.send({
      embeds: [new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle('Now Playing')
        .setDescription(`[${track.title}](${track.url})`)
        .addFields(
          { name: 'Duration',     value: track.duration,    inline: true },
          { name: 'Requested by', value: track.requestedBy, inline: true },
        )
        .setThumbnail(track.thumbnail)
        .setTimestamp()
      ]
    }).catch(() => {});

  } catch (e) {
    console.error('[music] Playback error:', e.message);
    q.textChannel?.send(`Could not play **${track.title}**: ${e.message}`).catch(() => {});
    playNext(guildId);
  }
}

// ── Slash handlers ─────────────────────────────────────────────────────────────

async function handlePlay(interaction) {
  const query = interaction.options.getString('query', true).trim();
  const vc    = interaction.member.voice?.channel;

  if (!vc) return interaction.reply({ content: 'Join a voice channel first.', flags: 64 });

  const perms = vc.permissionsFor(interaction.client.user);
  if (!perms.has('Connect') || !perms.has('Speak')) {
    return interaction.reply({ content: 'I need Connect and Speak permissions in your voice channel.', flags: 64 });
  }

  await interaction.deferReply();

  // Ensure yt-dlp is available
  await ensureYtdlp();
  if (!YTDLP_BIN) {
    return interaction.editReply('yt-dlp not found. Install it or place the binary at: `' + BIN_PATH + '`');
  }

  let track;
  try {
    track = await resolveTrack(query);
    track.requestedBy = interaction.user.tag;
  } catch (e) {
    return interaction.editReply(`Nothing found for **${query}**: ${e.message}`);
  }

  let q = getQueue(interaction.guild.id);

  if (!q) {
    const connection = joinVoiceChannel({
      channelId:      vc.id,
      guildId:        interaction.guild.id,
      adapterCreator: interaction.guild.voiceAdapterCreator,
    });

    // Self-deafen (like the Python bot does)
    interaction.guild.members.me.voice.setDeaf(true).catch(() => {});

    const player = createAudioPlayer();
    q = { connection, player, tracks: [], current: null, textChannel: interaction.channel, ffmpegProc: null };
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
  }

  q.tracks.push(track);

  if (q.player.state.status === AudioPlayerStatus.Idle) {
    playNext(interaction.guild.id);
    return interaction.editReply({
      embeds: [new EmbedBuilder().setColor(0x5865F2)
        .setDescription(`Starting **[${track.title}](${track.url})**`)]
    });
  }

  return interaction.editReply({
    embeds: [new EmbedBuilder().setColor(0x5865F2).setTitle('Added to Queue')
      .setDescription(`[${track.title}](${track.url})`)
      .addFields(
        { name: 'Duration', value: track.duration,       inline: true },
        { name: 'Position', value: `#${q.tracks.length}`, inline: true },
      )
      .setThumbnail(track.thumbnail)
    ]
  });
}

async function handleSkip(interaction) {
  const q = getQueue(interaction.guild.id);
  if (!q?.current) return interaction.reply({ content: 'Nothing is playing.', flags: 64 });
  const title = q.current.title;
  if (q.ffmpegProc) { try { q.ffmpegProc.kill('SIGKILL'); } catch {} q.ffmpegProc = null; }
  q.player.stop();
  return interaction.reply({ embeds: [new EmbedBuilder().setColor(0x5865F2).setDescription(`Skipped **${title}**`)] });
}

async function handlePause(interaction) {
  const q = getQueue(interaction.guild.id);
  if (!q?.current) return interaction.reply({ content: 'Nothing is playing.', flags: 64 });
  if (q.player.state.status !== AudioPlayerStatus.Playing) return interaction.reply({ content: 'Already paused.', flags: 64 });
  q.player.pause();
  return interaction.reply({ embeds: [new EmbedBuilder().setColor(0x5865F2).setDescription('Paused.')] });
}

async function handleResume(interaction) {
  const q = getQueue(interaction.guild.id);
  if (!q?.current) return interaction.reply({ content: 'Nothing is playing.', flags: 64 });
  if (q.player.state.status !== AudioPlayerStatus.Paused) return interaction.reply({ content: 'Not paused.', flags: 64 });
  q.player.unpause();
  return interaction.reply({ embeds: [new EmbedBuilder().setColor(0x5865F2).setDescription('Resumed.')] });
}

async function handleStop(interaction) {
  if (!getQueue(interaction.guild.id)) return interaction.reply({ content: 'Not in a voice channel.', flags: 64 });
  destroyQueue(interaction.guild.id);
  return interaction.reply({ embeds: [new EmbedBuilder().setColor(0x5865F2).setDescription('Stopped and cleared the queue.')] });
}

async function handleLeave(interaction) {
  if (!getQueue(interaction.guild.id)) return interaction.reply({ content: 'Not in a voice channel.', flags: 64 });
  destroyQueue(interaction.guild.id);
  return interaction.reply({ embeds: [new EmbedBuilder().setColor(0x5865F2).setDescription('Left voice channel.')] });
}

async function handleQueue(interaction) {
  const q = getQueue(interaction.guild.id);
  if (!q?.current && !q?.tracks?.length) return interaction.reply({ content: 'Queue is empty.', flags: 64 });
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
        { name: 'Duration',     value: t.duration,     inline: true },
        { name: 'Requested by', value: t.requestedBy,  inline: true },
        { name: 'Queue',        value: `${q.tracks.length} track(s) remaining`, inline: true },
      )
      .setThumbnail(t.thumbnail)
    ]
  });
}

// Pre-download yt-dlp on module load
ensureYtdlp().catch(console.error);

module.exports = {
  handlePlay, handleSkip, handlePause, handleResume,
  handleStop, handleLeave, handleQueue, handleNowPlaying,
};
