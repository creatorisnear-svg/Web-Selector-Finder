import http from 'http';
import https from 'https';
import { URL } from 'url';
import { spawn } from 'child_process';
import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags
} from 'discord.js';
import { searchVideos, getVideoStreamUrl, getDirectMp4Url, downloadVideoClip, cleanupClip } from './scraper.mjs';
import { logger } from './logger.mjs';

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;

if (!TOKEN || !CLIENT_ID) {
  logger.error('Missing DISCORD_TOKEN or DISCORD_CLIENT_ID environment variables.');
  process.exit(1);
}

// Hardcoded PornHub search URL
const SEARCH_URL = 'https://www.pornhub.com/video/search?search={query}';

// Temporary search results store: key -> { results, query, site }
const pendingResults = new Map();

// Short video link store: shortId -> { streamUrl, refUrl, title }
// Links expire after 2 hours — long enough for Discord to cache the embed.
const videoLinks = new Map();

function createShortLink(streamUrl, refUrl, title) {
  const id = Math.random().toString(36).slice(2, 9); // 7-char ID e.g. "k4x9bza"
  videoLinks.set(id, { streamUrl, refUrl, title });
  setTimeout(() => videoLinks.delete(id), 2 * 60 * 60 * 1000);
  return `${process.env.STREAM_BASE_URL}/v/${id}`;
}

// ── Stream proxy helpers ──────────────────────────────────────────────────────
const PROXY_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
  'Accept': '*/*',
  'Accept-Language': 'en-US,en;q=0.5',
  'Cookie': 'age_verified=1; ageGate=true; confirm=1',
};
const ALLOWED_HOSTS = ['xvideos-cdn.com', 'xvideos.com', 'pornhub.com', 'phncdn.com', 'xnxx.com', 'xnxx-cdn.com', 'xvideos2.com'];

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


