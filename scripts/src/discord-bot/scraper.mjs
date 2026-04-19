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

export async function searchVideos(searchUrlTemplate, query) {
  const url = searchUrlTemplate.replace('{query}', encodeURIComponent(query));
  console.log('Fetching:', url);

  const { data } = await axios.get(url, { headers: HEADERS, timeout: 15000 });
  const $ = cheerio.load(data);

  const results = [];
  const seenHrefs = new Set();

  // Patterns that typically indicate a single video page URL
  const videoPathPattern = /\/(video|watch|v|embed|clip|view)[\/-]|\/\d{5,}/i;

  // Patterns to skip
  const skipPattern = /(login|signup|register|cdn\.|\.jpg|\.png|\.gif|\.webp|\/search|\/tag|\/category|\/channel|\/user|\/profile|javascript:|mailto:|#)/i;

  $('a[href]').each((i, el) => {
    if (results.length >= 10) return;

    const href = $(el).attr('href');
    if (!href || seenHrefs.has(href)) return;
    if (skipPattern.test(href)) return;
    if (!videoPathPattern.test(href)) return;

    const fullUrl = resolveUrl(href, url);
    if (!fullUrl) return;

    const title = getTitle(el, $);
    if (!title) return;

    seenHrefs.add(href);
    results.push({
      title: title.length > 80 ? title.slice(0, 77) + '...' : title,
      url: fullUrl
    });
  });

  // If strict matching found nothing, fall back to a wider net
  if (results.length === 0) {
    console.log('Strict match found nothing — trying wider search');
    $('a[href]').each((i, el) => {
      if (results.length >= 10) return;

      const href = $(el).attr('href');
      if (!href || seenHrefs.has(href)) return;
      if (skipPattern.test(href)) return;

      // Must be an absolute or root-relative path with some depth
      if (!href.startsWith('/') && !href.startsWith('http')) return;
      if (href === '/' || href.split('/').filter(Boolean).length < 2) return;

      const fullUrl = resolveUrl(href, url);
      if (!fullUrl) return;

      const title = getTitle(el, $);
      if (!title || title.length < 5) return;

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
