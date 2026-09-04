const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const sanitizeHtml = require('sanitize-html');
const slugify = require('slugify');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const PUBLIC_PATH = process.env.PUBLIC_PATH || '/news';
const ROUTE_BASE = process.env.ROUTE_BASE || '';
const SITE_URL = (process.env.SITE_URL || 'http://localhost:' + PORT).replace(/\/$/, '');
const API_KEY = process.env.SGNEWS_API_KEY || '';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const MAIL_CONTROL_URL = (process.env.MAIL_CONTROL_URL || 'http://127.0.0.1:3200').replace(/\/$/, '');
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'data', 'sgnews.sqlite');

if (process.env.TRUST_PROXY) app.set('trust proxy', Number(process.env.TRUST_PROXY) || 1);
fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });

const dbPromise = open({ filename: DB_FILE, driver: sqlite3.Database });

async function initDb() {
  const db = await dbPromise;
  await db.exec(`
    PRAGMA journal_mode=WAL;

    CREATE TABLE IF NOT EXISTS articles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT UNIQUE NOT NULL,
      title TEXT NOT NULL,
      standfirst TEXT NOT NULL DEFAULT '',
      body_html TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'Developing',
      primary_category TEXT NOT NULL DEFAULT 'General',
      briefing_type TEXT NOT NULL DEFAULT 'Briefing',
      project_source TEXT NOT NULL DEFAULT '',
      published_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      what_changed TEXT NOT NULL DEFAULT '',
      is_hidden INTEGER NOT NULL DEFAULT 0,
      visit_count INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS article_categories (
      article_id INTEGER NOT NULL,
      category TEXT NOT NULL,
      UNIQUE(article_id, category)
    );

    CREATE TABLE IF NOT EXISTS article_tags (
      article_id INTEGER NOT NULL,
      tag TEXT NOT NULL,
      UNIQUE(article_id, tag)
    );

    CREATE TABLE IF NOT EXISTS article_sources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      article_id INTEGER NOT NULL,
      label TEXT NOT NULL,
      url TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS revisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      article_id INTEGER NOT NULL,
      changed_at TEXT NOT NULL,
      summary TEXT NOT NULL
    );
  `);
}

function esc(value='') {
  return String(value).replace(/[&<>"']/g, m => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'
  }[m]));
}

function cleanHtml(html='') {
  return sanitizeHtml(html, {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat(['img','figure','figcaption','table','thead','tbody','tr','th','td']),
    allowedAttributes: {
      a: ['href','target','rel'],
      img: ['src','alt','title','width','height','loading'],
      '*': ['class']
    },
    allowedSchemes: ['http','https','mailto']
  });
}

function normalizeList(value) {
  if (!value) return [];
  if (Array.isArray(value)) return [...new Set(value.map(v => String(v).trim()).filter(Boolean))];
  return [...new Set(String(value).split(',').map(v => v.trim()).filter(Boolean))];
}

function nowIso() { return new Date().toISOString(); }

function route(suffix='') {
  const value = `${ROUTE_BASE}${suffix}`;
  return value || '/';
}

function publicPath(suffix='') {
  const base = PUBLIC_PATH === '/' ? '' : PUBLIC_PATH.replace(/\/$/, '');
  const tail = String(suffix || '').replace(/^\/+/, '');
  if (!tail) return base || '/';
  return (base || '') + '/' + tail;
}

function articleUrl(slug) {
  return SITE_URL + publicPath(encodeURIComponent(slug));
}

function layout(title, body, extraHead='') {
  const baseAsset = PUBLIC_PATH === '/' ? '' : PUBLIC_PATH;
  return `<!doctype html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} | SG News</title>
<meta name="description" content="SG News briefings, research updates and evolving articles.">
<meta name="robots" content="index,follow,max-image-preview:large">
<link rel="stylesheet" href="${baseAsset}/assets/styles.css">
${extraHead}
</head>
<body>
<header class="site-header">
  <div class="wrap header-inner">
    <a class="brand" href="${publicPath()}">SG News</a>
    <button class="theme-button" type="button" data-theme-toggle>Light mode</button>
  </div>
</header>
<main class="wrap">${body}</main>
<footer class="footer"><div class="wrap">SG News · public briefings and research updates</div></footer>
<script src="${baseAsset}/assets/app.js"></script>
</body>
</html>`;
}

