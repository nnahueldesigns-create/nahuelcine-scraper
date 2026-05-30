// ─── FUENTES EXTRA (HTTP puro, sin Playwright) ───────────────────────────────
// Cada resolver recibe q = { title, originalTitle, year, type, season, episode }
// y devuelve [{ url, lang }] (lang = LAT|ESP|SUB|ENG|null). Todo por fetch HTTP:
// search → match por título → página → extraer/resolver el embed.
//
// Fuentes:
//   cinetimes    — cine clásico/dominio público, embeds YouTube/archive (limpio)
//   retinalatina — cine indie/festival latinoamericano, player instantvideocloud (limpio)
//   archive      — Internet Archive, API JSON + embed propio (limpio, dominio público)
//   pelicinehd   — estrenos modernos, DooPlay trembed → minochinos (con ads)

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function headers(referer) {
  return {
    'User-Agent': UA,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'es-AR,es;q=0.9,en;q=0.8',
    ...(referer ? { Referer: referer } : {}),
  };
}

async function getText(url, referer, timeoutMs = 9000) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const r = await fetch(url, { headers: headers(referer), signal: ctrl.signal });
    clearTimeout(t);
    if (!r.ok) return '';
    return await r.text();
  } catch { return ''; }
}

async function getJson(url, referer) {
  const txt = await getText(url, referer);
  try { return JSON.parse(txt); } catch { return null; }
}

function slugify(s) {
  return (s || '').toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s-]/g, '').trim()
    .replace(/\s+/g, '-').replace(/-+/g, '-');
}
function titleWords(s) { return slugify(s).split('-').filter(w => w.length > 2); }

function normLang(t) {
  if (!t) return null;
  t = t.toLowerCase();
  if (t.includes('latino') || /\blat\b/.test(t)) return 'LAT';
  if (t.includes('castellano') || t.includes('español') || t.includes('espanol') || /\bcas\b/.test(t) || /\besp\b/.test(t)) return 'ESP';
  if (t.includes('subtitul') || t.includes('vose') || /\bsub\b/.test(t) || /\bvos\b/.test(t)) return 'SUB';
  if (t.includes('ingl') || t.includes('english') || /\beng\b/.test(t)) return 'ENG';
  return null;
}

// Mejor candidato por solapamiento de palabras del título. Devuelve el de mayor
// score, o null si nadie supera el umbral (evita falsos positivos).
function bestMatch(candidates, qWords, getText2, minScore = 1) {
  let best = null, bs = minScore - 1;
  for (const c of candidates) {
    const text = (getText2 ? getText2(c) : c).toLowerCase();
    const sc = qWords.filter(w => text.includes(w)).length;
    if (sc > bs) { bs = sc; best = c; }
  }
  return best;
}