async function handleStreamProxy(req, res) {
  const reqUrl = new URL(req.url, 'http://localhost');
  const raw = reqUrl.searchParams.get('url');
  const ref = reqUrl.searchParams.get('ref');

  if (!raw || !isAllowedUrl(raw)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Missing or disallowed url' }));
    return;
  }

  // Discord's unfurler sends HEAD/GET with "Discordbot" UA.
  // Serve OG-tag HTML so Discord renders an inline embed.
  // The og:video points to /api/stream/play/video.mp4 which ALWAYS streams (never returns HTML).
  const ua = req.headers['user-agent'] || '';
  const isUnfurler = ua.includes('Discordbot') || ua.includes('Twitterbot') || ua.includes('facebookexternalhit') || req.method === 'HEAD';
  if (isUnfurler) {
    const playUrl = `${process.env.STREAM_BASE_URL}/api/stream/play/video.mp4?url=${encodeURIComponent(raw)}&ref=${encodeURIComponent(ref || '')}`;
    const html = `<!DOCTYPE html><html><head>
<meta property="og:type" content="video.other"/>
<meta property="og:video" content="${playUrl}"/>
<meta property="og:video:secure_url" content="${playUrl}"/>
<meta property="og:video:type" content="video/mp4"/>
<meta property="og:video:width" content="1280"/>
<meta property="og:video:height" content="720"/>
</head><body></body></html>`;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
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
      'Content-Type': 'video/mp4',
      'Content-Disposition': 'inline; filename="video.mp4"',
      'Cache-Control': 'no-store',
      'Transfer-Encoding': 'chunked',
    });

    // Build ffmpeg headers string for HLS auth
    const ffHeaders = [
      `User-Agent: ${PROXY_HEADERS['User-Agent']}`,
      `Cookie: ${PROXY_HEADERS['Cookie']}`,
      extra['Referer'] ? `Referer: ${extra['Referer']}` : '',
    ].filter(Boolean).join('\r\n') + '\r\n';

    const ff = spawn('ffmpeg', [
      '-headers', ffHeaders,
      '-i', raw,
      '-t', '75',
      '-c:v', 'copy',
      '-c:a', 'copy',
      '-bsf:a', 'aac_adtstoasc',
      '-f', 'mp4',
      '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
      '-loglevel', 'error',
      'pipe:1',
    ]);

    ff.stdout.pipe(res);
    ff.stderr.on('data', d => logger.warn('ffmpeg stderr:', d.toString().slice(0, 200)));
    ff.on('error', err => {
      logger.error('ffmpeg spawn error:', err.message);
      if (!res.writableEnded) res.end();
    });
    ff.on('close', () => { if (!res.writableEnded) res.end(); });
    req.on('close', () => ff.kill('SIGTERM'));
    return;
  }

  // Direct MP4 proxy — forward range requests so seeking works
  try {
    const rangeHeader = req.headers['range'];
    const upHeaders = { ...extra };
    if (rangeHeader) upHeaders['Range'] = rangeHeader;

    const upRes = await fetchUpstream(raw, upHeaders);
    if (upRes.statusCode >= 400) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Upstream ${upRes.statusCode}` }));
      upRes.resume();
      return;
    }
    const statusCode = rangeHeader && upRes.statusCode === 206 ? 206 : 200;
    const headers = {
      'Content-Type': upRes.headers['content-type'] || 'video/mp4',
      'Content-Disposition': 'inline; filename="video.mp4"',
      'Cache-Control': 'no-store',
      'Accept-Ranges': 'bytes',
    };
    if (upRes.headers['content-length']) headers['Content-Length'] = upRes.headers['content-length'];
    if (upRes.headers['content-range']) headers['Content-Range'] = upRes.headers['content-range'];
    res.writeHead(statusCode, headers);
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

// Always streams video — used by the og:video URL so Discord's player gets real data
async function handleVideoStream(req, res) {
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
      'Content-Type': 'video/mp4',
      'Content-Disposition': 'inline; filename="video.mp4"',
      'Cache-Control': 'no-store',
      'Accept-Ranges': 'none',
    });

    const ffHeaders = [
      `User-Agent: ${PROXY_HEADERS['User-Agent']}`,
      `Cookie: ${PROXY_HEADERS['Cookie']}`,
      extra['Referer'] ? `Referer: ${extra['Referer']}` : '',
    ].filter(Boolean).join('\r\n') + '\r\n';

    const ff = spawn('ffmpeg', [
      '-headers', ffHeaders,
      '-i', raw,
      '-c:v', 'copy',
      '-c:a', 'copy',
      '-bsf:a', 'aac_adtstoasc',
      '-f', 'mp4',
      '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
      '-loglevel', 'error',
      'pipe:1',
    ]);

    ff.stdout.pipe(res);
    ff.stderr.on('data', d => logger.warn('ffmpeg stderr:', d.toString().slice(0, 200)));
    ff.on('error', err => { logger.error('ffmpeg error:', err.message); if (!res.writableEnded) res.end(); });
    ff.on('close', () => { if (!res.writableEnded) res.end(); });
    req.on('close', () => ff.kill('SIGTERM'));
    return;
  }

  // Direct MP4 — support byte-range requests so Discord's player can seek
  try {
    const rangeHeader = req.headers['range'];
    const upHeaders = { ...extra };
    if (rangeHeader) upHeaders['Range'] = rangeHeader;

    const upRes = await fetchUpstream(raw, upHeaders);
    if (upRes.statusCode >= 400) {
      res.writeHead(502); res.end(); upRes.resume(); return;
    }

    const statusCode = rangeHeader && upRes.statusCode === 206 ? 206 : 200;
    const headers = {
      'Content-Type': upRes.headers['content-type'] || 'video/mp4',
      'Content-Disposition': 'inline; filename="video.mp4"',
      'Cache-Control': 'no-store',
      'Accept-Ranges': 'bytes',
    };
    if (upRes.headers['content-length']) headers['Content-Length'] = upRes.headers['content-length'];
    if (upRes.headers['content-range']) headers['Content-Range'] = upRes.headers['content-range'];

    res.writeHead(statusCode, headers);
    upRes.pipe(res);
    req.on('close', () => upRes.destroy());
  } catch (err) {
    logger.error('MP4 stream error:', err.message);
    if (!res.headersSent) { res.writeHead(502); res.end(); }
  }
}

// ── HTTP server: health check + stream proxy ──────────────────────────────────
const PORT = parseInt(process.env.PORT || '5000', 10);
const healthServer = http.createServer(async (req, res) => {
  const path = (req.url || '/').split('?')[0];

  if (path === '/api/stream/video.mp4') {
    await handleStreamProxy(req, res);
    return;
  }

  if (path === '/api/stream/play/video.mp4') {
    await handleVideoStream(req, res);
    return;
  }

  // Short video links: /v/:id
  const shortMatch = path.match(/^\/v\/([a-z0-9]+)$/i);
  if (shortMatch) {
    const id = shortMatch[1];
    const link = videoLinks.get(id);
    if (!link) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Link expired or not found');
      return;
    }
    const { streamUrl, refUrl, title } = link;
    const playUrl = `${process.env.STREAM_BASE_URL}/api/stream/play/video.mp4?url=${encodeURIComponent(streamUrl)}&ref=${encodeURIComponent(refUrl || '')}`;
    const ua = req.headers['user-agent'] || '';
    const isUnfurler = ua.includes('Discordbot') || ua.includes('Twitterbot') || ua.includes('facebookexternalhit') || req.method === 'HEAD';
    if (isUnfurler) {
      const safeTitle = (title || 'Video').replace(/"/g, '&quot;');
      const html = `<!DOCTYPE html><html><head>
<meta property="og:type" content="video.other"/>
<meta property="og:title" content="${safeTitle}"/>
<meta property="og:video" content="${playUrl}"/>
<meta property="og:video:secure_url" content="${playUrl}"/>
<meta property="og:video:type" content="video/mp4"/>
<meta property="og:video:width" content="1280"/>
<meta property="og:video:height" content="720"/>
</head><body></body></html>`;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } else {
      // Regular browser — redirect straight to the stream
      res.writeHead(302, { 'Location': playUrl });
      res.end();
    }
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('OK');
});
healthServer.listen(PORT, () => {
  logger.info(`Health check server listening on port ${PORT}`);
});

// ── Slash commands ────────────────────────────────────────────────────────────
const commands = [
  new SlashCommandBuilder()
    .setName('search')
    .setDescription('Search for videos')
    .addStringOption(opt =>
      opt.setName('query').setDescription('What to search for').setRequired(true)
    )
    .addStringOption(opt =>
      opt.setName('site')
        .setDescription('Which site to search (default: Xvideos/Pornhub)')
        .setRequired(false)
        .addChoices(
          { name: 'Xvideos / Pornhub (default)', value: 'auto' },
          { name: 'XNXX', value: 'xnxx' },
        )
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

const PAGE_SIZE = 5;

function buildResultsPage(results, page, key, userId, site = 'auto') {
  const totalPages = Math.ceil(results.length / PAGE_SIZE);
  const start = page * PAGE_SIZE;
  const pageItems = results.slice(start, start + PAGE_SIZE);
  const siteLabel = site === 'xnxx' ? 'XNXX' : 'Xvideos/Pornhub';

  const embed = new EmbedBuilder()
    .setTitle(`🔎 Search Results — Page ${page + 1} of ${totalPages}`)
    .setColor(site === 'xnxx' ? 0xe74c3c : 0x5865F2)
    .setDescription(
      pageItems.map((r, i) => {
        const num = start + i + 1;
        const dur = r.duration ? ` \`${r.duration}\`` : '';
        return `**${num}.** ${r.title}${dur}`;
      }).join('\n\n')
    )
    .setFooter({ text: `${results.length} videos from ${siteLabel} • Pick a number or browse` });

  const selectRow = new ActionRowBuilder().addComponents(
    pageItems.map((_, i) =>
      new ButtonBuilder()
        .setCustomId(`sel:${userId}:${key}:${start + i}`)
        .setLabel(String(start + i + 1))
        .setStyle(ButtonStyle.Primary)
    )
  );

  const navRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`nav:${userId}:${key}:${page - 1}`)
      .setLabel('◀ Prev')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page === 0),
    new ButtonBuilder()
      .setCustomId(`nav:${userId}:${key}:${page + 1}`)
      .setLabel('Next ▶')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page >= totalPages - 1),
    new ButtonBuilder()
      .setCustomId(`ref:${userId}:${key}`)
      .setLabel('🔄 Refresh')
      .setStyle(ButtonStyle.Success)
  );

  return { embeds: [embed], components: [selectRow, navRow] };
}

