// Auto-blogger: trending topics -> related fresh coverage -> Gemini rewrite -> Blogger publish.
// Node 20+, zero dependencies.
import fs from 'node:fs';

const env = process.env, DRY = env.DRY_RUN === 'true';
const CFG = JSON.parse(fs.readFileSync('config/schedules.json', 'utf8'));
const HFILE = 'data/history.json';
const H = fs.existsSync(HFILE) ? JSON.parse(fs.readFileSync(HFILE, 'utf8')) : { posts: [] };
const log = (...a) => console.log(...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------- helpers ---------- */
const esc = s => String(s).replace(/[&<>"']/g, c => '&#' + c.charCodeAt(0) + ';');
const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
const hash = s => [...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
const norm = s => s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length > 2);
const overlap = (a, b) => { const B = new Set(b); let n = 0; new Set(a).forEach(w => B.has(w) && n++); return n / (Math.min(new Set(a).size, B.size) || 1); };
const dec = s => s.replace(/<!\[CDATA\[|\]\]>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&').trim();
const tag = (x, n) => { const m = x.match(new RegExp(`<${n}[^>]*>([\\s\\S]*?)</${n}>`)); return m ? dec(m[1]) : ''; };
const items = (x, n = 'item') => x.split(new RegExp(`<${n}[ >]`)).slice(1).map(b => b.split(`</${n}>`)[0]);
const traffic = s => { const m = s.match(/([\d.]+)\s*([KM]?)/i); return m ? parseFloat(m[1]) * ({ K: 1e3, M: 1e6 }[m[2].toUpperCase()] || 1) : 0; };
async function get(url) {
  const r = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 (compatible; connect360-autopost)' } });
  if (!r.ok) throw new Error(r.status + ' ' + url);
  return r.text();
}

/* ---------- 1. trending topics (Google Trends RSS, falls back to Google News headlines) ---------- */
async function topicsFor(c) {
  if (c.mode === 'keywords') return c.keywords.map(k => ({ title: k, traffic: 0, news: [] }));
  try {
    const x = await get(`https://trends.google.com/trending/rss?geo=${c.geo}`);
    const t = items(x).map(b => ({
      title: tag(b, 'title'), traffic: traffic(tag(b, 'ht:approx_traffic')),
      news: items(b, 'ht:news_item').map(n => ({ title: tag(n, 'ht:news_item_title'), source: tag(n, 'ht:news_item_source'), url: tag(n, 'ht:news_item_url'), snippet: tag(n, 'ht:news_item_snippet') }))
    })).filter(t => t.title && t.traffic >= c.minTraffic);
    if (t.length) return t.sort((a, b) => b.traffic - a.traffic);
  } catch (e) { log('Trends failed:', e.message); }
  const x = await get(`https://news.google.com/rss?hl=${c.hl}&gl=${c.geo}&ceid=${c.geo}:en`);
  return items(x).slice(0, 15).map(b => ({ title: tag(b, 'title').replace(/ - [^-]+$/, ''), traffic: 0, news: [] }));
}

/* ---------- 2. fresh related coverage (date-filtered) ---------- */
async function related(c, t) {
  const age = c.maxAgeHours < 24 ? c.maxAgeHours + 'h' : Math.ceil(c.maxAgeHours / 24) + 'd';
  const x = await get(`https://news.google.com/rss/search?q=${encodeURIComponent(`${t.title} when:${age}`)}&hl=${c.hl}&gl=${c.geo}&ceid=${c.geo}:en`);
  const cutoff = Date.now() - c.maxAgeHours * 36e5;
  const found = items(x).map(b => {
    const full = tag(b, 'title'), i = full.lastIndexOf(' - ');
    return { title: i > 0 ? full.slice(0, i) : full, source: i > 0 ? full.slice(i + 3) : tag(b, 'source'), url: tag(b, 'link'), date: new Date(tag(b, 'pubDate')) };
  }).filter(a => a.date >= cutoff);
  const seen = new Set();
  return [...t.news, ...found].filter(a => a.title && !seen.has(a.title.toLowerCase()) && seen.add(a.title.toLowerCase())).slice(0, c.relatedCount);
}

/* ---------- history / dedupe ---------- */
const covered = (title, days) => {
  const w = norm(title), cut = Date.now() - days * 864e5;
  return H.posts.some(p => new Date(p.date) >= cut && (p.key === slug(title) || overlap(w, norm(p.topic)) >= .75 || overlap(w, norm(p.title)) >= .75));
};
const saveHistory = () => { H.posts = H.posts.slice(-500); fs.writeFileSync(HFILE, JSON.stringify(H, null, 1)); };

/* ---------- 3. Gemini rewrite (free-tier models, retry + fallback chain) ---------- */
function buildPrompt(c, t, rel) {
  return `You are the editor of "${CFG.site}", a news & trends blog. Write in ${c.language}.
TRENDING TOPIC: ${t.title}
ALLOWED CATEGORIES: ${c.categories.join(', ')}. Use category SKIP if the topic fits none, or is adult, graphic, a tragedy, medical/legal advice, or unverified rumour.
FRESH COVERAGE (last ${c.maxAgeHours}h):
${rel.map(r => `- ${r.title} (${r.source}${r.date ? ', ' + r.date.toISOString().slice(0, 10) : ''})${r.snippet ? ': ' + r.snippet : ''}`).join('\n')}

Write an ORIGINAL 600-900 word article that adds insight: what happened, background, why it matters, how coverage differs, and what to watch next. Do not copy sentences. Do not invent facts, quotes or numbers; hedge unconfirmed items ("reports suggest"). No clickbait.
Output EXACTLY:
TITLE: <title under 70 chars>
CATEGORY: <one allowed category or SKIP>
LABELS: <3-5 comma separated tags>
EXCERPT: <one sentence, max 150 chars>
---
<body as simple HTML using only p, h2, h3, ul, li, strong, blockquote. No h1, images, scripts or markdown.>`;
}
async function gemini(c, prompt) {
  for (const m of c.models) for (let a = 0; a < 2; a++) {
    const body = { contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: .7, maxOutputTokens: 8192 } };
    if (c.grounding) body.tools = [{ google_search: {} }];
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    const text = (j.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
    if (r.ok && text) return { text, model: m };
    log(`  ${m} -> ${r.status} ${(j.error?.message || 'empty').slice(0, 110)}`);
    if (r.status === 429 || r.status >= 500) { await sleep(15000 * (a + 1)); continue; }
    break;
  }
  throw new Error('all Gemini models failed');
}
function parse(txt) {
  const [head, ...rest] = txt.split(/\n-{3,}\s*\n/);
  const g = k => (head.match(new RegExp('^\\W*' + k + ':\\s*(.+)$', 'mi')) || [])[1]?.trim() || '';
  const html = rest.join('\n---\n').replace(/^```(?:html)?\s*|```\s*$/gm, '').replace(/<(script|style|iframe|object|embed)[\s\S]*?<\/\1>/gi, '').replace(/\son\w+\s*=\s*("[^"]*"|'[^']*')/gi, '').replace(/javascript:/gi, '').trim();
  return { title: g('TITLE'), category: g('CATEGORY'), labels: g('LABELS').split(',').map(s => s.trim()).filter(Boolean), excerpt: g('EXCERPT'), html };
}

/* ---------- 4. image fallback: inject after paragraph 2 or 3 when the response has none ---------- */
function addImage(c, html, title, seed) {
  if (/<img\s/i.test(html)) return html;
  const ps = [...html.matchAll(/<\/p>/gi)];
  if (!ps.length) return html;
  const src = c.fallbackImages[hash(seed) % c.fallbackImages.length].replace('{seed}', encodeURIComponent(seed));
  const at = ps[Math.min(ps.length - 1, 1 + (hash(seed) % 2))].index + 4;
  const fig = `<figure style="margin:1.5rem 0"><img src="${src}" alt="${esc(title)}" loading="lazy" style="width:100%;height:auto;border-radius:12px"/><figcaption style="font-size:.8rem;color:#64748b;margin-top:.4rem">Illustration</figcaption></figure>`;
  return html.slice(0, at) + fig + html.slice(at);
}

/* ---------- 5. Blogger publish ---------- */
async function accessToken() {
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: env.BLOGGER_CLIENT_ID, client_secret: env.BLOGGER_CLIENT_SECRET, refresh_token: env.BLOGGER_REFRESH_TOKEN, grant_type: 'refresh_token' }) });
  const j = await r.json();
  if (!j.access_token) throw new Error('OAuth failed: ' + JSON.stringify(j));
  return j.access_token;
}
async function publish(tk, c, p) {
  const r = await fetch(`https://www.googleapis.com/blogger/v3/blogs/${env.BLOGGER_BLOG_ID}/posts?isDraft=${!!c.draft}`, { method: 'POST',
    headers: { authorization: 'Bearer ' + tk, 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'blogger#post', title: p.title, content: p.html, labels: p.labels }) });
  const j = await r.json();
  if (!r.ok) throw new Error(`Blogger ${r.status}: ${j.error?.message}`);
  return j;
}

