const express = require('express');
const cors = require('cors');
const { chromium } = require('playwright');

const app = express();
app.use(cors());

const PORT = process.env.PORT || 3000;

const PLAYER_DOMAINS = [
  'streamtape', 'dood', 'filemoon', 'voe', 'streamz',
  'jawcloud', 'streamwish', 'links.cuevana.ac', 'player.cuevana.ac',
];

const PLAYER_REGEX = /['"](https?:\/\/(?:(?:streamtape|dood|filemoon|voe|streamz|jawcloud|streamwish|links\.cuevana\.ac|player\.cuevana\.ac)[^'"<>\s]+))['"]/gi;

function extractFromHtml(html) {
  const urls = new Set();
  for (const m of html.matchAll(PLAYER_REGEX)) urls.add(m[1]);
  return [...urls];
}

const langOrder = u => /[#&]lang=LAT/i.test(u) ? 0 : /[#&]lang=VOS/i.test(u) ? 1 : /[#&]lang=SUB/i.test(u) ? 2 : 3;

async function tryClickEpisode(page, season, episode) {
  const s = parseInt(season);
  const e = parseInt(episode);
  const ePad = String(e).padStart(2, '0');
  const sPad = String(s).padStart(2, '0');

  const selectors = [
    `a[href*="${s}x${e}"]:not([href*="${s}x${e}0"])`,
    `a[href*="${s}x${ePad}"]`,
    `a[href*="s${sPad}e${ePad}"]`,
    `a[href*="temporada/${s}/episodio/${e}"]`,
    `a[href*="temporada-${s}"][href*="episodio-${e}"]`,
    `a[href*="temporada-${s}"][href*="episodio-0${e}"]`,
    `a[href*="capitulo-${e}"]`,
  ];

  for (const sel of selectors) {
    try {
      const el = await page.$(sel);
      if (el) {
        const href = await el.getAttribute('href');
        console.log(`[ep-nav] clicking: ${href}`);
        await el.click();
        await page.waitForTimeout(3000);
        return true;
      }
    } catch {}
  }
  return false;
}

app.get('/scrape', async (req, res) => {
  const { url, season, episode, searchUrl, sectionFilter } = req.query;
  if (!url && !searchUrl) return res.status(400).json({ error: 'url or searchUrl required' });

  let browser;
  const timeoutMs = searchUrl ? 30000 : 15000;
  const timer = setTimeout(async () => {
    if (browser) await browser.close().catch(() => {});
    if (!res.headersSent) res.status(504).json({ error: 'timeout', urls: [] });
  }, timeoutMs);

  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
    });
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      locale: 'es-AR',
      extraHTTPHeaders: {
        'Accept-Language': 'es-AR,es;q=0.9,en;q=0.8',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });
    const page = await context.newPage();
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    let targetUrl = url;

    if (searchUrl) {
      console.log(`[search] navigating to: ${searchUrl}`);
      await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 12000 });
      await page.waitForTimeout(3000);

      const filter    = sectionFilter || '';
      const titleSlug = (req.query.titleSlug || '').toLowerCase();
      const slugWords = titleSlug.split('-').filter(w => w.length > 2);

      const foundLink = await page.evaluate((f, words) => {
        const links = [...document.querySelectorAll('a[href]')]
          .filter(a => f ? a.href.includes(f) : true);

        if (!words.length) return links[0]?.href || null;

        // Score each link by how many title words appear in its URL
        let best = null, bestScore = 0;
        for (const a of links) {
          const href = a.href.toLowerCase();
          const score = words.filter(w => href.includes(w)).length;
          if (score > bestScore) { bestScore = score; best = a.href; }
        }
        // Require at least 1 word match to avoid returning a wrong movie
        return bestScore > 0 ? best : null;
      }, filter, slugWords);

      if (!foundLink) {
        console.warn(`[search] no matching link for slug: ${titleSlug}`);
        clearTimeout(timer);
        await browser.close();
        return res.json({ urls: [] });
      }

      targetUrl = foundLink;
      console.log(`[search] found page: ${targetUrl}`);
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 12000 });
    } else {
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 12000 });
    }

    if (season && episode) {
      await page.waitForTimeout(2000);
      await tryClickEpisode(page, season, episode);
    }

    await page.waitForTimeout(4000);

    const urls = new Set();

    const iframeSrcs = await page.evaluate(() =>
      [...document.querySelectorAll('iframe')].map(f => f.getAttribute('src') || f.getAttribute('data-src') || '')
    );
    const AD_BLACKLIST = /google\.com|facebook\.com|disqus\.com|doubleclick|googlesyndication|twitter\.com|amazon-adsystem|googletagmanager|recaptcha/i;
    for (const src of iframeSrcs) {
      if (src && /^https?:\/\//i.test(src) && !AD_BLACKLIST.test(src)) urls.add(src);
    }

    const html = await page.content();
    for (const u of extractFromHtml(html)) urls.add(u);

    clearTimeout(timer);
    await browser.close();

    const sorted = [...urls].sort((a, b) => langOrder(a) - langOrder(b));
    res.json({ urls: sorted });
  } catch (err) {
    clearTimeout(timer);
    if (browser) await browser.close().catch(() => {});
    if (!res.headersSent) res.status(500).json({ error: err.message, urls: [] });
  }
});

app.listen(PORT, () => console.log(`Scraper server on port ${PORT}`));
