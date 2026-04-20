import axios from 'axios';
import * as cheerio from 'cheerio';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { tmpdir } from 'os';
import { join } from 'path';
import { stat, unlink } from 'fs/promises';
import { logger } from './logger.mjs';

const execFileAsync = promisify(execFile);

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

// Words found in nav/footer links — never real video titles
const JUNK_TITLE_WORDS = /^(trust|safety|notice|terms|privacy|cookie|about|help|support|contact|legal|dmca|faq|adverti|careers|press|sitemap|accessibility|copyright|report|feedback|language|settings|sign in|log in|sign up|register|subscribe|upgrade|premium|home|back|next|prev|more|less|see all|view all|show all|load more|follow|share|embed|download|playlist|channel|community|forum|blog|news|store|shop|gift|merch|gif|photo|image|album|gallery)$/i;

// URL path segments to skip — non-video pages and non-video media types
const SKIP_URL_PATTERN = /(login|signup|register|cdn\.|\.jpg|\.jpeg|\.png|\.gif|\.webp|\.svg|\.ico|\/search|\/tag|\/tags|\/category|\/categories|\/channel|\/channels|\/user|\/users|\/profile|\/author|\/page\/|\/feed|\/rss|javascript:|mailto:|#|\/about|\/help|\/support|\/contact|\/legal|\/privacy|\/terms|\/dmca|\/faq|\/advertise|\/careers|\/press|\/sitemap|\/playlist|\/playlists|\/gif|\/gifs|\/photo|\/photos|\/image|\/images|\/album|\/albums|\/gallery|\/galleries|\/collection|\/collections|\/random|\/top$|\/featured$|\/recommended$|\/popular$|\/trending$|\/new$|\/latest$|\/most-|\/best-)/i;

// URL patterns that look like individual video pages
const VIDEO_PATH_PATTERN = /\/(video|videos|watch|v|embed|clip|view_video|play|tube|movie|scene|porn|flv|vids?)[\/-]|\/(watch|embed)\?|viewkey=|[?&]v=|\/\d{4,}[^/]*$|\/(video|videos|vids?)\/[^/?#]{3,}/i;

function isJunkTitle(title) {
  if (!title) return true;
  const t = title.trim();
  if (t.length < 5) return true;
  if (t.length > 200) return true;
  if (JUNK_TITLE_WORDS.test(t)) return true;
  if (t.length < 20 && t === t.toUpperCase()) return true;
  return false;
}

// Returns a relevance score (0–N) for how well a title matches the query.
// Splits query into meaningful words (3+ chars) and counts how many appear in the title.
function relevanceScore(title, queryWords) {
  if (!queryWords.length) return 1; // no words to match — always relevant
  const lowerTitle = title.toLowerCase();
  let score = 0;
  for (const word of queryWords) {
    if (lowerTitle.includes(word)) score++;
  }
  return score;
}

// Extract meaningful search words (3+ chars, not stop words)
const STOP_WORDS = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'are', 'was', 'has', 'have', 'not', 'from', 'but', 'all', 'can', 'her', 'his', 'its', 'she', 'him', 'they', 'what', 'who', 'how', 'get', 'got', 'may', 'more', 'also', 'very', 'too', 'out', 'then', 'now', 'just', 'into', 'over', 'only', 'back', 'will', 'been', 'when', 'your', 'our', 'their', 'one', 'two', 'any', 'some', 'each', 'does', 'did', 'had', 'him', 'off']);

function extractQueryWords(query) {
  return query
    .toLowerCase()
    .split(/\W+/)
    .filter(w => w.length >= 3 && !STOP_WORDS.has(w));
}

