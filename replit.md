# Workspace

## Overview

pnpm workspace monorepo using TypeScript. Contains a Discord bot (EverGuard#7142) that lets users search video sites and receive downloadable clips.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm

## Discord Bot (`scripts/src/discord-bot/`)

**Commands:**
- `/website <url>` — Set target site URL with `{query}` placeholder (e.g. `https://www.pornhub.com/video/search?search={query}`)
- `/search <query>` — Search the configured site, returns up to 10 results sorted by relevance

**Search relevance:**
The scraper scores results by counting how many words from the query appear in the result title. Results with zero matching words are discarded. This prevents unrelated videos from appearing when searching on sites like PH.

**Logging:**
All bot activity is logged with timestamps and log levels via `scripts/src/discord-bot/logger.mjs`. Set `LOG_LEVEL=debug` for verbose output.

**Download pipeline (in order):**
1. `getVideoStreamUrl()` — fetches page, calls `get_media` API (for PH), parses flashvars
2. Direct axios mp4 download with session cookies
3. HLS segment download via axios + ffmpeg remux
4. yt-dlp (standalone binary at `scripts/bin/yt-dlp`) with Chrome TLS impersonation
5. Fallback: sends page link if all methods fail

**Known CDN limitation:** PornHub's CDN (`ev.phncdn.com`) blocks ALL requests from Replit's GCP IP. This is intentional anti-piracy protection. The bot falls back to sending the page link. On Koyeb, this may work better since it uses different IP ranges.

**Files:**
- `scripts/src/discord-bot/index.mjs` — bot commands, select menu, attachment upload
- `scripts/src/discord-bot/scraper.mjs` — search scraper, relevance filtering, stream URL extraction, download pipeline
- `scripts/src/discord-bot/logger.mjs` — lightweight structured logger (timestamps + log levels)
- `scripts/bin/yt-dlp` — standalone yt-dlp binary (gitignored)

**Required env vars:**
- `DISCORD_TOKEN` — bot token from Discord Developer Portal
- `DISCORD_CLIENT_ID` — application ID from Discord Developer Portal
- `LOG_LEVEL` — optional, defaults to `info` (set to `debug` for verbose logs)

**Workflow:** `Discord Bot` → `pnpm --filter @workspace/scripts run discord-bot`

## Koyeb Deployment

A `Dockerfile` is included at the project root for deploying to Koyeb:
1. Installs ffmpeg and downloads the latest yt-dlp binary automatically
2. Installs pnpm and all workspace dependencies
3. Starts the bot with `pnpm --filter @workspace/scripts run discord-bot`

**To deploy on Koyeb:**
1. Push the repo to GitHub (make sure `scripts/bin/yt-dlp` is committed or let Docker download it)
2. Create a new Koyeb service → "Deploy from GitHub"
3. Set build method to **Dockerfile**
4. Add environment variables: `DISCORD_TOKEN` and `DISCORD_CLIENT_ID`
5. Set instance type to **Nano** (the bot uses very little RAM)
6. Deploy — Koyeb will build and run the container

## Key Commands

- `pnpm --filter @workspace/scripts run discord-bot` — run the Discord bot

See the `pnpm-workspace` skill for workspace structure.
