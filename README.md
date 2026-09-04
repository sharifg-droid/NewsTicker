# SG News

SG News is a deliberately small publishing system for recurring briefings, research updates and evolving articles.

It provides:

- a public dark-first news site
- search and simple filtering
- categories and tags
- article statuses such as Confirmed, Developing, Speculative and Superseded
- stable URLs
- published and last-updated dates
- a short "What changed" note
- revision history
- source links
- visit counts
- sitemap and structured NewsArticle metadata
- a private API protected by an API key

## Deployment

The application is intended to run at:

`https://booksystems.co.uk/news`

Set these environment variables on the host:

```
PORT=3000
BASE_PATH=/news
SITE_URL=https://booksystems.co.uk
SGNEWS_API_KEY=<long-random-secret>
DB_FILE=./data/sgnews.sqlite
TRUST_PROXY=1
```

Then run:

```
npm install
npm start
```

The `data` directory must be writable and should be included in backups.

## Publishing API

Authenticate using either:

`X-API-Key: <secret>`

or

`Authorization: Bearer <secret>`

### Create article

`POST /news/api/articles`

Example payload:

```json
{
  "title": "Example briefing",
  "standfirst": "A short explanation of what happened and why it matters.",
  "body_html": "<p>The article body.</p>",
  "status": "Developing",
  "primary_category": "Science",
  "categories": ["Science", "Space"],
  "tags": ["orbital manufacturing", "asteroid mining"],
  "briefing_type": "Weekly briefing",
  "project_source": "2130 Science Briefing",
  "what_changed": "",
  "sources": [
    {
      "label": "Example source",
      "url": "https://example.com/source"
    }
  ],
  "revision_summary": "Initial publication"
}
```

### Update article

`PUT /news/api/articles/:slug`

Only supplied fields are changed. Every update creates a revision entry.

### Hide article

`DELETE /news/api/articles/:slug`

This performs a soft delete by hiding the article. It does not destroy the record.

### Search/list from the API

`GET /news/api/articles`

`GET /news/api/articles/:slug`

## SG News publishing rule

The publishing client should search existing articles before creating a new one. If new information materially advances an existing article, update that article and preserve the stable slug wherever practical.

The visible article should keep its original publication date. Material revisions update the last-updated date, status where necessary, the under-100-word "What changed" note, source list and revision history.

## Notes

The current view counter is intentionally simple. It counts page requests rather than running a third-party analytics system. A later release can separate likely human visits from known crawler traffic.

RSS is intentionally omitted from version 1.
