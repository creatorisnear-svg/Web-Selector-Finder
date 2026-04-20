import axios from 'axios';
import * as cheerio from 'cheerio';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { tmpdir } from 'os';
import { join } from 'path';
import { stat, unlink } from 'fs/promises';

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
// Covers: /video/123, /watch?v=, /view_video.php, viewkey=, /v/slug, /embed/id, /videos/slug, numeric IDs
const VIDEO_PATH_PATTERN = /\/(video|videos|watch|v|embed|clip|view_video|play|tube|movie|scene|porn|flv|vids?)[\/-]|\/(watch|embed)\?|viewkey=|[?&]v=|\/\d{4,}[^/]*$|\/(video|videos|vids?)\/[^/?#]{3,}/i;

function isJunkTitle(title) {
  if (!title) return true;
  const t = title.trim();
  if (t.length < 5) return true;
  if (t.length > 200) return true; // suspiciously long = probably grabbed wrong element
  if (JUNK_TITLE_WORDS.test(t)) return true;
  // All uppercase short strings are usually buttons/labels
  if (t.length < 20 && t === t.toUpperCase()) return true;
  return false;
}

export async function searchVideos(searchUrlTemplate, query) {
  const url = searchUrlTemplate.replace('{query}', encodeURIComponent(query));
  console.log('Fetching:', url);

  const { data } = await axios.get(url, { headers: HEADERS, timeout: 15000 });
  const $ = cheerio.load(data);

  const results = [];
  const seenHrefs = new Set();

  $('a[href]').each((i, el) => {
    if (results.length >= 10) return;

    const href = $(el).attr('href');
    if (!href || seenHrefs.has(href)) return;
    if (SKIP_URL_PATTERN.test(href)) return;
    if (!VIDEO_PATH_PATTERN.test(href)) return;

    const fullUrl = resolveUrl(href, url);
    if (!fullUrl) return;

    const title = getTitle(el, $);
    if (isJunkTitle(title)) return;

    seenHrefs.add(href);
    results.push({
      title: title.length > 80 ? title.slice(0, 77) + '...' : title,
      url: fullUrl
    });
  });

  // Fallback: wider net, but stricter title filter
  if (results.length === 0) {
    console.log('Strict match found nothing — trying wider search');
    $('a[href]').each((i, el) => {
      if (results.length >= 10) return;

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
      results.push({
        title: title.length > 80 ? title.slice(0, 77) + '...' : title,
        url: fullUrl
      });
    });
  }

  console.log(`Found ${results.length} results`);
  return results;
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
// Uses PornHub's get_media API to get direct IP-bound mp4 URLs for lowest available quality.
export async function getVideoStreamUrl(videoPageUrl) {
  console.log('Fetching video page:', videoPageUrl);
  let res;
  try {
    res = await axios.get(videoPageUrl, { headers: HEADERS, timeout: 15000 });
  } catch (err) {
    console.error('Failed to fetch video page:', err.message);
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
      return { url: resolveUrl(src, videoPageUrl), isHls: false, cookies: sessionCookies };
    }
  }

  // 2. og:video meta — direct embed
  const ogVideo =
    $('meta[property="og:video:secure_url"]').attr('content') ||
    $('meta[property="og:video"]').attr('content');
  if (ogVideo && (ogVideo.includes('.mp4') || ogVideo.includes('.webm')) && !ogVideo.includes('.m3u8')) {
    return { url: ogVideo, isHls: false, cookies: sessionCookies };
  }

  // 3. Flashvars: use get_media API to obtain direct IP-bound mp4 URLs
  const fvMatch = allScripts.match(/var\s+flashvars_\w+\s*=\s*(\{[\s\S]*?\});\s*\n/);
  if (fvMatch) {
    try {
      const fv = JSON.parse(fvMatch[1]);
      const defs = fv.mediaDefinitions || [];

      // Find the mp4 entry that has a get_media endpoint URL
      const mp4ApiDef = defs.find(d => d.format === 'mp4' && d.videoUrl && d.videoUrl.includes('get_media'));
      if (mp4ApiDef) {
        console.log('Calling get_media API...');
        const mediaHeaders = { ...HEADERS, 'Cookie': sessionCookies, 'Referer': videoPageUrl };
        const mediaRes = await axios.get(mp4ApiDef.videoUrl, { headers: mediaHeaders, timeout: 10000 });
        const mediaDefs = Array.isArray(mediaRes.data) ? mediaRes.data : [];
        if (mediaDefs.length > 0) {
          // Sort by quality: prefer 240p → 480p → 720p (smallest file)
          const qualityOrder = ['240', '480', '360', '720', '1080'];
          mediaDefs.sort((a, b) => {
            const ai = qualityOrder.findIndex(q => String(a.height || a.quality || '').includes(q));
            const bi = qualityOrder.findIndex(q => String(b.height || b.quality || '').includes(q));
            return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
          });
          const best = mediaDefs[0];
          const url = unescapeUrl(best.videoUrl);
          console.log(`get_media: ${best.height}p mp4:`, url.slice(0, 80));
          return { url, isHls: false, cookies: sessionCookies };
        }
      }

      // Fallback: HLS streams (IP-bound, same session)
      const hlsDefs = defs.filter(d => d.format === 'hls' && d.videoUrl);
      const qualityOrder = ['480', '240', '360', '720', '1080'];
      hlsDefs.sort((a, b) => {
        const ai = qualityOrder.findIndex(q => String(a.quality).includes(q));
        const bi = qualityOrder.findIndex(q => String(b.quality).includes(q));
        return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
      });
      if (hlsDefs.length > 0) {
        const url = unescapeUrl(hlsDefs[0].videoUrl);
        console.log(`HLS fallback ${hlsDefs[0].quality}:`, url.slice(0, 80));
        return { url, isHls: true, cookies: sessionCookies };
      }
    } catch (e) {
      console.error('Flashvars parse error:', e.message);
    }
  }

  // 4. Generic "videoUrl" JSON field scan (any site)
  const vuRegex = /"videoUrl"\s*:\s*"([^"]+)"/gi;
  let vuMatch;
  while ((vuMatch = vuRegex.exec(allScripts)) !== null) {
    const raw = unescapeUrl(vuMatch[1]);
    if (raw.includes('.mp4') || raw.includes('.m3u8')) {
      return { url: raw, isHls: raw.includes('.m3u8'), cookies: sessionCookies };
    }
  }

  // 5. Generic scan for plain .mp4 URLs in scripts
  const plainMp4 = /https?:\/\/[^\s"'<>\\]+\.mp4/gi;
  for (const match of (allScripts.match(plainMp4) || [])) {
    if (isThumbnailUrl(match)) continue;
    return { url: match, isHls: false, cookies: sessionCookies };
  }

  console.log('No video stream found on page');
  return null;
}

