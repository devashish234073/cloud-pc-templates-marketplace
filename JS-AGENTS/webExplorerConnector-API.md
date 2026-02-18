WEB SEARCH API (http://localhost:3006)

GET /search?q=your_query_here
Performs a web search using DuckDuckGo (HTML endpoint) and returns top 5 results.

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
      "title": "Node.js — Download Node.js",
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


Error Responses

Missing query parameter:

{
  "error": "Missing query parameter 'q'"
}


Invalid endpoint:

{
  "error": "Not Found"
}


Server error (upstream issue / network issue):

{
  "error": "error message"
}

Behavior Notes
Returns maximum 5 results.
Scrapes DuckDuckGo HTML search results.
Uses basic HTML parsing (no official API).
Requires internet connectivity.
Heavy usage may result in rate limiting by search provider.
Response time depends on upstream search response.
