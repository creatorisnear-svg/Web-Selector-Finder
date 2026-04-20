import axios from 'axios';
import * as cheerio from 'cheerio';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { tmpdir } from 'os';
import { join } from 'path';
import { stat, unlink } from 'fs/promises';
import { logger } from './logger.mjs';

const execFileAsync = promisify(execFile);

const YTDLP_BIN = new URL('../../bin/yt-dlp', import.meta.url).pathname;

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.5',
  'Cookie': 'age_verified=1; ageGate=true; confirm=1'
};

function resolveUrl(href, baseUrl) {
  if (!href) return null;
  if (href.startsWith('http://') || href.startsWith('https://')) return href;
  if (href.startsWith('//')) return 'https:' + href;
  if (href.startsWith('/')) {
    const base = new URL(baseUrl);
    return `${base.protocol}//${base.host}${href}`;
  }
  return null;
}

// ── PornHub WebMasters API search ─────────────────────────────────────────────
// Uses PH's official API endpoint — returns clean JSON, no bot detection issues.
// Fetches 30 results so the relevance filter has enough to pick 10 good ones from.
async function searchPornhub(query) {
  // 1. Try PornHub WebMasters JSON API (fast and clean when not IP-blocked)
  try {
    const apiUrl = `https://www.pornhub.com/webmasters/search?search_term=${encodeURIComponent(query)}&page=1&per_page=30&ordering=mostviewed&period=alltime`;
    logger.info(`PH API: ${apiUrl}`);
    const res = await axios.get(apiUrl, {
      headers: { 'Accept': 'application/json', 'User-Agent': HEADERS['User-Agent'] },
      timeout: 15000
    });
    const isJson = typeof res.data === 'object' && res.data !== null;
    const videos = isJson ? (res.data.videos || []) : [];
    if (!isJson) {
      logger.warn('PH API returned non-JSON (Cloudflare block) — falling back to xvideos');
    } else {
      logger.info(`PH API returned ${videos.length} videos`);
    }
    if (videos.length > 0) {
      return videos.filter(v => v.url && v.title).map(v => ({
        title: v.title.length > 80 ? v.title.slice(0, 77) + '...' : v.title,
        url: v.url
      }));
    }
  } catch (err) {
    logger.warn(`PH API error: ${err.message}`);
  }

  // 2. Fallback: xvideos search — not Cloudflare-gated, large library, yt-dlp can download
  logger.info('Falling back to xvideos search');
  return searchXvideos(query);
}

