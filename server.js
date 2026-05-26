const express = require('express');
const cors = require('cors');
const { chromium } = require('playwright');

const app = express();
app.use(cors());

const PORT = process.env.PORT || 3000;

const PLAYER_DOMAINS = [
  'streamtape', 'filemoon', 'voe',
  'vidfast', 'mp4upload', 'uqload', 'upstream',
  'fembed', 'vidbom', 'embed.su',
  'ok.ru', 'vidlox', 'netu',
  'videobin', 'vidmoly', 'vudeo', 'wishfast', 'streamvid',
  'video.cuevana.cz',
];

const INNER_PLAYER_DOMAINS = PLAYER_DOMAINS.filter(d => d !== 'video.cuevana.cz');

const PLAYER_REGEX = /['"](https?:\/\/(?:(?:streamtape|filemoon|voe|vidfast|mp4upload|uqload|upstream|fembed|vidbom|embed\.su|ok\.ru|vidlox|netu|videobin|vidmoly|vudeo|wishfast|streamvid|video\.cuevana\.cz)[^'"<>\s]+))['"]/gi;

function extractFromHtml(html) {
  const urls = new Set();
  for (const m of html.matchAll(PLAYER_REGEX)) urls.add(m[1]);
  return [...urls];
}

const langOrder = u => /[#&]lang=LAT/i.test(u) ? 0 : /[#&]lang=VOS/i.test(u) ? 1 : /[#&]lang=SUB/i.test(u) ? 2 : 3;

// ─── SHARED BROWSER ────────────────────────────────────────────────────────
// Reuse a single Chromium process across requests to avoid Railway resource limits.
let sharedBrowser = null;

async function getSharedBrowser() {
  if (sharedBrowser?.isConnected()) return sharedBrowser;
  sharedBrowser = await chromium.launch({
    headless: true,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-zygote',
      '--disable-extensions',
      '--disable-background-networking',
    ],
  });
  sharedBrowser.on('disconnected', () => { sharedBrowser = null; });
  return sharedBrowser;
}

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

  let context;
  const timeoutMs = 60000;
  const timer = setTimeout(async () => {
    if (context) await context.close().catch(() => {});
    if (!res.headersSent) res.status(504).json({ error: 'timeout', urls: [] });
  }, timeoutMs);

  try {
    const browser = await getSharedBrowser();
    context = await browser.newContext({
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

    // Set up network interceptor BEFORE any navigation so we capture everything
    const networkUrls = new Set();
    page.on('response', async (response) => {
      try {
        const resUrl = response.url();
        if (INNER_PLAYER_DOMAINS.some(d => resUrl.includes(d))) {
          networkUrls.add(resUrl);
          return;
        }
        const ct = response.headers()['content-type'] || '';
        if (ct.includes('json') || ct.includes('text/html') || ct.includes('text/plain')) {
          const text = await response.text().catch(() => '');
          for (const m of text.matchAll(PLAYER_REGEX)) {
            const u = m[1];
            if (!/\.js(\?|$)/.test(u) && !/\.css(\?|$)/.test(u)) networkUrls.add(u);
          }
        }
      } catch {}
    });

    let targetUrl = url;

    if (searchUrl) {
      console.log(`[search] navigating to: ${searchUrl}`);
      await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForFunction(
        () => !document.title.toLowerCase().includes('just a moment'),
        { timeout: 15000 }
      ).catch(() => {});
      const resultSelector = sectionFilter
        ? `a[href*="${sectionFilter}"]`
        : 'a[href*="/pelicula/"], a[href*="/serie/"]';
      await page.waitForSelector(resultSelector, { timeout: 8000 }).catch(() => {});
      await page.waitForTimeout(500);

      const filter    = sectionFilter || '';
      const titleSlug = (req.query.titleSlug || '').toLowerCase();
      const slugWords = titleSlug.split('-').filter(w => w.length > 2);

      const foundLink = await page.evaluate(({ f, words }) => {
        const links = [...document.querySelectorAll('a[href]')]
          .filter(a => f ? a.href.includes(f) : true);
        if (!words.length) return links[0]?.href || null;
        let best = null, bestScore = 0;
        for (const a of links) {
          const href = a.href.toLowerCase();
          const score = words.filter(w => href.includes(w)).length;
          if (score > bestScore) { bestScore = score; best = a.href; }
        }
        return bestScore > 0 ? best : null;
      }, { f: filter, words: slugWords });

      if (!foundLink) {
        console.warn(`[search] no matching link for slug: ${titleSlug}`);
        clearTimeout(timer);
        await context.close();
        return res.json({ urls: [] });
      }

      targetUrl = foundLink;
      if (season && episode && /\/serie\//.test(targetUrl)) {
        targetUrl = targetUrl.replace(/\/+$/, '') + `/${season}/${episode}/`;
        console.log(`[search] episode URL: ${targetUrl}`);
      } else {
        console.log(`[search] found page: ${targetUrl}`);
      }
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    } else {
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    }

    await page.waitForFunction(
      () => !document.title.toLowerCase().includes('just a moment'),
      { timeout: 20000 }
    ).catch(() => {});

    await page.waitForSelector('[data-server], iframe[src]', { timeout: 6000 }).catch(() => {});

    if (season && episode) {
      await page.waitForTimeout(1000);
      await tryClickEpisode(page, season, episode);
    }

    await page.waitForTimeout(1500);

    const urls = new Set();

    const getIframeSrcs = () => page.evaluate(() =>
      [...document.querySelectorAll('iframe')].map(f => f.getAttribute('src') || f.getAttribute('data-src') || '')
    );

    let iframeSrcs = await getIframeSrcs();
    for (const src of iframeSrcs) {
      if (src && PLAYER_DOMAINS.some(d => src.includes(d))) urls.add(src);
    }

    const cuevanaServerEls = await page.$$('[data-server*="video.cuevana.cz"]');
    if (cuevanaServerEls.length > 0) {
      const toClick = cuevanaServerEls.slice(0, 3);
      console.log(`[cuevana] clicking ${toClick.length}/${cuevanaServerEls.length} server button(s)`);
      for (const el of toClick) {
        try {
          await el.click();
          await page.waitForTimeout(2500);
        } catch {}
        const innerFound = [...networkUrls].some(u => INNER_PLAYER_DOMAINS.some(d => u.includes(d)));
        if (innerFound) break;
      }
    } else {
      const dataServers = await page.evaluate(() =>
        [...document.querySelectorAll('[data-server]')].map(el => el.getAttribute('data-server') || '')
      );
      for (const src of dataServers) {
        if (!src || !PLAYER_DOMAINS.some(d => src.includes(d))) continue;
        urls.add(src);
      }
    }

    if (!urls.size) {
      await page.waitForFunction((domains) => {
        return [...document.querySelectorAll('iframe')].some(f => {
          const src = f.getAttribute('src') || '';
          return domains.some(d => src.includes(d));
        });
      }, PLAYER_DOMAINS, { timeout: 5000 }).catch(() => {});

      iframeSrcs = await getIframeSrcs();
      for (const src of iframeSrcs) {
        if (src && PLAYER_DOMAINS.some(d => src.includes(d))) urls.add(src);
      }
    }

    const innerNetworkUrls = [...networkUrls].filter(u => INNER_PLAYER_DOMAINS.some(d => u.includes(d)));
    const cuevanaNetworkUrls = [...networkUrls].filter(u => u.includes('video.cuevana.cz'));
    for (const u of (innerNetworkUrls.length ? innerNetworkUrls : cuevanaNetworkUrls)) urls.add(u);

    if (!urls.size) {
      const html = await page.content();
      for (const u of extractFromHtml(html)) {
        if (!/\.js(\?|$)/.test(u) && !/\.css(\?|$)/.test(u)) urls.add(u);
      }
    }

    console.log(`[scrape] done: ${urls.size} URL(s) for ${targetUrl}`);
    clearTimeout(timer);
    await context.close();

    const sorted = [...urls].sort((a, b) => langOrder(a) - langOrder(b));
    res.json({ urls: sorted });
  } catch (err) {
    clearTimeout(timer);
    if (context) await context.close().catch(() => {});
    if (!res.headersSent) res.status(500).json({ error: err.message, urls: [] });
  }
});

app.listen(PORT, () => console.log(`Scraper server on port ${PORT}`));
