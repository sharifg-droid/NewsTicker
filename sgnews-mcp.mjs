import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import sqlite3 from "sqlite3";
import { open } from "sqlite";
import sanitizeHtml from "sanitize-html";
import slugify from "slugify";
import path from "path";

const DB_FILE = process.env.DB_FILE
  ? path.resolve(process.cwd(), process.env.DB_FILE)
  : "/var/www/f745a440-31f9-4b1a-af85-23f0b5ccb9b7/sgnews/data/sgnews.sqlite";

const SITE_URL = (process.env.SITE_URL || "https://booksystems.co.uk").replace(/\/$/, "");
const PUBLIC_PATH = process.env.PUBLIC_PATH || "/news";

const db = await open({ filename: DB_FILE, driver: sqlite3.Database });

function cleanHtml(html = "") {
  return sanitizeHtml(html, {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat([
      "img","figure","figcaption","table","thead","tbody","tr","th","td"
    ]),
    allowedAttributes: {
      a: ["href","target","rel"],
      img: ["src","alt","title","width","height","loading"],
      "*": ["class"]
    },
    allowedSchemes: ["http","https","mailto"]
  });
}

function normalizeList(value) {
  if (!value) return [];
  if (Array.isArray(value)) return [...new Set(value.map(v => String(v).trim()).filter(Boolean))];
  return [...new Set(String(value).split(",").map(v => v.trim()).filter(Boolean))];
}

function nowIso() {
  return new Date().toISOString();
}

function articleUrl(slug) {
  return SITE_URL + PUBLIC_PATH + "/" + encodeURIComponent(slug);
}

async function fullArticleBySlug(slug) {
  const article = await db.get("SELECT * FROM articles WHERE slug=?", slug);
  if (!article) return null;
  article.categories = (await db.all(
    "SELECT category FROM article_categories WHERE article_id=? ORDER BY category",
    article.id
  )).map(r => r.category);
  article.tags = (await db.all(
    "SELECT tag FROM article_tags WHERE article_id=? ORDER BY tag",
    article.id
  )).map(r => r.tag);
  article.sources = await db.all(
    "SELECT label,url FROM article_sources WHERE article_id=? ORDER BY id",
    article.id
  );
  article.revisions = await db.all(
    "SELECT changed_at,summary FROM revisions WHERE article_id=? ORDER BY changed_at DESC,id DESC",
    article.id
  );
  article.url = articleUrl(article.slug);
  return article;
}

function asText(value) {
  return {
    content: [{
      type: "text",
      text: typeof value === "string" ? value : JSON.stringify(value, null, 2)
    }]
  };
}

const server = new McpServer({
  name: "sg-news",
  version: "1.1.0"
});

server.registerTool(
  "search_articles",
  {
    title: "Search SG News",
    description: "Search SG News articles before deciding whether new information should create a new article or update an existing one.",
    inputSchema: {
      query: z.string().default(""),
      limit: z.number().int().min(1).max(100).default(25)
    }
  },
  async ({ query, limit }) => {
    const q = query.trim();
    let rows;
    if (!q) {
      rows = await db.all(
        "SELECT id,slug,title,status,primary_category,briefing_type,project_source,published_at,updated_at,is_hidden,visit_count FROM articles ORDER BY updated_at DESC LIMIT ?",
        limit
      );
    } else {
      const like = "%" + q + "%";
      rows = await db.all(
        `SELECT DISTINCT a.id,a.slug,a.title,a.status,a.primary_category,a.briefing_type,a.project_source,a.published_at,a.updated_at,a.is_hidden,a.visit_count
         FROM articles a
         LEFT JOIN article_categories c ON c.article_id=a.id
         LEFT JOIN article_tags t ON t.article_id=a.id
         WHERE a.title LIKE ? OR a.slug LIKE ? OR a.primary_category LIKE ? OR a.briefing_type LIKE ? OR a.project_source LIKE ? OR c.category LIKE ? OR t.tag LIKE ?
         ORDER BY a.updated_at DESC
         LIMIT ?`,
        like, like, like, like, like, like, like, limit
      );
    }
    return asText(rows);
  }
);

server.registerTool(
  "get_article",
  {
    title: "Get SG News Article",
    description: "Retrieve the full SG News record for one article, including categories, tags, sources and revision history.",
    inputSchema: {
      slug: z.string().min(1)
    }
  },
  async ({ slug }) => {
    const article = await fullArticleBySlug(slug);
    if (!article) throw new Error("Article not found: " + slug);
    return asText(article);
  }
);