async function searchXvideos(query) {
  const searchUrl = `https://www.xvideos.com/?k=${encodeURIComponent(query)}`;
  logger.info(`xvideos search: ${searchUrl}`);
  try {
    const { data } = await axios.get(searchUrl, {
      headers: {
        'User-Agent': HEADERS['User-Agent'],
        'Accept': 'text/html',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      timeout: 15000
    });
    const $ = cheerio.load(data);
    const seen = new Set();
    const results = [];
    $('.thumb-block').each((_, el) => {
      if (results.length >= 30) return;
      const titleEl = $(el).find('.title a');
      const rawTitle = titleEl.text().trim();
      const href = $(el).find('a').first().attr('href') || '';
      if (!rawTitle || !href || seen.has(href)) return;
      seen.add(href);
      const url = href.startsWith('http') ? href : `https://www.xvideos.com${href}`;
      // Strip duration suffix like " 14 min" from titles
      const title = rawTitle.replace(/\s+\d+\s*(min|sec)\s*$/, '').trim();
      if (!title || !url) return;
      results.push({ title: title.length > 80 ? title.slice(0, 77) + '...' : title, url });
    });
    logger.info(`xvideos search returned ${results.length} results`);
    return results;
  } catch (err) {
    logger.error(`xvideos search failed: ${err.message}`);
    return [];
  }
}

// ── Generic fallback scraper ──────────────────────────────────────────────────
const SKIP_URL_PATTERN = /(login|signup|register|cdn\.|\.jpg|\.jpeg|\.png|\.gif|\.webp|\.svg|\.ico|\/tag\/|\/tags\/|\/category\/|\/categories\/|\/channel\/|\/channels\/|\/user\/|\/users\/|\/profile\/|\/author\/|\/page\/|\/feed|\/rss|javascript:|mailto:|#|\/about|\/help|\/support|\/contact|\/legal|\/privacy|\/terms|\/dmca|\/faq|\/advertise|\/careers|\/press|\/sitemap|\/playlist|\/playlists|\/gif|\/gifs|\/photo|\/photos|\/image|\/images|\/album|\/albums|\/gallery|\/galleries|\/collection|\/collections|\/random)/i;
const VIDEO_PATH_PATTERN = /\/(video|videos|watch|v|embed|clip|view_video|play|tube|movie|scene|vids?)[\/-]|\/(watch|embed)\?|viewkey=|[?&]v=|\/\d{4,}[^/]*$/i;

const JUNK_TITLE_WORDS = /^(trust|safety|notice|terms|privacy|cookie|about|help|support|contact|legal|dmca|faq|adverti|careers|press|sitemap|accessibility|copyright|report|feedback|language|settings|sign in|log in|sign up|register|subscribe|upgrade|premium|home|back|next|prev|more|less|see all|view all|show all|load more|follow|share|embed|download|playlist|channel|community|forum|blog|news|store|shop|gift|merch|gif|photo|image|album|gallery)$/i;

function isJunkTitle(title) {
  if (!title) return true;
  const t = title.trim();
  if (t.length < 5 || t.length > 200) return true;
  if (JUNK_TITLE_WORDS.test(t)) return true;
  if (t.length < 20 && t === t.toUpperCase()) return true;
  return false;
}

function getTitle(el, $) {
  const sources = [
    $(el).attr('title'),
    $(el).find('img').attr('alt'),
    $(el).find('[class*="title"]').first().text().trim(),
    $(el).find('[class*="name"]').first().text().trim(),
    $(el).find('span, p, h3, h4').first().text().trim(),
    $(el).text().trim()
  ];
  for (const s of sources) {
    if (s && s.length >= 4) return s.replace(/\s+/g, ' ').trim();
  }
  return null;
}

function scrapeGeneric($, pageUrl) {
  const results = [];
  const seen = new Set();

  $('a[href]').each((_, el) => {
    if (results.length >= 10) return;
    const href = $(el).attr('href');
    if (!href || seen.has(href)) return;
    if (SKIP_URL_PATTERN.test(href)) return;
    if (!VIDEO_PATH_PATTERN.test(href)) return;

    const fullUrl = resolveUrl(href, pageUrl);
    if (!fullUrl) return;

    const title = getTitle(el, $);
    if (isJunkTitle(title)) return;

    seen.add(href);
    results.push({
      title: title.length > 80 ? title.slice(0, 77) + '...' : title,
      url: fullUrl
    });
  });

  logger.info(`Generic scraper found ${results.length} results`);
  return results;
}

// ── Relevance filtering ───────────────────────────────────────────────────────
// Removes spaces/hyphens so "step mom" == "stepmom" and "step-mom" == "stepmom".
function normalize(s) {
  return s.toLowerCase().replace(/[\s\-_]+/g, '');
}

// Returns search tokens expanded with sub-parts of compound words.
// "stepmom" → ["stepmom", "step", "mom"]  so titles with "stepmother" or "step mom" still match.
const FAMILY_BREAKS = ['step','mom','dad','son','daughter','mother','father','sister','brother','bro','sis','milf'];
function queryTokens(query) {
  const STOP = new Set(['the','and','for','with','that','this','from','but','all','not','are','was']);
  const base = query.toLowerCase().split(/\W+/).filter(w => w.length >= 3 && !STOP.has(w));
  const extra = [];
  for (const token of base) {
    for (const prefix of FAMILY_BREAKS) {
      if (token.startsWith(prefix) && token !== prefix) {
        extra.push(prefix);
        const rest = token.slice(prefix.length);
        if (rest.length >= 3) extra.push(rest);
        break;
      }
    }
  }
  return [...new Set([...base, ...extra])];
}

// Check if normalized title contains any query token as a substring.
function isRelevant(title, queryWords) {
  if (!queryWords.length) return true;
  const normTitle = normalize(title);
  return queryWords.some(w => normTitle.includes(normalize(w)));
}

// ── Public search entry point ─────────────────────────────────────────────────
export async function searchVideos(searchUrlTemplate, query) {
  const url = searchUrlTemplate.replace('{query}', encodeURIComponent(query));
  const isPornhub = url.includes('pornhub.com');

  let results = [];

  if (isPornhub) {
    results = await searchPornhub(query);
    // Sort: titles containing the query word(s) first, so the most relevant
    // results always appear at the top of the Discord select menu.
    const words = queryTokens(query);
    results.sort((a, b) => {
      const aMatch = isRelevant(a.title, words) ? 0 : 1;
      const bMatch = isRelevant(b.title, words) ? 0 : 1;
      return aMatch - bMatch;
    });
    logger.info(`Returning ${results.length} results for "${query}"`);
    return results;
  }

  logger.info(`Searching: ${url}`);
  const { data } = await axios.get(url, { headers: HEADERS, timeout: 15000 });
  const $ = cheerio.load(data);
  results = scrapeGeneric($, url);

  // Post-filter only for generic scraped results where we grab arbitrary links
  // off a page and need to check relevance ourselves.
  const words = queryTokens(query);
  const relevant = results.filter(r => isRelevant(r.title, words));
  logger.info(`Relevance filter: ${results.length} → ${relevant.length} results (words: ${JSON.stringify(words)})`);
  const final = relevant.length > 0 ? relevant : results;

  logger.info(`Returning ${final.length} results for "${query}"`);
  return final;
}

// ── Video stream extraction ───────────────────────────────────────────────────

function unescapeUrl(str) {
  return str.replace(/\\\//g, '/').replace(/\\u0026/g, '&');
}

function isThumbnailUrl(url) {
  return (
    url.includes('/plain/') ||
    url.includes('/rs:fit:') ||
    url.includes('/resize/') ||
    url.includes('/thumbnail') ||
    url.includes('/thumb') ||
    url.includes('/poster') ||
    url.includes('/preview')
  );
}

export async function getVideoStreamUrl(videoPageUrl) {
  logger.info(`Fetching video page: ${videoPageUrl}`);
  let res;
  try {
    res = await axios.get(videoPageUrl, { headers: HEADERS, timeout: 15000 });
  } catch (err) {
    logger.error('Failed to fetch video page:', err.message);
    return null;
  }

  const setCookies = res.headers['set-cookie'] || [];
  const sessionCookies = [
    ...HEADERS.Cookie.split('; '),
    ...setCookies.map(c => c.split(';')[0])
  ].join('; ');

  const $ = cheerio.load(res.data);
  const allScripts = $('script').map((_, el) => $(el).html() || '').get().join('\n');

  // 1. <source> or <video> tags
  for (const el of $('source[src], video[src]').toArray()) {
    const src = $(el).attr('src') || '';
    if (src.includes('.mp4') || src.includes('.webm')) {
      logger.info('Found direct video/source tag');
      return { url: resolveUrl(src, videoPageUrl), isHls: false, cookies: sessionCookies };
    }
  }

  // 2. og:video meta
  const ogVideo =
    $('meta[property="og:video:secure_url"]').attr('content') ||
    $('meta[property="og:video"]').attr('content');
  if (ogVideo && (ogVideo.includes('.mp4') || ogVideo.includes('.webm')) && !ogVideo.includes('.m3u8')) {
    logger.info('Found og:video meta tag');
    return { url: ogVideo, isHls: false, cookies: sessionCookies };
  }

  // 3. PH flashvars / get_media API
  const fvMatch = allScripts.match(/var\s+flashvars_\w+\s*=\s*(\{[\s\S]*?\});\s*\n/);
  if (fvMatch) {
    try {
      const fv = JSON.parse(fvMatch[1]);
      const defs = fv.mediaDefinitions || [];

      const mp4ApiDef = defs.find(d => d.format === 'mp4' && d.videoUrl && d.videoUrl.includes('get_media'));
      if (mp4ApiDef) {
        logger.info('Calling get_media API...');
        const mediaHeaders = { ...HEADERS, 'Cookie': sessionCookies, 'Referer': videoPageUrl };
        const mediaRes = await axios.get(mp4ApiDef.videoUrl, { headers: mediaHeaders, timeout: 10000 });
        const mediaDefs = Array.isArray(mediaRes.data) ? mediaRes.data : [];
        if (mediaDefs.length > 0) {
          const qualityOrder = ['240', '480', '360', '720', '1080'];
          mediaDefs.sort((a, b) => {
            const ai = qualityOrder.findIndex(q => String(a.height || a.quality || '').includes(q));
            const bi = qualityOrder.findIndex(q => String(b.height || b.quality || '').includes(q));
            return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
          });
          const best = mediaDefs[0];
          const url = unescapeUrl(best.videoUrl);
          logger.info(`get_media: ${best.height}p mp4: ${url.slice(0, 80)}`);
          return { url, isHls: false, cookies: sessionCookies };
        }
      }

      const hlsDefs = defs.filter(d => d.format === 'hls' && d.videoUrl);
      const qualityOrder = ['480', '240', '360', '720', '1080'];
      // Prefer iv-h CDN over ev-h (ev-h CDN blocks some server IPs)
      const cdnPrefer = (url) => url.includes('ev-h.') ? 1 : 0;
      hlsDefs.sort((a, b) => {
        const aUrl = unescapeUrl(a.videoUrl);
        const bUrl = unescapeUrl(b.videoUrl);
        const cdnDiff = cdnPrefer(aUrl) - cdnPrefer(bUrl);
        if (cdnDiff !== 0) return cdnDiff;
        const ai = qualityOrder.findIndex(q => String(a.quality).includes(q));
        const bi = qualityOrder.findIndex(q => String(b.quality).includes(q));
        return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
      });
      if (hlsDefs.length > 0) {
        const url = unescapeUrl(hlsDefs[0].videoUrl);
        logger.info(`HLS fallback ${hlsDefs[0].quality}: ${url.slice(0, 80)}`);
        return { url, isHls: true, cookies: sessionCookies };
      }
    } catch (e) {
      logger.error('Flashvars parse error:', e.message);
    }
  }

  // 4. Generic "videoUrl" JSON field
  const vuRegex = /"videoUrl"\s*:\s*"([^"]+)"/gi;
  let vuMatch;
  while ((vuMatch = vuRegex.exec(allScripts)) !== null) {
    const raw = unescapeUrl(vuMatch[1]);
    if (raw.includes('.mp4') || raw.includes('.m3u8')) {
      logger.info('Found videoUrl in script JSON');
      return { url: raw, isHls: raw.includes('.m3u8'), cookies: sessionCookies };
    }
  }

  // 5. Plain .mp4 URLs in scripts
  const plainMp4 = /https?:\/\/[^\s"'<>\\]+\.mp4/gi;
  for (const match of (allScripts.match(plainMp4) || [])) {
    if (isThumbnailUrl(match)) continue;
    logger.info('Found plain .mp4 URL in script');
    return { url: match, isHls: false, cookies: sessionCookies };
  }

  logger.warn('No video stream found on page');
  return null;
}

// ── HLS download helpers ──────────────────────────────────────────────────────

function parseM3u8Segments(m3u8Text, baseUrl) {
  const lines = m3u8Text.split('\n').map(l => l.trim()).filter(Boolean);
  const segments = [];
  for (const line of lines) {
    if (line.startsWith('#')) continue;
    try { segments.push(new URL(line, baseUrl).href); } catch { segments.push(line); }
  }
  return segments;
}

function parseMasterM3u8(m3u8Text, baseUrl, targetQuality = '480') {
  const lines = m3u8Text.split('\n').map(l => l.trim());
  const streams = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('#EXT-X-STREAM-INF')) {
      const bwMatch = lines[i].match(/BANDWIDTH=(\d+)/);
      const resMatch = lines[i].match(/RESOLUTION=\d+x(\d+)/);
      const nextLine = lines[i + 1] || '';
      if (!nextLine.startsWith('#') && nextLine) {
        streams.push({
          bandwidth: bwMatch ? parseInt(bwMatch[1]) : 0,
          height: resMatch ? parseInt(resMatch[1]) : 0,
          url: new URL(nextLine, baseUrl).href
        });
      }
    }
  }
  if (streams.length === 0) return null;
  const target = parseInt(targetQuality);
  const exact = streams.find(s => s.height === target);
  if (exact) return exact.url;
  const smaller = streams.filter(s => s.height <= target).sort((a, b) => b.height - a.height);
  if (smaller.length > 0) return smaller[0].url;
  return streams.sort((a, b) => a.bandwidth - b.bandwidth)[0].url;
}

