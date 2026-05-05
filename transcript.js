const { AttachmentBuilder, EmbedBuilder } = require('discord.js');
const { LOG_CHANNEL_ID } = require('./config');

async function fetchAllMessages(channel) {
  const messages = [];
  let lastId = null;
  while (true) {
    const opts  = { limit: 100 };
    if (lastId) opts.before = lastId;
    const batch = await channel.messages.fetch(opts);
    if (!batch.size) break;
    messages.push(...batch.values());
    lastId = batch.last().id;
    if (batch.size < 100) break;
  }
  return messages.sort((a, b) => a.createdTimestamp - b.createdTimestamp);
}

function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function fmt(date) {
  return date.toLocaleString('en-GB', { day:'2-digit', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit', second:'2-digit', hour12: false });
}

function renderMsg(msg) {
  const isBot   = msg.author.bot;
  const avatar  = msg.author.displayAvatarURL({ size: 32, extension: 'png' });
  const color   = msg.member?.displayHexColor !== '#000000' ? msg.member?.displayHexColor : '#aab0c4';
  const topRole = msg.member?.roles?.highest?.name || 'User';

  let body = esc(msg.content || '')
    .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank">$1</a>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/\n/g, '<br>');

  let atts = '';
  msg.attachments.forEach(a => {
    atts += a.contentType?.startsWith('image/')
      ? `<div class="att"><img src="${a.url}" loading="lazy" alt="attachment"></div>`
      : `<div class="att file"><a href="${a.url}" target="_blank">📎 ${esc(a.name)}</a></div>`;
  });

  let embeds = '';
  msg.embeds.forEach(e => {
    const bc = e.color ? `#${e.color.toString(16).padStart(6,'0')}` : '#5865f2';
    embeds += `<div class="embed" style="border-color:${bc}">
      ${e.title ? `<div class="et">${esc(e.title)}</div>` : ''}
      ${e.description ? `<div class="ed">${esc(e.description).replace(/\n/g,'<br>')}</div>` : ''}
      ${e.fields.map(f => `<div class="ef"><div class="efn">${esc(f.name)}</div><div class="efv">${esc(f.value).replace(/\n/g,'<br>')}</div></div>`).join('')}
      ${e.footer?.text ? `<div class="efoo">${esc(e.footer.text)}</div>` : ''}
    </div>`;
  });

  return `<div class="msg${isBot ? ' bot' : ''}">
    <img class="av" src="${avatar}" onerror="this.src='https://cdn.discordapp.com/embed/avatars/0.png'">
    <div class="mc">
      <div class="mh">
        <span class="un" style="color:${color}">${esc(msg.author.username)}</span>
        <span class="rb">${esc(topRole)}</span>
        <span class="ts">${fmt(msg.createdAt)}</span>
      </div>
      ${body ? `<div class="mb">${body}</div>` : ''}
      ${atts}${embeds}
    </div>
  </div>`;
}

function buildHTML(channel, messages, meta) {
  const { number, type, creatorTag, openedAt, closedBy, closeReason } = meta;
  const title = type === 'appeal' ? 'Ban Appeal' : 'Player Report';
  const dur   = (() => {
    const ms = Date.now() - new Date(openedAt).getTime();
    const m  = Math.floor(ms / 60000);
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    return h < 24 ? `${h}h ${m % 60}m` : `${Math.floor(h/24)}d ${h%24}h`;
  })();

  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Ticket #${number}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#1e2028;color:#c8cdd8;font:14px/1.5 'Segoe UI',system-ui,sans-serif}
.hd{background:#16181f;border-bottom:1px solid #2a2d37;padding:18px 24px;display:flex;align-items:center;gap:14px}
.hd-info h1{font-size:1.1rem;color:#fff;font-weight:700}
.hd-info p{color:#6b7280;font-size:.8rem;margin-top:2px}
.badge{display:inline-block;background:#5865f2;color:#fff;border-radius:4px;padding:2px 8px;font-size:.72rem;font-weight:600;text-transform:uppercase;letter-spacing:.04em;margin-left:8px}
.badge.appeal{background:#fee75c;color:#000}.badge.report{background:#ed4245}
.meta{background:#1a1d24;border-bottom:1px solid #2a2d37;padding:10px 24px;display:flex;gap:24px;flex-wrap:wrap}
.mi{display:flex;flex-direction:column}
.ml{color:#6b7280;font-size:.7rem;text-transform:uppercase;letter-spacing:.05em}
.mv{font-size:.85rem;font-weight:600;color:#e0e4f0;margin-top:1px}
.msgs{padding:12px 24px}
.msg{display:flex;gap:12px;padding:4px 6px;border-radius:5px;margin-bottom:1px}
.msg:hover{background:#22252e}.bot{opacity:.8}
.av{width:34px;height:34px;border-radius:50%;flex-shrink:0;margin-top:2px;object-fit:cover}
.mc{flex:1;min-width:0}
.mh{display:flex;align-items:baseline;gap:8px;margin-bottom:2px;flex-wrap:wrap}
.un{font-weight:700;font-size:.92rem}
.rb{background:rgba(255,255,255,.07);border-radius:3px;padding:1px 5px;font-size:.67rem;color:#6b7280;text-transform:uppercase}
.ts{color:#6b7280;font-size:.7rem}
.mb{word-break:break-word}
code{background:rgba(255,255,255,.1);border-radius:3px;padding:1px 4px;font-size:.87em;font-family:monospace}
.att{margin-top:5px}.att img{max-width:360px;max-height:260px;border-radius:5px;display:block;border:1px solid #2a2d37}
.att.file a{color:#5865f2;text-decoration:none;font-size:.88rem}
.embed{margin-top:5px;background:#2a2d37;border-left:3px solid #5865f2;border-radius:0 5px 5px 0;padding:9px 12px;max-width:440px}
.et{font-weight:700;font-size:.92rem;color:#fff;margin-bottom:3px}
.ed{font-size:.87rem;margin-bottom:5px}
.ef{margin-top:5px}.efn{font-weight:700;font-size:.75rem;text-transform:uppercase;color:#9ca3af}
.efv{font-size:.87rem}.efoo{color:#9ca3af;font-size:.73rem;margin-top:7px;padding-top:5px;border-top:1px solid #3a3d47}
.ft{text-align:center;padding:16px;color:#6b7280;font-size:.75rem;border-top:1px solid #2a2d37;margin-top:8px}
</style></head><body>
<div class="hd">
  <div class="hd-info">
    <h1>${title} — #${number} <span class="badge ${type}">${type.toUpperCase()}</span></h1>
    <p>${esc(channel.guild?.name || '1.8 Arena')} · #${esc(channel.name)}</p>
  </div>
</div>
<div class="meta">
  <div class="mi"><span class="ml">Ticket</span><span class="mv">#${number}</span></div>
  <div class="mi"><span class="ml">Opened by</span><span class="mv">${esc(creatorTag)}</span></div>
  <div class="mi"><span class="ml">Opened</span><span class="mv">${fmt(new Date(openedAt))}</span></div>
  <div class="mi"><span class="ml">Closed by</span><span class="mv">${esc(closedBy)}</span></div>
  <div class="mi"><span class="ml">Duration</span><span class="mv">${dur}</span></div>
  <div class="mi"><span class="ml">Messages</span><span class="mv">${messages.length}</span></div>
  ${closeReason ? `<div class="mi"><span class="ml">Close Reason</span><span class="mv">${esc(closeReason)}</span></div>` : ''}
</div>
<div class="msgs">${messages.map(renderMsg).join('\n') || '<p style="color:#6b7280;padding:16px 0">No messages captured.</p>'}</div>
<div class="ft">1.8 Arena — Transcript generated ${new Date().toUTCString()}</div>
</body></html>`;
}

async function generateAndPostTranscript(client, channel, ticketMeta, overrideLogChannelId) {
  let messages = [];
  try { messages = await fetchAllMessages(channel); } catch {}

  const html   = buildHTML(channel, messages, ticketMeta);
  const buffer = Buffer.from(html, 'utf8');
  const fname  = `transcript-${ticketMeta.type}-${ticketMeta.number}.html`;
  const attachment = new AttachmentBuilder(buffer, { name: fname });

  const TYPE_LABELS = { gr: 'Game Report', dr: 'Discord Report', appeal: 'Appeal', cc: 'CC Application', art: 'Art Request' };
  const embed = new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle(`Ticket Transcript — #${ticketMeta.number}`)
    .addFields(
      { name: 'Type',       value: TYPE_LABELS[ticketMeta.type] || ticketMeta.type, inline: true },
      { name: 'Opened by',  value: ticketMeta.creatorTag,                           inline: true },
      { name: 'Closed by',  value: ticketMeta.closedBy,                             inline: true },
      { name: 'Messages',   value: `${messages.length}`,                            inline: true },
      ...(ticketMeta.closeReason ? [{ name: 'Close Reason', value: ticketMeta.closeReason, inline: false }] : []),
    )
    .setTimestamp();

  // Post to the appropriate log channel
  const targetChannelId = overrideLogChannelId || LOG_CHANNEL_ID;
  if (client && targetChannelId) {
    try {
      const ch = await client.channels.fetch(targetChannelId);
      if (ch) await ch.send({ embeds: [embed], files: [attachment] });
    } catch (e) { console.error('Transcript post failed:', e.message); }
  }

  return { attachment, embed };
}

module.exports = { generateAndPostTranscript };