async function getArticleBySlug(slug) {
  const db = await dbPromise;
  const article = await db.get('SELECT * FROM articles WHERE slug = ?', slug);
  if (!article) return null;
  article.categories = (await db.all('SELECT category FROM article_categories WHERE article_id=? ORDER BY category', article.id)).map(r => r.category);
  article.tags = (await db.all('SELECT tag FROM article_tags WHERE article_id=? ORDER BY tag', article.id)).map(r => r.tag);
  article.sources = await db.all('SELECT label,url FROM article_sources WHERE article_id=? ORDER BY id', article.id);
  article.revisions = await db.all('SELECT changed_at,summary FROM revisions WHERE article_id=? ORDER BY changed_at DESC,id DESC', article.id);
  return article;
}

function auth(req,res,next) {
  if (!API_KEY) return res.status(503).json({error:'Publishing API is not configured'});
  const supplied = req.get('x-api-key') || (req.get('authorization') || '').replace(/^Bearer\s+/i,'');
  const a = Buffer.from(String(supplied));
  const b = Buffer.from(String(API_KEY));
  if (a.length !== b.length || !crypto.timingSafeEqual(a,b)) return res.status(401).json({error:'Unauthorised'});
  next();
}


function adminAuth(req,res,next) {
  if (!ADMIN_TOKEN) return res.status(503).send(layout('Mail Admin','<h1>Mail Admin</h1><p>Admin access is not configured.</p>','<meta name="robots" content="noindex,nofollow">'));

  const header = String(req.get('authorization') || '');
  const match = header.match(/^Basic\s+(.+)$/i);
  if (!match) {
    res.set('WWW-Authenticate', 'Basic realm="SG News Admin"');
    return res.status(401).send('Authentication required');
  }

  let decoded = '';
  try { decoded = Buffer.from(match[1], 'base64').toString('utf8'); } catch {}
  const colon = decoded.indexOf(':');
  const username = colon >= 0 ? decoded.slice(0, colon) : '';
  const password = colon >= 0 ? decoded.slice(colon + 1) : '';

  const userOk = username === 'admin';
  const supplied = Buffer.from(String(password));
  const expected = Buffer.from(String(ADMIN_TOKEN));
  const passOk = supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);

  if (!userOk || !passOk) {
    res.set('WWW-Authenticate', 'Basic realm="SG News Admin"');
    return res.status(401).send('Authentication required');
  }

  next();
}

async function mailControl(pathname, options={}) {
  const response = await fetch(MAIL_CONTROL_URL + pathname, {
    ...options,
    headers: {
      'X-Admin-Token': ADMIN_TOKEN,
      ...(options.headers || {})
    }
  });

  const raw = await response.text();
  let data;
  try { data = raw ? JSON.parse(raw) : null; } catch { data = raw; }

  if (!response.ok) {
    throw new Error(`Mail importer control ${response.status}: ${typeof data === 'string' ? data : JSON.stringify(data)}`);
  }
  return data;
}

const apiLimiter = rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: true, legacyHeaders: false });

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '2mb' }));
app.use(route('/assets'), express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));

