import http from 'http';
import https from 'https';
import { URL } from 'url';
import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  ActionRowBuilder,
  AttachmentBuilder,
  MessageFlags
} from 'discord.js';
import { searchVideos, getVideoStreamUrl, downloadVideoClip, cleanupClip } from './scraper.mjs';
import { logger } from './logger.mjs';

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;

if (!TOKEN || !CLIENT_ID) {
  logger.error('Missing DISCORD_TOKEN or DISCORD_CLIENT_ID environment variables.');
  process.exit(1);
}

// Hardcoded PornHub search URL
const SEARCH_URL = 'https://www.pornhub.com/video/search?search={query}';

// Temporary search results store: key -> results array
const pendingResults = new Map();

// ── Stream proxy helpers ──────────────────────────────────────────────────────
const PROXY_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
  'Accept': '*/*',
  'Accept-Language': 'en-US,en;q=0.5',
  'Cookie': 'age_verified=1; ageGate=true; confirm=1',
};
const ALLOWED_HOSTS = ['xvideos-cdn.com', 'xvideos.com', 'pornhub.com', 'phncdn.com'];

function isAllowedUrl(raw) {
  try { return ALLOWED_HOSTS.some(h => new URL(raw).hostname.endsWith(h)); } catch { return false; }
}

function fetchUpstream(raw, extra = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(raw);
    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.request(raw, { headers: { ...PROXY_HEADERS, ...extra }, method: 'GET' }, resolve);
    req.on('error', reject);
    req.end();
  });
}

async function fetchText(raw, extra = {}) {
  const res = await fetchUpstream(raw, extra);
  return new Promise((resolve, reject) => {
    let body = '';
    res.setEncoding('utf8');
    res.on('data', c => body += c);
    res.on('end', () => resolve(body));
    res.on('error', reject);
  });
}

function resolveHlsUrl(line, base) {
  try { return new URL(line, base).href; } catch { return line; }
}

function parseMasterPlaylist(text, base) {
  const lines = text.split('\n').map(l => l.trim());
  const streams = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('#EXT-X-STREAM-INF')) {
      const bw = (lines[i].match(/BANDWIDTH=(\d+)/) || [])[1] || '0';
      const next = lines[i + 1] || '';
      if (next && !next.startsWith('#')) streams.push({ bw: parseInt(bw), url: resolveHlsUrl(next, base) });
    }
  }
  if (!streams.length) return null;
  streams.sort((a, b) => a.bw - b.bw);
  return streams[0].url;
}

function parseSegments(text, base) {
  return text.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#')).map(l => resolveHlsUrl(l, base));
}

