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

app.get('/scrape', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'url required' });

  let browser;
  const timer = setTimeout(async () => {
    if (browser) await browser.close().catch(() => {});
    if (!res.headersSent) res.status(504).json({ error: 'timeout', urls: [] });
  }, 15000);

  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 12000 });
    await page.waitForTimeout(4000);

    const urls = new Set();

    const iframeSrcs = await page.evaluate(() =>
      [...document.querySelectorAll('iframe')].map(f => f.getAttribute('src') || f.getAttribute('data-src') || '')
    );
    for (const src of iframeSrcs) {
      if (src && PLAYER_DOMAINS.some(d => src.includes(d))) urls.add(src);
    }

    if (!urls.size) {
      const html = await page.content();
      for (const u of extractFromHtml(html)) urls.add(u);
    }

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
