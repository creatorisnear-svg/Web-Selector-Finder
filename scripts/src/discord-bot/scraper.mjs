import axios from 'axios';
import * as cheerio from 'cheerio';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
  'Cookie': 'age_verified=1; ageGate=true; confirm=1'
};

export async function searchVideos(searchUrlTemplate, query) {
  const url = searchUrlTemplate.replace('{query}', encodeURIComponent(query));

  const { data } = await axios.get(url, { headers: HEADERS });
  const $ = cheerio.load(data);

  const results = [];
  const seen = new Set();

  // Try to find video links — works across many video sites
  $('a[href]').each((i, el) => {
    if (results.length >= 10) return;

    const href = $(el).attr('href');
    if (!href || seen.has(href)) return;

    const lowerHref = href.toLowerCase();
    // Only keep links that look like individual video pages
    if (
      !lowerHref.includes('/video') &&
      !lowerHref.includes('/watch') &&
      !lowerHref.includes('/v/') &&
      !lowerHref.match(/\/\d{5,}/)
    ) return;

    // Skip obvious non-video links
    if (
      lowerHref.includes('search') ||
      lowerHref.includes('login') ||
      lowerHref.includes('signup') ||
      lowerHref.includes('cdn') ||
      lowerHref.includes('static') ||
      lowerHref.includes('.jpg') ||
      lowerHref.includes('.png')
    ) return;

    // Get title from various sources
    let title =
      $(el).attr('title') ||
      $(el).find('img').attr('alt') ||
      $(el).find('[class*="title"]').text().trim() ||
      $(el).text().trim();

    title = title.replace(/\s+/g, ' ').trim();
    if (!title || title.length < 3) return;
    if (title.length > 80) title = title.slice(0, 77) + '...';

    // Build absolute URL
    let fullUrl = href;
    if (href.startsWith('/')) {
      const base = new URL(url);
      fullUrl = `${base.protocol}//${base.host}${href}`;
    } else if (!href.startsWith('http')) {
      return;
    }

    seen.add(href);
    results.push({ title, url: fullUrl });
  });

  return results;
}