app.get(route(), async (req,res,next) => {
  try {
    const db = await dbPromise;
    const q = String(req.query.q || '').trim();
    const category = String(req.query.category || '').trim();
    const tag = String(req.query.tag || '').trim();
    const type = String(req.query.type || '').trim();

    const clauses = ['is_hidden=0'];
    const args = [];
    if (q) { clauses.push('(title LIKE ? OR standfirst LIKE ? OR body_html LIKE ?)'); args.push('%'+q+'%','%'+q+'%','%'+q+'%'); }
    if (category) { clauses.push('id IN (SELECT article_id FROM article_categories WHERE category=?)'); args.push(category); }
    if (tag) { clauses.push('id IN (SELECT article_id FROM article_tags WHERE tag=?)'); args.push(tag); }
    if (type) { clauses.push('briefing_type=?'); args.push(type); }

    const articles = await db.all(
      `SELECT * FROM articles WHERE ${clauses.join(' AND ')} ORDER BY updated_at DESC LIMIT 100`,
      ...args
    );
    const categories = await db.all(`
      SELECT ac.category, COUNT(*) AS count
      FROM article_categories ac
      JOIN articles a ON a.id = ac.article_id
      WHERE a.is_hidden=0
      GROUP BY ac.category
      ORDER BY ac.category
    `);
    const tags = await db.all(`
      SELECT at.tag, COUNT(*) AS count
      FROM article_tags at
      JOIN articles a ON a.id = at.article_id
      WHERE a.is_hidden=0
      GROUP BY at.tag
      ORDER BY at.tag
    `);
    const types = await db.all('SELECT DISTINCT briefing_type FROM articles WHERE is_hidden=0 ORDER BY briefing_type');

    const filterUrl = (changes={}) => {
      const params = new URLSearchParams();
      const next = {
        q,
        category,
        tag,
        type,
        ...changes
      };
      for (const [key, value] of Object.entries(next)) {
        if (value) params.set(key, value);
      }
      const query = params.toString();
      return publicPath() + (query ? '?' + query : '');
    };

    const cards = articles.map(a => {
      const newOrUpdated = a.updated_at === a.published_at ? 'New' : 'Updated';
      return `<article class="card">
        <div class="badges">
          <span class="badge">${esc(newOrUpdated)}</span>
          <span class="badge status-${esc(a.status.toLowerCase())}">${esc(a.status)}</span>
          <span class="badge">${esc(a.primary_category)}</span>
        </div>
        <h2><a href="${publicPath(encodeURIComponent(a.slug))}">${esc(a.title)}</a></h2>
        <p>${esc(a.standfirst)}</p>
        <div class="meta">Published ${new Date(a.published_at).toLocaleDateString('en-GB')} · Updated ${new Date(a.updated_at).toLocaleDateString('en-GB')} · ${esc(a.project_source || a.briefing_type)}</div>
      </article>`;
    }).join('');

    const body = `
      <h1>SG News</h1>
      <p class="intro">A searchable record of recurring briefings, research updates and evolving articles. Important pieces rise when they are materially updated.</p>

      <form class="toolbar" method="get" action="${publicPath()}">
        <input type="search" name="q" value="${esc(q)}" placeholder="Search SG News">
        <select name="type"><option value="">All briefing types</option>${types.map(t=>`<option ${t.briefing_type===type?'selected':''}>${esc(t.briefing_type)}</option>`).join('')}</select>
        ${category ? `<input type="hidden" name="category" value="${esc(category)}">` : ''}
        ${tag ? `<input type="hidden" name="tag" value="${esc(tag)}">` : ''}
        <button type="submit">Search</button>
      </form>

      <div class="news-grid">
        <aside class="filter-sidebar filter-sidebar-left">
          <div class="filter-panel">
            <h2>Categories</h2>
            <a class="filter-link ${!category ? 'active' : ''}" href="${filterUrl({category:''})}">
              <span>All categories</span>
            </a>
            ${categories.map(c => `
              <a class="filter-link ${c.category===category ? 'active' : ''}" href="${filterUrl({category:c.category})}">
                <span>${esc(c.category)}</span><span class="filter-count">${Number(c.count)}</span>
              </a>`).join('')}
          </div>
        </aside>

        <section class="article-list">
          ${(category || tag) ? `<div class="active-filters">
            ${category ? `<span class="active-filter">Category: ${esc(category)} <a href="${filterUrl({category:''})}" aria-label="Clear category filter">×</a></span>` : ''}
            ${tag ? `<span class="active-filter">Tag: ${esc(tag)} <a href="${filterUrl({tag:''})}" aria-label="Clear tag filter">×</a></span>` : ''}
          </div>` : ''}
          ${cards || '<p class="empty">No articles matched that search.</p>'}
        </section>

        <aside class="filter-sidebar filter-sidebar-right">
          <div class="filter-panel">
            <h2>Tags</h2>
            <div class="tag-list">
              ${tags.map(t => `
                <a class="tag-link ${t.tag===tag ? 'active' : ''}" href="${filterUrl({tag:t.tag})}">
                  <span>${esc(t.tag)}</span><span class="filter-count">${Number(t.count)}</span>
                </a>`).join('') || '<p class="meta">No tags yet.</p>'}
            </div>
          </div>
        </aside>
      </div>`;
    res.send(layout('Home', body));
  } catch (e) { next(e); }
});