async function downloadHlsViaAxios(masterUrl, reqHeaders = HEADERS, maxSegments = 40) {
  const tmpTs = join(tmpdir(), `discord_hls_${Date.now()}.ts`);
  const { createWriteStream } = await import('fs');

  try {
    const masterRes = await axios.get(masterUrl, { headers: reqHeaders, timeout: 10000 });
    let mediaUrl;

    if (masterRes.data.includes('#EXT-X-STREAM-INF')) {
      mediaUrl = parseMasterM3u8(masterRes.data, masterUrl, '480');
      if (!mediaUrl) { logger.error('Could not parse master m3u8'); return null; }
      logger.info(`Media playlist: ${mediaUrl.slice(0, 80)}`);
    } else {
      mediaUrl = masterUrl;
    }

    const mediaRes = await axios.get(mediaUrl, { headers: reqHeaders, timeout: 10000 });
    const segments = parseM3u8Segments(mediaRes.data, mediaUrl);
    if (segments.length === 0) { logger.error('No segments found in m3u8'); return null; }

    const toDownload = segments.slice(0, maxSegments);
    logger.info(`Downloading ${toDownload.length} of ${segments.length} HLS segments...`);

    const writeStream = createWriteStream(tmpTs, { flags: 'w' });
    let totalBytes = 0;
    const DISCORD_LIMIT = 8 * 1024 * 1024;

    for (const segUrl of toDownload) {
      if (totalBytes >= DISCORD_LIMIT) break;
      try {
        const segRes = await axios.get(segUrl, {
          headers: reqHeaders,
          responseType: 'arraybuffer',
          timeout: 15000
        });
        const chunk = Buffer.from(segRes.data);
        writeStream.write(chunk);
        totalBytes += chunk.length;
      } catch (segErr) {
        logger.warn(`Segment failed: ${segUrl.slice(0, 60)} — ${segErr.message}`);
      }
    }

    await new Promise((resolve, reject) => {
      writeStream.end();
      writeStream.on('finish', resolve);
      writeStream.on('error', reject);
    });

    logger.info(`Downloaded ${(totalBytes / 1024 / 1024).toFixed(1)}MB of HLS segments`);
    return tmpTs;
  } catch (err) {
    logger.error('HLS download failed:', err.message);
    try { await unlink(tmpTs); } catch {}
    return null;
  }
}

