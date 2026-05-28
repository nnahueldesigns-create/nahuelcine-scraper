const express = require('express');
const cors = require('cors');
const { chromium } = require('playwright');

const app = express();
app.use(cors());
app.use((req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });

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

const langOrder = u => /[?#&]lang=LAT/i.test(u) ? 0 : /[?#&]lang=VOS/i.test(u) ? 1 : /[?#&]lang=SUB/i.test(u) ? 2 : 3;
function langFromUrl(u) {
  if (/[?#&]lang=LAT/i.test(u)) return 'LAT';
  if (/[?#&]lang=VOS/i.test(u)) return 'VOS';
  if (/[?#&]lang=SUB/i.test(u)) return 'SUB';
  return null;
}

// ─── STEALTH HEADERS ───────────────────────────────────────────────────────
const STEALTH_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const STEALTH_HEADERS = {
  'User-Agent': STEALTH_UA,
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'es-AR,es;q=0.9,en-US;q=0.8,en;q=0.7',
  'sec-ch-ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
};

// ─── HTTP FAST PATH ────────────────────────────────────────────────────────
// Try plain HTTP before Playwright. Avoids CF overhead when player URLs are
// embedded in the initial HTML (script tags, data attributes, JSON config).
async function tryHttpFetch(url) {
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 8000);
    const origin = new URL(url).origin;
    const res = await fetch(url, {
      headers: { ...STEALTH_HEADERS, 'Referer': origin + '/' },
      signal: controller.signal,
    });
    clearTimeout(t);
    if (!res.ok) return [];
    const html = await res.text();
    // CF challenge pages are short; skip them
    if (html.length < 2000 || html.toLowerCase().includes('just a moment')) return [];
    return extractFromHtml(html);
  } catch {
    return [];
  }
}

// ─── CONCURRENCY QUEUE ─────────────────────────────────────────────────────
// 2 concurrent Playwright contexts (each ~150MB; shared browser keeps overhead low)
const MAX_CONCURRENT = 2;
let _running = 0;
const _queue = [];
function enqueue(fn) {
  return new Promise((resolve, reject) => {
    _queue.push({ fn, resolve, reject });
    drainQueue();
  });
}
function drainQueue() {
  while (_running < MAX_CONCURRENT && _queue.length) {
    _running++;
    const { fn, resolve, reject } = _queue.shift();
    (async () => {
      try { resolve(await fn()); } catch (e) { reject(e); }
      finally { _running--; drainQueue(); }
    })();
  }
}

// ─── SHARED BROWSER ────────────────────────────────────────────────────────
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
  const { url, season, episode, searchUrl, sectionFilter, year } = req.query;
  const streamMode = req.query.stream === '1';
  if (!url && !searchUrl) return res.status(400).json({ error: 'url or searchUrl required' });

  // ─── HTTP FAST PATH ────────────────────────────────────────────────────
  // Only for direct URL requests (not search). Fast, no Playwright overhead.
  if (url && !searchUrl) {
    const fastUrls = await tryHttpFetch(url);
    if (fastUrls.length) {
      console.log(`[http-fast] ${fastUrls.length} URL(s) from ${url}`);
      const sortedFast = fastUrls.sort((a, b) => langOrder(a) - langOrder(b));
      if (streamMode) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        for (const u of sortedFast) res.write(`data: ${JSON.stringify({ url: u, lang: langFromUrl(u) })}\n\n`);
        res.write('event: done\ndata: {}\n\n');
        return res.end();
      }
      return res.json({ urls: sortedFast, languages: sortedFast.map(langFromUrl) });
    }
  }

  // Set SSE headers before entering queue so client can start receiving
  if (streamMode) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
  }

  let clientGone = false;
  req.on('close', () => { clientGone = true; });

  let context;
  const urls = new Set();
  const urlLangs = new Map();
  const LANG_CODES = { 'Latino': 'LAT', 'Castellano': 'ESP', 'Subtitulado': 'SUB' };

  const sendSse = (u, lang) => {
    if (streamMode && !res.writableEnded) res.write(`data: ${JSON.stringify({ url: u, lang })}\n\n`);
  };
  const doneSse = () => {
    if (streamMode && !res.writableEnded) { res.write('event: done\ndata: {}\n\n'); res.end(); }
  };

  const timeoutMs = 55000;
  const timer = setTimeout(async () => {
    if (context) await context.close().catch(() => {});
    if (streamMode) { doneSse(); return; }
    if (!res.headersSent) {
      const collected = [...urls];
      if (collected.length > 0) {
        const sorted = collected.sort((a, b) => langOrder(a) - langOrder(b));
        const languages = sorted.map(u => urlLangs.get(u) || langFromUrl(u) || 'LAT');
        console.log(`[timeout] returning ${collected.length} partial URL(s)`);
        res.json({ urls: sorted, languages });
      } else {
        res.status(504).json({ error: 'timeout', urls: [] });
      }
    }
  }, timeoutMs);

  enqueue(async () => { try {
    if (clientGone) { clearTimeout(timer); if (!res.headersSent) res.json({ urls: [] }); return; }
    const browser = await getSharedBrowser();
    context = await browser.newContext({
      userAgent: STEALTH_UA,
      locale: 'es-AR',
      viewport: { width: 1366, height: 768 },
      extraHTTPHeaders: {
        'Accept-Language': 'es-AR,es;q=0.9,en-US;q=0.8,en;q=0.7',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'sec-ch-ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
      },
    });
    const page = await context.newPage();
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
      Object.defineProperty(navigator, 'languages', { get: () => ['es-AR', 'es', 'en-US', 'en'] });
      window.chrome = { runtime: {}, loadTimes: () => {}, csi: () => {}, app: {} };
      Object.defineProperty(screen, 'colorDepth', { get: () => 24 });
    });

    // Network interceptor — capture player URLs from all responses
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
        { timeout: 10000 }
      ).catch(() => {});
      const resultSelector = sectionFilter
        ? `a[href*="${sectionFilter}"]`
        : 'a[href*="/pelicula/"], a[href*="/serie/"]';
      await page.waitForSelector(resultSelector, { timeout: 6000 }).catch(() => {});
      await page.waitForTimeout(500);

      const filter    = sectionFilter || '';
      const titleSlug = (req.query.titleSlug || '').toLowerCase();
      const slugWords = titleSlug.split('-').filter(w => w.length > 2);

      const foundLink = await page.evaluate(({ f, words, yr }) => {
        const links = [...document.querySelectorAll('a[href]')]
          .filter(a => f ? a.href.includes(f) : true);
        if (!words.length) return links[0]?.href || null;
        let best = null, bestScore = -Infinity;
        for (const a of links) {
          const href = a.href.toLowerCase();
          const text = (a.textContent || '').toLowerCase().replace(/\s+/g, '-');
          const combined = href + ' ' + text;
          const titleScore = words.filter(w => combined.includes(w)).length;
          if (titleScore === 0) continue;
          let yearScore = 0;
          if (yr) {
            const card = a.closest('article, .item, .card, li') || a.parentElement;
            const cardText = card?.textContent || '';
            if (cardText.includes(String(yr))) yearScore = 3;
            else if (cardText.includes(String(parseInt(yr) - 1))) yearScore = 1;
          }
          const total = titleScore + yearScore;
          if (total > bestScore) { bestScore = total; best = a.href; }
        }
        return bestScore > 0 ? best : null;
      }, { f: filter, words: slugWords, yr: year || null });

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
      { timeout: 15000 }
    ).catch(() => {});

    await page.waitForSelector('[data-server], iframe[src]', { timeout: 5000 }).catch(() => {});

    if (season && episode) {
      await page.waitForTimeout(1000);
      await tryClickEpisode(page, season, episode);
    }

    await page.waitForTimeout(800);



    const getIframeSrcs = () => page.evaluate(() =>
      [...document.querySelectorAll('iframe')].map(f => f.getAttribute('src') || f.getAttribute('data-src') || '')
    );

    let iframeSrcs = await getIframeSrcs();
    for (const src of iframeSrcs) {
      if (src && PLAYER_DOMAINS.some(d => src.includes(d))) urls.add(src);
    }

    // ─── CUEVANA POPUP FLOW ──────────────────────────────────────────────────
    // Real Cuevana UX: language tab → dropdown → REPRODUCIR → new tab → video
    // stream mode: traverse ALL language tabs + ALL buttons, SSE each URL on find
    const isCuevanaPage = targetUrl.includes('cuevana.cz');
    if (isCuevanaPage) {
      const langPriority = ['Latino', 'Castellano', 'Subtitulado'];
      let gotUrls = false;
      for (const lang of langPriority) {
        if (!streamMode && gotUrls) break;
        if (clientGone) break;
        try {
          const langEl = await page.$(`text=${lang}`);
          if (!langEl) continue;
          await langEl.click();
          await page.waitForTimeout(800);

          const repBtns = await page.$$('text=REPRODUCIR');
          console.log(`[cuevana] ${lang}: ${repBtns.length} REPRODUCIR button(s)`);

          for (const btn of repBtns.slice(0, streamMode ? 5 : 3)) {
            if (clientGone) break;
            try {
              const popupUrls = new Set();
              const [popup] = await Promise.all([
                context.waitForEvent('page', { timeout: 6000 }),
                btn.click(),
              ]);

              popup.on('response', async (resp) => {
                try {
                  const u = resp.url();
                  if (/\.(m3u8|ts|mp4)(\?|$)/i.test(u) || PLAYER_DOMAINS.some(d => u.includes(d))) {
                    popupUrls.add(u); return;
                  }
                  const ct = resp.headers()['content-type'] || '';
                  if (/video|mpegurl/i.test(ct)) { popupUrls.add(u); return; }
                  if (/json|text\/(html|plain)/i.test(ct)) {
                    const text = await resp.text().catch(() => '');
                    for (const m of text.matchAll(PLAYER_REGEX)) popupUrls.add(m[1]);
                  }
                } catch {}
              });

              await popup.waitForLoadState('domcontentloaded', { timeout: 12000 }).catch(() => {});

              // Poll until an inner player URL appears, up to 8s
              for (let i = 0; i < 16; i++) {
                await popup.waitForTimeout(500);
                if ([...popupUrls].some(u => INNER_PLAYER_DOMAINS.some(d => u.includes(d)))) break;
              }

              const popupHtml = await popup.content().catch(() => '');
              for (const u of extractFromHtml(popupHtml)) {
                if (!/\.(js|css)(\?|$)/.test(u)) popupUrls.add(u);
              }
              await popup.close().catch(() => {});

              // Prefer inner player URLs (streamtape/filemoon/etc) over video.cuevana.cz wrapper
              const innerPopupUrls = [...popupUrls].filter(u => INNER_PLAYER_DOMAINS.some(d => u.includes(d)));
              const finalPopupUrls = innerPopupUrls.length ? innerPopupUrls : [...popupUrls];
              console.log(`[cuevana] popup (${lang}): ${popupUrls.size} URL(s), ${innerPopupUrls.length} inner`);
              const lc = LANG_CODES[lang] || 'LAT';
              for (const u of finalPopupUrls) {
                if (!urls.has(u)) {
                  urls.add(u);
                  if (!urlLangs.has(u)) urlLangs.set(u, lc);
                  sendSse(u, lc); // stream immediately in SSE mode
                }
              }
              if (urls.size) gotUrls = true;
              if (!streamMode && gotUrls) break; // non-stream: stop after first success per lang
            } catch {}
          }
        } catch {}
      }
    }

    // Non-cuevana or cuevana fallback: data-server based approach
    if (!urls.size) {
      const cuevanaServerEls = await page.$$('[data-server*="video.cuevana.cz"]');
      if (cuevanaServerEls.length > 0) {
        const toClick = cuevanaServerEls.slice(0, 3);
        console.log(`[cuevana-fallback] clicking ${toClick.length} server button(s)`);
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
    }

    if (!urls.size) {
      await page.waitForFunction((domains) => {
        return [...document.querySelectorAll('iframe')].some(f => {
          const src = f.getAttribute('src') || '';
          return domains.some(d => src.includes(d));
        });
      }, PLAYER_DOMAINS, { timeout: 3000 }).catch(() => {});

      iframeSrcs = await getIframeSrcs();
      for (const src of iframeSrcs) {
        if (src && PLAYER_DOMAINS.some(d => src.includes(d))) urls.add(src);
      }
    }

    // Only add network URLs if popup flow didn't already populate urls
    if (!isCuevanaPage || !urls.size) {
      const innerNetworkUrls = [...networkUrls].filter(u => INNER_PLAYER_DOMAINS.some(d => u.includes(d)));
      const cuevanaNetworkUrls = [...networkUrls].filter(u => u.includes('video.cuevana.cz'));
      for (const u of (innerNetworkUrls.length ? innerNetworkUrls : cuevanaNetworkUrls)) urls.add(u);
    }

    if (!urls.size) {
      const html = await page.content();
      for (const u of extractFromHtml(html)) {
        if (!/\.js(\?|$)/.test(u) && !/\.css(\?|$)/.test(u)) urls.add(u);
      }
    }

    // For Cuevana URLs without a language tag, detect from page DOM
    if (isCuevanaPage) {
      const untagged = [...urls].filter(u => !urlLangs.has(u));
      if (untagged.length) {
        const pageLangText = await page.evaluate(() => {
          for (const t of ['Latino', 'Castellano', 'Subtitulado']) {
            if (document.body?.textContent?.includes(t)) return t;
          }
          return null;
        }).catch(() => null);
        const detectedLang = LANG_CODES[pageLangText] || 'LAT';
        console.log(`[cuevana] untagged URLs → detected lang: ${detectedLang}`);
        for (const u of untagged) urlLangs.set(u, detectedLang);
      }
    }

    console.log(`[scrape] done: ${urls.size} URL(s) for ${targetUrl}`);
    clearTimeout(timer);
    await context.close();

    if (streamMode) { doneSse(); return; }
    const sorted = [...urls].sort((a, b) => langOrder(a) - langOrder(b));
    const languages = sorted.map(u => urlLangs.get(u) || langFromUrl(u));
    res.json({ urls: sorted, languages });
  } catch (err) {
    clearTimeout(timer);
    if (context) await context.close().catch(() => {});
    if (!res.headersSent) res.json({ urls: [], error: err.message });
  } }).catch(() => {
    clearTimeout(timer);
    if (!res.headersSent) res.json({ urls: [] });
  });
});

// ─── /extract — HTTP-only direct video URL extraction ─────────────────────────
// Fetches an embed page and looks for m3u8/mp4 URLs in the source.
// No Playwright — fast, cheap. Falls back gracefully if obfuscated.
async function tryExtractVideo(url) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const origin = new URL(url).origin;
    const res = await fetch(url, {
      headers: { ...STEALTH_HEADERS, 'Referer': origin + '/', 'Accept': '*/*' },
      signal: ctrl.signal,
    });
    clearTimeout(t);
    if (!res.ok) return null;
    const text = await res.text();
    const m3u8 = text.match(/['"`](https?:\/\/[^'"`\s]+\.m3u8[^'"`\s]*)[`'"]/i);
    if (m3u8) return m3u8[1];
    const mp4 = text.match(/['"`](https?:\/\/[^'"`\s]+\.mp4[^'"`\s]*)[`'"]/i);
    if (mp4) return mp4[1];
  } catch {}
  return null;
}

app.get('/extract', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'url required' });
  console.log(`[extract] ${url}`);
  const direct = await tryExtractVideo(url);
  console.log(`[extract] result: ${direct || 'null'}`);
  res.json({ url: direct });
});

app.listen(PORT, () => console.log(`Scraper server on port ${PORT}`));
