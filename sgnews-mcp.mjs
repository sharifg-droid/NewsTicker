import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const API_BASE = (process.env.SGNEWS_API_BASE || "https://booksystems.co.uk/news/api").replace(/\/$/, "");
const API_KEY = process.env.SGNEWS_API_KEY || "";

if (!API_KEY) {
  console.error("SGNEWS_API_KEY is required");
  process.exit(1);
}

async function api(path = "", options = {}) {
  const response = await fetch(API_BASE + path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": API_KEY,
      ...(options.headers || {})
    }
  });

  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  if (!response.ok) {
    throw new Error(`SG News API ${response.status}: ${typeof data === "string" ? data : JSON.stringify(data)}`);
  }

  return data;
}

function asText(value) {
  return {
    content: [
      {
        type: "text",
        text: typeof value === "string" ? value : JSON.stringify(value, null, 2)
      }
    ]
  };
}

const server = new McpServer({
  name: "sg-news",
  version: "1.0.0"
});

server.registerTool(
  "search_articles",
  {
    title: "Search SG News",
    description: "Search recent SG News articles by title, project source, briefing type, category or slug before deciding whether to create a new article or update an existing one.",
    inputSchema: {
      query: z.string().default(""),
      limit: z.number().int().min(1).max(100).default(25)
    }
  },
  async ({ query, limit }) => {
    const response = await api("/articles");
    const rows = Array.isArray(response)
      ? response
      : Array.isArray(response?.articles)
        ? response.articles
        : Array.isArray(response?.data)
          ? response.data
          : null;

    if (!rows) {
      throw new Error("Unexpected SG News article-list response: " + JSON.stringify(response));
    }

    const q = query.trim().toLowerCase();

    const filtered = q
      ? rows.filter((row) =>
          [
            row.title,
            row.slug,
            row.status,
            row.primary_category,
            row.briefing_type,
            row.project_source
          ].some((value) => String(value || "").toLowerCase().includes(q))
        )
      : rows;

    return asText(filtered.slice(0, limit));
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
  async ({ slug }) => asText(await api("/articles/" + encodeURIComponent(slug)))
);

server.registerTool(
  "publish_article",
  {
    title: "Publish SG News Article",
    description: "Create a new SG News article. Search first to avoid duplicates. Preserve full source provenance.",
    inputSchema: {
      title: z.string().min(1),
      standfirst: z.string().default(""),
      body_html: z.string().default(""),
      status: z.enum(["Confirmed", "Developing", "Speculative", "Superseded"]).default("Developing"),
      primary_category: z.string().default("General"),
      categories: z.array(z.string()).default([]),
      tags: z.array(z.string()).default([]),
      briefing_type: z.string().default("Briefing"),
      project_source: z.string().default(""),
      what_changed: z.string().max(1000).default(""),
      sources: z.array(
        z.object({
          label: z.string().min(1),
          url: z.string().url()
        })
      ).default([]),
      revision_summary: z.string().default("Initial publication")
    }
  },
  async (input) => asText(await api("/articles", {
    method: "POST",
    body: JSON.stringify(input)
  }))
);

server.registerTool(
  "update_article",
  {
    title: "Update SG News Article",
    description: "Update an existing SG News article in place while preserving its original publication date and, normally, its stable slug.",
    inputSchema: {
      slug: z.string().min(1),
      title: z.string().optional(),
      standfirst: z.string().optional(),
      body_html: z.string().optional(),
      status: z.enum(["Confirmed", "Developing", "Speculative", "Superseded"]).optional(),
      primary_category: z.string().optional(),
      categories: z.array(z.string()).optional(),
      tags: z.array(z.string()).optional(),
      briefing_type: z.string().optional(),
      project_source: z.string().optional(),
      what_changed: z.string().max(1000).optional(),
      sources: z.array(
        z.object({
          label: z.string().min(1),
          url: z.string().url()
        })
      ).optional(),
      revision_summary: z.string().default("Article updated")
    }
  },
  async ({ slug, ...changes }) => asText(await api("/articles/" + encodeURIComponent(slug), {
    method: "PUT",
    body: JSON.stringify(changes)
  }))
);

server.registerTool(
  "hide_article",
  {
    title: "Hide SG News Article",
    description: "Hide an SG News article from the public site without permanently deleting its database record.",
    inputSchema: {
      slug: z.string().min(1)
    }
  },
  async ({ slug }) => asText(await api("/articles/" + encodeURIComponent(slug), {
    method: "DELETE"
  }))
);

const transport = new StdioServerTransport();
await server.connect(transport);
