'use strict';

const axios = require('axios');

// Simple 5-minute in-process cache so we don't hammer Bloxlink on every log action
const cache = new Map(); // discordId -> { robloxId, robloxName, exp }
const TTL   = 5 * 60 * 1000;

async function getRobloxFromDiscord(discordId, guildId) {
  const apiKey = process.env.BLOXLINK_API_KEY;
  if (!apiKey || !guildId) return null;

  const now = Date.now();
  const hit  = cache.get(discordId);
  if (hit && hit.exp > now) return { id: hit.robloxId, name: hit.robloxName };

  try {
    const res = await axios.get(
      `https://api.blox.link/v4/public/guilds/${guildId}/discord-to-roblox/${discordId}`,
      { headers: { Authorization: apiKey }, timeout: 4000 }
    );
    const robloxId   = res.data?.robloxID;
    const robloxName = res.data?.resolved?.roblox?.name || null;
    if (!robloxId) return null;
    cache.set(discordId, { robloxId, robloxName, exp: now + TTL });
    return { id: robloxId, name: robloxName };
  } catch {
    return null;
  }
}

module.exports = { getRobloxFromDiscord };
