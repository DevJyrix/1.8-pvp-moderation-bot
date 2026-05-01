# 1.8 Arena Moderation Bot v2

A complete Discord moderation + ticket bot with Roblox DataStore integration, role hierarchy, anti-raid protection, and a full ticket system.

---

## 📦 Files

| File | Purpose |
|------|---------|
| `index.js` | Main bot — all commands and interactions |
| `config.js` | Config + role hierarchy helpers |
| `roblox.js` | Roblox API + DataStore calls |
| `rules.js` | Offense rules + ban escalation logic |
| `antiraid.js` | Anti-raid rate limiting + lockout |
| `logger.js` | Action logging to channel + webhook |
| `statsEmbed.js` | Builds the player stats embed |
| `tickets.js` | Ticket system (create, close, DM) |

---

## ⚡ Quick Setup

### 1. Install dependencies
```bash
npm install
```

### 2. Configure `.env`
```bash
cp .env.example .env
```
Open `.env` and fill in every value. Key ones:

| Variable | Where to get it |
|----------|----------------|
| `DISCORD_TOKEN` | [discord.dev](https://discord.com/developers) → Your App → Bot → Token |
| `STAFF_ROLE_IDS` | Discord: Developer Mode on → Right click role → Copy ID |
| `MOD_ROLE_IDS` | Same as above |
| `ADMIN_ROLE_IDS` | Same as above |
| `TICKET_CHANNEL_ID` | Right click the channel where the ticket panel will live |
| `TICKET_CATEGORY_ID` | Right click the category where tickets should go |
| `LOG_CHANNEL_ID` | Ban log channel |
| `MOD_LOG_CHANNEL_ID` | General mod log (can be same as LOG_CHANNEL_ID) |
| `ROBLOX_API_KEY` | [create.roblox.com](https://create.roblox.com) → Credentials → API Keys |
| `ROBLOX_UNIVERSE_ID` | Your game page URL: `roblox.com/games/UNIVERSE_ID/...` |

### 3. Roblox Open Cloud API Key setup
1. Go to [create.roblox.com/credentials](https://create.roblox.com/credentials)
2. Create a new API Key
3. Under **Access Permissions** → Add your Universe
4. Enable **DataStore** with **Read** and **List** permissions
5. Paste into `.env` as `ROBLOX_API_KEY`

> **Note:** The bot only **reads** your DataStore for checkstats. For `.gban`/`.ungban` to work, it also needs **Write** permission.

### 4. Bot permissions
Your bot needs these Discord permissions:
- `MANAGE_CHANNELS` (creating ticket channels)
- `MANAGE_ROLES` (applying permission overwrites)
- `BAN_MEMBERS`
- `KICK_MEMBERS`
- `MODERATE_MEMBERS` (for mute/timeout)
- `SEND_MESSAGES`, `EMBED_LINKS`, `READ_MESSAGE_HISTORY`
- `VIEW_CHANNEL`

Or just give it **Administrator** for testing.

### 5. Post the ticket panel
Once the bot is running, go to your tickets channel and run:
```
/ticketpanel
```
This posts the dropdown ticket creator. **Only needs to be done once.**

### 6. Run
```bash
node index.js
```

---

## 🎮 Commands

### Moderation (prefix: `.`)

| Command | Who | Description |
|---------|-----|-------------|
| `.checkstats <RobloxUser>` | Staff+ | Full stats panel with GBAN/UNGBAN buttons |
| `.ban @user [reason]` | Staff+ | Discord server ban |
| `.unban <userID> [reason]` | Staff+ | Discord server unban |
| `.gban <RobloxUser> <Rule> [reason]` | Staff+ | Game ban (writes to DataStore) |
| `.ungban <RobloxUser> [reason]` | Staff+ | Remove game ban |
| `.mute @user <duration> [reason]` | Staff+ | Discord timeout (5m, 1h, 1d, 7d, etc.) |
| `.unmute @user` | Staff+ | Remove timeout |
| `.kick @user [reason]` | Staff+ | Discord kick |
| `.modhelp` | Staff+ | Shows all commands |
| `.resetlockout @user` | Admin | Resets anti-raid lockout |

### Slash Commands

| Command | Who | Description |
|---------|-----|-------------|
| `/close` | Staff or ticket creator | Close the current ticket |
| `/ticketpanel` | Mod+ | Post the ticket panel |
| `/resetlockout @user` | Admin | Reset anti-raid lockout |

---

## ⚖️ Rule Codes

| Code | Category | Name | Auto-Escalation |
|------|----------|------|----------------|
| A1 | Minor | Autoclicker | 1d → 3d → 7d → 30d |
| A2 | Minor | Toxicity | 1d → 3d → 7d → 30d |
| B1 | Moderate | Stat Farming | 7d → 30d → Permanent |
| B2 | Moderate | Repeated Glitch Abuse | 7d → 30d → Permanent |
| B3 | Moderate | Ban Evasion | 7d → 30d → Permanent |
| C1 | Severe | Exploiting | Permanent |
| C2 | Severe | Major Bug Abuse | Permanent |

Bans **automatically escalate** based on how many prior bans the player has.

---

## 🛡️ Role Hierarchy

Set three tiers in `.env`:
- `STAFF_ROLE_IDS` — basic moderators
- `MOD_ROLE_IDS` — moderators with extra trust
- `ADMIN_ROLE_IDS` — full admins

**Rules:**
- You can only action users ranked BELOW you
- A Staff cannot ban a Mod
- A Mod cannot ban an Admin
- Admins can action anyone without a higher role

---

## 🎫 Ticket System

- Users click the dropdown in the ticket panel
- Choose **Appeal** or **Report Player**
- A private channel is created: `appeal-5` or `report-12`
- Channel name auto-increments
- Ticket creator + all staff roles get access
- Everyone in the ticket has embed/attachment/reaction permissions
- `/close` or the 🔒 button closes it → deletes channel → DMs the user

---

## 🔒 Anti-Raid Protection

- Default: max **3 bans per minute** per staff member
- Exceeding this triggers a **10-minute lockout**
- Admin can reset with `.resetlockout @user` or `/resetlockout @user`
- Configure in `.env`: `ANTI_RAID_MAX_BANS_PER_MINUTE` and `ANTI_RAID_LOCKOUT_MINUTES`

---

## 📊 DataStore Format

Your game's `PlayerStats` DataStore should store entries keyed by `UserId` (as string):
```json
{
  "level": 4,
  "progress": 200,
  "maxProgress": 5000,
  "coins": 176300,
  "killstreak": 0,
  "lifetimeKills": 152,
  "highestKillstreak": 18,
  "playtime": 7200,
  "clicksPerSecond": 8.2
}
```
Adjust field names in `roblox.js` and `statsEmbed.js` to match your actual DataStore keys.

The `PlayerBans` DataStore is managed entirely by the bot.

---

## 💡 Suggested Additions

Here are features worth adding next:

1. **Warn system** — `.warn @user [reason]` that tracks warnings in a DataStore and auto-escalates to mute/ban at thresholds
2. **Infractions log** — A per-player history of all Discord/game actions in one embed
3. **Watchlist** — Flag a player for extra monitoring, staff gets pinged when they join
4. **Auto-ban evasion detection** — Cross-reference Roblox accounts with prior ban history
5. **Ticket transcripts** — Before deleting a ticket channel, save a HTML transcript and send it to staff logs
6. **Appeal auto-check** — When an appeal ticket is opened, auto-pull the player's ban info if they provide their Roblox username
7. **Staff activity log** — Weekly summary of how many actions each staff member took
8. **`/lookup` slash command** — Cleaner alternative to `.checkstats`
9. **Roblox group rank sync** — Assign Discord roles based on in-game ranks
10. **Game join/leave log** — If your game webhooks to Discord, correlate with ban events

---

## ⚠️ Important Notes

- The bot **does not need any Lua scripts** in your game for stats reading (read-only DataStore API)
- For `.gban`/`.ungban` to take effect in-game, your game needs to check the `PlayerBans` DataStore on player join
- Kicks (`/kick` in game) still require a polling script or MessagingService — this bot handles Discord kicks only
- Keep your `.env` file secret — never commit it to Git
