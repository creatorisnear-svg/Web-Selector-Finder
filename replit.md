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
- `/search <query>` — Search the configured site, returns 10 results in a dropdown

**Download pipeline (in order):**
1. `getVideoStreamUrl()` — fetches page, calls `get_media` API (for PH), parses flashvars
2. Direct axios mp4 download with session cookies
3. HLS segment download via axios + ffmpeg remux
4. yt-dlp (standalone binary at `scripts/bin/yt-dlp`) with Chrome TLS impersonation
5. Fallback: sends page link if all methods fail

**Known CDN limitation:** PornHub's CDN (`ev.phncdn.com`) blocks ALL requests from Replit's GCP IP (`35.238.86.175`). This is intentional anti-piracy protection. Even yt-dlp cannot bypass it. The bot falls back to sending the page link. Other video sites with less restrictive CDNs will work for direct video delivery.

**Files:**
- `scripts/src/discord-bot/index.mjs` — bot commands, select menu, attachment upload
- `scripts/src/discord-bot/scraper.mjs` — search scraper, stream URL extraction, download pipeline
- `scripts/bin/yt-dlp` — standalone yt-dlp binary (gitignored)

**Workflow:** `Discord Bot` → `pnpm --filter @workspace/scripts run discord-bot`

## Key Commands

- `pnpm --filter @workspace/scripts run discord-bot` — run the Discord bot

See the `pnpm-workspace` skill for workspace structure.
