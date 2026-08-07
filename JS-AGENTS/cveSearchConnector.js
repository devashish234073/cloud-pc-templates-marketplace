const http = require('http');
const url = require('url');
const https = require('https');

const PORT = 3040;

/* ================================================================
   CVE SEARCH AGENT - Free NVD API (No API Key Required)
   ================================================================ */

/**
 * Rate limiting management for NVD API
 * NVD allows 5 requests per 30 seconds
 */
class RateLimiter {
    constructor(requestsPerWindow = 5, windowMs = 30000) {
        this.requestsPerWindow = requestsPerWindow;
        this.windowMs = windowMs;
        this.timestamps = [];
    }

    async waitIfNeeded() {
        const now = Date.now();
        // Remove timestamps older than the window
        this.timestamps = this.timestamps.filter(ts => now - ts < this.windowMs);

        if (this.timestamps.length >= this.requestsPerWindow) {
            const oldest = this.timestamps[0];
            const waitTime = this.windowMs - (now - oldest);
            if (waitTime > 0) {
                console.log(`Rate limit: waiting ${Math.ceil(waitTime / 1000)} seconds...`);
                await new Promise(resolve => setTimeout(resolve, waitTime));
                return this.waitIfNeeded(); // Recursively check again
            }
        }

        this.timestamps.push(Date.now());
    }
}

const rateLimiter = new RateLimiter();

/* ================================================================
   CACHE FOR RECENT CVE LOOKUPS (5 minute TTL)
   ================================================================ */
const cveCache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000;

function getCached(cveId) {
    const cached = cveCache.get(cveId);
    if (cached && (Date.now() - cached.timestamp) < CACHE_TTL_MS) {
        return cached.data;
    }
    return null;
}

function setCache(cveId, data) {
    cveCache.set(cveId, {
        data: JSON.parse(JSON.stringify(data)), // Deep copy
        timestamp: Date.now()
    });
}

/* ================================================================
   NVD API REQUEST FUNCTION
   ================================================================ */

function fetchFromNVD(cveId) {
    return new Promise((resolve, reject) => {
        const apiUrl = `https://services.nvd.nist.gov/rest/json/cves/2.0?cveId=${cveId.toUpperCase()}`;

        const options = {
            headers: {
                'User-Agent': 'CVE-Search-Agent/1.0',
                'Accept': 'application/json'
            },
            timeout: 30000
        };

        const req = https.get(apiUrl, options, (res) => {
            let data = '';

            res.on('data', (chunk) => {
                data += chunk;
            });

            res.on('end', () => {
                if (res.statusCode === 200) {
                    try {
                        const jsonData = JSON.parse(data);
                        resolve(jsonData);
                    } catch (e) {
                        reject(new Error(`Failed to parse JSON: ${e.message}`));
                    }
                } else if (res.statusCode === 403) {
                    reject(new Error('Rate limited by NVD. Please wait 30 seconds and try again.'));
                } else if (res.statusCode === 404) {
                    reject(new Error(`CVE ${cveId} not found in NVD database`));
                } else {
                    reject(new Error(`NVD API returned HTTP ${res.statusCode}: ${data.substring(0, 200)}`));
                }
            });
        });

        req.on('error', (err) => {
            reject(new Error(`Request failed: ${err.message}`));
        });

        req.on('timeout', () => {
            req.destroy();
            reject(new Error('Request timeout after 30 seconds'));
        });
    });
}

/* ================================================================
   FORMATTING FUNCTIONS
   ================================================================ */

function formatCVSS(score) {
    if (score === undefined || score === null) return 'N/A';
    const numScore = parseFloat(score);
    if (isNaN(numScore)) return score;

    if (numScore >= 9.0) return `${numScore.toFixed(1)} (CRITICAL)`;
    if (numScore >= 7.0) return `${numScore.toFixed(1)} (HIGH)`;
    if (numScore >= 4.0) return `${numScore.toFixed(1)} (MEDIUM)`;
    return `${numScore.toFixed(1)} (LOW)`;
}