server.registerTool(
  "publish_article",
  {
    title: "Publish SG News Article",
    description: "Create a new SG News article. Search first to avoid duplicates and preserve source provenance.",
    inputSchema: {
      title: z.string().min(1),
      standfirst: z.string().default(""),
      body_html: z.string().default(""),
      status: z.enum(["Confirmed","Developing","Speculative","Superseded"]).default("Developing"),
      primary_category: z.string().default("General"),
      categories: z.array(z.string()).default([]),
      tags: z.array(z.string()).default([]),
      briefing_type: z.string().default("Briefing"),
      project_source: z.string().default(""),
      what_changed: z.string().max(1000).default(""),
      sources: z.array(z.object({
        label: z.string().min(1),
        url: z.string().url()
      })).default([]),
      revision_summary: z.string().default("Initial publication")
    }
  },
  async (input) => {
    const slug = slugify(input.title, { lower: true, strict: true });
    const existing = await db.get("SELECT id FROM articles WHERE slug=?", slug);
    if (existing) throw new Error("Article slug already exists: " + slug);

    const published = nowIso();
    const result = await db.run(
      `INSERT INTO articles
       (slug,title,standfirst,body_html,status,primary_category,briefing_type,project_source,published_at,updated_at,what_changed,is_hidden)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,0)`,
      slug,
      input.title,
      input.standfirst,
      cleanHtml(input.body_html),
      input.status,
      input.primary_category,
      input.briefing_type,
      input.project_source,
      published,
      published,
      input.what_changed
    );

    const categories = normalizeList(input.categories);
    if (!categories.includes(input.primary_category)) categories.unshift(input.primary_category);

    for (const c of categories) {
      await db.run("INSERT OR IGNORE INTO article_categories(article_id,category) VALUES (?,?)", result.lastID, c);
    }
    for (const t of normalizeList(input.tags)) {
      await db.run("INSERT OR IGNORE INTO article_tags(article_id,tag) VALUES (?,?)", result.lastID, t);
    }
    for (const s of input.sources) {
      await db.run("INSERT INTO article_sources(article_id,label,url) VALUES (?,?,?)", result.lastID, s.label, s.url);
    }
    await db.run(
      "INSERT INTO revisions(article_id,changed_at,summary) VALUES (?,?,?)",
      result.lastID,
      published,
      input.revision_summary
    );

    return asText({ ok: true, slug, url: articleUrl(slug) });
  }
);

server.registerTool(
  "update_article",
  {
    title: "Update SG News Article",
    description: "Update an existing SG News article in place while preserving its original publication date and stable slug.",
    inputSchema: {
      slug: z.string().min(1),
      title: z.string().optional(),
      standfirst: z.string().optional(),
      body_html: z.string().optional(),
      status: z.enum(["Confirmed","Developing","Speculative","Superseded"]).optional(),
      primary_category: z.string().optional(),
      categories: z.array(z.string()).optional(),
      tags: z.array(z.string()).optional(),
      briefing_type: z.string().optional(),
      project_source: z.string().optional(),
      what_changed: z.string().max(1000).optional(),
      sources: z.array(z.object({
        label: z.string().min(1),
        url: z.string().url()
      })).optional(),
      revision_summary: z.string().default("Article updated")
    }
  },
  async ({ slug, ...changes }) => {
    const article = await db.get("SELECT * FROM articles WHERE slug=?", slug);
    if (!article) throw new Error("Article not found: " + slug);

    const updated = nowIso();
    await db.run(
      `UPDATE articles SET
        title=?, standfirst=?, body_html=?, status=?, primary_category=?,
        briefing_type=?, project_source=?, updated_at=?, what_changed=?
       WHERE id=?`,
      changes.title ?? article.title,
      changes.standfirst ?? article.standfirst,
      changes.body_html !== undefined ? cleanHtml(changes.body_html) : article.body_html,
      changes.status ?? article.status,
      changes.primary_category ?? article.primary_category,
      changes.briefing_type ?? article.briefing_type,
      changes.project_source ?? article.project_source,
      updated,
      changes.what_changed ?? article.what_changed,
      article.id
    );

    const primary = changes.primary_category ?? article.primary_category;

    if (changes.categories !== undefined) {
      const categories = normalizeList(changes.categories);
      if (!categories.includes(primary)) categories.unshift(primary);
      await db.run("DELETE FROM article_categories WHERE article_id=?", article.id);
      for (const c of categories) {
        await db.run("INSERT OR IGNORE INTO article_categories(article_id,category) VALUES (?,?)", article.id, c);
      }
    }

    if (changes.tags !== undefined) {
      await db.run("DELETE FROM article_tags WHERE article_id=?", article.id);
      for (const t of normalizeList(changes.tags)) {
        await db.run("INSERT OR IGNORE INTO article_tags(article_id,tag) VALUES (?,?)", article.id, t);
      }
    }

    if (changes.sources !== undefined) {
      await db.run("DELETE FROM article_sources WHERE article_id=?", article.id);
      for (const s of changes.sources) {
        await db.run("INSERT INTO article_sources(article_id,label,url) VALUES (?,?,?)", article.id, s.label, s.url);
      }
    }

    await db.run(
      "INSERT INTO revisions(article_id,changed_at,summary) VALUES (?,?,?)",
      article.id,
      updated,
      changes.revision_summary || changes.what_changed || "Article updated"
    );

    return asText({ ok: true, slug, url: articleUrl(slug) });
  }
);

server.registerTool(
  "hide_article",
  {
    title: "Hide SG News Article",
    description: "Hide an SG News article from the public site without permanently deleting it.",
    inputSchema: {
      slug: z.string().min(1)
    }
  },
  async ({ slug }) => {
    const article = await db.get("SELECT id FROM articles WHERE slug=?", slug);
    if (!article) throw new Error("Article not found: " + slug);
    const updated = nowIso();
    await db.run("UPDATE articles SET is_hidden=1, updated_at=? WHERE id=?", updated, article.id);
    await db.run(
      "INSERT INTO revisions(article_id,changed_at,summary) VALUES (?,?,?)",
      article.id,
      updated,
      "Article hidden"
    );
    return asText({ ok: true, hidden: true, slug });
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
