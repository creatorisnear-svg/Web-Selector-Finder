import axios from 'axios';
import * as cheerio from 'cheerio';

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
const SKIP_URL_PATTERN = /(login|signup|register|cdn\.|\.jpg|\.jpeg|\.png|\.gif|\.webp|\.svg|\.ico|\/search|\/tag|\/tags|\/category|\/categories|\/channel|\/channels|\/user|\/users|\/profile|\/author|\/page\/|\/feed|\/rss|javascript:|mailto:|#|\/about|\/help|\/support|\/contact|\/legal|\/privacy|\/terms|\/dmca|\/faq|\/advertise|\/careers|\/press|\/sitemap|\/playlist|\/playlists|\/gif|\/gifs|\/photo|\/photos|\/image|\/images|\/album|\/albums|\/gallery|\/galleries|\/collection|\/collections)/i;

// URL patterns that look like individual video pages
const VIDEO_PATH_PATTERN = /\/(video|videos|watch|v|embed|clip|view|play|porn|tube|movie|scene)[\/-]|\/(vids?|flv|mp4)\/|\/\d{5,}/i;

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
      // In fallback, require longer title to reduce noise
      if (title.length < 10) return;

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

export async function getDirectMp4(videoPageUrl) {
  console.log('Looking for mp4 on:', videoPageUrl);
  let data;
  try {
    const res = await axios.get(videoPageUrl, { headers: HEADERS, timeout: 15000 });
    data = res.data;
  } catch (err) {
    console.error('Failed to fetch video page:', err.message);
    return null;
  }

  const $ = cheerio.load(data);

  // 1. <source> or <video> tags with .mp4
  const fromTag =
    $('source[src*=".mp4"]').attr('src') ||
    $('video[src*=".mp4"]').attr('src');
  if (fromTag) return resolveUrl(fromTag, videoPageUrl);

  // 2. og:video meta tag
  const ogVideo =
    $('meta[property="og:video:secure_url"]').attr('content') ||
    $('meta[property="og:video"]').attr('content');
  if (ogVideo && ogVideo.includes('.mp4')) return ogVideo;

  // 3. Scan script tags for .mp4 URLs, prefer higher quality
  const mp4Pattern = /https?:[^"'\s,)\\]+\.mp4[^"'\s,)\\]*/gi;
  let bestMp4 = null;
  let bestScore = -1;

  $('script').each((_, el) => {
    const text = $(el).html() || '';
    const matches = text.match(mp4Pattern) || [];
    for (const match of matches) {
      let score = 0;
      if (match.includes('1080')) score = 4;
      else if (match.includes('720')) score = 3;
      else if (match.includes('480')) score = 2;
      else if (match.includes('hd') || match.includes('high')) score = 1;
      if (score > bestScore) {
        bestScore = score;
        bestMp4 = match;
      } else if (!bestMp4) {
        bestMp4 = match;
      }
    }
  });

  if (bestMp4) return bestMp4;

  // 4. Scan raw HTML as last resort
  const rawMatches = data.match(mp4Pattern);
  if (rawMatches && rawMatches.length > 0) return rawMatches[0];

  return null;
}
