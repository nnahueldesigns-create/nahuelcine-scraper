const express = require('express');
const cors = require('cors');
const { chromium } = require('playwright');

const app = express();
app.use(cors());
app.use((req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });

const PORT = process.env.PORT || 3000;

// ─── SHARED CACHE (Upstash Redis REST API) ──────────────────────────────────
// Cache compartida y persistente: el primer scrape de un título lo guarda, los
// demás lo reciben sin Playwright. Si faltan las env vars, degrada silencioso
// (cacheGet→null, cacheSet→no-op) y el server funciona igual que sin cache.
const REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL || '';
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';
const CACHE_TTL   = parseInt(process.env.CACHE_TTL_SECONDS || '345600', 10); // 4 días
const CACHE_ON    = !!(REDIS_URL && REDIS_TOKEN);
console.log(`[cache] ${CACHE_ON ? 'ON (Upstash)' : 'OFF (sin env vars)'} ttl=${CACHE_TTL}s`);

function cacheKey(q) {
  return 'scrape:' + [q.url || q.searchUrl || '', q.season || '', q.episode || '', q.sectionFilter || '', q.titleSlug || ''].join('|');
}

async function cacheGet(key) {
  if (!CACHE_ON) return null;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2500);
    const r = await fetch(`${REDIS_URL}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
      signal: ctrl.signal,
    });
    clearTimeout(t);
    if (!r.ok) return null;
    const data = await r.json();        // { result: "<json-string|null>" }
    if (!data.result) return null;
    return JSON.parse(data.result);     // { urls, languages }
  } catch { return null; }
}

async function cacheSet(key, value) {
  if (!CACHE_ON || !value?.urls?.length) return; // no cachear vacío → permite reintentar
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2500);
    await fetch(`${REDIS_URL}/set/${encodeURIComponent(key)}?EX=${CACHE_TTL}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'text/plain' },
      body: JSON.stringify(value),
      signal: ctrl.signal,
    });
    clearTimeout(t);
    console.log(`[cache] SET ${key} (${value.urls.length} URL)`);
  } catch {}
}

const PLAYER_DOMAINS = [
  'streamtape', 'filemoon', 'voe',
  'vidfast', 'mp4upload', 'uqload', 'upstream',
  'fembed', 'vidbom', 'embed.su',
  'ok.ru', 'vidlox', 'netu',
  'videobin', 'vidmoly', 'vudeo', 'wishfast', 'streamvid',
  // Gnula: hqq, dood, streamz / Pelisplus: streamwish, vidhide
  'hqq', 'dood', 'streamz', 'streamwish', 'vidhide',
  'video.cuevana.cz',
];

const INNER_PLAYER_DOMAINS = PLAYER_DOMAINS.filter(d => d !== 'video.cuevana.cz');

const PLAYER_REGEX = /['"](https?:\/\/(?:(?:streamtape|filemoon|voe|vidfast|mp4upload|uqload|upstream|fembed|vidbom|embed\.su|ok\.ru|vidlox|netu|videobin|vidmoly|vudeo|wishfast|streamvid|hqq\.to|dood|streamz|streamwish|vidhide|video\.cuevana\.cz)[^'"<>\s]+))['"]/gi;

function extractFromHtml(html) {
  const urls = new Set();
  for (const m of html.matchAll(PLAYER_REGEX)) urls.add(m[1]);
  return [...urls];
}

// ─── CUEVANA SERVER PARSER ──────────────────────────────────────────────────
// El idioma de cada server NO está en la URL (token/v opacos). Está en la
// pestaña: cada `data-server="...video.cuevana.cz..."` cae bajo una pestaña con
// una imagen `image/<código>.png` (lat/cas/sub/eng). El idioma de un server =
// el de la última imagen de idioma que aparece ANTES en el HTML. Parsear esto
// del HTML da idioma correcto sin clicks ni Playwright.
const CUEVANA_LANG_IMG = { lat: 'LAT', cas: 'ESP', cast: 'ESP', esp: 'ESP', sub: 'SUB', vose: 'SUB', vos: 'VOS', eng: 'ENG', ing: 'ENG' };
function parseCuevanaServers(html) {
  const langPos = [...html.matchAll(/image\/(lat|cas|cast|esp|sub|vose?|vos|eng|ing)\.png/gi)]
    .map(m => ({ lang: m[1].toLowerCase(), pos: m.index }));
  const out = [];
  const seen = new Set();
  for (const m of html.matchAll(/data-server="([^"]+)"/g)) {
    const u = m[1];
    if (!u.includes('video.cuevana.cz') || seen.has(u)) continue;
    seen.add(u);
    let lang = null;
    for (const lp of langPos) { if (lp.pos < m.index) lang = CUEVANA_LANG_IMG[lp.lang] || null; else break; }
    out.push({ url: u, lang });
  }
  return out;
}