async function remuxToMp4(tsPath) {
  const mp4Path = tsPath.replace('.ts', '.mp4');
  const args = ['-y', '-i', tsPath, '-c', 'copy', '-movflags', '+faststart', '-loglevel', 'error', mp4Path];
  try {
    await execFileAsync('ffmpeg', args, { timeout: 30000 });
    logger.info(`Remuxed to mp4: ${mp4Path}`);
    return mp4Path;
  } catch (err) {
    logger.error('Remux failed:', (err.stderr || err.message).slice(0, 200));
    return null;
  }
}

// ── yt-dlp fallback ───────────────────────────────────────────────────────────

async function downloadWithYtDlp(videoPageUrl, cookies = '') {
  const timestamp = Date.now();
  const tmpTemplate = join(tmpdir(), `discord_ytdlp_${timestamp}.%(ext)s`);
  const tmpMp4 = join(tmpdir(), `discord_ytdlp_${timestamp}.mp4`);
  const cookieStr = cookies || HEADERS.Cookie;
  const args = [
    '--impersonate', 'chrome',
    '-f', 'worstvideo[height>=240]+worstaudio/worst[height>=240]/worst',
    '--download-sections', '*0-75',
    '-o', tmpTemplate,
    '--no-playlist',
    '--merge-output-format', 'mp4',
    '--add-header', `Referer:${videoPageUrl}`,
    '--add-header', `Cookie:${cookieStr}`,
    videoPageUrl
  ];

  logger.info('Trying yt-dlp...');
  try {
    const result = await execFileAsync(YTDLP_BIN, args, { timeout: 120000 });
    if (result.stdout) logger.info(`yt-dlp stdout: ${result.stdout.slice(0, 500)}`);
  } catch (err) {
    const errMsg = (err.stderr || err.stdout || err.message || '').slice(0, 500);
    logger.error('yt-dlp failed:', errMsg);
    try { await unlink(tmpMp4); } catch {}
    return null;
  }
  const DISCORD_LIMIT = 8 * 1024 * 1024;
  try {
    const { size } = await stat(tmpMp4);
    if (size > 0) {
      logger.info(`yt-dlp success: ${(size / 1024 / 1024).toFixed(1)}MB`);
      if (size <= DISCORD_LIMIT) return tmpMp4;
      // File too large — re-encode to fit under 8MB
      const reencPath = join(tmpdir(), `discord_ytdlp_${timestamp}_reenc.mp4`);
      logger.info(`File too large (${(size / 1024 / 1024).toFixed(1)}MB), re-encoding to fit 8MB...`);
      try {
        // Get duration via ffprobe
        const { stdout: probeOut } = await execFileAsync('ffprobe', [
          '-v', 'error', '-show_entries', 'format=duration',
          '-of', 'default=noprint_wrappers=1:nokey=1', tmpMp4
        ], { timeout: 10000 });
        const duration = parseFloat(probeOut.trim());
        // Cap duration at 90s to keep encode fast and clip watchable
        const targetDuration = Math.min(duration, 90);
        // Target 7.5MB, reserve 128kbps for audio, rest for video
        const targetTotalKbps = Math.floor((7.5 * 8 * 1024) / targetDuration);
        const audioBitrateKbps = 96;
        const videoBitrateKbps = Math.max(100, targetTotalKbps - audioBitrateKbps);
        logger.info(`Re-encoding: duration=${targetDuration.toFixed(1)}s video=${videoBitrateKbps}kbps audio=${audioBitrateKbps}kbps`);
        await execFileAsync('ffmpeg', [
          '-y', '-i', tmpMp4,
          '-t', String(targetDuration),
          '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
          '-c:v', 'libx264', '-b:v', `${videoBitrateKbps}k`, '-preset', 'ultrafast',
          '-c:a', 'aac', '-b:a', `${audioBitrateKbps}k`,
          '-movflags', '+faststart',
          '-loglevel', 'error', reencPath
        ], { timeout: 300000 });
        const { size: reencSize } = await stat(reencPath);
        logger.info(`Re-encoded to ${(reencSize / 1024 / 1024).toFixed(1)}MB`);
        try { await unlink(tmpMp4); } catch {}
        if (reencSize > 0 && reencSize <= DISCORD_LIMIT) return reencPath;
        try { await unlink(reencPath); } catch {}
      } catch (reencErr) {
        logger.error('Re-encode failed:', reencErr.message);
        try { await unlink(tmpMp4); } catch {}
      }
      return null;
    }
    logger.warn('yt-dlp produced empty file');
  } catch {
    logger.warn('yt-dlp output file not found');
  }
  try { await unlink(tmpMp4); } catch {}
  return null;
}