async function handleStreamProxy(req, res) {
  const reqUrl = new URL(req.url, 'http://localhost');
  const raw = reqUrl.searchParams.get('url');
  const ref = reqUrl.searchParams.get('ref');

  if (!raw || !isAllowedUrl(raw)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Missing or disallowed url' }));
    return;
  }

  const extra = {};
  if (ref) {
    try {
      const o = new URL(ref);
      extra['Referer'] = ref;
      extra['Origin'] = `${o.protocol}//${o.host}`;
    } catch {}
  }

  const isHls = raw.includes('.m3u8') || raw.includes('/hls');

  if (isHls) {
    res.writeHead(200, {
      'Content-Type': 'video/MP2T',
      'Content-Disposition': 'inline; filename="video.ts"',
      'Cache-Control': 'no-store',
      'Transfer-Encoding': 'chunked',
    });

    try {
      const masterText = await fetchText(raw, extra);
      let playlistUrl = raw;

      if (masterText.includes('#EXT-X-STREAM-INF')) {
        const variantUrl = parseMasterPlaylist(masterText, raw);
        if (!variantUrl) { res.end(); return; }
        playlistUrl = variantUrl;
      }

      const variantText = playlistUrl === raw ? masterText : await fetchText(playlistUrl, extra);
      const segments = parseSegments(variantText, playlistUrl).slice(0, 38);

      for (const segUrl of segments) {
        if (res.destroyed) break;
        try {
          const segRes = await fetchUpstream(segUrl, extra);
          await new Promise((resolve, reject) => {
            segRes.on('data', chunk => { if (!res.destroyed) res.write(chunk); });
            segRes.on('end', resolve);
            segRes.on('error', reject);
          });
        } catch { /* skip bad segment */ }
      }
      res.end();
    } catch (err) {
      logger.error('HLS proxy error:', err.message);
      if (!res.writableEnded) res.end();
    }
    return;
  }

  // Direct MP4 proxy
  try {
    const upRes = await fetchUpstream(raw, extra);
    if (upRes.statusCode >= 400) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Upstream ${upRes.statusCode}` }));
      upRes.resume();
      return;
    }
    const headers = {
      'Content-Type': 'video/mp4',
      'Content-Disposition': 'inline; filename="video.mp4"',
      'Cache-Control': 'no-store',
    };
    if (upRes.headers['content-length']) headers['Content-Length'] = upRes.headers['content-length'];
    res.writeHead(upRes.statusCode || 200, headers);
    upRes.pipe(res);
    req.on('close', () => upRes.destroy());
  } catch (err) {
    logger.error('MP4 proxy error:', err.message);
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  }
}

// ── HTTP server: health check + stream proxy ──────────────────────────────────
const PORT = parseInt(process.env.PORT || '5000', 10);
const healthServer = http.createServer(async (req, res) => {
  const path = (req.url || '/').split('?')[0];
  if (path === '/api/stream/video.mp4') {
    await handleStreamProxy(req, res);
  } else {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('OK');
  }
});
healthServer.listen(PORT, () => {
  logger.info(`Health check server listening on port ${PORT}`);
});

// ── Slash commands ────────────────────────────────────────────────────────────
const commands = [
  new SlashCommandBuilder()
    .setName('search')
    .setDescription('Search PornHub for videos')
    .addStringOption(opt =>
      opt
        .setName('query')
        .setDescription('What to search for')
        .setRequired(true)
    ),
].map(cmd => cmd.toJSON());

const rest = new REST({ version: '10' }).setToken(TOKEN);

async function registerCommands() {
  try {
    logger.info('Registering slash commands...');
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
    logger.info('Slash commands registered.');
  } catch (err) {
    logger.error('Failed to register commands:', err.message);
  }
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once('clientReady', () => {
  logger.info(`Bot is online as ${client.user.tag}`);
});

// Wrap the whole handler so one bad interaction never crashes the bot
client.on('interactionCreate', async interaction => {
  try {
    await handleInteraction(interaction);
  } catch (err) {
    logger.error('Interaction error:', err.message, err.stack);
    try {
      const msg = { content: '❌ Something went wrong. Please try again.', flags: MessageFlags.Ephemeral };
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(msg);
      } else {
        await interaction.reply(msg);
      }
    } catch (_) {}
  }
});

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection:', reason instanceof Error ? reason.stack : reason);
});
process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception:', err.stack || err.message);
  process.exit(1);
});

async function handleInteraction(interaction) {
  // Drop interactions older than 2.5s — their tokens are expired (e.g. delivered after a bot restart)
  if (Date.now() - interaction.createdTimestamp > 2500) {
    logger.warn(`Dropping stale interaction (${Date.now() - interaction.createdTimestamp}ms old)`);
    return;
  }

  // ── Slash commands ──────────────────────────────────────────────────────────
  if (interaction.isChatInputCommand()) {
    const { commandName, guildId } = interaction;
    logger.info(`Command /${commandName} from user ${interaction.user.tag} (guild ${guildId})`);

    if (commandName === 'search') {
      const query = interaction.options.getString('query');
      logger.info(`Search query: "${query}"`);
      try {
        await interaction.deferReply();
      } catch (err) {
        if (err.code === 10062 || err.code === 40060) {
          // 10062 = Unknown Interaction (token expired), 40060 = already acknowledged
          logger.warn(`Skipping duplicate/stale interaction (code ${err.code})`);
          return;
        }
        throw err;
      }

      let results;
      try {
        results = await searchVideos(SEARCH_URL, query);
      } catch (err) {
        logger.error('Scrape error:', err.message);
        await interaction.editReply(`❌ Could not fetch results: ${err.message}`);
        return;
      }

      if (!results || results.length === 0) {
        logger.warn(`No results found for query: "${query}"`);
        await interaction.editReply(`❌ No results found for **${query}**. Try a different search term.`);
        return;
      }

      const top10 = results.slice(0, 10);

      const key = `${interaction.user.id}-${Date.now()}`;
      pendingResults.set(key, top10);
      setTimeout(() => pendingResults.delete(key), 5 * 60 * 1000);

      const select = new StringSelectMenuBuilder()
        .setCustomId(`pick_video:${interaction.user.id}:${key}`)
        .setPlaceholder('Choose a video...')
        .addOptions(
          top10.map((r, i) =>
            new StringSelectMenuOptionBuilder()
              .setLabel(`${i + 1}. ${r.title.slice(0, 97)}`)
              .setValue(String(i))
          )
        );

      const row = new ActionRowBuilder().addComponents(select);

      await interaction.editReply({
        content: `🔎 **${top10.length} results** for "${query}" — pick one:`,
        components: [row]
      });
    }
  }

  // ── Select menu ─────────────────────────────────────────────────────────────
  if (interaction.isStringSelectMenu()) {
    const parts = interaction.customId.split(':');
    if (parts[0] !== 'pick_video') return;

    const [, userId, key] = parts;

    if (interaction.user.id !== userId) {
      await interaction.reply({
        content: '❌ Only the person who ran `/search` can pick from this menu.',
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    const results = pendingResults.get(key);
    if (!results) {
      await interaction.update({
        content: '❌ This search has expired. Run `/search` again.',
        components: []
      });
      return;
    }

    const index = parseInt(interaction.values[0], 10);
    const picked = results[index];
    pendingResults.delete(key);

    logger.info(`User ${interaction.user.tag} picked: "${picked.title}" — ${picked.url}`);

    await interaction.update({
      content: `⏳ Fetching **${picked.title}**...`,
      components: []
    });

    const stream = await getVideoStreamUrl(picked.url);
    logger.info(`Stream result: ${stream ? stream.url?.slice(0, 80) : 'null'}`);

    // Try proxy stream first (instant — no download needed)
    const STREAM_BASE_URL = process.env.STREAM_BASE_URL;
    if (STREAM_BASE_URL && stream?.url) {
      const proxyUrl = `${STREAM_BASE_URL}/api/stream/video.mp4?url=${encodeURIComponent(stream.url)}&ref=${encodeURIComponent(picked.url)}`;
      logger.info(`Using proxy stream: ${proxyUrl.slice(0, 100)}`);
      await interaction.editReply({
        content: `🎬 **${picked.title}**\n${proxyUrl}`
      });
      return;
    }

    // Fall back to download + upload
    logger.info('Proxy not available — falling back to download');
    const filePath = await downloadVideoClip(
      stream?.url || '',
      stream?.cookies || '',
      picked.url
    );

    if (filePath) {
      logger.info(`Uploading file to Discord: ${filePath}`);
      const attachment = new AttachmentBuilder(filePath, { name: 'video.mp4' });
      await interaction.editReply({
        content: `🎬 **${picked.title}**`,
        files: [attachment]
      });
      await cleanupClip(filePath);
    } else {
      logger.warn(`Download failed for: ${picked.url}`);
      await interaction.editReply({
        content: `🎬 **${picked.title}**\n${picked.url}\n\n> ⚠️ Couldn't download this video directly. Click the link above to watch.`
      });
    }
  }
}

await registerCommands();
client.login(TOKEN);