export async function searchVideos(searchUrlTemplate, query) {
  const url = searchUrlTemplate.replace('{query}', encodeURIComponent(query));
  logger.info(`Searching: ${url}`);

  const { data } = await axios.get(url, { headers: HEADERS, timeout: 15000 });
  const $ = cheerio.load(data);

  const queryWords = extractQueryWords(query);
  logger.debug(`Query words for relevance filter: ${JSON.stringify(queryWords)}`);

  const candidates = [];
  const seenHrefs = new Set();

  $('a[href]').each((i, el) => {
    const href = $(el).attr('href');
    if (!href || seenHrefs.has(href)) return;
    if (SKIP_URL_PATTERN.test(href)) return;
    if (!VIDEO_PATH_PATTERN.test(href)) return;

    const fullUrl = resolveUrl(href, url);
    if (!fullUrl) return;

    const title = getTitle(el, $);
    if (isJunkTitle(title)) return;

    seenHrefs.add(href);
    candidates.push({
      title: title.length > 80 ? title.slice(0, 77) + '...' : title,
      url: fullUrl,
      score: relevanceScore(title, queryWords)
    });
  });

  // Fallback: wider net if strict video URL pattern found nothing
  if (candidates.length === 0) {
    logger.info('Strict video URL match found nothing — trying wider search');
    $('a[href]').each((i, el) => {
      const href = $(el).attr('href');
      if (!href || seenHrefs.has(href)) return;
      if (SKIP_URL_PATTERN.test(href)) return;
      if (!href.startsWith('/') && !href.startsWith('http')) return;
      if (href === '/' || href.split('/').filter(Boolean).length < 2) return;

      const fullUrl = resolveUrl(href, url);
      if (!fullUrl) return;

      const title = getTitle(el, $);
      if (isJunkTitle(title)) return;

      seenHrefs.add(href);
      candidates.push({
        title: title.length > 80 ? title.slice(0, 77) + '...' : title,
        url: fullUrl,
        score: relevanceScore(title, queryWords)
      });
    });
  }

  // Sort by relevance — highest score first
  candidates.sort((a, b) => b.score - a.score);

  // If we have relevant results (score > 0), only keep those
  const relevant = candidates.filter(r => r.score > 0);
  const results = (relevant.length > 0 ? relevant : candidates).slice(0, 10);

  logger.info(`Found ${candidates.length} candidates, ${relevant.length} relevant — returning ${results.length}`);
  if (results.length > 0) {
    logger.debug('Top results:', results.slice(0, 3).map(r => `[${r.score}] ${r.title}`).join(' | '));
  }

  return results.map(({ title, url }) => ({ title, url }));
}

// Score a video URL by quality — higher is better
function qualityScore(url) {
  if (url.includes('1080')) return 4;
  if (url.includes('720')) return 3;
  if (url.includes('480')) return 2;
  if (url.includes('360')) return 1;
  if (url.includes('hd') || url.includes('high')) return 2;
  return 0;
}

