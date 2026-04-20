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
  } else if (path === '/api/stream/play/video.mp4') {
    // Always stream — never return HTML regardless of user-agent
    await handleVideoStream(req, res);
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

const PAGE_SIZE = 5;

function buildResultsPage(results, page, key, userId) {
  const totalPages = Math.ceil(results.length / PAGE_SIZE);
  const start = page * PAGE_SIZE;
  const pageItems = results.slice(start, start + PAGE_SIZE);

  const embed = new EmbedBuilder()
    .setTitle(`🔎 Search Results — Page ${page + 1} of ${totalPages}`)
    .setColor(0x5865F2)
    .setDescription(
      pageItems.map((r, i) => {
        const num = start + i + 1;
        const dur = r.duration ? ` \`${r.duration}\`` : '';
        return `**${num}.** ${r.title}${dur}`;
      }).join('\n\n')
    )
    .setFooter({ text: `${results.length} videos found • Pick a number or use the arrows to browse` });

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
      .setLabel('◀ Previous')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page === 0),
    new ButtonBuilder()
      .setCustomId(`nav:${userId}:${key}:${page + 1}`)
      .setLabel('Next ▶')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page >= totalPages - 1)
  );

  return { embeds: [embed], components: [selectRow, navRow] };
}

async function handleVideoFetch(interaction, picked, isUpdate = true) {
  const fetchPayload = { content: `⏳ Fetching **${picked.title}**...`, embeds: [], components: [] };
  if (isUpdate) await interaction.update(fetchPayload);
  else await interaction.editReply(fetchPayload);

  const STREAM_BASE_URL = process.env.STREAM_BASE_URL;

  let proxyTargetUrl = null;
  if (STREAM_BASE_URL) {
    logger.info('Trying yt-dlp direct URL extraction...');
    proxyTargetUrl = await getDirectMp4Url(picked.url, '');
  }

  if (STREAM_BASE_URL && proxyTargetUrl) {
    const proxyUrl = `${STREAM_BASE_URL}/api/stream/video.mp4?url=${encodeURIComponent(proxyTargetUrl)}&ref=${encodeURIComponent(picked.url)}`;
    logger.info(`Using yt-dlp proxy URL: ${proxyUrl.slice(0, 100)}`);
    await interaction.editReply({ content: `🎬 **${picked.title}**\n${proxyUrl}`, embeds: [], components: [] });
    return;
  }

  const stream = await getVideoStreamUrl(picked.url);
  logger.info(`Stream result: ${stream ? stream.url?.slice(0, 80) : 'null'}`);

  if (STREAM_BASE_URL && stream?.url && !stream.isHls) {
    const proxyUrl = `${STREAM_BASE_URL}/api/stream/video.mp4?url=${encodeURIComponent(stream.url)}&ref=${encodeURIComponent(picked.url)}`;
    logger.info(`Using scraped MP4 proxy: ${proxyUrl.slice(0, 100)}`);
    await interaction.editReply({ content: `🎬 **${picked.title}**\n${proxyUrl}`, embeds: [], components: [] });
    return;
  }

  logger.info('No proxiable URL found — downloading for upload...');
  const filePath = await downloadVideoClip(stream?.url || '', stream?.cookies || '', picked.url);

  if (filePath) {
    logger.info(`Uploading file to Discord: ${filePath}`);
    const attachment = new AttachmentBuilder(filePath, { name: 'video.mp4' });
    await interaction.editReply({ content: `🎬 **${picked.title}**`, embeds: [], components: [], files: [attachment] });
    await cleanupClip(filePath);
  } else {
    logger.warn(`Download failed for: ${picked.url}`);
    await interaction.editReply({
      content: `🎬 **${picked.title}**\n${picked.url}\n\n> ⚠️ Couldn't download directly. Click the link to watch.`,
      embeds: [],
      components: []
    });
  }
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
      logger.info(`Search query: "${query}"`);
      try {
        await interaction.deferReply();
      } catch (err) {
        if (err.code === 10062 || err.code === 40060) {
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

      const top20 = results.slice(0, 20);
      const key = `${interaction.user.id}-${Date.now()}`;
      pendingResults.set(key, top20);
      setTimeout(() => pendingResults.delete(key), 5 * 60 * 1000);

      await interaction.editReply(buildResultsPage(top20, 0, key, interaction.user.id));
    }
  }

  // ── Buttons ─────────────────────────────────────────────────────────────────
  if (interaction.isButton()) {
    const parts = interaction.customId.split(':');
    const [type, userId, key] = parts;

    if (type !== 'sel' && type !== 'nav') return;

    if (interaction.user.id !== userId) {
      await interaction.reply({
        content: '❌ Only the person who ran `/search` can use these buttons.',
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    const results = pendingResults.get(key);
    if (!results) {
      await interaction.update({ content: '❌ This search has expired. Run `/search` again.', embeds: [], components: [] });
      return;
    }

    if (type === 'nav') {
      const page = parseInt(parts[3], 10);
      await interaction.update(buildResultsPage(results, page, key, userId));
      return;
    }

    if (type === 'sel') {
      const index = parseInt(parts[3], 10);
      const picked = results[index];
      pendingResults.delete(key);
      logger.info(`User ${interaction.user.tag} picked: "${picked.title}" — ${picked.url}`);
      await handleVideoFetch(interaction, picked, true);
    }
  }
}

await registerCommands();
client.login(TOKEN);