// Parse an m3u8 playlist and extract .ts segment URLs (absolute).
function parseM3u8Segments(m3u8Text, baseUrl) {
  const lines = m3u8Text.split('\n').map(l => l.trim()).filter(Boolean);
  const segments = [];
  for (const line of lines) {
    if (line.startsWith('#')) continue;
    // Resolve relative URLs
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
  // Prefer target quality, otherwise pick smallest
  const target = parseInt(targetQuality);
  const exact = streams.find(s => s.height === target);
  if (exact) return exact.url;
  // Pick closest quality ≤ target (prefer smaller file)
  const smaller = streams.filter(s => s.height <= target).sort((a, b) => b.height - a.height);
  if (smaller.length > 0) return smaller[0].url;
  // Fall back to smallest available
  return streams.sort((a, b) => a.bandwidth - b.bandwidth)[0].url;
}

// Download an HLS stream segment-by-segment via axios (same IP as page fetch).
// Returns temp .ts file path, or null on failure.
async function downloadHlsViaAxios(masterUrl, reqHeaders = HEADERS, maxSegments = 40) {
  const tmpTs = join(tmpdir(), `discord_hls_${Date.now()}.ts`);
  const { createWriteStream } = await import('fs');

  try {
    // 1. Fetch master playlist
    const masterRes = await axios.get(masterUrl, { headers: reqHeaders, timeout: 10000 });
    let mediaUrl;

    if (masterRes.data.includes('#EXT-X-STREAM-INF')) {
      // It's a master playlist — find 480p or lower
      mediaUrl = parseMasterM3u8(masterRes.data, masterUrl, '480');
      if (!mediaUrl) {
        console.error('Could not parse master m3u8');
        return null;
      }
      console.log('Media playlist:', mediaUrl.slice(0, 80));
    } else {
      // Already a media playlist
      mediaUrl = masterUrl;
    }

    // 2. Fetch media playlist
    const mediaRes = await axios.get(mediaUrl, { headers: reqHeaders, timeout: 10000 });
    const segments = parseM3u8Segments(mediaRes.data, mediaUrl);
    if (segments.length === 0) {
      console.error('No segments found in m3u8');
      return null;
    }

    const toDownload = segments.slice(0, maxSegments);
    console.log(`Downloading ${toDownload.length} of ${segments.length} HLS segments...`);

    // 3. Download segments and concatenate into a .ts file
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
        console.warn('Segment failed:', segUrl.slice(0, 60), segErr.message);
      }
    }

    await new Promise((resolve, reject) => {
      writeStream.end();
      writeStream.on('finish', resolve);
      writeStream.on('error', reject);
    });

    const mb = (totalBytes / 1024 / 1024).toFixed(1);
    console.log(`Downloaded ${mb}MB of HLS segments`);
    return tmpTs;
  } catch (err) {
    console.error('HLS download failed:', err.message);
    try { await unlink(tmpTs); } catch {}
    return null;
  }
}