app.get(route('/:slug'), async (req,res,next) => {
  try {
    const article = await getArticleBySlug(req.params.slug);
    if (!article || article.is_hidden) return res.status(404).send(layout('Not found','<h1>Not found</h1><p>This article is unavailable.</p>'));

    const db = await dbPromise;
    await db.run('UPDATE articles SET visit_count = visit_count + 1 WHERE id=?', article.id);
    article.visit_count += 1;

    const schema = {
      '@context':'https://schema.org',
      '@type':'NewsArticle',
      headline: article.title,
      datePublished: article.published_at,
      dateModified: article.updated_at,
      mainEntityOfPage: articleUrl(article.slug),
      articleSection: article.primary_category,
      keywords: article.tags.join(', ')
    };

    const sourceHtml = article.sources.length ? `<section class="sources"><h2>Sources</h2><ol>${article.sources.map(s=>`<li><a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">${esc(s.label)}</a></li>`).join('')}</ol></section>` : '';
    const revisionHtml = article.revisions.length ? `<section class="revisions"><h2>Revision history</h2><ol>${article.revisions.map(r=>`<li><strong>${new Date(r.changed_at).toLocaleString('en-GB')}</strong>: ${esc(r.summary)}</li>`).join('')}</ol></section>` : '';
    const changed = article.what_changed ? `<aside class="callout"><strong>What changed</strong><p>${esc(article.what_changed)}</p></aside>` : '';
    const tags = article.tags.length ? `<p class="meta">Tags: ${article.tags.map(esc).join(', ')}</p>` : '';

    const body = `
      <article>
        <header class="article-header">
          <div class="badges">
            <span class="badge">${article.updated_at === article.published_at ? 'New' : 'Updated'}</span>
            <span class="badge status-${esc(article.status.toLowerCase())}">${esc(article.status)}</span>
            <span class="badge">${esc(article.primary_category)}</span>
          </div>
          <h1>${esc(article.title)}</h1>
          <p class="standfirst">${esc(article.standfirst)}</p>
          <div class="meta">Published ${new Date(article.published_at).toLocaleString('en-GB')} · Last updated ${new Date(article.updated_at).toLocaleString('en-GB')} · Source: ${esc(article.project_source || article.briefing_type)} · Views: ${article.visit_count}</div>
          ${tags}
        </header>
        ${changed}
        <div class="article-body">${article.body_html}</div>
        ${sourceHtml}
        ${revisionHtml}
      </article>`;

    const head = `<link rel="canonical" href="${articleUrl(article.slug)}">
<meta property="og:type" content="article">
<meta property="og:title" content="${esc(article.title)}">
<meta property="og:description" content="${esc(article.standfirst)}">
<meta property="og:url" content="${articleUrl(article.slug)}">
<script type="application/ld+json">${JSON.stringify(schema).replace(/</g,'\\u003c')}</script>`;

    res.send(layout(article.title, body, head));
  } catch (e) { next(e); }
});

