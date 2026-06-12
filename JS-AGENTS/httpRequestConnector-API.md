# HTTP Request Connector – API Reference

**Port:** `3039` | **Base URL:** `http://localhost:3039`

**Startup:** `node httpRequestConnector.js` (no `npm install` needed — zero dependencies)

Use this connector when the orchestrator needs to call any HTTP/HTTPS endpoint directly: testing a locally running Spring Boot app, hitting a REST API, polling a health check, or verifying a response without spinning up a full browser. Think of it as `curl` accessible over HTTP.

---

## Quick Reference

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/health` | Server status |
| POST | `/request` | Execute a single HTTP request |
| POST | `/batch` | Execute up to 20 requests sequentially |
| POST | `/probe` | Reachability check for up to 10 URLs (no body parse, parallel) |

---

## Endpoints

### `GET /health`
```json
{ "status": 200, "status": "UP", "version": "1.0", "type": "http-request-connector", "port": 3039 }
```

---

### `POST /request` — Single HTTP request

The core endpoint. Executes one outbound HTTP or HTTPS request and returns the full response.

**Body:**
```json
{
  "url":      "https://api.example.com/users",
  "method":   "POST",
  "headers":  { "Authorization": "Bearer abc123", "X-Custom": "value" },
  "body":     { "name": "Alice", "role": "admin" },
  "timeout":  10000,
  "rawBody":  false
}
```

| Field | Type | Required | Default | Notes |
|-------|------|----------|---------|-------|
| `url` | string | ✅ | — | Full URL including protocol |
| `method` | string | — | `GET` | GET, POST, PUT, PATCH, DELETE |
| `headers` | object | — | `{}` | Merged with auto-set `Content-Type` / `Content-Length` |
| `body` | object \| string | — | — | Object → serialised as JSON; string → sent as-is |
| `timeout` | number | — | `30000` | Milliseconds before request is aborted |
| `rawBody` | boolean | — | `false` | `true` = skip JSON parsing, always return raw string |

**Response:**
```json
{
  "status": 200,
  "message": "Request completed",
  "request": {
    "url": "https://api.example.com/users",
    "method": "POST",
    "headers": { "Authorization": "Bearer abc123" }
  },
  "response": {
    "statusCode": 201,
    "statusMessage": "Created",
    "headers": { "content-type": "application/json", "x-request-id": "abc" },
    "body": { "id": 42, "name": "Alice" },
    "rawBody": "{\"id\":42,\"name\":\"Alice\"}",
    "contentType": "application/json",
    "elapsedMs": 134
  }
}
```

`body` is auto-parsed as JSON when the response `Content-Type` is `application/json`. For all other types (HTML, plain text, XML) `body` and `rawBody` are both the raw string.

**Example — test a locally running Spring Boot app:**
```json
{
  "url": "http://localhost:8080/api/health",
  "method": "GET"
}
```

**Example — POST with auth header:**
```json
{
  "url": "http://localhost:8080/api/products",
  "method": "POST",
  "headers": { "Content-Type": "application/json", "Authorization": "Bearer token123" },
  "body": { "name": "Widget", "price": 9.99 }
}
```

---

### `POST /batch` — Sequential multi-request

Executes up to 20 requests one after another. Useful for a setup sequence (create resource → update it → verify) or for calling multiple endpoints to compare responses.

**Body:**
```json
{
  "requests": [
    { "url": "http://localhost:8080/api/health" },
    { "url": "http://localhost:8080/api/products", "method": "POST", "body": { "name": "Widget" } },
    { "url": "http://localhost:8080/api/products/1" }
  ],
  "stopOnError": true
}
```

| Field | Type | Default | Notes |
|-------|------|---------|-------|
| `requests` | array | — | Each entry has the same fields as `/request` body |
| `stopOnError` | boolean | `false` | Abort on first network error or 4xx/5xx response |

**Response:**
```json
{
  "status": 200,
  "message": "Batch completed",
  "total": 3,
  "completed": 3,
  "aborted": false,
  "results": [
    {
      "index": 0,
      "request": { "url": "http://localhost:8080/api/health", "method": "GET" },
      "response": { "statusCode": 200, "body": { "status": "UP" }, "elapsedMs": 12 }
    },
    { "index": 1, "request": { ... }, "response": { "statusCode": 201, ... } },
    { "index": 2, "request": { ... }, "response": { "statusCode": 200, ... } }
  ]
}
```

If a request fails (network error), its result entry has `{ "index": N, "url": "...", "error": "..." }` instead of a `response` field.

---

### `POST /probe` — Parallel reachability check

Fires GET requests to up to 10 URLs in parallel with a short timeout. Does not parse response bodies — only checks reachability and status code. Ideal for polling until a Spring Boot app finishes startup.

**Body:**
```json
{
  "urls": [
    "http://localhost:8080/api/health",
    "http://localhost:3038/health"
  ],
  "timeout": 3000
}
```

Single URL shorthand: `{ "url": "http://localhost:8080/api/health" }` also accepted.

| Field | Type | Default | Notes |
|-------|------|---------|-------|
| `urls` | string[] | — | Up to 10 URLs |
| `url` | string | — | Shorthand for a single URL |
| `timeout` | number | `5000` | Per-request timeout in ms |

**Response:**
```json
{
  "status": 200,
  "message": "Probe complete",
  "allReachable": true,
  "results": [
    { "url": "http://localhost:8080/api/health", "reachable": true,  "statusCode": 200, "elapsedMs": 45 },
    { "url": "http://localhost:3038/health",      "reachable": true,  "statusCode": 200, "elapsedMs": 8  }
  ]
}
```

Unreachable URLs return `{ "reachable": false, "error": "connect ECONNREFUSED ..." }`.

---

## Error responses

All errors return HTTP 200 (so the orchestrator always gets a JSON body) with a non-200 `status` field:

```json
{ "status": 400, "error": "Provide { url: \"...\" } in body" }
{ "status": 500, "error": "Request failed: connect ECONNREFUSED 127.0.0.1:8080" }
```

---

## Orchestrator usage patterns

**Poll until app is up (use with /probe in a retry loop):**
```
POST /probe  { "url": "http://localhost:8080/api/health", "timeout": 2000 }
→ reachable: false  →  wait, retry
→ reachable: true   →  proceed
```

**CRUD verification sequence (use /batch with stopOnError):**
```
POST /batch {
  requests: [
    { POST /api/products  body: { name: "Widget" } },   // create
    { GET  /api/products/1 },                           // verify created
    { PUT  /api/products/1  body: { name: "Updated" }}, // update
    { GET  /api/products/1 },                           // verify update
    { DELETE /api/products/1 },                         // delete
    { GET  /api/products/1 }                            // verify 404
  ],
  stopOnError: true
}
```

**Test with custom auth headers:**
```
POST /request {
  url: "http://localhost:8080/api/admin/users",
  method: "GET",
  headers: { "Authorization": "Bearer <token>" }
}
```