// Remux a .ts file to .mp4 using ffmpeg (local operation, no network).
async function remuxToMp4(tsPath) {
  const mp4Path = tsPath.replace('.ts', '.mp4');
  const args = ['-y', '-i', tsPath, '-c', 'copy', '-movflags', '+faststart', '-loglevel', 'error', mp4Path];
  try {
    await execFileAsync('ffmpeg', args, { timeout: 30000 });
    return mp4Path;
  } catch (err) {
    console.error('Remux failed:', (err.stderr || err.message).slice(0, 200));
    return null;
  }
}

// Path to yt-dlp binary (bundled with the project for portability)
const YTDLP_BIN = new URL('../../bin/yt-dlp', import.meta.url).pathname;

// Try to download a video from a PAGE URL using yt-dlp.
// Returns temp mp4 file path, or null.
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

  console.log('Trying yt-dlp...');
  try {
    await execFileAsync(YTDLP_BIN, args, { timeout: 120000 });
    const { size } = await stat(tmpPath);
    if (size > 0) {
      console.log(`yt-dlp success: ${(size / 1024 / 1024).toFixed(1)}MB`);
      return tmpPath;
    }
  } catch (err) {
    const detail = err.stderr || err.message || '';
    console.error('yt-dlp failed:', detail.slice(0, 200));
  }
  try { await unlink(tmpPath); } catch {}
  return null;
}

// Download a video stream (HLS or direct mp4) using session cookies to bypass IP binding.
// videoPageUrl: the original video page URL (for yt-dlp fallback)
// streamUrl: direct CDN URL if already resolved
// cookies: session cookie string captured during the page request
// Returns temp file path or null.
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
        console.log(`Direct mp4: ${(size / 1024 / 1024).toFixed(1)}MB`);
        return tmpPath;
      }
    } catch (err) {
      console.error('Direct mp4 download failed:', err.message);
    }
    try { await unlink(tmpPath); } catch {}
  } else if (streamUrl && isHls) {
    // HLS via axios segments
    const tsPath = await downloadHlsViaAxios(streamUrl, reqHeaders);
    if (tsPath) {
      const mp4Path = await remuxToMp4(tsPath);
      try { await unlink(tsPath); } catch {}
      if (mp4Path) {
        const { size } = await stat(mp4Path);
        if (size > 0 && size <= MAX) {
          console.log(`HLS mp4: ${(size / 1024 / 1024).toFixed(1)}MB`);
          return mp4Path;
        }
        try { await unlink(mp4Path); } catch {}
      }
    }
  }

  // --- Method 2: yt-dlp with page URL (handles auth, cookies, DRM) ---
  if (videoPageUrl) {
    const ytPath = await downloadWithYtDlp(videoPageUrl);
    if (ytPath) return ytPath;
  }

  console.log('All download methods failed');
  return null;
}

export async function cleanupClip(filePath) {
  try { await unlink(filePath); } catch {}
}