// Unescape JSON-encoded URLs (e.g. https:\/\/example.com -> https://example.com)
function unescapeUrl(str) {
  return str.replace(/\\\//g, '/').replace(/\\u0026/g, '&');
}

// Is this URL a thumbnail/image CDN URL rather than an actual video?
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

// Returns { url, isHls, cookies } for the best downloadable video URL on a page, or null.
export async function getVideoStreamUrl(videoPageUrl) {
  logger.info(`Fetching video page: ${videoPageUrl}`);
  let res;
  try {
    res = await axios.get(videoPageUrl, { headers: HEADERS, timeout: 15000 });
  } catch (err) {
    logger.error('Failed to fetch video page:', err.message);
    return null;
  }

  // Capture session cookies so we can reuse them for CDN requests
  const setCookies = res.headers['set-cookie'] || [];
  const sessionCookies = [
    ...HEADERS.Cookie.split('; '),
    ...setCookies.map(c => c.split(';')[0])
  ].join('; ');

  const $ = cheerio.load(res.data);
  const allScripts = $('script').map((_, el) => $(el).html() || '').get().join('\n');

  // 1. <source> or <video> tags — direct embed, best case
  for (const el of $('source[src], video[src]').toArray()) {
    const src = $(el).attr('src') || '';
    if (src.includes('.mp4') || src.includes('.webm')) {
      logger.info('Found direct video/source tag');
      return { url: resolveUrl(src, videoPageUrl), isHls: false, cookies: sessionCookies };
    }
  }

  // 2. og:video meta — direct embed
  const ogVideo =
    $('meta[property="og:video:secure_url"]').attr('content') ||
    $('meta[property="og:video"]').attr('content');
  if (ogVideo && (ogVideo.includes('.mp4') || ogVideo.includes('.webm')) && !ogVideo.includes('.m3u8')) {
    logger.info('Found og:video meta tag');
    return { url: ogVideo, isHls: false, cookies: sessionCookies };
  }

  // 3. Flashvars: use get_media API to obtain direct IP-bound mp4 URLs
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

      // Fallback: HLS streams
      const hlsDefs = defs.filter(d => d.format === 'hls' && d.videoUrl);
      const qualityOrder = ['480', '240', '360', '720', '1080'];
      hlsDefs.sort((a, b) => {
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

  // 4. Generic "videoUrl" JSON field scan (any site)
  const vuRegex = /"videoUrl"\s*:\s*"([^"]+)"/gi;
  let vuMatch;
  while ((vuMatch = vuRegex.exec(allScripts)) !== null) {
    const raw = unescapeUrl(vuMatch[1]);
    if (raw.includes('.mp4') || raw.includes('.m3u8')) {
      logger.info('Found videoUrl in script JSON');
      return { url: raw, isHls: raw.includes('.m3u8'), cookies: sessionCookies };
    }
  }

  // 5. Generic scan for plain .mp4 URLs in scripts
  const plainMp4 = /https?:\/\/[^\s"'<>\\]+\.mp4/gi;
  for (const match of (allScripts.match(plainMp4) || [])) {
    if (isThumbnailUrl(match)) continue;
    logger.info('Found plain .mp4 URL in script');
    return { url: match, isHls: false, cookies: sessionCookies };
  }

  logger.warn('No video stream found on page');
  return null;
}

// Parse an m3u8 playlist and extract .ts segment URLs (absolute).
function parseM3u8Segments(m3u8Text, baseUrl) {
  const lines = m3u8Text.split('\n').map(l => l.trim()).filter(Boolean);
  const segments = [];
  for (const line of lines) {
    if (line.startsWith('#')) continue;
    try {
      segments.push(new URL(line, baseUrl).href);
    } catch {
      segments.push(line);
    }
  }
  return segments;
}

// Parse a master m3u8 and find the best media playlist URL for a given target quality.
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

// Download an HLS stream segment-by-segment via axios.
async function downloadHlsViaAxios(masterUrl, reqHeaders = HEADERS, maxSegments = 40) {
  const tmpTs = join(tmpdir(), `discord_hls_${Date.now()}.ts`);
  const { createWriteStream } = await import('fs');

  try {
    const masterRes = await axios.get(masterUrl, { headers: reqHeaders, timeout: 10000 });
    let mediaUrl;

    if (masterRes.data.includes('#EXT-X-STREAM-INF')) {
      mediaUrl = parseMasterM3u8(masterRes.data, masterUrl, '480');
      if (!mediaUrl) {
        logger.error('Could not parse master m3u8');
        return null;
      }
      logger.info(`Media playlist: ${mediaUrl.slice(0, 80)}`);
    } else {
      mediaUrl = masterUrl;
    }

    const mediaRes = await axios.get(mediaUrl, { headers: reqHeaders, timeout: 10000 });
    const segments = parseM3u8Segments(mediaRes.data, mediaUrl);
    if (segments.length === 0) {
      logger.error('No segments found in m3u8');
      return null;
    }

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

// Remux a .ts file to .mp4 using ffmpeg.
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

// Path to yt-dlp binary (bundled with the project for portability)
const YTDLP_BIN = new URL('../../bin/yt-dlp', import.meta.url).pathname;

// Try to download a video from a PAGE URL using yt-dlp.
async function downloadWithYtDlp(videoPageUrl) {
  const tmpPath = join(tmpdir(), `discord_ytdlp_${Date.now()}.mp4`);
  const args = [
    '--impersonate', 'chrome',
    '-f', 'bv[height<=480][ext=mp4]+ba[ext=m4a]/bv[height<=480]+ba/worst[ext=mp4]/worst',
    '--max-filesize', '7.5M',
    '-o', tmpPath,
    '--no-playlist',
    '--merge-output-format', 'mp4',
    '--quiet',
    '--no-warnings',
    videoPageUrl
  ];

  logger.info('Trying yt-dlp...');
  try {
    await execFileAsync(YTDLP_BIN, args, { timeout: 120000 });
    const { size } = await stat(tmpPath);
    if (size > 0) {
      logger.info(`yt-dlp success: ${(size / 1024 / 1024).toFixed(1)}MB`);
      return tmpPath;
    }
  } catch (err) {
    const detail = err.stderr || err.message || '';
    logger.error('yt-dlp failed:', detail.slice(0, 200));
  }
  try { await unlink(tmpPath); } catch {}
  return null;
}

// Download a video clip via stream URL, then yt-dlp as fallback.
export async function downloadVideoClip(streamUrl, cookies = '', videoPageUrl = '') {
  const reqHeaders = { ...HEADERS };
  if (cookies) reqHeaders['Cookie'] = cookies;
  const MAX = 8 * 1024 * 1024;

  const isHls = streamUrl.includes('.m3u8');

  // --- Method 1: Axios download (direct mp4 or HLS segments) ---
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

  // --- Method 2: yt-dlp with page URL ---
  if (videoPageUrl) {
    const ytPath = await downloadWithYtDlp(videoPageUrl);
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
