# Workspace

## Overview

pnpm workspace monorepo using TypeScript. Contains a Discord bot (EverGuard#7142) that lets users search video sites and receive downloadable clips.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm

## Discord Bot (`scripts/src/discord-bot/`)

**Commands:**
- `/search <query>` — Search PornHub + Xvideos + XNXX + XXBrits combined, shows results with thumbnails
- `/search20 <query>` — Search and post 10 related videos directly into the channel with thumbnails

**Search sources:** PornHub (API), Xvideos, XNXX, XXBrits — searched in parallel, results interleaved.

**Search relevance:**
The scraper scores results by counting how many words from the query appear in the result title. Results with zero matching words are discarded.

**Logging:**
All bot activity is logged with timestamps and log levels via `scripts/src/discord-bot/logger.mjs`. Set `LOG_LEVEL=debug` for verbose output.

**Video playback pipeline (in order):**
1. HTML scraper — extracts direct MP4 or HLS URL from the video page
2. If `STREAM_BASE_URL` is set: creates a short proxy link Discord can unfurl as an inline player
3. yt-dlp URL extraction (Chrome TLS impersonation) — also proxied via short link
4. Direct download + upload as Discord attachment (fallback if no STREAM_BASE_URL)
5. Last resort: sends the page link

**How inline video playback works:**
The bot runs an HTTP server on `PORT` (default 5000). When `STREAM_BASE_URL` is set to the public URL of that server (e.g. your Render service URL), the bot creates short `/v/:id` links that Discord's embed bot unfurls into inline video players via OG tags. Without `STREAM_BASE_URL`, the bot falls back to uploading the file directly to Discord (8 MB limit).

**Known CDN limitation:** PornHub's CDN (`ev.phncdn.com`) blocks some hosting provider IPs. The bot extracts the HLS stream URL and proxies it through ffmpeg — this works as long as the HLS manifest itself is accessible.

**Files:**
- `scripts/src/discord-bot/index.mjs` — bot commands, select menu, stream proxy server
- `scripts/src/discord-bot/scraper.mjs` — search scraper, relevance filtering, stream URL extraction, download pipeline
- `scripts/src/discord-bot/logger.mjs` — lightweight structured logger (timestamps + log levels)
- `scripts/bin/yt-dlp` — standalone yt-dlp binary (gitignored)

**Required env vars:**
- `DISCORD_TOKEN` — bot token from Discord Developer Portal
- `DISCORD_CLIENT_ID` — application ID from Discord Developer Portal
- `STREAM_BASE_URL` — public URL of the bot's HTTP server, e.g. `https://my-bot.onrender.com` (enables inline video playback in Discord)
- `LOG_LEVEL` — optional, defaults to `info` (set to `debug` for verbose logs)
- `PORT` — optional, defaults to `5000`

**Workflow:** `Discord Bot` → `pnpm --filter @workspace/scripts run discord-bot`

## Render Deployment

A `Dockerfile` is included at the project root for deploying to Render:

**To deploy on Render:**
1. Push the repo to GitHub
2. Go to [render.com](https://render.com) → New → Web Service
3. Connect your GitHub repo
4. Set **Environment** to `Docker`
5. Set **Instance Type** to `Free` (or Starter for always-on)
6. Add environment variables:
   - `DISCORD_TOKEN` — your bot token
   - `DISCORD_CLIENT_ID` — your application ID
   - `STREAM_BASE_URL` — set to your Render service URL, e.g. `https://my-bot.onrender.com`
   - `PORT` — `5000`
7. Deploy

**UptimeRobot (to prevent Render free-tier spin-down):**
1. Go to [uptimerobot.com](https://uptimerobot.com) → Add New Monitor
2. Monitor Type: **HTTP(s)**
3. URL: `https://my-bot.onrender.com/health`
4. Monitoring Interval: **5 minutes**
5. The `/health` endpoint returns `{"status":"ok","uptime":...}` — UptimeRobot will keep the service alive

**Note:** Free Render instances spin down after 15 minutes of no HTTP traffic. UptimeRobot pinging `/health` every 5 minutes prevents this.

## Key Commands

- `pnpm --filter @workspace/scripts run discord-bot` — run the Discord bot
- `pnpm install` — install all workspace dependencies

See the `pnpm-workspace` skill for workspace structure.
