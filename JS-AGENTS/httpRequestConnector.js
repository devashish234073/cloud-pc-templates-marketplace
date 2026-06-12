const http = require('http');
const https = require('https');
const url = require('url');

const PORT = 3039;
const VERSION = '1.0';

/* ================================================================
   REQUEST BODY PARSER
   ================================================================ */

function readBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', () => {
            try { resolve(body ? JSON.parse(body) : {}); }
            catch { reject(new Error('Invalid JSON body')); }
        });
        req.on('error', reject);
    });
}

/* ================================================================
   RESPONSE HELPERS
   ================================================================ */

function send(res, status, data) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status, ...data }, null, 2));
}

function err400(res, msg) { send(res, 400, { error: msg }); }
function err500(res, msg) { send(res, 500, { error: msg }); }

/* ================================================================
   CORE HTTP REQUEST EXECUTOR
   ================================================================ */

/**
 * Perform an outbound HTTP/HTTPS request.
 *
 * @param {object} opts
 * @param {string}  opts.url            - Full target URL (required)
 * @param {string}  [opts.method]       - HTTP verb (default: GET)
 * @param {object}  [opts.headers]      - Request headers
 * @param {*}       [opts.body]         - Request body (serialised to JSON if object)
 * @param {number}  [opts.timeout]      - Timeout ms (default: 30000)
 * @param {boolean} [opts.rawBody]      - Return raw response string instead of parsed JSON
 * @returns {Promise<object>}
 */
function makeRequest(opts) {
    return new Promise((resolve, reject) => {
        const targetUrl = opts.url;
        const method = (opts.method || 'GET').toUpperCase();
        const timeoutMs = opts.timeout || 30000;

        let parsedUrl;
        try {
            parsedUrl = new URL(targetUrl);
        } catch (e) {
            return reject(new Error(`Invalid URL: ${targetUrl}`));
        }

        const isHttps = parsedUrl.protocol === 'https:';
        const transport = isHttps ? https : http;

        // Serialise body
        let bodyBuffer = null;
        const headers = { ...(opts.headers || {}) };

        if (opts.body !== undefined && opts.body !== null) {
            if (typeof opts.body === 'object') {
                bodyBuffer = Buffer.from(JSON.stringify(opts.body), 'utf8');
                if (!headers['Content-Type'] && !headers['content-type']) {
                    headers['Content-Type'] = 'application/json';
                }
            } else {
                bodyBuffer = Buffer.from(String(opts.body), 'utf8');
                if (!headers['Content-Type'] && !headers['content-type']) {
                    headers['Content-Type'] = 'text/plain';
                }
            }
            headers['Content-Length'] = bodyBuffer.length;
        }

        const reqOpts = {
            hostname: parsedUrl.hostname,
            port: parsedUrl.port || (isHttps ? 443 : 80),
            path: parsedUrl.pathname + parsedUrl.search,
            method,
            headers
        };

        const startTime = Date.now();

        const req = transport.request(reqOpts, (res) => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => {
                const rawText = Buffer.concat(chunks).toString('utf8');
                const elapsed = Date.now() - startTime;

                let parsedBody = null;
                let parseError = null;
                const contentType = (res.headers['content-type'] || '').toLowerCase();

                if (!opts.rawBody && contentType.includes('application/json')) {
                    try { parsedBody = JSON.parse(rawText); }
                    catch (e) { parseError = `JSON parse error: ${e.message}`; parsedBody = rawText; }
                } else {
                    parsedBody = rawText;
                }

                resolve({
                    statusCode: res.statusCode,
                    statusMessage: res.statusMessage,
                    headers: res.headers,
                    body: parsedBody,
                    rawBody: rawText,
                    contentType: res.headers['content-type'] || null,
                    elapsedMs: elapsed,
                    parseError: parseError || undefined
                });
            });
            res.on('error', reject);
        });

        req.on('error', reject);

        req.setTimeout(timeoutMs, () => {
            req.destroy(new Error(`Request timed out after ${timeoutMs}ms`));
        });

        if (bodyBuffer) req.write(bodyBuffer);
        req.end();
    });
}

/* ================================================================
   SERVER
   ================================================================ */

