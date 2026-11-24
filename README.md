# Telegram Bot on Cloudflare Workers

A lightweight Telegram bot for **Cloudflare Workers** (JavaScript ES modules, webhook mode) that stores its data in **Turso (libSQL over HTTP)**.
It is a focused re-implementation of selected Nobara features — not a copy of any repository.

| Area | Commands |
|---|---|
| Basics | `/start` `/help` `/about` `/id` `/ping` |
| Anime info | `/anime` `/animeinfo` |
| Anime schedule (IST) | `/schedule` `/animeschedule` `/airing` (`today`, `tomorrow`, `week`, or an anime name) |
| Translation | `/tr` `/translate` (`/tr en hi Hello`, `/tr langs`, or reply to a message) |
| Image search | `/image` `/img` `/imagesearch` |
| Custom buttons | `/button` |
| Groups & fun (v3) | `/all` `/atag` `/leaderboard` `/couple` `/mypartner` `/export` |
| Clone bots (v3) | `/clonebot` `/myclone` `/clone` (owner panel: `/panel` → Bot Controls → Clones) |
| Broadcast (owner) | `/broadcast [users\|groups\|all]` `/allbroadcast` `/broadcaststatus` `/dashboard` |
| Group announcements (group admins) | `/announce [pin]` |
| Backup / restore | `/backup` `/import` + automatic backups |
| Group ownership | `/groupinfo` `/registerowner` `/authorize` `/unauthorize` `/groupadmins` |
| **Group management** | 17 sections, 120+ commands — see [section 10](#10-group-management-system) |
| Welcome (owner) | `/setwelcome` `/setwelcomeimage` `/resetwelcome` |

Removed on purpose: song/music/audio/video/YouTube downloaders, TTS, image upscaling, heavy image processing, games and other entertainment/experimental modules.

---

## 1. What you need

* A Cloudflare account (free plan works; Queues are available on the free plan).
* A Turso account and the `turso` CLI.
* A Telegram bot token from [@BotFather](https://t.me/BotFather).
* Node.js 22+ on your computer (to run `wrangler`).
* Optional: a free [Pixabay API key](https://pixabay.com/api/docs/) for image search (without it, Wikimedia Commons is used).

> **Important:** uploading these files to Cloudflare does **not** create secrets, queues, R2 buckets or KV namespaces for you.
> Do the one-time steps below once.

## 2. Turso setup

```bash
turso auth login
turso db create nobara-bot
turso db show nobara-bot --url          # -> libsql://nobara-bot-<org>.turso.io   (TURSO_DATABASE_URL)
turso db tokens create nobara-bot       # -> long token                           (TURSO_AUTH_TOKEN)
```

You do **not** need to create tables by hand: `/setup` runs the migrations (`migrations/001_initial.sql`, `migrations/002_group_management.sql`; also available via `npm run sql`). Migrations are additive and safe to re-run.

## 3. Cloudflare setup

```bash
npm install
npx wrangler login

# 1) the queue used by broadcasts (required, one time)
npx wrangler queues create nobara-broadcast

# 2) secrets (you are prompted for each value; nothing is written to disk)
npx wrangler secret put BOT_TOKEN
npx wrangler secret put TURSO_DATABASE_URL
npx wrangler secret put TURSO_AUTH_TOKEN
npx wrangler secret put WEBHOOK_SECRET      # npm run gen  prints random values for you
npx wrangler secret put SETUP_SECRET        # password for /setup and /status (use 20+ characters)
npx wrangler secret put PIXABAY_API_KEY     # optional
```

Edit `wrangler.toml` → `[vars]`: set **`OWNER_ID`** to your numeric Telegram id (get it from @userinfobot), and optionally `DEVELOPER_URL`, `UPDATES_CHANNEL_URL`, `WELCOME_IMAGE`. Every non-secret option is documented there. **Never put credentials in `wrangler.toml`.**

Optional bindings (uncomment the blocks in `wrangler.toml` after creating them):

```bash
npx wrangler r2 bucket create nobara-backups        # backups stored in R2 (otherwise sent to the owner's chat)
npx wrangler kv namespace create CACHE              # paste the id into wrangler.toml (otherwise Turso is the cache)
```

Deploy:

```bash
npm run deploy
```

Wrangler prints your Worker URL, e.g. `https://nobara-bot.<subdomain>.workers.dev`. The cron trigger (`* * * * *`, every minute: group expiry jobs + the backup schedule) is registered by the deploy.

## 4. Telegram webhook (automatic)

Open `https://<your-worker-url>/setup` in a browser and enter your `SETUP_SECRET`. The page:

1. validates the bot token with `getMe`,
2. connects to Turso and runs the migrations,
3. checks the Queue / R2 / KV bindings,
4. compares the current webhook with the expected one. If a different one is set (for example from the old bot) it is **replaced directly with `setWebhook` + secret token** — no `deleteWebhook`, no `drop_pending_updates`,
5. verifies the result with `getWebhookInfo`,
6. tests the anime, translation and image APIs and a backup export,
7. shows **only what it actually verified**.

It is safe to open again at any time (idempotent). Failed `/setup` logins are rate-limited per IP. `/status` shows the same diagnostics (`/status?format=json` for monitoring). Afterwards open Telegram and send `/start`.

Manual alternative (not needed normally):

```bash
curl "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook" \
  -d "url=https://<your-worker-url>/webhook" \
  -d "secret_token=<WEBHOOK_SECRET>" \
  -d 'allowed_updates=["message","callback_query","my_chat_member"]'
```

## 5. Required keys

| Name | Kind | Required | Purpose |
|---|---|---|---|
| `BOT_TOKEN` | secret | yes | Telegram bot token |
| `TURSO_DATABASE_URL` | secret | yes | `libsql://…` database URL |
| `TURSO_AUTH_TOKEN` | secret | yes | Turso token |
| `WEBHOOK_SECRET` | secret | yes | Verifies requests really come from Telegram |
| `SETUP_SECRET` | secret | yes | Protects `/setup` and `/status` |
| `PIXABAY_API_KEY` | secret | no | Pixabay image search |
| `OWNER_ID` | var | yes | Your Telegram user id |
| `BROADCAST_QUEUE` | Queue binding | yes | Broadcast delivery |
| `BACKUPS` | R2 binding | no | Backup storage |
| `CACHE` | KV binding | no | Faster cache |

No key is needed for AniList, Taizen, MyMemory or Wikimedia.

## 6. Features in detail

**Permissions.** The owner is `OWNER_ID`. Authorisation always uses the real sender id of the Telegram update (never a number typed in a message) and, in groups, a live `getChatMember` check. Anonymous admins are rejected. Group owner = the Telegram group creator (or someone registered with `/registerowner`); owners can `/authorize` other admins.

**Broadcast.** `/broadcast users|groups|all <text>` (or reply to any message; media is copied with its caption) shows a preview with *Send Now / Cancel*. Confirming snapshots the recipients (unique per job, so nobody receives it twice) and hands the work to a Queue consumer that sends in small chunks, honours `429 retry_after`, flags blocked users/removed groups, resumes after crashes (a cron sweep restarts stalled jobs) and updates a live progress message. Delivery is *at most once*: if a Worker dies mid-send the affected recipients are marked `unknown` rather than resent. `/allbroadcast` targets users and groups. `/dashboard` shows totals, recent broadcasts and backups. Group admins use `/announce` to post (and optionally pin) an announcement in their group.

**Anime.** Taizen is queried first; on error or empty result AniList is used. Results are cached. `/schedule` shows today / tomorrow / the week in **IST (Asia/Kolkata)** or the next episode of a named anime.

**Translation.** MyMemory behind a small provider interface, cached. The free service has a daily allowance; when it is used up the bot says so instead of failing silently. No unlimited use is promised.

**Image search.** Pixabay (if the key is set) or Wikimedia Commons, Next/Previous buttons, author/licence attribution, cached.

**Custom buttons** (`/button`, `/setwelcome`, `/broadcast`, `/announce`):

```
(Website - https://example.com) | (Docs - https://docs.example.com)
(More info - Plain text shown as a pop-up)
(Label with (nested) parentheses - https://example.com/a)
```

`(Label - https://…)` is a URL button, `(Label - plain text)` shows the text in a pop-up, `|` separates buttons on one row, a new line starts a new row. Malformed input is rejected with a message that names the problem. The parser is a standalone module (`src/keyboards/buttonParser.js`). Pop-up text is stored in the database and only ever *displayed*.

**Backups.**
* *Automatic*: the cron trigger creates a validated backup every `BACKUP_INTERVAL` and stores it in R2 (keeping `BACKUP_RETENTION`), or sends it to the owner's chat when R2 is not bound.
* *`/backup`*: the bot owner gets a **global** backup (private chat); a group owner (or authorised admin) gets **that group only**.
* *`/import`* (reply to a backup file): size/format/checksum validation, whitelisted tables and columns, type and reference checks → confirmation button → automatic **safety backup** → restore in **one transaction** (all or nothing). Nothing in a file is ever executed as code or SQL; a group import can never change ownership or touch another group.
* Format: JSON, `{"format":"nobara-backup","version":1,"scope":"global|group",…,"checksum":"sha256 of the tables JSON","tables":{…}}`.

**Group isolation.** Every group-owned row is keyed by `telegram_chat_id`; group backups/imports only contain and affect that group.

## 7. Development & tests

```bash
cp .dev.vars.example .dev.vars   # fill in; never commit it
npm run dev                      # wrangler dev
npm test                         # node:test, uses an in-memory SQLite (node:sqlite) in place of Turso
```

The test suite covers the button parser, permissions, backup/import, broadcast (queue, retries, blocked chats, duplicates), webhook/routing, `/start` and `/help`, group welcome and isolation, the setup flow (old webhook replaced, idempotency, no secret leakage), the Turso HTTP client, IST handling and the API features with stubbed network responses. SQLite is used **only in tests**; production uses Turso.

## 8. Known limitations (please read)

* **Taizen's schema could not be verified** while this project was built (its documentation was not reachable). The client sends AniList-style GraphQL queries and normalises responses tolerantly; if Taizen rejects them the bot falls back to AniList automatically and logs the reason. If you see AniList in the footer of every result, adjust the query strings in `src/features/anime/graphql.js` to Taizen's real schema.
* **Nothing was run against live Telegram, Turso, Cloudflare, Taizen, AniList, MyMemory, Pixabay or Wikimedia** during development. Tests use fakes and stubbed responses. `/setup` verifies the real thing at first deploy — trust its report, and run the acceptance check below.
* Media-group albums are broadcast as **one** message (Telegram's `copyMessage` copies a single message).
* Broadcast job logs and progress are **not** part of backups (they are operational data).
* Broadcast text keeps Telegram formatting via entities; very unusual entity combinations may be simplified.
* Work started from a webhook runs under `ctx.waitUntil`, which Cloudflare limits to roughly 30 s after the response; heavy work (broadcasts, backups of very large databases) is therefore done through Queues/cron. Very large databases may need a paid plan or a bigger `BROADCAST_CHUNK_SIZE` tuning.
* Delivery is at-most-once (see Broadcast). MyMemory's free allowance is limited and may change.
* Automatic backups require the cron trigger from `wrangler.toml`; the Worker cannot verify that it is registered, only that backups are enabled and exportable.
* The setup login uses a cookie valid for 30 minutes; use a long random `SETUP_SECRET`.

## 9. Acceptance checklist (after deploy)

1. Open `/setup` → every critical row ✅, "SETUP COMPLETED".
2. Telegram → `/start` shows the welcome with working buttons.
3. `/help`, `/anime frieren`, `/schedule today`, `/tr en hi Hello`, `/image cats`, `/button Hi\n(Site - https://example.com)`.
4. Add the bot to a group → one welcome message; `/groupinfo`.
5. `/broadcast users test` → preview → Send Now → progress message completes.
6. `/backup` → file arrives; `/import` (reply to it) → confirmation → restore.
7. Wait for the cron (or set `BACKUP_INTERVAL = "5m"` temporarily) → automatic backup appears in R2/chat.

## 10. Group management system

Add the bot to a group and **make it an administrator** with the rights you want it to use (delete messages, ban/restrict users, pin messages, invite users, add admins for `/promote`). The bot never claims an action worked unless Telegram confirmed it; when it lacks a right it says which one. Send `/help` in a group for the 17 sections below.

**Targeting** — every moderation command accepts a reply, a numeric user ID, a known `@username`, or a tapped text-mention. Without a target it shows usage. The sender is never moderated by accident, and the group owner, other admins and the bot itself are protected. The *reason* is everything after the target (and duration) and is stored in full. Durations: `30s 10m 2h 1d 7d 1w` (30 seconds – 366 days).

| Section | Commands |
|---|---|
| 🛡️ Moderation | `/ban /unban /kick /mute /unmute /tban /tmute /sban /skick /smute /dkick /banme /unbanme /muteme /unmuteme /kickme` |
| ⚠️ Warnings | `/warn /dwarn /swarn /unwarn /rmwarn /resetwarn /warns /warnings /warnlimit /warnmode /warntime` |
| 🗑️ Messages | `/del /purge /spurge /pin /unpin /pinmessage /unpinmessage /purgefrom /purgeto` |
| 👮 Admins | `/promote /demote /admins /adminlist /staff /admin /unadmin /sync` |
| 🔒 Locks | `/lock /unlock /locks /locktypes /lockall /unlockall` |
| 🌊 Antiflood | `/antiflood /setflood /setfloodmode /flood /clearflood /floodlimit` |
| 🚫 Anti-spam / raid | `/antispam /antiraid /raidmode /raidaction /raidtime /clearraid` |
| 🔐 Captcha | `/captcha /verify /setcaptcha /captchamode /captchatime /captchakick` |
| 📝 Filters | `/filter /filters /stop /stopall /addfilter /rmfilter /removefilter` |
| 📚 Notes | `/save /get /notes /clear /clearall` (and `#name`) |
| 👋 Welcome / goodbye | `/welcome /setwelcome /resetwelcome /welcomemute /welcometype /cleanwelcome /goodbye /setgoodbye /resetgoodbye /cleangoodbye` |
| 📜 Rules | `/rules /setrules /resetrules /clearrules` |
| 🚫 Blacklist | `/blacklist /addblacklist /rmblacklist /delblacklist /blacklisted /blacklistmode` |
| 📢 Reports | `/report /reports /reportmode /clearreports` |
| ⚙️ Settings & cleanup | `/settings /config /groupconfig /setdescription /settitle /cleanservice /cleancommands /cleanbots /cleanlinks` |
| 📊 Information | `/info /chatinfo /id /groupid /userinfo /whois /link /invite` |
| 📋 History | `/adminlog /modlog /modhistory` |

**Data.** Group settings (key/value `group_settings`), filters, notes, blacklist, greetings, warnings, restrictions, moderation log, verifications, flood counters, reports and scheduled deletions each live in their own table keyed by the group, so groups never see each other's data. All SQL is parameterised. Moderation logs record action, target, admin, reason, date, expiry, group and the Telegram result, and are pruned after a retention period. Only the data needed for moderation is stored (ids, names/usernames Telegram already shows); there is no tracking of message content beyond what a rule must inspect at that moment.

**Scheduled work.** The Cron Trigger runs **every minute**: it confirms/marks expired temporary bans and mutes (Telegram itself lifts them at `until_date`), expires unanswered captchas, runs scheduled deletions and (hourly) housekeeping. The automatic backup still follows `BACKUP_INTERVAL`; the minute tick only checks whether it is due. Expiry/captcha timing therefore has about one-minute accuracy.

**Backups.** Backup schema v2 adds filters, notes, blacklist and greetings. Warnings, restrictions, logs, reports, verifications and flood counters are deliberately **not** exported (personal/operational data). Version-1 backups still import.

### Commands that work
All commands listed above are implemented and covered by tests (169 in total). Highlights: reply/ID targeting, timed bans/mutes with automatic expiry, warning limits with mute/ban/kick/tmute/tban actions, per-message purge with accurate counts, locks (native Telegram permissions for photo/video/document/audio/voice/video note/poll plus deletion for the rest), antiflood, antispam, captcha (button or math), anti-raid, filters, notes, welcome/goodbye with variables and buttons, rules, blacklist (delete/warn/mute/kick/ban), reports, settings menu, cleanup options and moderation history.

### Telegram API limitations (honest list)
* **Usernames** can only be resolved for people the bot already knows (they started the bot, are admins, were moderated before, or are text-mentioned). Telegram offers no username → id lookup for bots. Use a reply or numeric ID otherwise.
* **/unbanme, /unmuteme** only undo restrictions the user put on themselves with `/banme` / `/muteme`; a banned or muted user cannot send commands to begin with.
* **/demote** only works for admins that this bot promoted (Telegram rule). **/promote** cannot grant rights the bot does not itself have. Anonymous admins cannot be verified and are refused.
* **/purge, /del** can only remove messages younger than 48 hours (Telegram rule) and the bot needs "Delete messages". The bot cannot list history, so purge works by message-id range between the replied message and the command.
* **/cleanbots** only removes messages sent *via inline bots*; Telegram never delivers other bots' messages to a bot.
* **Admin-title/rights changes, /settitle, /setdescription, /link** need the matching admin right; otherwise the bot reports the missing right.
* **Locks** — Telegram natively restricts only media-type permissions; other locks (links, forwards, stickers, etc.) are enforced by deleting the message after it is posted, so it is briefly visible.
* **Flood, spam, raid and captcha are heuristics.** They reduce abuse but cannot identify every spammer or stop every attack; they should not replace human moderators.
* Temporary-restriction and captcha timing has about one-minute resolution. Telegram treats restrictions shorter than 30 s or longer than 366 days as permanent, so those are rejected.
* Group admin commands that use `getChatMember` depend on Telegram being reachable; failures are reported instead of guessed.

## 11. Interface design system (v2.0)

The whole interface goes through one presentation layer in `src/ui/` — nothing in it touches the database or Telegram:

| File | Role |
|---|---|
| `src/ui/typography.js` | Unicode type styles: headings = sans **bold** caps, sub-headings = sans *italic*, button labels = serif **bold**. Only the 52 ASCII letters are converted; HTML entities, digits, emoji, `/commands`, IDs, URLs and `callback_data` are never changed. |
| `src/ui/design.js` | `box()` headings, `formatWelcome()`, `formatSuccess/Error/Warning/Info()`, `formatStatus()`, `formatCommandHelp()`, `formatModerationLog()`, `formatMenu()`, `onOff()`, `blockquote()`. |
| `src/ui/buttons.js` | Button look: label typography + colour (`primary` blue, `success` green, `danger` red). |
| `src/keyboards/inlineKeyboard.js` | `btn()`, `urlBtn()`, `closeBtn()`, `backCloseRow()`, `gridRows()` (two-column grid), `pagerRow()`. |
| `src/utils/formatter.js` | Existing `messages.*` / `panel()` API, now rendered with the same system. |

**Navigation.** `/start` (image + caption, `Commands` / `Help` / `About` / `Developer` / `Updates` / `Add Me`) → **Main Menu** (sections) → section grid (2 columns) → category command list (paginated, 8 per page) → `/help <command>` cards. Every screen edits the existing message (a welcome photo keeps its picture when the new text fits a caption), has **Back** and **Close**, and only shows what the person may use. Group Close is limited to the person who opened the menu or an admin.

**Moderation panels** (ban, tban, mute, tmute, kick, unban, unmute, warn…) show user, user ID, admin, reason, duration and group, and are only sent after Telegram confirmed the action. **Undo** is shown only where a real reversal exists: Undo Ban → unban, Undo Mute → unmute, Undo Warning → removes the warning (admin-checked again at click time). A kick has no Undo.

**Security overview** (`/security`, also in `/settings`) shows the real stored state (🟢 ON / 🔴 OFF) of anti-spam, antiflood, verification, anti-raid, blacklist, reports and active locks. There is no "Guardian" feature in this bot, so none is displayed.

**Switches** (`wrangler.toml` `[vars]`): `UI_BUTTON_STYLES = "false"` removes button colours; `UI_FANCY_BUTTONS = "false"` shows plain button labels. Owner welcome captions set with `/setwelcome` are always shown exactly as written.

**Telegram limits for the design.** Colours use the Bot API `style` field on inline buttons; clients that do not support it show normal grey buttons. Telegram has no font selection, so "fonts" are Unicode look-alikes, which depend on the device's font support and may be read letter-by-letter by screen readers — they are used only for headings and button labels, never for commands, IDs or long text. `icon_custom_emoji_id` (custom emoji on buttons) is restricted by Telegram to bots with Fragment usernames or Premium owners and is not used. Message effects/animations are not used. Captions are limited to 1024 characters, messages to 4096; screens that do not fit a caption are sent as text.

## 12. Roles, /sudo, /panel and global bans (v2.1)

**Roles** (resolved only from `OWNER_ID` and the `sudo_users` table — never from user input):

| Role | Who | Sees / can use |
|---|---|---|
| Main owner | `OWNER_ID` | everything: public + moderator tools + owner commands + `/sudo` |
| Sudo moderator | added with `/sudo add` | public commands + `/panel` + `/gban` family. Never `/sudo`, `/broadcast`, `/backup`… |
| User | everybody else | public commands only |

Hidden commands are hidden in `/help`, in the Telegram command menu **and** refused server-side if typed directly.

**New commands**

* `/sudo add|remove|list [USER_ID]` — owner only (reply also works). Sudo moderators get their own command menu.
* `/panel` — moderator dashboard (private chat): users, groups, commands used, group bans, global bans, warnings, moderation actions, sudo count, daily usage, recent activity. Buttons: USER STATS · GROUP STATS · BANNED USERS · SUDO MANAGEMENT (owner) · RECENT ACTIVITY · REFRESH · CLOSE, with pagination and in-place editing. Every tap re-checks the role.
* `/gban USER_ID [reason]` (or reply), `/ungban USER_ID`, `/gbanlist`, `/gbaninfo USER_ID` — moderators (owner + sudo).

**How /gban works.** The ban is stored once and queued for every active group. The first 20 groups are processed immediately, the rest by the 1-minute cron, so huge group lists never block the webhook. The result message lists confirmed / failed / skipped / still-queued groups — a group is "banned" only after Telegram confirmed it. Users who join later are banned on arrival; groups the bot joins later get the ban queued. The owner and sudo moderators cannot be globally banned. A global ban is separate from a normal group `/ban`.

**/start** is role aware (🎉 𝗪𝗘𝗟𝗖𝗢𝗠𝗘 𝗕𝗢𝗦𝗦! / 𝗠𝗢𝗗𝗘𝗥𝗔𝗧𝗢𝗥! / 𝗪𝗘𝗟𝗖𝗢𝗠𝗘!), uses quote-style blocks, the 🎉 message effect (private chats; automatic fallback) and a 🎉 reaction. Moderators also get a 🛡 PANEL button. A custom `/setwelcome` caption is shown to normal users.

**Configuration:** `BOT_NAME` (used everywhere), `DEVELOPER_ID` (secret; Developer button → `tg://user?id=<id>`; falls back to `DEVELOPER_URL`), `WELCOME_EFFECT`, `UI_BUTTON_STYLES`, `UI_FANCY_BUTTONS`.

**Database:** migration `003_roles_and_global_bans` (additive; applied automatically; also in `migrations/003_roles_and_global_bans.sql`). Tables: `sudo_users`, `bot_audit_log`, `global_bans`, `global_ban_results`, `usage_daily`. They are intentionally **not** part of backups/imports so restoring an old backup never changes who is a moderator or un-bans anybody.

**Telegram limitations:** message effects work only in private chats; button colours (`style`) depend on the client version; a global ban only works in groups where the bot is an admin with the *ban users* right and cannot act on group administrators; `tg://user?id=` opens the profile only if the target's privacy settings allow it; command menus for a sudo user are set best-effort (the person must have started the bot). Deployment identifiers (worker/queue/R2/DB names) are unchanged and the backup file marker stays `nobara-backup` so old backups still import.


## 13. Broadcast system (send a message to every user or group)

The broadcast system sends one message to many chats without freezing the bot. It has three parts: a **preview and confirmation** (nothing is sent until you tap Send Now), a **job** that snapshots the recipient list, and a **queue** that sends the work in small chunks in the background.

### One-time setup

1. Create the queue before the first deploy (the Worker needs it):
   ```bash
   npx wrangler queues create nobara-broadcast
   ```
2. Deploy as usual (`npx wrangler deploy`). The queue binding is already in `wrangler.toml` under `[[queues.producers]]` and `[[queues.consumers]]`.
3. Optional tuning in `wrangler.toml`:
   * `BROADCAST_CHUNK_SIZE` — recipients per queue message. Free plan: keep at 25–40. Paid plan: up to 200.
   * `BROADCAST_CONCURRENCY` — parallel sends inside one chunk (default 10). Telegram allows about 30 messages per second for a bot, so do not raise this much above 20.
4. Check that it works: send `/broadcast users test` to the bot in private, read the preview, tap **Cancel**. Then try a real small broadcast.

### Commands

| Command | Who | What it does |
|---|---|---|
| `/broadcast users <text>` | owner | Message every registered user (private chats with the bot). |
| `/broadcast groups <text>` | owner | Message every group where the bot is active. |
| `/broadcast all <text>` · `/allbroadcast <text>` | owner | Users and groups. |
| `/broadcast users` (reply to a photo, video, document, sticker…) | owner | Sends that media with its caption. |
| `/broadcaststatus [id]` | owner | Progress of a job: sent, failed, skipped, remaining. |
| `/announce <text>` | group admins, inside the group | Posts an announcement in that group only. |

### How a broadcast runs

1. You send `/broadcast …`. The bot shows the **exact** preview with the target count, and two buttons: **Send Now** and **Cancel**.
2. On **Send Now** the bot takes the recipient list at that moment and saves it as a job. The confirmation can be used only once.
3. The job is split into chunks and put on the queue. The queue worker sends one chunk after another (`max_concurrency = 1`, so a job never runs twice in parallel).
4. A cron job every minute restarts any job that stalled (for example after a Worker restart).
5. The progress message is edited as it goes. `/broadcaststatus` shows the same numbers.

### Buttons inside a broadcast

Add button rows at the **end** of the message (the bot only reads a trailing block of button lines), one row per line:

```
Big update is live!
(Read more - https://example.com/news) | (Info - Files are safe)
(Feedback - Thanks for your support)
```

* `(Label - https://…)` → link button.
* `(Label - any text)` → pop-up button (the text appears when tapped).
* `|` puts two buttons on the same row. A new line starts a new row.

### Limits you must know

* A user can receive the broadcast only if they have started the bot. Users who blocked the bot are counted as **failed**, not as success.
* A group receives it only while the bot is still a member. Groups the bot left are **skipped**.
* Telegram limits bots to about 30 messages per second and 20 messages per minute to the same group. The chunk settings keep you under those limits.
* A broadcast cannot be cancelled once **Send Now** is tapped. Check the preview carefully.

---

## 14. Owner tools (v2.1)

Owner-only commands. Moderators and users never see them in `/help` or the command menu.

* **`/setlogchannel <channel id>`** — sends every command, moderation action, global ban, sudo change, bot join/leave and error to a channel. The bot first posts a test message and saves the channel only if that works. Turn it off with `/setlogchannel off`. Setup: create a private channel, add the bot as an administrator with "Post messages", and copy the channel ID (it starts with `-100`).
  * Public commands (/id, /ping, /anime…) and button taps are **not** logged, to avoid spam.
* **`/buttonstyle`** — toggles all button labels between **BLOCK + BOLD** (`𝗛𝗘𝗟𝗟𝗢 𝗖𝗢𝗠𝗠𝗔𝗡𝗗𝗦`) and **ITALIC + BOLD** (`𝙃𝙚𝙡𝙡𝙤 𝘾𝙤𝙢𝙢𝙖𝙣𝙙𝙨`).
* **`/setwelcomeimage`** — shows two buttons: **AUTO PFP** (the welcome message uses the bot's own profile picture) and **MANUAL IMAGE**. A manual picture switches AUTO PFP off. Set your own bot's picture in @BotFather for AUTO PFP to show something.
* **Developer button** — set the secret **`DEVELOPER_ID`** (numeric Telegram user id) with `npx wrangler secret put DEVELOPER_ID` or in the dashboard. The button opens `tg://user?id=<DEVELOPER_ID>`. Without it, `DEVELOPER_URL` is used. Telegram's client decides whether the profile opens; a link to someone who has hidden their profile may show only the ID.

---

## 15. Group helpers: /afk and /approve

* **`/afk [reason]`** / **`/unafk`** — anyone who replies to an AFK member, or mentions them with a text-mention, sees the reason and how long they have been AFK. When the AFK member writes again, the bot says how long they were away.
* **`/approve`** / **`/unapprove`** (reply, or user ID) — approved members are exempt from locks, flood, spam, blacklist and captcha. Group admins only.

### /help in groups

* In a group, `/help` shows the welcome picture, a reaction, and a **📩 DM / Help** button. The button opens the private help, which also lists the group commands (each command shows badges: 🔒 admin, 👥 group only, 🛡 moderator, 👑 owner).
* The group card deletes itself after 5 minutes.

---

## 16. Anime data sources and the status page

The anime commands use **Taizen** (primary) and **AniList** (fallback). **MyAnimeList is not used by this bot.** `/status` (owner) checks both:

* `Available` — working.
* `Busy right now` — AniList or Taizen rate-limited the bot (AniList documents a limit of about 90 requests a minute). This is temporary and the bot falls back automatically.
* `Unavailable` — the request failed. The message under it shows the reason (for example DNS, timeout, HTTP status).

If `/status` shows **Unavailable** for both sources, check that the Worker can reach `graphql.anilist.co` and your `ANIME_API` URL, and read the reason line in `/status`.

---

## 17. Groups, leaderboard, couples, export and clone bots (v3)

### Commands

| Command | Who | What it does |
|---|---|---|
| `/all` · `/atag` | owner, sudo, group owner, group admin | Mentions known group members (in batches of 20, max 300). Members are known from their messages and joins; Telegram does not list every member. |
| `/leaderboard` | everyone (groups) | Top 10 by message count, Today / Weekly / Monthly, with a Group / Global toggle. Needs the image service for the picture. |
| `/couple` | group moderators | Picks 10 pairs from 20 recently active members, once per 24 hours. Sends one picture per pair (needs the image service). |
| `/mypartner` | everyone (groups) | Shows your partner for today, or a trolling line. Lines can be edited by the owner in Bot Controls → Couple trolling lines. |
| `/export` | owner (main); clone owner (own clone only) | Sends every table as one JSON file (limit 45 MB). Inside a clone it exports only that clone's data. |
| `/clonebot` | everyone (private chat) | Creates your own clone bot: BotFather token (send within 60 seconds), then your Turso database URL and token. |
| `/myclone` | clone owner | Stop, resume, restart, maintenance, reset data, delete database, remove. |
| `/clone` | everyone | Opens the main bot's `/clonebot` (use it inside a clone). |

### Setup you must do

1. **Image service** (`image-api/`): deploy to Vercel, set `IMAGE_API_KEY` there, and set `IMAGE_API_URL` and `IMAGE_API_KEY` as Worker secrets. Without it, `/leaderboard` and `/couple` cannot draw pictures. Put a font at `image-api/fonts/NotoSans-Bold.ttf` for the intended style; otherwise a default font is used.
2. **Clone bots**: generate a key with `openssl rand -base64 32` and set it as `CLONE_ENCRYPTION_KEY`. Keep a copy: losing it makes stored clone tokens unreadable.
3. **Public URL**: set `public_base_url` in bot settings. Clone webhooks are `<public_base_url>/webhook/clone/<id>`.
4. Each clone needs its own empty Turso database. The owner is shown a help button that sends the setup guide.

### Usage percentage

Usage = active users / registered users, for the last **day**, **week** and **month**. A user is active when they interact with the bot (`users.last_seen_at`, set on every update). Each bot counts its own users; the Clones panel adds the main bot and every running clone together. A clone database that cannot be read is counted as unavailable, not guessed.

### How clone bots work

- One Worker serves every clone. Each clone has its own webhook URL and its own Turso database; tokens and secrets are stored encrypted (AES-256-GCM).
- A clone is never reported as done until Telegram confirms its webhook (`getWebhookInfo`). If Telegram does not confirm, the clone is shown as **Webhook Not Set** and the owner gets a link to set it again.
- A cron job checks each running clone's webhook every 10 minutes and alerts the owner after 3 failures in a row.
- The Main Owner's **Clones** panel (Bot Controls → 🧬 Clones) lists all clones, stops or restarts them, approves broadcast, changes the per-user limit (default 1) and removes clones. A clone stopped by the Main Owner can only be resumed by the Main Owner.
- Global bans from the main bot are written into every clone's database and queued in that clone's groups. `/ungban` does the same in reverse. A clone's own `/gban` affects only that clone.

### Known gaps (not done yet)

- Clone broadcasts send **text messages only**. Media and copied messages use the main bot's file ids and chats, so they stay on the main bot.
- Clone broadcasts need the Main Owner's permission. A clone owner or moderator taps **Request permission**; the Main Owner gets Accept / Deny in DM. Permission can be removed from the Clones panel, and the cron then cancels that clone's queued jobs.
- `/broadcast` and `/allbroadcast` ask two things before sending: pin it or not, and which approved clones to send to (tap to select, then send). Nothing goes to a clone unless it is selected. Clone progress is not shown in the main chat; the clone owner can use `/broadcaststatus` inside the clone.
- Clone usage statistics and failed-API stats on the dashboard are not collected yet.
- Nothing from this section has been verified against live Telegram and Turso yet.

## Security notes

Secrets only in Wrangler secrets / `.dev.vars` (git-ignored); never logged (`src/utils/logger.js` redacts them); all SQL is parameterised; imported files are data, never code; webhook requests require the secret header; `/setup` is authenticated and rate-limited; the webhook is replaced in place and never deleted by this project.

License: MIT.