const decAmp = u => u.replace(/&(amp;|#0?38;)/g, '&');

// ─── CINETIMES ───────────────────────────────────────────────────────────────
async function cinetimes(q) {
  if (q.type === 'tv') return []; // catálogo = pelis clásicas
  const out = [];
  const qWords = [...new Set([...titleWords(q.originalTitle || ''), ...titleWords(q.title)])];
  for (const [sec, lang] of [['es-lat', 'LAT'], ['es', 'ESP']]) {
    const sh = await getText(`https://cinetimes.org/${sec}/?s=${encodeURIComponent(q.title)}`, 'https://cinetimes.org/');
    const re = new RegExp(`/${sec}/t/([a-z0-9-]+)`, 'gi');
    const slugs = [...new Set([...sh.matchAll(re)].map(m => m[1]))];
    const best = bestMatch(slugs, qWords);
    if (!best) continue;
    const ph = await getText(`https://cinetimes.org/${sec}/t/${best}`, `https://cinetimes.org/${sec}/`);
    const m = ph.match(/src="(https:\/\/www\.youtube\.com\/embed\/[^"]+|https:\/\/archive\.org\/embed\/[^"]+|https:\/\/[^"]*dailymotion[^"]+)"/i);
    if (m) out.push({ url: decAmp(m[1]), lang });
  }
  return out;
}

// ─── RETINA LATINA ───────────────────────────────────────────────────────────
async function retinalatina(q) {
  if (q.type === 'tv') return [];
  const qWords = [...new Set([...titleWords(q.originalTitle || ''), ...titleWords(q.title)])];
  const sh = await getText(`https://www.retinalatina.org/?s=${encodeURIComponent(q.title)}`, 'https://www.retinalatina.org/');
  const slugs = [...new Set([...sh.matchAll(/\/peliculas\/([a-z0-9-]+)\//gi)].map(m => m[1]))];
  const best = bestMatch(slugs, qWords);
  if (!best) return [];
  const ph = await getText(`https://www.retinalatina.org/peliculas/${best}/`, 'https://www.retinalatina.org/');
  const m = ph.match(/src="(https:\/\/player\.instantvideocloud\.net\/[^"]+)"/i);
  return m ? [{ url: decAmp(m[1]), lang: 'LAT' }] : [];
}

// ─── INTERNET ARCHIVE ─────────────────────────────────────────────────────────
const ARCHIVE_JUNK = /review|commentary|trailer|demo|sample|clip|reaction|\bfan\b|behind|making|presents|interview|soundtrack|score|\bmix\b|podcast|episode \d|part \d/i;
async function archive(q) {
  if (q.type === 'tv') return [];
  // Archive = clásicos/dominio público. Las pelis modernas NO están legalmente
  // ahí; lo que matchea suele ser un trailer/clip/mirror de YouTube (falso
  // positivo, ej. "Oppenheimer 2023" → mirror). Cortar en año >= 1980.
  if (q.year && parseInt(q.year, 10) >= 1980) return [];
  const qWords = [...new Set([...titleWords(q.originalTitle || ''), ...titleWords(q.title)])];
  if (!qWords.length) return [];
  const qstr = `title:(${q.title}) AND mediatype:movies`;
  const api = `https://archive.org/advancedsearch.php?q=${encodeURIComponent(qstr)}&fl[]=identifier&fl[]=title&fl[]=year&rows=12&output=json`;
  const j = await getJson(api, 'https://archive.org/');
  const docs = j?.response?.docs || [];
  let best = null, bs = 0;
  for (const d of docs) {
    if (ARCHIVE_JUNK.test(d.title || '')) continue;
    const text = (d.title || '').toLowerCase();
    const matched = qWords.filter(w => text.includes(w)).length;
    if (matched < qWords.length) continue; // todas las palabras del título presentes
    const sc = matched + (q.year && String(d.year || '') === String(q.year) ? 2 : 0);
    if (sc > bs) { bs = sc; best = d; }
  }
  if (!best) return [];
  return [{ url: `https://archive.org/embed/${best.identifier}`, lang: null }];
}

// ─── PELICINEHD (DooPlay trembed) ─────────────────────────────────────────────
async function pelicinehd(q) {
  if (q.type === 'tv') return []; // series DooPlay = otra estructura, después
  const qWords = [...new Set([...titleWords(q.originalTitle || ''), ...titleWords(q.title)])];
  const sh = await getText(`https://pelicinehd.com/?s=${encodeURIComponent(q.title)}`, 'https://pelicinehd.com/');
  const slugs = [...new Set([...sh.matchAll(/\/movies\/([a-z0-9-]+)\//gi)].map(m => m[1]))];
  const best = bestMatch(slugs, qWords);
  if (!best) return [];
  const page = `https://pelicinehd.com/movies/${best}/`;
  const ph = await getText(page, 'https://pelicinehd.com/');
  // tabs en orden: <a href="#options-N">OPCIÓN N Minochinos -LAT HD</a>
  const tabLangs = [...ph.matchAll(/href="#options?[^"]*"[^>]*>([\s\S]*?)<\/a>/gi)].map(m => normLang(m[1]));
  const tm = ph.match(/trid=(\d+)/i);
  if (!tm) return [];
  const trid = tm[1];
  const count = tabLangs.length || 3;
  const out = [];
  const seen = new Set();
  for (let n = 0; n < count; n++) {
    const th = await getText(`https://pelicinehd.com/?trembed=${n}&trid=${trid}&trtype=1`, page);
    const m = th.match(/<iframe[^>]*src="(https?:\/\/[^"]+)"/i);
    if (!m) continue;
    const u = decAmp(m[1]);
    if (/youtube|trembed|pelicinehd\.com/i.test(u) || seen.has(u)) continue;
    seen.add(u);
    out.push({ url: u, lang: tabLangs[n] || null });
  }
  return out;
}

const RESOLVERS = { cinetimes, retinalatina, archive, pelicinehd };

async function resolveSource(src, q) {
  const fn = RESOLVERS[src];
  if (!fn) return [];
  try { return await fn(q); } catch { return []; }
}

module.exports = { resolveSource, SOURCES: Object.keys(RESOLVERS) };