const YTDLP_TIMEOUT_MS = 12000;

async function handleVideoFetch(interaction, picked, isUpdate = true) {
  const fetchPayload = { content: `⏳ Fetching **${picked.title}**...`, embeds: [], components: [] };
  if (isUpdate) await interaction.update(fetchPayload);
  else await interaction.editReply(fetchPayload);

  const STREAM_BASE_URL = process.env.STREAM_BASE_URL;

  // Step 1: HTML scraper — fast (1-2s), now extracts direct MP4 URLs for xvideos.
  // If it returns a direct MP4 we proxy it immediately without calling yt-dlp at all.
  const stream = await getVideoStreamUrl(picked.url);
  logger.info(`Stream result: ${stream ? `${stream.isHls ? 'HLS' : 'MP4'} ${stream.url?.slice(0, 60)}` : 'null'}`);

  if (STREAM_BASE_URL && stream?.url && !stream.isHls) {
    const shortUrl = createShortLink(stream.url, picked.url, picked.title);
    logger.info(`Fast path — short link: ${shortUrl}`);
    await interaction.editReply({ content: shortUrl, embeds: [], components: [] });
    return;
  }

  // Step 2: Scraper got HLS or nothing — try yt-dlp with a hard timeout so it never hangs.
  if (STREAM_BASE_URL) {
    logger.info('HLS/no URL — trying yt-dlp (12s timeout)...');
    const directUrl = await Promise.race([
      getDirectMp4Url(picked.url, stream?.cookies || ''),
      new Promise(r => setTimeout(() => r(null), YTDLP_TIMEOUT_MS)),
    ]);
    if (directUrl) {
      const shortUrl = createShortLink(directUrl, picked.url, picked.title);
      logger.info(`yt-dlp short link: ${shortUrl}`);
      await interaction.editReply({ content: shortUrl, embeds: [], components: [] });
      return;
    }
    logger.warn('yt-dlp timed out or returned nothing — falling back to download');
  }

  // Step 3: Download and upload directly to Discord as a file.
  logger.info('Downloading clip for upload...');
  const filePath = await downloadVideoClip(stream?.url || '', stream?.cookies || '', picked.url);

  if (filePath) {
    logger.info(`Uploading file to Discord: ${filePath}`);
    const attachment = new AttachmentBuilder(filePath, { name: 'video.mp4' });
    await interaction.editReply({ content: `🎬 **${picked.title}**`, embeds: [], components: [], files: [attachment] });
    await cleanupClip(filePath);
  } else {
    logger.warn(`All methods failed for: ${picked.url}`);
    await interaction.editReply({
      content: `🎬 **${picked.title}**\n${picked.url}\n\n> ⚠️ Couldn't fetch this video. Click the link to watch.`,
      embeds: [],
      components: []
    });
  }
}