function getSeverityLevel(score) {
    if (score === undefined || score === null) return 'UNKNOWN';
    const numScore = parseFloat(score);
    if (isNaN(numScore)) return 'UNKNOWN';
    if (numScore >= 9.0) return 'CRITICAL';
    if (numScore >= 7.0) return 'HIGH';
    if (numScore >= 4.0) return 'MEDIUM';
    return 'LOW';
}

function formatDescription(text, maxWidth = 100) {
    if (!text) return 'No description available.';
    return text;
}

/* ================================================================
   RESPONSE HELPERS
   ================================================================ */

function sendJson(res, statusCode, data) {
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data, null, 2));
}

function sendError(res, statusCode, error, details = null) {
    const response = { error };
    if (details) response.details = details;
    sendJson(res, statusCode, response);
}

/* ================================================================
   CVE DATA PARSING & TRANSFORMATION
   ================================================================ */

function parseCVEData(cveData, cveId) {
    if (!cveData.vulnerabilities || cveData.vulnerabilities.length === 0) {
        return null;
    }

    const vuln = cveData.vulnerabilities[0].cve;

    // Parse CVSS metrics
    let cvssMetrics = {
        cvssV31: null,
        cvssV30: null,
        cvssV2: null
    };

    if (vuln.metrics) {
        if (vuln.metrics.cvssMetricV31 && vuln.metrics.cvssMetricV31.length > 0) {
            const m = vuln.metrics.cvssMetricV31[0];
            cvssMetrics.cvssV31 = {
                score: m.cvssData.baseScore,
                severity: m.cvssData.baseSeverity,
                vectorString: m.cvssData.vectorString,
                exploitabilityScore: m.exploitabilityScore,
                impactScore: m.impactScore
            };
        }

        if (vuln.metrics.cvssMetricV30 && vuln.metrics.cvssMetricV30.length > 0) {
            const m = vuln.metrics.cvssMetricV30[0];
            cvssMetrics.cvssV30 = {
                score: m.cvssData.baseScore,
                severity: m.cvssData.baseSeverity,
                vectorString: m.cvssData.vectorString
            };
        }

        if (vuln.metrics.cvssMetricV2 && vuln.metrics.cvssMetricV2.length > 0) {
            const m = vuln.metrics.cvssMetricV2[0];
            cvssMetrics.cvssV2 = {
                score: m.cvssData.baseScore,
                severity: m.baseSeverity,
                vectorString: m.cvssData.vectorString
            };
        }
    }

    // Get primary CVSS score (prefer v3.1, then v3.0, then v2)
    let primaryScore = null;
    let primarySeverity = null;
    let primaryVector = null;
    if (cvssMetrics.cvssV31) {
        primaryScore = cvssMetrics.cvssV31.score;
        primarySeverity = cvssMetrics.cvssV31.severity;
        primaryVector = cvssMetrics.cvssV31.vectorString;
    } else if (cvssMetrics.cvssV30) {
        primaryScore = cvssMetrics.cvssV30.score;
        primarySeverity = cvssMetrics.cvssV30.severity;
        primaryVector = cvssMetrics.cvssV30.vectorString;
    } else if (cvssMetrics.cvssV2) {
        primaryScore = cvssMetrics.cvssV2.score;
        primarySeverity = cvssMetrics.cvssV2.severity;
        primaryVector = cvssMetrics.cvssV2.vectorString;
    }

    // Parse description
    let description = '';
    if (vuln.descriptions && vuln.descriptions.length > 0) {
        const desc = vuln.descriptions.find(d => d.lang === 'en') || vuln.descriptions[0];
        description = desc.value;
    }

    // Parse weaknesses (CWEs)
    const weaknesses = [];
    if (vuln.weaknesses && vuln.weaknesses.length > 0) {
        for (const weakness of vuln.weaknesses) {
            for (const desc of weakness.description) {
                if (desc.lang === 'en') {
                    weaknesses.push(desc.value);
                }
            }
        }
    }

    // Parse affected software configurations
    const affectedSoftware = [];
    if (vuln.configurations && vuln.configurations.length > 0) {
        for (const config of vuln.configurations) {
            if (config.nodes && config.nodes.length > 0) {
                for (const node of config.nodes) {
                    if (node.cpeMatch && node.cpeMatch.length > 0) {
                        for (const cpe of node.cpeMatch) {
                            if (cpe.vulnerable === true) {
                                const cpeParts = cpe.criteria.split(':');
                                const vendor = cpeParts[3] || 'unknown';
                                const product = cpeParts[4] || 'unknown';
                                const version = cpeParts[5] || 'any';

                                const affected = {
                                    vendor,
                                    product,
                                    version,
                                    criteria: cpe.criteria
                                };

                                if (cpe.versionEndIncluding) {
                                    affected.versionEndIncluding = cpe.versionEndIncluding;
                                }
                                if (cpe.versionEndExcluding) {
                                    affected.versionEndExcluding = cpe.versionEndExcluding;
                                }
                                if (cpe.versionStartIncluding) {
                                    affected.versionStartIncluding = cpe.versionStartIncluding;
                                }
                                if (cpe.versionStartExcluding) {
                                    affected.versionStartExcluding = cpe.versionStartExcluding;
                                }

                                affectedSoftware.push(affected);
                            }
                        }
                    }
                }
            }
        }
    }

    // Parse references
    const references = [];
    if (vuln.references && vuln.references.length > 0) {
        for (const ref of vuln.references) {
            references.push({
                url: ref.url,
                tags: ref.tags || []
            });
        }
    }

    return {
        id: vuln.id,
        published: vuln.published,
        lastModified: vuln.lastModified,
        status: vuln.vulnStatus || 'UNKNOWN',
        description,
        cvssMetrics,
        primaryScore,
        primarySeverity,
        primaryVector,
        weaknesses,
        affectedSoftware,
        references,
        sourceIdentifier: vuln.sourceIdentifier
    };
}