/* ---------- run one schedule config ---------- */
async function runConfig(raw, tk) {
  const c = { ...CFG.defaults, ...raw };
  log(`\n== ${c.id} (${c.mode}, ${c.geo}) ==`);
  const topics = (await topicsFor(c)).filter(t => !c.blockWords.some(w => t.title.toLowerCase().includes(w)) && !covered(t.title, c.dedupeDays));
  log(`${topics.length} fresh topic(s)`);
  let ok = 0, tries = 0;
  for (const t of topics) {
    if (ok >= c.maxPosts || tries >= c.maxPosts * 3) break;
    tries++;
    try {
      const rel = await related(c, t);
      if (rel.length < c.minRelated) { log('skip (thin coverage):', t.title); continue; }
      const { text, model } = await gemini(c, buildPrompt(c, t, rel));
      const p = parse(text);
      const cat = c.categories.find(x => x.toLowerCase() === p.category.toLowerCase());
      if (!cat) { log('skip (category):', t.title, '->', p.category); continue; }
      if (!p.title || (p.html.match(/<p[ >]/gi) || []).length < 3 || p.html.length < 1500) { log('skip (weak output):', t.title); continue; }
      p.labels = [...new Set([cat, ...p.labels])].slice(0, 6);
      p.html = addImage(c, p.html, p.title, slug(p.title)) +
        `<hr/><p><small>${esc(CFG.disclosure)}</small></p><h3>Sources</h3><ul>${rel.map(r => `<li><a href="${esc(r.url)}" rel="nofollow noopener" target="_blank">${esc(r.title)}</a> - ${esc(r.source)}</li>`).join('')}</ul>`;
      if (DRY) { log(`[dry] ${p.title} [${p.labels}]\n${p.html.slice(0, 300)}…`); ok++; }
      else {
        const post = await publish(tk, c, p);
        H.posts.push({ key: slug(t.title), topic: t.title, title: p.title, category: cat, schedule: c.id, model, id: post.id, url: post.url, date: new Date().toISOString(), sources: rel.length });
        saveHistory(); ok++; log('published:', post.url);
      }
      await sleep(c.delayMs);
    } catch (e) { log('  fail:', t.title, '-', e.message); }
  }
  return { ok, tries };
}

/* ---------- main ---------- */
const want = env.SCHEDULE_ID || '', ev = env.EVENT_SCHEDULE || '';
const runs = CFG.schedules.filter(s => s.enabled !== false && (want ? (want === 'all' || s.id === want) : s.cron === ev));
if (!runs.length) { log('No schedule matched', { want, ev }); process.exit(0); }
const tk = DRY ? '' : await accessToken();
let posted = 0, tried = 0;
for (const s of runs) { const r = await runConfig(s, tk); posted += r.ok; tried += r.tries; }
log(`\nDone: ${posted} post(s) from ${tried} attempt(s)`);
if (tried && !posted) process.exitCode = 1;