// ─── LANGUAGE NORMALIZER ────────────────────────────────────────────────────
// Texto libre del sitio (label de pestaña, data-name, <em>) → código corto.
function normalizeLang(text) {
  if (!text) return null;
  const t = text.toLowerCase();
  if (t.includes('latino') || /\blat\b/.test(t)) return 'LAT';
  if (t.includes('castellano') || t.includes('español') || t.includes('espanol') || /\besp\b/.test(t)) return 'ESP';
  if (t.includes('subtitul') || t.includes('vose') || /\bsub\b/.test(t) || /\bvos\b/.test(t)) return 'SUB';
  if (t.includes('ingl') || t.includes('english') || /\beng\b/.test(t)) return 'ENG';
  return null;
}

// ─── PELISPLUS SERVER PARSER ────────────────────────────────────────────────
// Cada server es <li class="...playurl..." data-url="URL" data-name="IDIOMA">.
// El idioma vive explícito en data-name → parse directo del HTML, sin Playwright.
function parsePelisplusServers(html) {
  const out = [];
  const seen = new Set();
  for (const m of html.matchAll(/<li\b[^>]*\bplayurl\b[^>]*>/gi)) {
    const tag = m[0];
    const urlM = tag.match(/data-url="([^"]+)"/i);
    if (!urlM) continue;
    const u = urlM[1];
    if (!/^https?:\/\//.test(u) || seen.has(u)) continue;
    seen.add(u);
    const nameM = tag.match(/data-name="([^"]*)"/i);
    out.push({ url: u, lang: normalizeLang(nameM?.[1]) });
  }
  return out;
}

// ─── GNULA SERVER PARSER ────────────────────────────────────────────────────
// El idioma está en un header `<em>opción N, IDIOMA, calidad</em>` que precede
// a su grupo de iframes. Los iframes cargan lazy (data-lazy-src). Idioma de un
// server = el del último <em> que aparece ANTES en el HTML (igual que Cuevana).
const GNULA_PLAYER_RE = /(?:data-lazy-src|data-src|src)="(https?:\/\/(?:hqq\.to|fembed|dood|streamz|streamwish|vidhide|uqload|streamtape|filemoon|voe|mp4upload|streamvid|vidmoly|vudeo)[^"]+)"/gi;
function parseGnulaServers(html) {
  const langPos = [...html.matchAll(/<em>\s*opci[oó]n[^,<]*,\s*([^,<]+?)\s*,/gi)]
    .map(m => ({ lang: normalizeLang(m[1]), pos: m.index }));
  const out = [];
  const seen = new Set();
  for (const m of html.matchAll(GNULA_PLAYER_RE)) {
    const u = m[1];
    if (seen.has(u)) continue;
    seen.add(u);
    let lang = null;
    for (const lp of langPos) { if (lp.pos < m.index) lang = lp.lang; else break; }
    out.push({ url: u, lang });
  }
  return out;
}

// Orden por etiqueta de idioma: LAT primero, luego ESP, SUB, ENG, sin etiqueta.
const LANG_LABEL_ORDER = { LAT: 0, ESP: 1, SUB: 2, ENG: 3 };
const langLabelOrder = l => LANG_LABEL_ORDER[l] ?? 4;

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

// HTTP fast path genérico con parser específico por sitio: trae el HTML una vez
// y lo pasa a `parser(html)` → [{ url, lang }], sin Playwright. Usado por
// Cuevana, Pelisplus y Gnula (cada uno con su parser y su Referer).
async function tryParseHttp(url, parser, referer) {
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(url, {
      headers: { ...STEALTH_HEADERS, 'Referer': referer },
      signal: controller.signal,
    });
    clearTimeout(t);
    if (!res.ok) return [];
    const html = await res.text();
    if (html.length < 2000 || html.toLowerCase().includes('just a moment')) return [];
    return parser(html); // [{ url, lang }]
  } catch {
    return [];
  }
}

