import axios from 'axios';
import * as cheerio from 'cheerio';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { tmpdir } from 'os';
import { join } from 'path';
import { stat, unlink } from 'fs/promises';
import { logger, redact, redactUrl } from './logger.mjs';

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

// Try multiple lazy-load attributes in priority order; resolve relative URLs; skip placeholders.
const THUMB_ATTRS = ['data-src', 'data-original', 'data-lazy-src', 'data-thumb', 'data-video-thumb', 'data-cfsrc', 'data-url', 'src'];
function extractThumbnail(imgEl, $, baseUrl) {
  for (const attr of THUMB_ATTRS) {
    const raw = imgEl.attr(attr) || '';
    if (!raw || raw.startsWith('data:')) continue;
    // Skip obvious 1×1 / spinner placeholders
    if (/blank|placeholder|spinner|loading|1x1|pixel|transparent/i.test(raw)) continue;
    // Must look like an image URL
    if (!raw.match(/\.(jpg|jpeg|png|webp|gif)(\?|$)/i) && !raw.includes('/thumb') && !raw.includes('/image')) continue;
    const resolved = raw.startsWith('http') ? raw : (raw.startsWith('//') ? 'https:' + raw : resolveUrl(raw, baseUrl));
    if (resolved) return resolved;
  }
  return null;
}

// ── PornHub WebMasters API search ─────────────────────────────────────────────
// Uses PH's official API endpoint — returns clean JSON, no bot detection issues.
// Fetches 30 results so the relevance filter has enough to pick 10 good ones from.
async function searchPornhub(query, page = 0) {
  // 1. Try PornHub WebMasters JSON API (fast and clean when not IP-blocked)
  // PH API uses 1-indexed pages, so page 0 → page=1, page 1 → page=2, etc.
  try {
    const phPage = page + 1;
    const apiUrl = `https://www.pornhub.com/webmasters/search?search_term=${encodeURIComponent(query)}&page=${phPage}&per_page=30&ordering=mostviewed&period=alltime`;
    logger.info(`PH API: search ${redact(query)} p${phPage}`);
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
      return videos.filter(v => v.url && v.title).map(v => {
        let duration = null;
        if (v.duration) {
          // Check for MM:SS format FIRST — parseInt("20:32") = 20 (not NaN!), which is wrong
          if (typeof v.duration === 'string' && v.duration.includes(':')) {
            duration = v.duration;
          } else {
            const secs = parseInt(v.duration, 10);
            if (!isNaN(secs) && secs > 0) {
              const m = Math.floor(secs / 60);
              const s = secs % 60;
              duration = `${m}:${String(s).padStart(2, '0')}`;
            }
          }
        }
        const thumb = v.defaultThumb?.src || (Array.isArray(v.thumbs) && v.thumbs[0]?.src) || null;
        const thumbnail = thumb && !thumb.startsWith('data:') ? thumb : null;
        // Extract actor names from PH API response (most reliable source)
        const actors = Array.isArray(v.actors)
          ? v.actors.slice(0, 2).map(a => a.actorName || a.name || '').filter(Boolean)
          : [];
        return {
          title: v.title.length > 80 ? v.title.slice(0, 77) + '...' : v.title,
          url: v.url,
          duration,
          thumbnail,
          ...(actors.length ? { actors } : {}),
        };
      });
    }
  } catch (err) {
    logger.warn(`PH API error: ${err.message}`);
  }

  // 2. Fallback: xvideos search — not Cloudflare-gated, large library, yt-dlp can download
  logger.info('Falling back to xvideos search');
  return searchXvideos(query);
}

