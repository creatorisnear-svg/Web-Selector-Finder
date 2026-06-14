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
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { searchVideos, getVideoStreamUrl, getDirectMp4Url, downloadVideoClip, cleanupClip } from './scraper.mjs';
import { logger } from './logger.mjs';

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;

if (!TOKEN || !CLIENT_ID) {
  logger.error('Missing DISCORD_TOKEN or DISCORD_CLIENT_ID environment variables.');
  process.exit(1);
}

const SEARCH_URL = '';

// Pending search sessions: key -> { results, query, lastSitePage, exhausted, currentPage }
const pendingResults = new Map();

// Short video link store: shortId -> { streamUrl, refUrl, title }
const videoLinks = new Map();

function createShortLink(streamUrl, refUrl, title) {
  const id = Math.random().toString(36).slice(2, 9);
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
const ALLOWED_HOSTS = ['xvideos-cdn.com', 'xvideos.com', 'pornhub.com', 'phncdn.com', 'xnxx.com', 'xnxx-cdn.com', 'xvideos2.com', 'xxbrits.com', 'media.xxbrits.com'];

function isAllowedUrl(raw) {
  try { return ALLOWED_HOSTS.some(h => new URL(raw).hostname.endsWith(h)); } catch { return false; }
}

async function probeContentLength(streamUrl, refUrl) {
  const headers = {};
  if (refUrl) {
    try {
      const o = new URL(refUrl);
      headers['Referer'] = refUrl;
      headers['Origin'] = `${o.protocol}//${o.host}`;
    } catch {}
  }
  headers['Range'] = 'bytes=0-0';
  try {
    const res = await Promise.race([
      fetchUpstream(streamUrl, headers),
      new Promise((_, rej) => setTimeout(() => rej(new Error('probe timeout')), 5000)),
    ]);
    res.resume();
    const cr = res.headers['content-range'];
    if (cr) { const m = cr.match(/\/(\d+)$/); if (m) return parseInt(m[1], 10); }
    const cl = res.headers['content-length'];
    if (cl) return parseInt(cl, 10);
    return null;
  } catch (err) {
    logger.warn(`probeContentLength failed: ${err.message}`);
    return null;
  }
}

function fetchUpstream(raw, extra = {}, depth = 0) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(raw);
    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.request(raw, { headers: { ...PROXY_HEADERS, ...extra }, method: 'GET' }, res => {
      const status = res.statusCode || 0;
      const loc = res.headers['location'];
      if (status >= 300 && status < 400 && loc && depth < 5) {
        res.resume();
        const next = new URL(loc, raw).toString();
        resolve(fetchUpstream(next, extra, depth + 1));
        return;
      }
      resolve(res);
    });
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
    ff.on('error', err => { logger.error('ffmpeg spawn error:', err.message); if (!res.writableEnded) res.end(); });
    ff.on('close', () => { if (!res.writableEnded) res.end(); });
    req.on('close', () => ff.kill('SIGTERM'));
    return;
  }

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
    if (!res.headersSent) { res.writeHead(502, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: err.message })); }
  }
}

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

  try {
    const rangeHeader = req.headers['range'];
    const upHeaders = { ...extra };
    if (rangeHeader) upHeaders['Range'] = rangeHeader;
    const upRes = await fetchUpstream(raw, upHeaders);
    if (upRes.statusCode >= 400) { res.writeHead(502); res.end(); upRes.resume(); return; }
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

// ── HTTP server ───────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || '5000', 10);
const healthServer = http.createServer(async (req, res) => {
  const path = (req.url || '/').split('?')[0];

  if (path === '/api/stream/video.mp4') { await handleStreamProxy(req, res); return; }
  if (path === '/api/stream/play/video.mp4') { await handleVideoStream(req, res); return; }

  const shortMatch = path.match(/^\/v\/([a-z0-9]+)$/i);
  if (shortMatch) {
    const id = shortMatch[1];
    const link = videoLinks.get(id);
    if (!link) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Link expired or not found'); return; }
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
      res.writeHead(302, { 'Location': playUrl });
      res.end();
    }
    return;
  }

  if (path === '/' || path === '/health') {
    const payload = JSON.stringify({ status: 'ok', uptime: process.uptime() | 0 });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(payload);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});
healthServer.listen(PORT, '0.0.0.0', () => {
  logger.info(`Health check server listening on port ${PORT}`);
});

// ── Slash commands ────────────────────────────────────────────────────────────
// /search has NO options — it opens a modal instead
const commands = [
  new SlashCommandBuilder()
    .setName('search')
    .setDescription('Search for videos — opens a search box'),
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

client.on('interactionCreate', async interaction => {
  try {
    await handleInteraction(interaction);
  } catch (err) {
    logger.error('Interaction error:', err.message, err.stack);
    try {
      const msg = { content: '❌ Something went wrong. Please try again.', flags: MessageFlags.Ephemeral };
      if (interaction.deferred || interaction.replied) await interaction.editReply(msg);
      else await interaction.reply(msg);
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

// ── Constants ─────────────────────────────────────────────────────────────────
const PAGE_SIZE = 5;
const SOURCE_LABELS = { pornhub: 'PH', xvideos: 'XV', xnxx: 'XNXX', xxbrits: 'XXBrits' };
const YTDLP_TIMEOUT_MS = 12000;

// ── Build ephemeral results page ──────────────────────────────────────────────
function buildResultsPage(results, page, key, userId, exhausted = false) {
  const loadedPages = Math.ceil(results.length / PAGE_SIZE);
  const start = page * PAGE_SIZE;
  const pageItems = results.slice(start, start + PAGE_SIZE);

  const hasMoreLoaded = page < loadedPages - 1;
  const nextEnabled = hasMoreLoaded || !exhausted;
  const totalLabel = exhausted ? `${loadedPages}` : `${loadedPages}+`;

  const headerEmbed = new EmbedBuilder()
    .setTitle(`🔎 Search Results — Page ${page + 1} of ${totalLabel}`)
    .setColor(0x5865F2)
    .setFooter({
      text: exhausted
        ? `${results.length} videos from PH + Xvideos + XNXX + XXBrits • End of results`
        : `${results.length}+ videos from PH + Xvideos + XNXX + XXBrits • More load as you browse`,
    });

  const resultEmbeds = pageItems.map((r, i) => {
    const num = start + i + 1;
    const dur = r.duration ? ` \`${r.duration}\`` : '';
    const src = r.source ? ` \`${SOURCE_LABELS[r.source] || r.source}\`` : '';
    const e = new EmbedBuilder()
      .setColor(0x5865F2)
      .setDescription(`**${num}.**${src} ${r.title}${dur}`);
    if (r.thumbnail) e.setThumbnail(r.thumbnail);
    return e;
  });

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
      .setDisabled(!nextEnabled),
    new ButtonBuilder()
      .setCustomId(`ref:${userId}:${key}`)
      .setLabel('🔄 Refresh')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`newsearch:${userId}`)
      .setLabel('🔍 New Search')
      .setStyle(ButtonStyle.Secondary),
  );

  return {
    embeds: [headerEmbed, ...resultEmbeds],
    components: [selectRow, navRow],
    flags: MessageFlags.Ephemeral,
  };
}

// ── Send the search panel (ephemeral) ─────────────────────────────────────────
// Used both for the first render and to restore after a video is sent.
// `interaction` must already be deferred+ephemeral OR replied.
async function sendSearchPanel(interaction, key, page) {
  const stored = pendingResults.get(key);
  if (!stored) {
    await interaction.editReply({ content: '❌ Search expired. Run `/search` again.', embeds: [], components: [], flags: MessageFlags.Ephemeral });
    return;
  }
  stored.currentPage = page;
  const payload = buildResultsPage(stored.results, page, key, interaction.user.id, stored.exhausted);
  await interaction.editReply(payload);
}

// ── Run a search and build the key ────────────────────────────────────────────
async function startSearch(query, userId) {
  const results = dedupeByUrl(await searchVideos(SEARCH_URL, query, 0));
  const key = `${userId}-${Date.now()}`;
  pendingResults.set(key, { results, query, lastSitePage: 0, exhausted: false, currentPage: 0 });
  setTimeout(() => pendingResults.delete(key), 30 * 60 * 1000);
  return key;
}

// ── Dedupe helpers ────────────────────────────────────────────────────────────
function dedupeByUrl(items) {
  const seen = new Set();
  const out = [];
  for (const r of items) {
    if (!r || !r.url || seen.has(r.url)) continue;
    seen.add(r.url);
    out.push(r);
  }
  return out;
}

// ── Video fetch — posts video publicly, sends fresh panel at the bottom ───────
async function handleVideoFetch(interaction, key, picked, restorePage) {
  // Silently acknowledge the button — leave the old panel visible while we fetch
  await interaction.deferUpdate();

  // Replace the old panel with a minimal "fetching" note so the user knows something is happening
  await interaction.editReply({
    content: `⏳ Fetching **${picked.title}**…`,
    embeds: [],
    components: [],
  });

  const STREAM_BASE_URL = process.env.STREAM_BASE_URL;
  let sent = false;

  // Step 1: HTML scraper
  const stream = await getVideoStreamUrl(picked.url);
  logger.info(`Stream result: ${stream ? `${stream.isHls ? 'HLS' : 'MP4'} ${stream.url?.slice(0, 60)}` : 'null'}`);

  if (STREAM_BASE_URL && stream?.url) {
    let shortUrl;
    if (stream.isHls) {
      shortUrl = createShortLink(stream.url, picked.url, picked.title);
      logger.info(`HLS short link: ${shortUrl}`);
    } else {
      const sizeBytes = await probeContentLength(stream.url, picked.url);
      const MAX_EMBED_BYTES = 50 * 1024 * 1024;
      if (sizeBytes === null || sizeBytes <= MAX_EMBED_BYTES) {
        shortUrl = createShortLink(stream.url, picked.url, picked.title);
        logger.info(`Fast path — short link: ${shortUrl} (size=${sizeBytes ?? 'unknown'})`);
      } else {
        logger.warn(`Stream too large to embed (${sizeBytes} bytes) — falling through`);
      }
    }
    if (shortUrl) {
      await interaction.followUp({ content: shortUrl });
      sent = true;
    }
  }

  // Step 2: yt-dlp URL extraction
  if (!sent) {
    logger.info('Trying yt-dlp URL extraction...');
    const directUrl = await Promise.race([
      getDirectMp4Url(picked.url, stream?.cookies || ''),
      new Promise(r => setTimeout(() => r(null), YTDLP_TIMEOUT_MS)),
    ]);
    if (directUrl) {
      if (STREAM_BASE_URL) {
        const shortUrl = createShortLink(directUrl, picked.url, picked.title);
        await interaction.followUp({ content: shortUrl });
      } else {
        await interaction.followUp({ content: `🎬 **${picked.title}**\n${directUrl}` });
      }
      sent = true;
    }
  }

  // Step 3: Download and attach
  if (!sent) {
    logger.info('Downloading clip for upload...');
    const filePath = await downloadVideoClip(stream?.url || '', stream?.cookies || '', picked.url);
    if (filePath) {
      const attachment = new AttachmentBuilder(filePath, { name: 'video.mp4' });
      await interaction.followUp({ content: `🎬 **${picked.title}**`, files: [attachment] });
      await cleanupClip(filePath);
      sent = true;
    }
  }

  // Step 4: Last resort — page link
  if (!sent) {
    const bestUrl = (stream?.url && !stream.isHls) ? stream.url : picked.url;
    await interaction.followUp({
      content: `🎬 **${picked.title}**\n${bestUrl}\n\n> ⚠️ Couldn't embed this video. Click the link to watch.`,
    });
  }

  // Send the search panel as a NEW ephemeral followUp — appears right below the video
  // so the user never has to scroll up
  const stored = pendingResults.get(key);
  if (stored) {
    stored.currentPage = restorePage;
    const panel = buildResultsPage(stored.results, restorePage, key, interaction.user.id, stored.exhausted);
    await interaction.followUp(panel);
  }

  // Clear the old "⏳ Fetching…" placeholder so it doesn't linger
  await interaction.editReply({ content: '✅ Done', embeds: [], components: [] });
}

// ── Main interaction handler ──────────────────────────────────────────────────
async function handleInteraction(interaction) {
  // ── /search slash command — show modal ──────────────────────────────────────
  if (interaction.isChatInputCommand() && interaction.commandName === 'search') {
    logger.info(`/search from ${interaction.user.tag}`);
    const modal = new ModalBuilder()
      .setCustomId(`searchmodal:${interaction.user.id}`)
      .setTitle('Video Search');
    const input = new TextInputBuilder()
      .setCustomId('query')
      .setLabel('What are you searching for?')
      .setStyle(TextInputStyle.Short)
      .setPlaceholder('e.g. step mom kitchen')
      .setRequired(true)
      .setMaxLength(100);
    modal.addComponents(new ActionRowBuilder().addComponents(input));
    await interaction.showModal(modal);
    return;
  }

  // ── Modal submit ────────────────────────────────────────────────────────────
  if (interaction.isModalSubmit() && interaction.customId.startsWith('searchmodal:')) {
    const query = interaction.fields.getTextInputValue('query').trim();
    if (!query) { await interaction.reply({ content: '❌ Please enter a search term.', flags: MessageFlags.Ephemeral }); return; }

    logger.info(`Modal search: "${query}" from ${interaction.user.tag}`);

    // Defer ephemerally — only this user sees the loading indicator
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    let key;
    try {
      key = await startSearch(query, interaction.user.id);
    } catch (err) {
      logger.error('Search error:', err.message);
      await interaction.editReply({ content: `❌ Search failed: ${err.message}`, flags: MessageFlags.Ephemeral });
      return;
    }

    const stored = pendingResults.get(key);
    if (!stored || stored.results.length === 0) {
      await interaction.editReply({ content: `❌ No results found for **${query}**. Try a different search term.`, flags: MessageFlags.Ephemeral });
      return;
    }

    await sendSearchPanel(interaction, key, 0);
    return;
  }

  // ── Buttons ─────────────────────────────────────────────────────────────────
  if (interaction.isButton()) {
    const parts = interaction.customId.split(':');
    const [type, userId] = parts;

    // New Search button — opens modal again
    if (type === 'newsearch') {
      if (interaction.user.id !== userId) {
        await interaction.reply({ content: '❌ This is not your search panel.', flags: MessageFlags.Ephemeral });
        return;
      }
      const modal = new ModalBuilder()
        .setCustomId(`searchmodal:${interaction.user.id}`)
        .setTitle('Video Search');
      const input = new TextInputBuilder()
        .setCustomId('query')
        .setLabel('What are you searching for?')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('e.g. step mom kitchen')
        .setRequired(true)
        .setMaxLength(100);
      modal.addComponents(new ActionRowBuilder().addComponents(input));
      await interaction.showModal(modal);
      return;
    }

    if (!['sel', 'nav', 'ref'].includes(type)) return;

    if (interaction.user.id !== userId) {
      await interaction.reply({ content: '❌ This is not your search panel.', flags: MessageFlags.Ephemeral });
      return;
    }

    const key = parts[2];
    const stored = pendingResults.get(key);

    if (!stored) {
      await interaction.update({ content: '❌ Search expired. Run `/search` again.', embeds: [], components: [], flags: MessageFlags.Ephemeral });
      return;
    }

    // ── Select a video ────────────────────────────────────────────────────────
    if (type === 'sel') {
      const index = parseInt(parts[3], 10);
      const picked = stored.results[index];
      const restorePage = stored.currentPage || 0;
      logger.info(`User ${interaction.user.tag} picked: "${picked.title}" — ${picked.url}`);
      await handleVideoFetch(interaction, key, picked, restorePage);
      return;
    }

    // ── Navigate pages ────────────────────────────────────────────────────────
    if (type === 'nav') {
      const page = parseInt(parts[3], 10);
      const needed = (page + 1) * PAGE_SIZE;

      // Load more from source sites if needed
      while (stored.results.length < needed && !stored.exhausted) {
        if (!interaction.deferred && !interaction.replied) {
          try { await interaction.deferUpdate(); } catch {}
        }
        const nextPage = stored.lastSitePage + 1;
        logger.info(`Loading more for "${stored.query}" — site page ${nextPage}`);
        let more = [];
        try { more = await searchVideos(SEARCH_URL, stored.query, nextPage); } catch (err) { logger.error(`Pagination failed: ${err.message}`); break; }
        stored.lastSitePage = nextPage;
        const before = stored.results.length;
        stored.results = dedupeByUrl([...stored.results, ...more]);
        const added = stored.results.length - before;
        logger.info(`Loaded ${more.length} (${added} after dedupe). Total: ${stored.results.length}`);
        if (added === 0) { stored.exhausted = true; break; }
      }

      const maxPage = Math.max(0, Math.ceil(stored.results.length / PAGE_SIZE) - 1);
      const finalPage = Math.min(page, maxPage);

      if (!interaction.deferred && !interaction.replied) {
        await interaction.deferUpdate();
      }
      await sendSearchPanel(interaction, key, finalPage);
      return;
    }

    // ── Refresh ───────────────────────────────────────────────────────────────
    if (type === 'ref') {
      await interaction.deferUpdate();
      let fresh;
      try {
        fresh = dedupeByUrl(await searchVideos(SEARCH_URL, stored.query, 0));
      } catch (err) {
        logger.error('Refresh failed:', err.message);
        await interaction.editReply({ content: '❌ Refresh failed. Try `/search` again.', embeds: [], components: [], flags: MessageFlags.Ephemeral });
        return;
      }
      if (!fresh || fresh.length === 0) {
        await interaction.editReply({ content: `❌ No results on refresh for **${stored.query}**.`, embeds: [], components: [], flags: MessageFlags.Ephemeral });
        return;
      }
      const newKey = `${userId}-${Date.now()}`;
      pendingResults.delete(key);
      pendingResults.set(newKey, { results: fresh, query: stored.query, lastSitePage: 0, exhausted: false, currentPage: 0 });
      setTimeout(() => pendingResults.delete(newKey), 30 * 60 * 1000);
      await sendSearchPanel(interaction, newKey, 0);
    }
  }
}

await registerCommands();
client.login(TOKEN);