app.get(route('/sitemap.xml'), async (req,res,next) => {
  try {
    const db = await dbPromise;
    const rows = await db.all('SELECT slug,updated_at FROM articles WHERE is_hidden=0 ORDER BY updated_at DESC');
    res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${rows.map(r=>`<url><loc>${articleUrl(r.slug)}</loc><lastmod>${r.updated_at}</lastmod></url>`).join('\n')}
</urlset>`);
  } catch (e) { next(e); }
});

app.get(route('/robots.txt'), (req,res) => {
  res.type('text/plain').send(`User-agent: *
Allow: ${publicPath() === '/' ? '/' : publicPath() + '/'}
Sitemap: ${SITE_URL}${publicPath('sitemap.xml')}
`);
});

app.use(route('/api'), apiLimiter, auth);

app.get(route('/api/articles'), async (req,res,next) => {
  try {
    const db = await dbPromise;
    const rows = await db.all('SELECT id,slug,title,status,primary_category,briefing_type,project_source,published_at,updated_at,is_hidden,visit_count FROM articles ORDER BY updated_at DESC LIMIT 200');
    res.json(rows);
  } catch(e){ next(e); }
});

app.get(route('/api/articles/:slug'), async (req,res,next) => {
  try {
    const article = await getArticleBySlug(req.params.slug);
    if (!article) return res.status(404).json({error:'Not found'});
    res.json(article);
  } catch(e){ next(e); }
});

app.post(route('/api/articles'), async (req,res,next) => {
  try {
    const db = await dbPromise;
    const title = String(req.body.title || '').trim();
    if (!title) return res.status(400).json({error:'title is required'});

    const requestedSlug = String(req.body.slug || '').trim();
    const slug = requestedSlug || slugify(title, { lower:true, strict:true });
    const existing = await db.get('SELECT id FROM articles WHERE slug=?', slug);
    if (existing) return res.status(409).json({error:'slug already exists', slug});

    const published = req.body.published_at || nowIso();
    const updated = req.body.updated_at || published;
    const status = req.body.status || 'Developing';
    const primary = req.body.primary_category || 'General';
    const categories = normalizeList(req.body.categories);
    if (!categories.includes(primary)) categories.unshift(primary);
    const tags = normalizeList(req.body.tags);
    const sources = Array.isArray(req.body.sources) ? req.body.sources : [];

    const result = await db.run(
      `INSERT INTO articles (slug,title,standfirst,body_html,status,primary_category,briefing_type,project_source,published_at,updated_at,what_changed,is_hidden)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      slug, title, String(req.body.standfirst || ''), cleanHtml(String(req.body.body_html || '')), status,
      primary, String(req.body.briefing_type || 'Briefing'), String(req.body.project_source || ''),
      published, updated, String(req.body.what_changed || '').slice(0,1000), req.body.is_hidden ? 1 : 0
    );

    for (const c of categories) await db.run('INSERT OR IGNORE INTO article_categories(article_id,category) VALUES (?,?)', result.lastID, c);
    for (const t of tags) await db.run('INSERT OR IGNORE INTO article_tags(article_id,tag) VALUES (?,?)', result.lastID, t);
    for (const s of sources) {
      if (s && s.url) await db.run('INSERT INTO article_sources(article_id,label,url) VALUES (?,?,?)', result.lastID, String(s.label || s.url), String(s.url));
    }
    await db.run('INSERT INTO revisions(article_id,changed_at,summary) VALUES (?,?,?)', result.lastID, updated, String(req.body.revision_summary || 'Initial publication'));
    res.status(201).json({ok:true, slug, url:articleUrl(slug)});
  } catch(e){ next(e); }
});

app.put(route('/api/articles/:slug'), async (req,res,next) => {
  try {
    const db = await dbPromise;
    const article = await db.get('SELECT * FROM articles WHERE slug=?', req.params.slug);
    if (!article) return res.status(404).json({error:'Not found'});

    const newSlug = String(req.body.slug || article.slug);
    const updated = req.body.updated_at || nowIso();
    const title = req.body.title ?? article.title;
    const standfirst = req.body.standfirst ?? article.standfirst;
    const bodyHtml = req.body.body_html !== undefined ? cleanHtml(String(req.body.body_html)) : article.body_html;
    const status = req.body.status ?? article.status;
    const primary = req.body.primary_category ?? article.primary_category;
    const briefingType = req.body.briefing_type ?? article.briefing_type;
    const projectSource = req.body.project_source ?? article.project_source;
    const whatChanged = String(req.body.what_changed ?? article.what_changed).slice(0,1000);
    const hidden = req.body.is_hidden === undefined ? article.is_hidden : (req.body.is_hidden ? 1 : 0);

    await db.run(
      `UPDATE articles SET slug=?,title=?,standfirst=?,body_html=?,status=?,primary_category=?,briefing_type=?,project_source=?,updated_at=?,what_changed=?,is_hidden=? WHERE id=?`,
      newSlug,title,standfirst,bodyHtml,status,primary,briefingType,projectSource,updated,whatChanged,hidden,article.id
    );

    if (req.body.categories !== undefined) {
      const categories = normalizeList(req.body.categories);
      if (!categories.includes(primary)) categories.unshift(primary);
      await db.run('DELETE FROM article_categories WHERE article_id=?', article.id);
      for (const c of categories) await db.run('INSERT OR IGNORE INTO article_categories(article_id,category) VALUES (?,?)', article.id, c);
    }

    if (req.body.tags !== undefined) {
      await db.run('DELETE FROM article_tags WHERE article_id=?', article.id);
      for (const t of normalizeList(req.body.tags)) await db.run('INSERT OR IGNORE INTO article_tags(article_id,tag) VALUES (?,?)', article.id, t);
    }

    if (req.body.sources !== undefined && Array.isArray(req.body.sources)) {
      await db.run('DELETE FROM article_sources WHERE article_id=?', article.id);
      for (const s of req.body.sources) if (s && s.url) await db.run('INSERT INTO article_sources(article_id,label,url) VALUES (?,?,?)', article.id, String(s.label || s.url), String(s.url));
    }

    await db.run('INSERT INTO revisions(article_id,changed_at,summary) VALUES (?,?,?)', article.id, updated, String(req.body.revision_summary || whatChanged || 'Article updated'));
    res.json({ok:true, slug:newSlug, url:articleUrl(newSlug)});
  } catch(e){ next(e); }
});