/* ================================================================
   API HIT TRACKING
   ================================================================ */

const apiHitCounts = {
    'GET /cve/search': 0,
    'POST /cve/search': 0,
    'GET /cve/recent': 0,
    'GET /cve/status': 0,
    'GET /cve/clear-cache': 0,
    'GET /': 0
};

/* ================================================================
   SERVER
   ================================================================ */

const server = http.createServer(async (req, res) => {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        return res.end();
    }

    const parsed = url.parse(req.url, true);
    const { pathname, query } = parsed;

    /* ── GET /health ──────────────────────────────────────────── */
    if (pathname === '/health') {
        return sendJson(res, 200, {
            status: 'UP',
            version: '1.0',
            type: 'cve-search-agent',
            name: 'CVE Vulnerability Search Agent',
            features: {
                freeApi: true,
                noApiKeyRequired: true,
                rateLimit: '5 requests per 30 seconds',
                cacheTTL: '5 minutes'
            },
            cacheSize: cveCache.size
        });
    }

    /* ── GET /insights ──────────────────────────────────────────── */
    if (pathname === '/insights') {
        return sendJson(res, 200, { apiHitCounts });
    }

    /* ── GET /cve/search?cveId=CVE-2026-41711 ──────────────────
       Search for a specific CVE by ID
    ─────────────────────────────────────────────────────────── */
    if (pathname === '/cve/search' && req.method === 'GET') {
        apiHitCounts['GET /cve/search']++;
        const { cveId } = query;

        if (!cveId) {
            return sendError(res, 400, 'Missing required parameter: cveId', {
                example: '/cve/search?cveId=CVE-2026-41711',
                format: 'CVE-YYYY-NNNNN'
            });
        }

        // Validate CVE format
        const cvePattern = /^CVE-\d{4}-\d{4,}$/i;
        if (!cvePattern.test(cveId)) {
            return sendError(res, 400, 'Invalid CVE ID format', {
                provided: cveId,
                expectedFormat: 'CVE-YYYY-NNNNN (e.g., CVE-2026-41711)'
            });
        }

        const normalizedCveId = cveId.toUpperCase();

        // Check cache first
        const cached = getCached(normalizedCveId);
        if (cached) {
            console.log(`Cache hit for ${normalizedCveId}`);
            return sendJson(res, 200, {
                success: true,
                cached: true,
                data: cached
            });
        }

        try {
            // Apply rate limiting
            await rateLimiter.waitIfNeeded();

            const rawData = await fetchFromNVD(normalizedCveId);
            const parsedData = parseCVEData(rawData, normalizedCveId);

            if (!parsedData) {
                return sendError(res, 404, `CVE ${normalizedCveId} not found`);
            }

            // Cache the result
            setCache(normalizedCveId, parsedData);

            return sendJson(res, 200, {
                success: true,
                cached: false,
                data: parsedData
            });

        } catch (error) {
            console.error(`Error fetching CVE ${normalizedCveId}:`, error.message);
            return sendError(res, 500, 'Failed to fetch CVE data', {
                cveId: normalizedCveId,
                message: error.message,
                suggestion: 'Check your internet connection or try again later'
            });
        }
    }

    /* ── POST /cve/search ──────────────────────────────────────
       Search for CVE with JSON body: { "cveId": "CVE-2026-41711" }
    ─────────────────────────────────────────────────────────── */
    if (pathname === '/cve/search' && req.method === 'POST') {
        apiHitCounts['POST /cve/search']++;
        let body = '';

        req.on('data', chunk => {
            body += chunk.toString();
        });

        req.on('end', async () => {
            try {
                const parsedBody = JSON.parse(body);
                const { cveId } = parsedBody;

                if (!cveId) {
                    return sendError(res, 400, 'Missing required field: cveId', {
                        example: { cveId: 'CVE-2026-41711' }
                    });
                }

                const cvePattern = /^CVE-\d{4}-\d{4,}$/i;
                if (!cvePattern.test(cveId)) {
                    return sendError(res, 400, 'Invalid CVE ID format', {
                        provided: cveId,
                        expectedFormat: 'CVE-YYYY-NNNNN'
                    });
                }

                const normalizedCveId = cveId.toUpperCase();

                // Check cache
                const cached = getCached(normalizedCveId);
                if (cached) {
                    return sendJson(res, 200, {
                        success: true,
                        cached: true,
                        data: cached
                    });
                }

                await rateLimiter.waitIfNeeded();
                const rawData = await fetchFromNVD(normalizedCveId);
                const parsedData = parseCVEData(rawData, normalizedCveId);

                if (!parsedData) {
                    return sendError(res, 404, `CVE ${normalizedCveId} not found`);
                }

                setCache(normalizedCveId, parsedData);

                return sendJson(res, 200, {
                    success: true,
                    cached: false,
                    data: parsedData
                });

            } catch (e) {
                return sendError(res, 400, 'Invalid JSON body', { message: e.message });
            }
        });
    }

    /* ── GET /cve/recent?limit=10 ──────────────────────────────
       Get recent CVEs (from cache only, doesn't call NVD)
    ─────────────────────────────────────────────────────────── */
    if (pathname === '/cve/recent' && req.method === 'GET') {
        apiHitCounts['GET /cve/recent']++;
        const { limit = 10 } = query;
        const recent = [];

        // Get most recent from cache
        const entries = Array.from(cveCache.entries());
        entries.sort((a, b) => b[1].timestamp - a[1].timestamp);

        for (let i = 0; i < Math.min(parseInt(limit), entries.length); i++) {
            recent.push({
                cveId: entries[i][0],
                timestamp: new Date(entries[i][1].timestamp).toISOString(),
                summary: {
                    score: entries[i][1].data.primaryScore,
                    severity: entries[i][1].data.primarySeverity,
                    description: entries[i][1].data.description.substring(0, 200) + '...'
                }
            });
        }

        return sendJson(res, 200, {
            success: true,
            count: recent.length,
            recentSearches: recent
        });
    }

    /* ── GET /cve/status ───────────────────────────────────────
       Get agent status and stats
    ─────────────────────────────────────────────────────────── */
    if (pathname === '/cve/status' && req.method === 'GET') {
        apiHitCounts['GET /cve/status']++;
        return sendJson(res, 200, {
            status: 'operational',
            type: 'cve-search-agent',
            version: '1.0',
            cacheStats: {
                size: cveCache.size,
                maxAge: `${CACHE_TTL_MS / 1000} seconds`,
                entries: Array.from(cveCache.keys())
            },
            rateLimiter: {
                requestsPerWindow: 5,
                windowMs: 30000,
                currentPending: rateLimiter.timestamps.length
            },
            apiInfo: {
                provider: 'NIST NVD',
                url: 'https://nvd.nist.gov/developers/vulnerabilities',
                requiresApiKey: false,
                rateLimit: '5 requests per 30 seconds'
            }
        });
    }

    /* ── GET /cve/clear-cache ──────────────────────────────────
       Clear the CVE cache
    ─────────────────────────────────────────────────────────── */
    if (pathname === '/cve/clear-cache' && req.method === 'GET') {
        apiHitCounts['GET /cve/clear-cache']++;
        const size = cveCache.size;
        cveCache.clear();
        return sendJson(res, 200, {
            success: true,
            message: 'Cache cleared successfully',
            clearedEntries: size
        });
    }

    /* ── GET / ─────────────────────────────────────────────────
       Root endpoint with available endpoints
    ─────────────────────────────────────────────────────────── */
    if (pathname === '/') {
        apiHitCounts['GET /']++;
        return sendJson(res, 200, {
            name: 'CVE Vulnerability Search Agent',
            version: '1.0',
            description: 'Search for CVE vulnerabilities using the free NVD API (no API key required)',
            endpoints: {
                'GET /health': 'Health check and agent info',
                'GET /cve/status': 'Agent status and statistics',
                'GET /cve/search?cveId=CVE-YYYY-NNNNN': 'Search for a CVE by ID',
                'POST /cve/search': 'Search for a CVE with JSON body { "cveId": "CVE-YYYY-NNNNN" }',
                'GET /cve/recent?limit=10': 'Get recently searched CVEs (from cache)',
                'GET /cve/clear-cache': 'Clear the in-memory cache'
            },
            examples: {
                search: '/cve/search?cveId=CVE-2026-41711',
                postSearch: 'curl -X POST http://localhost:3040/cve/search -H "Content-Type: application/json" -d \'{"cveId":"CVE-2026-41711"}\''
            },
            notes: {
                rateLimit: 'NVD API allows 5 requests per 30 seconds',
                cache: 'Results are cached for 5 minutes to reduce API calls',
                noApiKey: 'No API key required - completely free to use'
            }
        });
    }

    /* ── 404 ──────────────────────────────────────────────────── */
    sendJson(res, 404, {
        error: 'Endpoint not found',
        availableEndpoints: [
            'GET  /',
            'GET  /health',
            'GET  /cve/status',
            'GET  /cve/search?cveId=CVE-YYYY-NNNNN',
            'POST /cve/search (with JSON body)',
            'GET  /cve/recent?limit=10',
            'GET  /cve/clear-cache'
        ]
    });
});

server.listen(PORT, () => {
    console.log(`
╔════════════════════════════════════════════════════════════════════════════╗
║                    CVE VULNERABILITY SEARCH AGENT                          ║
║                         v1.0 - No API Key Required                         ║
╚════════════════════════════════════════════════════════════════════════════╝

Server running at: http://localhost:${PORT}

📋 Available Endpoints:
   GET  /                              - API documentation
   GET  /health                        - Health check
   GET  /cve/status                    - Agent status & stats
   GET  /cve/search?cveId=CVE-XXXX    - Search CVE by ID
   POST /cve/search                    - Search CVE (JSON body)
   GET  /cve/recent?limit=10          - Recently searched CVEs
   GET  /cve/clear-cache              - Clear cache

🔍 Example Usage:
   curl "http://localhost:${PORT}/cve/search?cveId=CVE-2026-41711"

📊 Features:
   ✓ Free NVD API - No API key required
   ✓ 5-minute caching to respect rate limits
   ✓ Automatic rate limiting (5 requests per 30 seconds)
   ✓ Complete CVE data including CVSS scores, CWEs, affected software
   ✓ Zero dependencies - native Node.js only

💡 Rate Limit Info:
   NVD API allows 5 requests per 30 seconds. The agent handles this automatically.
`);
});