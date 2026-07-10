# CVE Search Connector – API Reference
"agentId": "cve-search-connector"
**Port:** `3040` | **Base URL:** `http://localhost:3040`

## Quick Reference

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/health` | Health check + agent info |
| GET | `/cve/search?cveId=` | Search CVE by ID |
| POST | `/cve/search` | Search CVE with JSON body |
| GET | `/cve/status` | Cache & rate limit status |
| GET | `/cve/recent` | Recently searched CVEs |
| GET | `/cve/clear-cache` | Clear cache |

---

## Endpoints

### `GET /health`
```{
  "status": "UP",
  "version": "1.0",
  "type": "cve-search-agent",
  "features": {
    "freeApi": true,
    "noApiKeyRequired": true,
    "rateLimit": "5 requests per 30 seconds",
    "cacheTTL": "5 minutes"
  }
}

GET /cve/search?cveId=CVE-2026-41711
Query params: cveId (required)

{
  "success": true,
  "cached": false,
  "data": {
    "id": "CVE-2026-41711",
    "published": "2026-06-09T00:00:00.000",
    "lastModified": "2026-06-10T00:00:00.000",
    "status": "Analyzed",
    "description": "Applications using Spring Data Commons may be vulnerable to a Denial of Service (DoS) attack...",
    "primaryScore": 5.9,
    "primarySeverity": "MEDIUM",
    "primaryVector": "CVSS:3.1/AV:N/AC:H/PR:N/UI:N/S:U/C:N/I:N/A:H",
    "weaknesses": ["CWE-400: Uncontrolled Resource Consumption"],
    "affectedSoftware": [
      {
        "vendor": "vmware",
        "product": "spring_data_commons",
        "version": "4.0.0",
        "versionEndIncluding": "4.0.5"
      }
    ],
    "references": [
      {
        "url": "https://spring.io/security/cve-2026-41711",
        "tags": ["Vendor Advisory"]
      }
    ],
    "sourceIdentifier": "VMware"
  }
}
POST /cve/search
// Request Body
{ "cveId": "CVE-2026-41711" }

// Response same as GET
GET /cve/status
{
  "status": "operational",
  "cacheStats": { "size": 3, "maxAge": "300 seconds" },
  "rateLimiter": { "requestsPerWindow": 5, "windowMs": 30000 }
}
GET /cve/recent?limit=5
{
  "success": true,
  "count": 3,
  "recentSearches": [
    {
      "cveId": "CVE-2026-41711",
      "timestamp": "2026-06-13T10:30:00.000Z",
      "summary": {
        "score": 5.9,
        "severity": "MEDIUM",
        "description": "Applications using Spring Data Commons..."
      }
    }
  ]
}
GET /cve/clear-cache
{ "success": true, "message": "Cache cleared successfully", "clearedEntries": 3 }