app.delete(route('/api/articles/:slug'), async (req,res,next) => {
  try {
    const db = await dbPromise;
    const article = await db.get('SELECT id FROM articles WHERE slug=?', req.params.slug);
    if (!article) return res.status(404).json({error:'Not found'});
    await db.run('UPDATE articles SET is_hidden=1, updated_at=? WHERE id=?', nowIso(), article.id);
    await db.run('INSERT INTO revisions(article_id,changed_at,summary) VALUES (?,?,?)', article.id, nowIso(), 'Article hidden');
    res.json({ok:true, hidden:true});
  } catch(e){ next(e); }
});


app.get(route('/admin/mail'), adminAuth, async (req,res) => {
  try {
    const status = await mailControl('/status');
    const lastCheck = status.last_check ? new Date(status.last_check).toLocaleString('en-GB') : 'Never';
    const lastResult = status.last_result || {};
    const body = `
      <section class="card">
        <div class="badges">
          <span class="badge">Admin</span>
          <span class="badge status-confirmed">Mail Importer</span>
        </div>
        <h1>SG News Mail Importer</h1>
        <p>Check the articles mailbox immediately instead of waiting for the hourly automatic check.</p>
        <div class="meta">
          Last check: ${esc(lastCheck)}<br>
          Automatic interval: ${Math.round((status.poll_seconds || 3600) / 60)} minutes<br>
          Last result: ${Number(lastResult.found || 0)} found, ${Number(lastResult.processed || 0)} processed, ${Number(lastResult.errors || 0)} errors
        </div>
        <form method="post" action="${route('/admin/mail/check')}">
          <button type="submit">Check mailbox now</button>
        </form>
      </section>`;
    res.send(layout('Mail Admin', body, '<meta name="robots" content="noindex,nofollow">'));
  } catch (error) {
    res.status(500).send(layout('Mail Admin', `<h1>Mail Admin</h1><p>${esc(error.message || error)}</p>`, '<meta name="robots" content="noindex,nofollow">'));
  }
});

app.post(route('/admin/mail/check'), adminAuth, async (req,res) => {
  try {
    const result = await mailControl('/check-now', { method:'POST' });
    const body = `
      <section class="card">
        <div class="badges">
          <span class="badge">Admin</span>
          <span class="badge status-confirmed">Mail Importer</span>
        </div>
        <h1>Mailbox checked</h1>
        <p>Found ${Number(result.found || 0)} new message(s), processed ${Number(result.processed || 0)}, errors ${Number(result.errors || 0)}.</p>
        <p><a href="${route('/admin/mail')}">Back to mail admin</a></p>
      </section>`;
    res.send(layout('Mailbox Checked', body, '<meta name="robots" content="noindex,nofollow">'));
  } catch (error) {
    res.status(500).send(layout('Mail Admin', `<h1>Mail Admin</h1><p>${esc(error.message || error)}</p>`, '<meta name="robots" content="noindex,nofollow">'));
  }
});

app.get('/health', (req,res) => res.json({ok:true, service:'sg-news'}));

app.use((err,req,res,next) => {
  console.error(err);
  res.status(500).json({error:'Internal server error'});
});

initDb().then(() => {
  app.listen(PORT, () => console.log(`SG News listening on port ${PORT}; public path ${PUBLIC_PATH}; route base ${ROUTE_BASE || '/'}`));
}).catch(err => {
  console.error(err);
  process.exit(1);
});
