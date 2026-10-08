WEB SEARCH API (http://localhost:3031)
"agentId": "web-explorer"


GET /search?q=web_search_query_here
Performs a web search with the query passed. Use this when recent online data, official docs or recent event details are needed. e.g. scores, matches details, etc from web. Requests like search web or search online should use this agent.

Query Parameters:
q (required) → Search query

URL encode spaces using %20

Example: latest%20nodejs%20version

Returns response like:

{
  "query": "latest nodejs version",
  "count": 5,
  "results": [
    {
      "title": "Node.js - Download Node.js",
      "url": "https://nodejs.org/en"
    },
    {
      "title": "Node.js Releases",
      "url": "https://nodejs.org/en/about/releases"
    },
    {
      "title": "What’s New in Node.js",
      "url": "https://example.com/article"
    }
  ]
}

Behavior Notes
Returns maximum 5 results.
Scrapes DuckDuckGo HTML search results.
Uses basic HTML parsing (no official API).