// ── Main download pipeline ────────────────────────────────────────────────────

export async function downloadVideoClip(streamUrl, cookies = '', videoPageUrl = '') {
  const reqHeaders = { ...HEADERS };
  if (cookies) reqHeaders['Cookie'] = cookies;
  if (videoPageUrl) {
    try {
      const origin = new URL(videoPageUrl);
      reqHeaders['Referer'] = videoPageUrl;
      reqHeaders['Origin'] = `${origin.protocol}//${origin.host}`;
    } catch {}
  }
  const MAX = 8 * 1024 * 1024;

  const isHls = streamUrl.includes('.m3u8');

  if (streamUrl && !isHls) {
    const tmpPath = join(tmpdir(), `discord_vid_${Date.now()}.mp4`);
    try {
      const { createWriteStream } = await import('fs');
      logger.info(`Direct mp4 download: ${streamUrl.slice(0, 80)}`);
      const dlRes = await axios.get(streamUrl, {
        headers: reqHeaders,
        responseType: 'stream',
        timeout: 60000,
        validateStatus: s => s < 400
      });

      let total = 0;
      const ws = createWriteStream(tmpPath);
      await new Promise((resolve, reject) => {
        dlRes.data.on('data', (chunk) => {
          total += chunk.length;
          if (total > MAX) { ws.end(); dlRes.data.destroy(); resolve(); return; }
          ws.write(chunk);
        });
        dlRes.data.on('end', () => { ws.end(); resolve(); });
        dlRes.data.on('error', reject);
      });

      const { size } = await stat(tmpPath);
      if (size > 0 && size <= MAX) {
        logger.info(`Direct mp4: ${(size / 1024 / 1024).toFixed(1)}MB`);
        return tmpPath;
      }
      logger.warn(`Direct mp4 size out of range: ${size} bytes`);
    } catch (err) {
      logger.error('Direct mp4 download failed:', err.message);
    }
    try { await unlink(tmpPath); } catch {}
  } else if (streamUrl && isHls) {
    const tsPath = await downloadHlsViaAxios(streamUrl, reqHeaders);
    if (tsPath) {
      const mp4Path = await remuxToMp4(tsPath);
      try { await unlink(tsPath); } catch {}
      if (mp4Path) {
        const { size } = await stat(mp4Path);
        if (size > 0 && size <= MAX) {
          logger.info(`HLS mp4: ${(size / 1024 / 1024).toFixed(1)}MB`);
          return mp4Path;
        }
        try { await unlink(mp4Path); } catch {}
      }
    }
  }

  if (videoPageUrl) {
    const ytPath = await downloadWithYtDlp(videoPageUrl, cookies);
    if (ytPath) return ytPath;
  }

  logger.warn('All download methods failed');
  return null;
}

export async function cleanupClip(filePath) {
  try {
    await unlink(filePath);
    logger.debug(`Cleaned up temp file: ${filePath}`);
  } catch {}
}
