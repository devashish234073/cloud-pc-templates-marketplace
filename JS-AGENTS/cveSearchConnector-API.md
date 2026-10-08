# CVE Search Connector – API Reference
"agentId": "cve-search-connector"
**Port:** `3040` | **Base URL:** `http://localhost:3040`

## Endpoints

GET /cve/search?cveId=<cve-id>
Query params: cveId (required)

Sample Response:
{
  "success": true,
  "cached": false,
  "data": {
    "id": "<cve-id>",
    "published": "<published-date>",
    "lastModified": "<lastModified-date>",
    "status": "<status>",
    "description": "<short-description>",
    "primaryScore": "<primary-score>",
    "primarySeverity": "<primary-severity>",
    "primaryVector": "<primary-vector>",
    "weaknesses": ["<weakness-identifier>"],
    "affectedSoftware": [
      {
        "vendor": "<vendor>",
        "product": "<product>",
        "version": "<version>",
        "versionEndIncluding": "<version-end-including>"
      }
    ],
    "references": [
      {
        "url": "<reference-url>",
        "tags": ["<tag>"]
      }
    ],
    "sourceIdentifier": "<source-identifier>"
  }
}
POST /cve/search
// Request Body
{ "cveId": "<cve-id>" }

Sample Response:
{
  "success": true,
  "cached": false,
  "data": {
    "id": "<cve-id>",
    "published": "<published-date>",
    "lastModified": "<lastModified-date>",
    "status": "<status>",
    "description": "<short-description>",
    "primaryScore": "<primary-score>",
    "primarySeverity": "<primary-severity>",
    "primaryVector": "<primary-vector>",
    "weaknesses": ["<weakness-identifier>"],
    "affectedSoftware": [
      {
        "vendor": "<vendor>",
        "product": "<product>",
        "version": "<version>",
        "versionEndIncluding": "<version-end-including>"
      }
    ],
    "references": [
      {
        "url": "<reference-url>",
        "tags": ["<tag>"]
      }
    ],
    "sourceIdentifier": "<source-identifier>"
  }
}

GET /cve/status

Sample Response:
{
  "status": "operational",
  "cacheStats": { "size": "<cache-size>", "maxAge": "<max-age-seconds>" },
  "rateLimiter": { "requestsPerWindow": "<requests-per-window>", "windowMs": "<window-ms>" }
}

GET /cve/recent?limit=<limit>

Sample Response:
{
  "success": true,
  "count": "<recent-count>",
  "recentSearches": [
    {
      "cveId": "<cve-id>",
      "timestamp": "<timestamp>",
      "summary": {
        "score": "<score>",
        "severity": "<severity>",
        "description": "<short-description>"
      }
    }
  ]
}

GET /cve/clear-cache

Sample Response:
{ "success": true, "message": "Cache cleared successfully", "clearedEntries": "<cleared-entries>" }
