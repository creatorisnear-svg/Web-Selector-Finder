import axios from 'axios';
import * as cheerio from 'cheerio';

async function findSelectors() {
  const url = 'PASTE_YOUR_URL_HERE';

  const { data } = await axios.get(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36'
    }
  });

  const $ = cheerio.load(data);

  $('div[class], li[class], article[class]').each((i, el) => {
    if (i > 50) return;
    const className = $(el).attr('class');
    const text = $(el).text().trim().slice(0, 50);
    console.log(`[${i}] .${className.split(' ')[0]} => "${text}"`);
  });
}

findSelectors();