async function runSearch(query, site) {
  const results = await searchVideos(SEARCH_URL, query, site);
  return results ? results.slice(0, 20) : [];
}

async function handleInteraction(interaction) {
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
      const site = interaction.options.getString('site') || 'auto';
      logger.info(`Search query: "${query}" site: ${site}`);
      try {
        await interaction.deferReply();
      } catch (err) {
        if (err.code === 10062 || err.code === 40060) {
          logger.warn(`Skipping duplicate/stale interaction (code ${err.code})`);
          return;
        }
        throw err;
      }

      let top20;
      try {
        top20 = await runSearch(query, site);
      } catch (err) {
        logger.error('Scrape error:', err.message);
        await interaction.editReply(`❌ Could not fetch results: ${err.message}`);
        return;
      }

      if (!top20 || top20.length === 0) {
        logger.warn(`No results found for query: "${query}"`);
        await interaction.editReply(`❌ No results found for **${query}**. Try a different search term.`);
        return;
      }

      const key = `${interaction.user.id}-${Date.now()}`;
      pendingResults.set(key, { results: top20, query, site });
      setTimeout(() => pendingResults.delete(key), 5 * 60 * 1000);

      await interaction.editReply(buildResultsPage(top20, 0, key, interaction.user.id, site));
    }
  }

  // ── Buttons ─────────────────────────────────────────────────────────────────
  if (interaction.isButton()) {
    const parts = interaction.customId.split(':');
    const [type, userId, key] = parts;

    if (!['sel', 'nav', 'ref'].includes(type)) return;

    if (interaction.user.id !== userId) {
      await interaction.reply({
        content: '❌ Only the person who ran `/search` can use these buttons.',
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    const stored = pendingResults.get(key);
    if (!stored) {
      await interaction.update({ content: '❌ This search has expired. Run `/search` again.', embeds: [], components: [] });
      return;
    }

    const { results, query, site } = stored;

    if (type === 'nav') {
      const page = parseInt(parts[3], 10);
      await interaction.update(buildResultsPage(results, page, key, userId, site));
      return;
    }

    if (type === 'sel') {
      const index = parseInt(parts[3], 10);
      const picked = results[index];
      pendingResults.delete(key);
      logger.info(`User ${interaction.user.tag} picked: "${picked.title}" — ${picked.url}`);
      await handleVideoFetch(interaction, picked, true);
      return;
    }

    if (type === 'ref') {
      // deferUpdate holds the interaction open (up to 15 min) so editReply works after async work.
      await interaction.deferUpdate();
      let fresh;
      try {
        fresh = await runSearch(query, site);
      } catch (err) {
        logger.error('Refresh scrape error:', err.message);
        await interaction.editReply({ content: '❌ Refresh failed. Try `/search` again.', embeds: [], components: [] });
        return;
      }
      if (!fresh || fresh.length === 0) {
        await interaction.editReply({ content: `❌ No results on refresh for **${query}**.`, embeds: [], components: [] });
        return;
      }
      const newKey = `${userId}-${Date.now()}`;
      pendingResults.delete(key);
      pendingResults.set(newKey, { results: fresh, query, site });
      setTimeout(() => pendingResults.delete(newKey), 5 * 60 * 1000);
      await interaction.editReply(buildResultsPage(fresh, 0, newKey, userId, site));
    }
  }
}

await registerCommands();
client.login(TOKEN);
