FROM node:24-slim

# Install system deps: ffmpeg for HLS remux, curl for yt-dlp download
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    curl \
    ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Download latest yt-dlp binary
RUN curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
    -o /usr/local/bin/yt-dlp \
  && chmod +x /usr/local/bin/yt-dlp

# Install pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

# Copy workspace manifests first for layer caching
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./

# Copy all package.json files so pnpm can resolve the workspace graph
COPY scripts/package.json ./scripts/
COPY artifacts/api-server/package.json ./artifacts/api-server/
COPY lib/api-client-react/package.json ./lib/api-client-react/
COPY lib/api-spec/package.json ./lib/api-spec/
COPY lib/api-zod/package.json ./lib/api-zod/
COPY lib/db/package.json ./lib/db/

# Install dependencies (frozen lockfile for reproducible builds)
RUN pnpm install --frozen-lockfile --prod 2>/dev/null || pnpm install --frozen-lockfile

# Copy bot source (after install to keep the layer cache warm)
COPY scripts/src/ ./scripts/src/

# Symlink system yt-dlp into the location the bot expects
RUN mkdir -p /app/scripts/bin \
  && ln -sf /usr/local/bin/yt-dlp /app/scripts/bin/yt-dlp

ENV NODE_ENV=production
ENV LOG_LEVEL=info

# Discord bots are long-running processes — no HTTP port needed
CMD ["pnpm", "--filter", "@workspace/scripts", "run", "discord-bot"]