const server = http.createServer(async (req, res) => {

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

    const parsed = url.parse(req.url, true);
    const { pathname } = parsed;

    /* ── GET /health ─────────────────────────────────────────── */
    if (pathname === '/health' && req.method === 'GET') {
        return send(res, 200, {
            status: 'UP',
            version: VERSION,
            type: 'http-request-connector',
            port: PORT
        });
    }

    /* ── POST /request – Execute a single HTTP request ──────────
       Body: {
         url:       "https://api.example.com/users",   // required
         method?:   "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
         headers?:  { "Authorization": "Bearer ..." },
         body?:     { ... } | "raw string",            // sent as request body
         timeout?:  30000,                             // ms, default 30000
         rawBody?:  false                              // true = skip JSON parse
       }
       ─────────────────────────────────────────────────────────── */
    if (pathname === '/request' && req.method === 'POST') {
        let body;
        try { body = await readBody(req); } catch { return err400(res, 'Invalid JSON body'); }

        if (!body.url || typeof body.url !== 'string') {
            return err400(res, 'Provide { url: "..." } in body');
        }

        try {
            const result = await makeRequest(body);
            return send(res, 200, {
                message: 'Request completed',
                request: {
                    url: body.url,
                    method: (body.method || 'GET').toUpperCase(),
                    headers: body.headers || {}
                },
                response: result
            });
        } catch (e) {
            return err500(res, `Request failed: ${e.message}`);
        }
    }

    /* ── POST /batch – Execute multiple requests sequentially ───
       Body: {
         requests: [
           { url, method?, headers?, body?, timeout?, rawBody? },
           ...
         ],
         stopOnError?: true    // abort batch on first failure (default: false)
       }
       ─────────────────────────────────────────────────────────── */
    if (pathname === '/batch' && req.method === 'POST') {
        let body;
        try { body = await readBody(req); } catch { return err400(res, 'Invalid JSON body'); }

        if (!Array.isArray(body.requests) || body.requests.length === 0) {
            return err400(res, 'Provide { requests: [...] } with at least one request');
        }

        if (body.requests.length > 20) {
            return err400(res, 'Maximum 20 requests per batch');
        }

        const stopOnError = body.stopOnError === true;
        const results = [];
        let aborted = false;

        for (let i = 0; i < body.requests.length; i++) {
            const reqDef = body.requests[i];
            if (!reqDef.url) {
                const errEntry = { index: i, error: 'Missing url in request definition' };
                results.push(errEntry);
                if (stopOnError) { aborted = true; break; }
                continue;
            }

            try {
                const result = await makeRequest(reqDef);
                results.push({
                    index: i,
                    request: { url: reqDef.url, method: (reqDef.method || 'GET').toUpperCase() },
                    response: result
                });

                // Treat 4xx/5xx as errors when stopOnError is set
                if (stopOnError && result.statusCode >= 400) {
                    aborted = true;
                    break;
                }
            } catch (e) {
                results.push({ index: i, url: reqDef.url, error: e.message });
                if (stopOnError) { aborted = true; break; }
            }
        }

        return send(res, 200, {
            message: aborted ? 'Batch aborted on error' : 'Batch completed',
            total: body.requests.length,
            completed: results.length,
            aborted,
            results
        });
    }

    /* ── POST /probe – Quick reachability check ─────────────────
       Body: { urls: ["http://localhost:8080", "http://localhost:3038/health"] }
       Returns statusCode and elapsedMs for each, without parsing body.
       Useful to check if a Spring Boot app has started yet.
       ─────────────────────────────────────────────────────────── */
    if (pathname === '/probe' && req.method === 'POST') {
        let body;
        try { body = await readBody(req); } catch { return err400(res, 'Invalid JSON body'); }

        const urls = Array.isArray(body.urls) ? body.urls
            : body.url ? [body.url]
            : null;

        if (!urls || urls.length === 0) {
            return err400(res, 'Provide { urls: [...] } or { url: "..." } in body');
        }

        if (urls.length > 10) {
            return err400(res, 'Maximum 10 URLs per probe');
        }

        const results = await Promise.all(
            urls.map(async (u) => {
                const start = Date.now();
                try {
                    const r = await makeRequest({ url: u, method: 'GET', timeout: body.timeout || 5000, rawBody: true });
                    return { url: u, reachable: true, statusCode: r.statusCode, elapsedMs: r.elapsedMs };
                } catch (e) {
                    return { url: u, reachable: false, error: e.message, elapsedMs: Date.now() - start };
                }
            })
        );

        return send(res, 200, {
            message: 'Probe complete',
            results,
            allReachable: results.every(r => r.reachable)
        });
    }

    /* ── 404 ─────────────────────────────────────────────────── */
    send(res, 404, {
        error: 'Endpoint not found',
        availableEndpoints: [
            'GET  /health              -- Server status',
            'POST /request             -- Execute a single HTTP request { url, method?, headers?, body?, timeout?, rawBody? }',
            'POST /batch               -- Execute up to 20 requests sequentially { requests: [...], stopOnError? }',
            'POST /probe               -- Reachability check for up to 10 URLs { urls: [...], timeout? }'
        ]
    });
});

server.listen(PORT, () => {
    console.log(`\nHTTP Request Connector v${VERSION} running at http://localhost:${PORT}`);
    console.log('\nAvailable endpoints:');
    console.log('  GET  /health    - Server status');
    console.log('  POST /request   - Execute a single HTTP request');
    console.log('  POST /batch     - Execute up to 20 requests sequentially');
    console.log('  POST /probe     - Quick reachability check (no body parse)');
});