// Devuelve servers [{url, lang}] por JSON o SSE, y los cachea. Centraliza la
// respuesta del fast path para Cuevana / Pelisplus / Gnula.
async function emitServers(res, ckey, servers, streamMode) {
  const urls = servers.map(s => s.url);
  const languages = servers.map(s => s.lang || null);
  await cacheSet(ckey, { urls, languages });
  if (streamMode) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    for (const s of servers) res.write(`data: ${JSON.stringify({ url: s.url, lang: s.lang || null })}\n\n`);
    res.write('event: done\ndata: {}\n\n');
    return res.end();
  }
  return res.json({ urls, languages });
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

  // ─── SHARED CACHE READ ──────────────────────────────────────────────────
  // ?fresh=1 saltea la lectura (re-scrape) pero igual reescribe la entrada.
  const ckey  = cacheKey(req.query);
  const fresh = req.query.fresh === '1';
  if (!fresh) {
    const hit = await cacheGet(ckey);
    if (hit?.urls?.length) {
      console.log(`[cache] HIT ${ckey} (${hit.urls.length})`);
      if (streamMode) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        hit.urls.forEach((u, i) => res.write(`data: ${JSON.stringify({ url: u, lang: hit.languages?.[i] || null })}\n\n`));
        res.write('event: done\ndata: {}\n\n');
        return res.end();
      }
      return res.json({ urls: hit.urls, languages: hit.languages || [] });
    }
  }

  // ─── HTTP FAST PATH ────────────────────────────────────────────────────
  // Only for direct URL requests (not search). Fast, no Playwright overhead.
  if (url && !searchUrl) {
    // Sitios con parser de idioma propio: traen servers + idioma del HTML, sin
    // Playwright. Cuevana mantiene su orden (pestañas); Gnula/Pelisplus se
    // ordenan por idioma (LAT primero).
    const siteParser =
      url.includes('cuevana.cz')                                ? { fn: parseCuevanaServers,  ref: 'https://cuevana.cz/',            sort: false, tag: 'cuevana'   } :
      url.includes('gnula')                                      ? { fn: parseGnulaServers,    ref: 'https://www2.gnula.one/',         sort: true,  tag: 'gnula'     } :
      (url.includes('pelisplus') || url.includes('pelisplushd')) ? { fn: parsePelisplusServers, ref: 'https://www.pelisplushd.la/',    sort: true,  tag: 'pelisplus' } :
      null;
    if (siteParser) {
      let servers = await tryParseHttp(url, siteParser.fn, siteParser.ref); // [{ url, lang }]
      if (servers.length) {
        if (siteParser.sort) servers = servers.sort((a, b) => langLabelOrder(a.lang) - langLabelOrder(b.lang));
        console.log(`[http-fast/${siteParser.tag}] ${servers.length} server(s) from ${url}`);
        return emitServers(res, ckey, servers, streamMode);
      }
    }
    const fastUrls = await tryHttpFetch(url);
    if (fastUrls.length) {
      console.log(`[http-fast] ${fastUrls.length} URL(s) from ${url}`);
      const sortedFast = fastUrls.sort((a, b) => langOrder(a) - langOrder(b));
      await cacheSet(ckey, { urls: sortedFast, languages: sortedFast.map(langFromUrl) });
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
  const LANG_CODES = { 'Latino': 'LAT', 'Castellano': 'ESP', 'Subtitulado': 'SUB', 'Inglés': 'ENG', 'Ingles': 'ENG', 'English': 'ENG' };

  // Acumular lo streameado para escribir el cache al cerrar el stream.
  const streamedUrls = [];
  const streamedLangs = [];
  const sendSse = (u, lang) => {
    if (streamMode && !res.writableEnded) res.write(`data: ${JSON.stringify({ url: u, lang })}\n\n`);
    streamedUrls.push(u); streamedLangs.push(lang || null);
  };
  const doneSse = () => {
    if (streamMode && !res.writableEnded) { res.write('event: done\ndata: {}\n\n'); res.end(); }
    if (streamedUrls.length) cacheSet(ckey, { urls: streamedUrls, languages: streamedLangs });
  };

  const timeoutMs = 55000;
  const timer = setTimeout(async () => {
    if (context) await context.close().catch(() => {});
    if (streamMode) { doneSse(); return; }
    if (!res.headersSent) {
      const collected = [...urls];
      if (collected.length > 0) {
        const sorted = collected.sort((a, b) => langOrder(a) - langOrder(b));
        const languages = sorted.map(u => urlLangs.get(u) || langFromUrl(u) || null);
        console.log(`[timeout] returning ${collected.length} partial URL(s)`);
        cacheSet(ckey, { urls: sorted, languages });
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
        // Cuevana usa /serie/slug/episodio-SxE; el resto /serie/slug/S/E/.
        targetUrl = targetUrl.replace(/\/+$/, '') + (targetUrl.includes('cuevana.cz')
          ? `/episodio-${season}x${episode}`
          : `/${season}/${episode}/`);
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

    // ─── CUEVANA: PARSE DEL DOM ──────────────────────────────────────────────
    // El idioma de cada server vive en su pestaña (imagen lat/cas/sub/eng.png),
    // NO en la URL (token/v opacos). Parsear el HTML de la página da los servers
    // CON idioma correcto, sin clicks ni popups → rápido y fiable. (El viejo flujo
    // de popups era lento y devolvía los mismos wrappers pero sin idioma.)
    const isCuevanaPage = targetUrl.includes('cuevana.cz');
    if (isCuevanaPage) {
      const cuevanaHtml = await page.content().catch(() => '');
      const cuevanaServers = parseCuevanaServers(cuevanaHtml);
      console.log(`[cuevana] parsed ${cuevanaServers.length} server(s) from DOM`);
      for (const { url: u, lang } of cuevanaServers) {
        if (urls.has(u)) continue;
        urls.add(u);
        if (lang) urlLangs.set(u, lang);
        sendSse(u, lang || null);
      }
    }

    // ─── GNULA / PELISPLUS: PARSE DEL DOM ───────────────────────────────────
    // Mismo enfoque que Cuevana: el idioma vive en el HTML (data-name en
    // Pelisplus, <em>opción N, IDIOMA</em> en Gnula), no en la URL. Parsear el
    // DOM da servers + idioma sin clicks. Sólo si el HTTP fast path no entró
    // (search fallback) o no devolvió nada.
    const isGnulaPage     = targetUrl.includes('gnula');
    const isPelisplusPage = targetUrl.includes('pelisplus') || targetUrl.includes('pelisplushd');
    if ((isGnulaPage || isPelisplusPage)) {
      const pageHtml = await page.content().catch(() => '');
      const parsed = isGnulaPage ? parseGnulaServers(pageHtml) : parsePelisplusServers(pageHtml);
      parsed.sort((a, b) => langLabelOrder(a.lang) - langLabelOrder(b.lang));
      console.log(`[${isGnulaPage ? 'gnula' : 'pelisplus'}] parsed ${parsed.length} server(s) from DOM`);
      for (const { url: u, lang } of parsed) {
        if (urls.has(u)) continue;
        urls.add(u);
        if (lang) urlLangs.set(u, lang);
        sendSse(u, lang || null);
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

    // URLs de Cuevana sin etiqueta de idioma: se dejan SIN tag (null).
    // Antes se adivinaba por texto del body, pero la página casi siempre contiene
    // "Latino" (label de pestaña) → tageaba todo como LAT aunque el audio fuera otro.
    // Mejor sin etiqueta que con una etiqueta mentirosa.
    if (isCuevanaPage) {
      const untagged = [...urls].filter(u => !urlLangs.has(u));
      if (untagged.length) {
        console.log(`[cuevana] ${untagged.length} URL(s) sin idioma confiable → sin etiqueta`);
      }
    }

    console.log(`[scrape] done: ${urls.size} URL(s) for ${targetUrl}`);
    clearTimeout(timer);
    await context.close();

    if (streamMode) { doneSse(); return; }
    const sorted = [...urls].sort((a, b) => langOrder(a) - langOrder(b));
    const languages = sorted.map(u => urlLangs.get(u) || langFromUrl(u) || null);
    cacheSet(ckey, { urls: sorted, languages });
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
