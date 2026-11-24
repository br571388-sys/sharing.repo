# Secrets for Nobara bot

> This file lists only the **names** of secrets and how to set them.
> It never contains real values. Keep real values only in Cloudflare secrets
> (or a git-ignored `.dev.vars` for local testing).

## Required

| Name | What it is | Where to get it |
|---|---|---|
| `BOT_TOKEN` | Telegram bot token | @BotFather → `/token` |
| `TURSO_DATABASE_URL` | Database URL (`libsql://…`) | Turso dashboard |
| `TURSO_AUTH_TOKEN` | Turso auth token | `turso db tokens create <db>` |
| `WEBHOOK_SECRET` | Checks that requests really come from Telegram (1–256 chars: A-Z a-z 0-9 _ -) | `npm run gen` prints a random value |
| `SETUP_SECRET` | Password for `/setup` and `/status` (use 20+ characters) | Make your own, keep it private |

## Optional

| Name | What it is | When needed |
|---|---|---|
| `PIXABAY_API_KEY` | Pixabay image search | Only if `IMAGE_PROVIDER = "pixabay"` |
| `DEVELOPER_ID` | Your numeric Telegram user id, used by the Developer button (`tg://user?id=…`) | Optional. Without it, `DEVELOPER_URL` is used |
| `IMAGE_API_URL` | Base URL of the image service (`image-api/image.py` on Vercel) | Only for `/leaderboard` and `/couple` pictures |
| `IMAGE_API_KEY` | Shared key sent in the `X-Image-Key` header; must equal the key set on the image service | Required when `IMAGE_API_URL` is set |
| `CLONE_ENCRYPTION_KEY` | 32 random bytes, base64. Encrypts clone bot tokens, Turso tokens and webhook secrets (AES-256-GCM) | Only for `/clonebot`. Generate with `openssl rand -base64 32`. Losing it makes stored clones unusable |

## How to set them

Run these from the project folder. Wrangler asks for each value and never writes it to disk:

```bash
npx wrangler secret put BOT_TOKEN
npx wrangler secret put TURSO_DATABASE_URL
npx wrangler secret put TURSO_AUTH_TOKEN
npx wrangler secret put WEBHOOK_SECRET
npx wrangler secret put SETUP_SECRET
npx wrangler secret put PIXABAY_API_KEY   # optional
npx wrangler secret put DEVELOPER_ID      # optional
npx wrangler secret put IMAGE_API_URL     # optional
npx wrangler secret put IMAGE_API_KEY     # optional (same value as on the image service)
npx wrangler secret put CLONE_ENCRYPTION_KEY  # optional, needed for /clonebot
```

List the names that are set (values are never shown):

```bash
npx wrangler secret list
```

## Rules

- Never put a secret in `wrangler.toml`, in code, in this file, or in a chat message.
- Never commit `.dev.vars`. It is for local testing only and must stay git-ignored.
- If a secret leaks, rotate it: set a new value with `wrangler secret put <NAME>` and, for `BOT_TOKEN`, revoke the old token in @BotFather.
- After changing `BOT_TOKEN` or `WEBHOOK_SECRET`, open `/setup` once so the webhook is updated.
