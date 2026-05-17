const fs   = require('fs');
const path = require('path');
const { EmbedBuilder } = require('discord.js');

const DATA_FILE = path.join(__dirname, 'data', 'memberstats.json');

function load() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch {
    return {
      totalJoins:      0,
      totalLeaves:     0,
      events:          [],
      trackingStarted: new Date().toISOString(),
    };
  }
}

function save(data) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(data));
}

function recordEvent(type) {
  const data = load();
  if (type === 'join') data.totalJoins++;
  else data.totalLeaves++;
  data.events.push({ type, ts: new Date().toISOString() });
  // Keep only last 90 days of individual events; running totals are preserved
  const cutoff = new Date(Date.now() - 90 * 86_400_000).toISOString();
  data.events = data.events.filter(e => e.ts >= cutoff);
  save(data);
}

function getStats(currentCount) {
  const data = load();
  const now   = Date.now();
  const h24   = now - 86_400_000;
  const d7    = now - 7 * 86_400_000;

  const joins24h  = data.events.filter(e => e.type === 'join'  && new Date(e.ts) >= h24).length;
  const leaves24h = data.events.filter(e => e.type === 'leave' && new Date(e.ts) >= h24).length;
  const joins7d   = data.events.filter(e => e.type === 'join'  && new Date(e.ts) >= d7).length;
  const leaves7d  = data.events.filter(e => e.type === 'leave' && new Date(e.ts) >= d7).length;
  const net7d     = joins7d - leaves7d;
  const avgDaily  = net7d / 7;

  const trackStart  = new Date(data.trackingStarted);
  const daysTracked = Math.max(1, Math.floor((now - trackStart) / 86_400_000));
  const avgJoinsAll = data.totalJoins  / daysTracked;
  const avgNetAll   = (data.totalJoins - data.totalLeaves) / daysTracked;

  function daysToMilestone(target) {
    if (currentCount >= target) return null;
    if (avgDaily <= 0) return Infinity;
    return Math.ceil((target - currentCount) / avgDaily);
  }

  return {
    totalJoins:    data.totalJoins,
    totalLeaves:   data.totalLeaves,
    netGain:       data.totalJoins - data.totalLeaves,
    joins24h,  leaves24h,
    joins7d,   leaves7d,
    avgDailyGrowth: Math.round(avgDaily  * 10) / 10,
    avgJoinsAll:    Math.round(avgJoinsAll * 10) / 10,
    avgNetAll:      Math.round(avgNetAll  * 10) / 10,
    trackingStarted: data.trackingStarted,
    daysTracked,
    days1k:  daysToMilestone(1_000),
    days10k: daysToMilestone(10_000),
  };
}

function buildEmbed(guild) {
  const current = guild.memberCount;
  const s = getStats(current);

  function fmtMilestone(days) {
    if (days === null)          return '✅ Already reached!';
    if (!isFinite(days))        return '📉 Server not growing at current rate';
    if (days < 1)               return '🔥 Very soon!';
    const target = new Date(Date.now() + days * 86_400_000);
    const label  = target.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    return `~${days.toLocaleString()} days (${label})`;
  }

  const net24h = s.joins24h - s.leaves24h;
  const net7d  = s.joins7d  - s.leaves7d;

  return new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle(`📊 Server Growth — ${guild.name}`)
    .setThumbnail(guild.iconURL({ dynamic: true }) || null)
    .addFields(
      { name: '👥 Current Members',      value: current.toLocaleString(),                                     inline: true },
      { name: '📈 Net Gain (Tracked)',    value: `${s.netGain >= 0 ? '+' : ''}${s.netGain.toLocaleString()}`, inline: true },
      { name: '📅 Tracking Since',        value: `${s.daysTracked}d ago`,                                     inline: true },

      { name: '✅ Total Joined',          value: s.totalJoins.toLocaleString(),  inline: true },
      { name: '❌ Total Left',            value: s.totalLeaves.toLocaleString(), inline: true },
      { name: '📊 Avg Joins/Day (all)',   value: `+${s.avgJoinsAll}`,            inline: true },

      { name: '📥 Joined (24h)',          value: `+${s.joins24h}`,                                              inline: true },
      { name: '📤 Left (24h)',            value: `-${s.leaves24h}`,                                             inline: true },
      { name: '📊 Net (24h)',             value: `${net24h >= 0 ? '+' : ''}${net24h}`,                          inline: true },

      { name: '📥 Joined (7d)',           value: `+${s.joins7d}`,                                               inline: true },
      { name: '📤 Left (7d)',             value: `-${s.leaves7d}`,                                              inline: true },
      { name: '📊 Net (7d)',              value: `${net7d >= 0 ? '+' : ''}${net7d}`,                            inline: true },

      { name: '📈 Avg Net Growth/Day (7d)', value: `${s.avgDailyGrowth >= 0 ? '+' : ''}${s.avgDailyGrowth}/day`, inline: false },

      { name: '🎯 Time to 1,000 members',  value: fmtMilestone(s.days1k),  inline: true },
      { name: '🚀 Time to 10,000 members', value: fmtMilestone(s.days10k), inline: true },
    )
    .setFooter({ text: `Growth estimated from last 7 days of data • ${s.daysTracked}d tracked` })
    .setTimestamp();
}

module.exports = { recordEvent, getStats, buildEmbed };