async function searchXvideos(query, page = 0) {
  // xvideos uses 0-indexed `p` — page 1 is `p=0`, page 2 is `p=1`, etc.
  const pageParam = page > 0 ? `&p=${page}` : '';
  const searchUrl = `https://www.xvideos.com/?k=${encodeURIComponent(query)}${pageParam}`;
  logger.info(`xvideos search: ${redact(query)} p${page}`);
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
      if (results.length >= 20) return;
      const titleEl = $(el).find('.title a');
      const rawTitle = titleEl.text().trim();
      const href = $(el).find('a').first().attr('href') || '';
      if (!rawTitle || !href || seen.has(href)) return;
      seen.add(href);
      const url = href.startsWith('http') ? href : `https://www.xvideos.com${href}`;
      const title = rawTitle.replace(/\s+\d+\s*(min|sec)\s*$/, '').trim();
      if (!title || !url) return;
      const rawDuration = $(el).find('.duration').text().trim() || $(el).find('[class*="duration"]').text().trim() || '';
      const duration = rawDuration || null;
      const thumbnail = extractThumbnail($(el).find('img').first(), $, searchUrl);
      results.push({ title: title.length > 80 ? title.slice(0, 77) + '...' : title, url, duration, thumbnail });
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

// Breaks a compound word into its component parts for fuzzy matching.
// "stepmom" → ["stepmom", "step", "mom", "stepmother", "mother"]
// "stepson" → ["stepson", "step", "son"]
const FAMILY_BREAKS = ['step','mom','dad','son','daughter','mother','father','sister','brother','bro','sis','milf'];
const FAMILY_SYNONYMS = { mom: ['mom','mother','mum'], dad: ['dad','father'], sis: ['sis','sister'], bro: ['bro','brother'] };
function wordVariants(token) {
  const variants = new Set([token]);
  for (const prefix of FAMILY_BREAKS) {
    if (token.startsWith(prefix) && token !== prefix) {
      variants.add(prefix);
      const rest = token.slice(prefix.length);
      if (rest.length >= 3) variants.add(rest);
      // Also add synonym forms e.g. "stepmom" → "stepmother"
      const syns = FAMILY_SYNONYMS[prefix] || [];
      for (const syn of syns) {
        variants.add(token.replace(prefix, syn));
        variants.add(syn);
      }
      break;
    }
    // suffix break: "stepmom" ends with "mom" → already handled by prefix above
  }
  return [...variants];
}

// Returns an array of concept groups. Each group is a list of word variants
// that all count as a match for that ONE query concept.
// "stepmom stepson threesome" →
//   [ ["stepmom","step","mom","stepmother","mother"],
//     ["stepson","step","son"],
//     ["threesome"] ]
// Scoring: matched_groups / total_groups  →  no token inflation.
function queryGroups(query) {
  const STOP = new Set(['the','and','for','with','that','this','from','but','all','not','are','was']);
  const base = query.toLowerCase().split(/\W+/).filter(w => w.length >= 3 && !STOP.has(w));
  return [...new Set(base)].map(w => wordVariants(w));
}

// Legacy flat token list — still used by sortByRelevance signature kept below.
function queryTokens(query) {
  return queryGroups(query).flat();
}

// Returns a relevance score [0, 1] — fraction of CONCEPTS (not raw tokens) matched.
// e.g. query "stepmom stepson threesome" (3 concepts), title "step mom" →
//   concept "stepmom" → title contains "stepmom"/"step"/"mom" → YES
//   concept "stepson" → title contains "stepson"/"son" → NO
//   concept "threesome" → NO   →  1/3 ≈ 0.33
function relevanceScore(title, groups) {
  if (!groups.length) return 1;
  // Accept both flat arrays (legacy) and arrays-of-arrays (new groups)
  const isGrouped = Array.isArray(groups[0]);
  const normTitle = normalize(title);
  if (isGrouped) {
    const matched = groups.filter(g => g.some(w => normTitle.includes(normalize(w)))).length;
    return matched / groups.length;
  }
  // Legacy flat path
  const matched = groups.filter(w => normTitle.includes(normalize(w))).length;
  return matched / groups.length;
}

// Kept for single-word / general queries where any match counts.
function isRelevant(title, groups) {
  return relevanceScore(title, groups) > 0;
}

// Sort results by relevance score (descending), preserving site-interleave order
// within equal-score groups. For specific queries (2+ concepts) zero-score results
// are dropped. For general/short queries they're kept as a fallback.
function sortByRelevance(results, queryWordsOrGroups) {
  const groups = queryWordsOrGroups;
  const isSpecific = groups.length >= 2;
  const scored = results.map(r => ({ ...r, _score: relevanceScore(r.title, groups) }));
  const filtered = isSpecific ? scored.filter(r => r._score > 0) : scored;
  // Stable sort: higher score first; ties preserve round-robin interleave order
  filtered.sort((a, b) => b._score - a._score);
  return filtered.map(({ _score, ...r }) => r); // strip internal _score field
}

// ── XNXX scraper ─────────────────────────────────────────────────────────────
async function searchXnxx(query, page = 0) {
  // xnxx: use + for spaces (more reliable than %20 in path segments).
  // Try /search/videos/ path first; fall back to ?k= query param.
  const qEncoded = query.trim().replace(/\s+/g, '+');
  const pageSuffix = page > 0 ? `/${page}` : '';
  const primaryUrl = `https://www.xnxx.com/search/videos/${qEncoded}${pageSuffix}`;
  const fallbackUrl = `https://www.xnxx.com/?k=${qEncoded}${page > 0 ? `&p=${page}` : ''}`;
  logger.info(`xnxx search: ${redact(query)} p${page}`);

  const reqHeaders = {
    'User-Agent': HEADERS['User-Agent'],
    'Accept': 'text/html',
    'Accept-Language': 'en-US,en;q=0.9',
    'Cookie': 'age_verified=1; noncache=1',
  };

  async function parseXnxxPage(data, searchUrl) {
    const $ = cheerio.load(data);
    const seen = new Set();
    const results = [];

    // XNXX uses .thumb-block or .mozaique li — try both
    const containers = $('.thumb-block, .mozaique li').toArray();
    // Also try a broader fallback: any <a> pointing to /video-
    const videoAnchors = containers.length === 0
      ? $('a[href^="/video-"]').toArray()
      : [];

    if (containers.length > 0) {
      for (const el of containers) {
        if (results.length >= 20) break;
        const anchor = $(el).find('a[href^="/video-"]').first();
        const href = anchor.attr('href') || '';
        if (!href || seen.has(href)) continue;
        seen.add(href);
        const url = `https://www.xnxx.com${href}`;

        // Title: .thumb-under > p.title, or anchor title attr, or img alt
        const thumbUnder = $(el).find('.thumb-under, p.title').first();
        let title = thumbUnder.text().trim().split('\n')[0].trim()
          .replace(/\s+\d+\s*(min|sec)\s*$/i, '').trim();
        if (!title) title = anchor.attr('title') || $(el).find('img').attr('alt') || '';
        title = title.trim();
        if (!title || title.length < 4) continue;

        const metaText = $(el).find('.metadata, .dur, [class*="duration"]').first().text();
        const durMatch = metaText.match(/(\d+)\s*min/i) || metaText.match(/(\d+:\d+)/);
        let duration = null;
        if (durMatch) {
          duration = durMatch[0].includes(':') ? durMatch[1] : `${parseInt(durMatch[1], 10)}:00`;
        }

        const thumbnail = extractThumbnail($(el).find('img').first(), $, searchUrl);
        results.push({ title: title.length > 80 ? title.slice(0, 77) + '...' : title, url, duration, thumbnail });
      }
    } else {
      // Fallback: deduplicate from direct <a href="/video-"> links
      for (const el of videoAnchors) {
        if (results.length >= 20) break;
        const href = $(el).attr('href') || '';
        if (!href || seen.has(href)) continue;
        seen.add(href);
        const url = `https://www.xnxx.com${href}`;
        const title = ($(el).attr('title') || $(el).find('img').attr('alt') || $(el).text()).trim();
        if (!title || title.length < 4) continue;
        const thumbnail = extractThumbnail($(el).find('img').first(), $, searchUrl);
        results.push({ title: title.length > 80 ? title.slice(0, 77) + '...' : title, url, duration: null, thumbnail });
      }
    }

    return results;
  }

  try {
    const { data } = await axios.get(primaryUrl, { headers: reqHeaders, timeout: 15000 });
    let results = await parseXnxxPage(data, primaryUrl);

    // If primary URL returned nothing, try the ?k= fallback format
    if (results.length === 0) {
      logger.info('xnxx primary URL returned 0 results, trying fallback URL');
      const { data: data2 } = await axios.get(fallbackUrl, { headers: reqHeaders, timeout: 15000 });
      results = await parseXnxxPage(data2, fallbackUrl);
    }

    logger.info(`xnxx search returned ${results.length} results`);
    return results;
  } catch (err) {
    logger.error(`xnxx search failed: ${err.message}`);
    // Try fallback URL on error
    try {
      const { data } = await axios.get(fallbackUrl, { headers: reqHeaders, timeout: 15000 });
      const results = await parseXnxxPage(data, fallbackUrl);
      logger.info(`xnxx fallback returned ${results.length} results`);
      return results;
    } catch (err2) {
      logger.error(`xnxx fallback also failed: ${err2.message}`);
      return [];
    }
  }
}

// ── XXBrits scraper ──────────────────────────────────────────────────────────
async function searchXxbrits(query, page = 0) {
  // xxbrits paginates via AJAX block fetch; from_videos is 1-indexed,
  // so page 0 = from_videos=1, page 1 = from_videos=2.
  const fromVideos = page + 1;
  const searchUrl = fromVideos === 1
    ? `https://www.xxbrits.com/search/${encodeURIComponent(query)}/`
    : `https://www.xxbrits.com/search/${encodeURIComponent(query)}/?mode=async&function=get_block&block_id=list_videos_videos_list_search_result&q=${encodeURIComponent(query)}&from_videos=${fromVideos}`;
  logger.info(`xxbrits search: ${redact(query)} p${page}`);
  try {
    const { data } = await axios.get(searchUrl, {
      headers: {
        'User-Agent': HEADERS['User-Agent'],
        'Accept': 'text/html',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      timeout: 15000,
    });
    const $ = cheerio.load(data);
    const seen = new Set();
    const results = [];

    $('a[href*="/videos/"]').each((_, el) => {
      if (results.length >= 20) return;
      const url = $(el).attr('href') || '';
      if (!url.match(/\/videos\/\d+\//) || seen.has(url)) return;
      const title = ($(el).attr('title') || $(el).find('img').attr('alt') || '').trim();
      if (!title || title.length < 4) return;
      seen.add(url);

      // Walk up looking for a sibling .box span containing duration like "12:34"
      let duration = null;
      let p = $(el);
      for (let i = 0; i < 5; i++) {
        const d = p.find('.box span').first().text().trim();
        if (d && /^\d+:\d+/.test(d)) { duration = d; break; }
        p = p.parent();
      }

      const thumbnail = extractThumbnail($(el).find('img').first(), $, searchUrl);

      results.push({
        title: title.length > 80 ? title.slice(0, 77) + '...' : title,
        url,
        duration,
        thumbnail,
      });
    });

    logger.info(`xxbrits search returned ${results.length} results`);
    return results;
  } catch (err) {
    logger.error(`xxbrits search failed: ${err.message}`);
    return [];
  }
}

// ── FPoxxx scraper ────────────────────────────────────────────────────────────
// fpo.xxx search URL: /search/{query}/
// Pagination: AJAX block fetch with from_videos={n}&from_albums={n} (1-indexed page number)
// Video containers: div.item inside #list_videos_videos_list_search_result_items
// Structure: <div class="item"><a href="https://www.fpo.xxx/video/.../" title="...">
//              <img data-original="..."><span class="duration">MM:SS</span>
//            </a><strong class="title">...</strong></div>
async function searchFpoxxx(query, page = 0) {
  const qEnc = encodeURIComponent(query);
  const fromPage = page + 1; // 1-indexed

  // Page 1: plain search page. Page 2+: AJAX block fetch (same engine as xxbrits)
  const searchUrl = fromPage === 1
    ? `https://www.fpo.xxx/search/${qEnc}/`
    : `https://www.fpo.xxx/search/${qEnc}/?mode=async&function=get_block&block_id=list_videos_videos_list_search_result&q=${qEnc}&from_videos=${fromPage}&from_albums=${fromPage}`;

  logger.info(`fpo.xxx search: ${redact(query)} p${page} → ${fromPage === 1 ? 'html' : 'ajax'}`);

  try {
    const { data } = await axios.get(searchUrl, {
      headers: {
        'User-Agent': HEADERS['User-Agent'],
        'Accept': 'text/html, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cookie': 'age_verified=1',
        ...(fromPage > 1 ? { 'X-Requested-With': 'XMLHttpRequest', 'Referer': `https://www.fpo.xxx/search/${qEnc}/` } : {}),
      },
      timeout: 15000,
    });

    const $ = cheerio.load(data);
    const seen = new Set();
    const results = [];

    // Target the search results container specifically to avoid picking up
    // sidebar / featured / "most recent" blocks that appear on every page.
    // On page 1 the container is #list_videos_videos_list_search_result_items;
    // on AJAX responses the entire payload is just the items fragment.
    const container = $('#list_videos_videos_list_search_result_items');
    const scope = container.length ? container : $.root();

    scope.find('div.item').each((_, el) => {
      if (results.length >= 20) return;
      const anchor = $(el).find('a[href*="/video/"]').first();
      const rawUrl = anchor.attr('href') || '';
      if (!rawUrl || seen.has(rawUrl)) return;

      const url = rawUrl.startsWith('http') ? rawUrl : `https://www.fpo.xxx${rawUrl}`;
      seen.add(rawUrl);

      // Title: prefer anchor title attr (already clean), fall back to <strong class="title">
      const title = (
        anchor.attr('title') ||
        $(el).find('strong.title, .title').first().text() ||
        $(el).find('img').first().attr('alt') || ''
      ).replace(/\s+/g, ' ').trim();
      if (!title || title.length < 4) return;

      const duration = $(el).find('span.duration').first().text().trim() || null;
      const thumbnail = extractThumbnail($(el).find('img').first(), $, searchUrl);

      results.push({
        title: title.length > 80 ? title.slice(0, 77) + '...' : title,
        url,
        duration,
        thumbnail,
      });
    });

    logger.info(`fpoxxx search returned ${results.length} results`);
    return results;
  } catch (err) {
    logger.error(`fpoxxx search failed: ${err.message}`);
    return [];
  }
}

// ── FreePornVideos scraper ─────────────────────────────────────────────────────
async function searchFreepornvideos(query, page = 0) {
  // Page 0 = no page param, page 1+ = &page=N (1-indexed so page+1)
  const pageParam = page > 0 ? `&page=${page + 1}` : '';
  const searchUrl = `https://www.freepornvideos.xxx/search/?q=${encodeURIComponent(query)}${pageParam}`;
  logger.info(`freepornvideos search: ${redact(query)} p${page}`);
  try {
    const { data } = await axios.get(searchUrl, {
      headers: {
        'User-Agent': HEADERS['User-Agent'],
        'Accept': 'text/html',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      timeout: 15000,
    });
    const $ = cheerio.load(data);
    const seen = new Set();
    const results = [];

    $('.item').each((_, el) => {
      if (results.length >= 20) return;
      const anchor = $(el).find('a[href]').first();
      const rawUrl = anchor.attr('href') || '';
      if (!rawUrl || seen.has(rawUrl)) return;
      // Only video pages (contain a slug path, not category/search/lang pages)
      if (!rawUrl.includes('freepornvideos.xxx/') || rawUrl.includes('/search/') || rawUrl.includes('/category/') || /\/[a-z]{2}\//.test(rawUrl)) return;
      seen.add(rawUrl);
      const url = rawUrl.startsWith('http') ? rawUrl : `https://www.freepornvideos.xxx${rawUrl}`;

      const title = (
        $(el).find('.thumb_title').first().text().trim() ||
        anchor.attr('title') ||
        $(el).find('img').first().attr('alt') || ''
      ).replace(/\s+/g, ' ').trim();
      if (!title || title.length < 4) return;

      const durText = $(el).find('.duration').first().text().trim();
      const thumbnail = extractThumbnail($(el).find('img').first(), $, searchUrl);

      results.push({
        title: title.length > 80 ? title.slice(0, 77) + '...' : title,
        url,
        duration: durText || null,
        thumbnail,
      });
    });

    logger.info(`freepornvideos search returned ${results.length} results`);
    return results;
  } catch (err) {
    logger.error(`freepornvideos search failed: ${err.message}`);
    return [];
  }
}

// ── Duration helpers ──────────────────────────────────────────────────────────
// Parse "MM:SS", "H:MM:SS", or bare number (minutes) into total seconds.
function parseDurSecs(dur) {
  if (!dur) return 0;
  const s = dur.trim();
  const parts = s.split(':').map(p => parseInt(p, 10));
  if (parts.some(isNaN)) return 0;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0] * 60; // bare number treated as minutes
}

// Normalize title for duplicate detection: lowercase, strip non-alphanumeric.
function normTitle(t) {
  return t.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 40);
}

// Deduplicate combined results: where two entries have nearly identical titles,
// keep the one with the longer duration (prefer the better version across sites).
function dedupByDuration(results) {
  const titleMap = new Map(); // normKey → index in output array
  const output = [];

  for (const r of results) {
    const key = normTitle(r.title);
    if (!key || key.length < 8) { output.push(r); continue; }

    const existingIdx = titleMap.get(key);
    if (existingIdx === undefined) {
      titleMap.set(key, output.length);
      output.push(r);
    } else {
      const existing = output[existingIdx];
      const newSecs = parseDurSecs(r.duration);
      const oldSecs = parseDurSecs(existing.duration);
      if (newSecs > oldSecs) {
        output[existingIdx] = { ...r };
        logger.info(`Dedup(title): replaced "${existing.title}" (${existing.duration}/${existing.source}) with longer "${r.title}" (${r.duration}/${r.source})`);
      }
    }
  }

  return output;
}

// Secondary dedup pass: if two results share the exact same thumbnail path
// (same CDN image = same video clip), keep only the longer-duration one.
// Uses the URL pathname so query-string variations don't fool it.
function dedupByThumbnail(results) {
  const thumbMap = new Map(); // normPath → index in output array
  const output = [];

  for (const r of results) {
    if (!r.thumbnail) { output.push(r); continue; }
    let normPath;
    try { normPath = new URL(r.thumbnail).pathname; } catch { normPath = r.thumbnail; }

    const existingIdx = thumbMap.get(normPath);
    if (existingIdx === undefined) {
      thumbMap.set(normPath, output.length);
      output.push(r);
    } else {
      const existing = output[existingIdx];
      const newSecs = parseDurSecs(r.duration);
      const oldSecs = parseDurSecs(existing.duration);
      if (newSecs > oldSecs) {
        output[existingIdx] = { ...r };
        logger.info(`Dedup(thumb): replaced "${existing.title}" (${existing.duration}/${existing.source}) with longer "${r.title}" (${r.duration}/${r.source})`);
      }
    }
  }

  return output;
}

// ── Public search entry point ─────────────────────────────────────────────────
// Searches all sites in parallel and interleaves results. `page` is 0-indexed.
// Pass `source` to restrict to one site.
export async function searchVideos(_searchUrlTemplate, query, page = 0, source = null) {
  // Single-source mode
  if (source && source !== 'all') {
    const scrapers = {
      pornhub: searchPornhub, xvideos: searchXvideos, xnxx: searchXnxx,
      xxbrits: searchXxbrits, fpoxxx: searchFpoxxx, freepornvideos: searchFreepornvideos,
    };
    const fn = scrapers[source];
    if (fn) {
      const results = await fn(query, page).catch(e => { logger.warn(`${source} failed: ${e.message}`); return []; });
      const words = queryGroups(query);
      const tagged = results.map(r => ({ ...r, source }));
      logger.info(`Single-source "${source}" search ${redact(query)} p${page}: ${results.length} results`);
      return sortByRelevance(tagged, words);
    }
  }

  const [ph, xv, xn, xb, fp, fpv] = await Promise.all([
    searchPornhub(query, page).catch(e => { logger.warn(`pornhub failed: ${e.message}`); return []; }),
    searchXvideos(query, page).catch(e => { logger.warn(`xvideos failed: ${e.message}`); return []; }),
    searchXnxx(query, page).catch(e => { logger.warn(`xnxx failed: ${e.message}`); return []; }),
    searchXxbrits(query, page).catch(e => { logger.warn(`xxbrits failed: ${e.message}`); return []; }),
    searchFpoxxx(query, page).catch(e => { logger.warn(`fpoxxx failed: ${e.message}`); return []; }),
    searchFreepornvideos(query, page).catch(e => { logger.warn(`freepornvideos failed: ${e.message}`); return []; }),
  ]);

  // Tag each result with its source
  const tag = (arr, src) => arr.map(r => ({ ...r, source: src }));
  const tagged = [
    tag(ph, 'pornhub'), tag(xv, 'xvideos'), tag(xn, 'xnxx'),
    tag(xb, 'xxbrits'), tag(fp, 'fpoxxx'), tag(fpv, 'freepornvideos'),
  ];

  // Round-robin interleave so results from all sites appear on every page
  const interleaved = [];
  const seen = new Set();
  let added = true;
  for (let i = 0; added; i++) {
    added = false;
    for (const list of tagged) {
      if (i < list.length) {
        const r = list[i];
        if (!seen.has(r.url)) { seen.add(r.url); interleaved.push(r); }
        added = true;
      }
    }
  }

  // Deduplicate: by title first, then by thumbnail (same image = same clip across sites)
  const deduped = dedupByThumbnail(dedupByDuration(interleaved));

  // Score and sort: higher relevance first, zero-matches dropped for specific queries
  const words = queryGroups(query);
  const final = sortByRelevance(deduped, words);

  logger.info(`Combined search ${redact(query)} p${page}: ph=${ph.length} xv=${xv.length} xn=${xn.length} xb=${xb.length} fp=${fp.length} fpv=${fpv.length} → ${final.length} (after dedup+score)`);
  return final;
}

// ── Trending videos (PH most viewed this week) ────────────────────────────────
export async function getTrending() {
  try {
    const apiUrl = `https://www.pornhub.com/webmasters/search?search_term=&page=1&per_page=32&ordering=mostviewed&period=weekly`;
    const res = await axios.get(apiUrl, {
      headers: { 'Accept': 'application/json', 'User-Agent': HEADERS['User-Agent'] },
      timeout: 15000,
    });
    const videos = (typeof res.data === 'object' && Array.isArray(res.data.videos)) ? res.data.videos : [];
    logger.info(`Trending: ${videos.length} videos from PH`);
    return videos.filter(v => v.url && v.title).map(v => {
      let duration = null;
      if (v.duration) {
        if (typeof v.duration === 'string' && v.duration.includes(':')) {
          duration = v.duration;
        } else {
          const secs = parseInt(v.duration, 10);
          if (!isNaN(secs) && secs > 0) {
            duration = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
          }
        }
      }
      const thumb = v.defaultThumb?.src || (Array.isArray(v.thumbs) && v.thumbs[0]?.src) || null;
      return {
        title: v.title.length > 80 ? v.title.slice(0, 77) + '...' : v.title,
        url: v.url,
        duration,
        thumbnail: thumb && !thumb.startsWith('data:') ? thumb : null,
        source: 'pornhub',
      };
    });
  } catch (err) {
    logger.warn(`getTrending failed: ${err.message}`);
    return [];
  }
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
  logger.info(`Fetching video page: ${redactUrl(videoPageUrl)}`);
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
          const qualityOrder = ['1080', '720', '480', '360', '240'];
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
      const qualityOrder = ['1080', '720', '480', '360', '240'];
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
        logger.info(`HLS fallback ${hlsDefs[0].quality}: ${redactUrl(url)}`);
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

  // 4b. xxbrits / kt_player style — fields are `video_url` (480p) / `video_alt_url` (720p)
  // (with required `?v-acctoken=...` signing token).
  // Prefer 480p — Discord refuses to inline-play videos above ~25MB, and 720p commonly exceeds that.
  // The trailing `/?v-acctoken=...` MUST be kept or the CDN returns 403.
  const ktMatch = allScripts.match(/video_url\s*:\s*['"]([^'"]+\.mp4\/?\?[^'"]+)['"]/);
  if (ktMatch) {
    logger.info('Found kt_player video_url (480p)');
    return { url: ktMatch[1], isHls: false, cookies: sessionCookies };
  }
  const ktAltMatch = allScripts.match(/video_alt_url\s*:\s*['"]([^'"]+\.mp4\/?\?[^'"]+)['"]/);
  if (ktAltMatch) {
    logger.info('Found kt_player video_alt_url (HD fallback)');
    return { url: ktAltMatch[1], isHls: false, cookies: sessionCookies };
  }

  // 5. xvideos direct MP4 via html5player.setVideoUrlHigh / setVideoUrlLow
  const xvMp4Match = allScripts.match(/html5player\.setVideoUrl(?:High|Low)\s*\(\s*['"]([^'"]+)['"]\s*\)/i);
  if (xvMp4Match) {
    const mp4Url = unescapeUrl(xvMp4Match[1]);
    const resolved = resolveUrl(mp4Url, videoPageUrl);
    if (resolved) {
      logger.info(`Found xvideos direct MP4 URL: ${redactUrl(resolved)}`);
      return { url: resolved, isHls: false, cookies: sessionCookies };
    }
  }

  // 5b. xvideos HLS via html5player.setVideoHLS(...) — only if no direct MP4
  const xvHlsMatch = allScripts.match(/html5player\.setVideoHLS\s*\(\s*['"]([^'"]+)['"]\s*\)/i);
  if (xvHlsMatch) {
    const hlsUrl = unescapeUrl(xvHlsMatch[1]);
    logger.info(`Found xvideos HLS URL: ${redactUrl(hlsUrl)}`);
    return { url: hlsUrl, isHls: true, cookies: sessionCookies };
  }

  // 6. Plain .mp4 URLs in scripts
  const plainMp4 = /https?:\/\/[^\s"'<>\\]+\.mp4/gi;
  for (const match of (allScripts.match(plainMp4) || [])) {
    if (isThumbnailUrl(match)) continue;
    // xxbrits get_file URLs without a v-acctoken always 403. Skip them so the
    // caller falls through to yt-dlp instead of returning a broken stream.
    if (/xxbrits\.com\/get_file/i.test(match) && !/v-acctoken/i.test(match)) {
      logger.warn('Skipping xxbrits .mp4 without v-acctoken (would 403)');
      continue;
    }
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
        const targetDuration = Math.min(duration, 300);
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

// ── yt-dlp URL extraction (no download) ──────────────────────────────────────
// Returns a direct MP4 CDN URL that can be proxied with range support.
// Returns null if yt-dlp can't find one.
export async function getDirectMp4Url(videoPageUrl, cookies = '') {
  const cookieStr = cookies || HEADERS.Cookie;
  const args = [
    '--impersonate', 'chrome',
    '--get-url',
    '-f', 'best[ext=mp4][height<=480]/best[ext=mp4]/best[height<=480]/best',
    '--no-playlist',
    '--add-header', `Referer:${videoPageUrl}`,
    '--add-header', `Cookie:${cookieStr}`,
    videoPageUrl
  ];
  logger.info('Extracting direct URL via yt-dlp...');
  try {
    const { stdout } = await execFileAsync(YTDLP_BIN, args, { timeout: 11000 });
    const url = stdout.trim().split('\n')[0].trim();
    if (url && url.startsWith('http') && !url.includes('.m3u8')) {
      logger.info(`yt-dlp direct URL: ${url.slice(0, 80)}`);
      return url;
    }
    logger.warn('yt-dlp returned no usable direct URL');
  } catch (err) {
    logger.warn('yt-dlp URL extraction failed:', (err.stderr || err.message || '').slice(0, 200));
  }
  return null;
}
