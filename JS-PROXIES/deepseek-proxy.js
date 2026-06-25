const http = require('http');
const https = require('https');

const PORT = 3006;
const DEEPSEEK_HOST = 'api.deepseek.com';

const API_KEY = process.argv[2];

if (!API_KEY) {
    console.error('Usage: node server.js <DEEPSEEK_API_KEY>');
    process.exit(1);
}

function proxyRequest(path, method, body, callback) {
    const payload = body ? JSON.stringify(body) : null;

    const options = {
        hostname: DEEPSEEK_HOST,
        path,
        method,
        headers: {
            'Authorization': `Bearer ${API_KEY}`,
            'Content-Type': 'application/json'
        }
    };

    if (payload) {
        options.headers['Content-Length'] =
            Buffer.byteLength(payload);
    }

    const req = https.request(options, res => {
        let data = '';

        res.on('data', chunk => {
            data += chunk;
        });

        res.on('end', () => {
            try {
                callback(null, JSON.parse(data), res.statusCode);
            } catch (err) {
                callback(err);
            }
        });
    });

    req.on('error', callback);

    if (payload) {
        req.write(payload);
    }

    req.end();
}

function proxyStreaming(body, clientRes) {
    const payload = JSON.stringify(body);

    const options = {
        hostname: DEEPSEEK_HOST,
        path: '/chat/completions',
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${API_KEY}`,
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload)
        }
    };

    const req = https.request(options, deepseekRes => {

        // DeepSeek returns real HTTP status codes even for the streaming
        // endpoint, e.g. 402 Insufficient Balance, with a non-SSE JSON body.
        if (deepseekRes.statusCode && deepseekRes.statusCode >= 400) {
            let errBody = '';
            deepseekRes.on('data', chunk => { errBody += chunk; });
            deepseekRes.on('end', () => {
                let errMessage = `DeepSeek error (HTTP ${deepseekRes.statusCode})`;
                try {
                    const parsedErr = JSON.parse(errBody);
                    errMessage = parsedErr?.error?.message || parsedErr?.error?.type || errMessage;
                } catch {
                    // body wasn't JSON, fall back to generic message
                }

                console.warn(`[DEEPSEEK ERROR] HTTP ${deepseekRes.statusCode}: ${errMessage}`);

                clientRes.writeHead(200, {
                    'Content-Type': 'text/event-stream',
                    'Cache-Control': 'no-cache',
                    'Connection': 'keep-alive',
                    'X-Ollama-Error': errMessage
                });
                clientRes.write('data: [DONE]\n\n');
                clientRes.end();
            });
            return;
        }

        clientRes.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive'
        });

        deepseekRes.on('data', chunk => {
            clientRes.write(chunk);
        });

        deepseekRes.on('end', () => {
            clientRes.end();
        });
    });

    req.on('error', err => {
        clientRes.write(
            `data: ${JSON.stringify({
                error: err.message
            })}\n\n`
        );
        clientRes.end();
    });

    req.write(payload);
    req.end();
}

const server = http.createServer((req, res) => {

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader(
        'Access-Control-Allow-Methods',
        'GET, POST, OPTIONS'
    );
    res.setHeader(
        'Access-Control-Allow-Headers',
        'Content-Type, Authorization'
    );
    res.setHeader('Access-Control-Expose-Headers', 'X-Ollama-Error');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        return res.end();
    }

    /*
     * GET /v1/models
     */
    if (
        req.method === 'GET' &&
        req.url === '/v1/models'
    ) {
        return proxyRequest(
            '/models',
            'GET',
            null,
            (err, data, statusCode) => {
                if (err) {
                    res.writeHead(500, {
                        'Content-Type': 'application/json'
                    });
                    return res.end(
                        JSON.stringify({
                            error: err.message
                        })
                    );
                }

                if (statusCode && statusCode >= 400) {
                    const errMessage =
                        data?.error?.message ||
                        data?.error?.type ||
                        `DeepSeek error (HTTP ${statusCode})`;

                    console.warn(`[DEEPSEEK ERROR] HTTP ${statusCode}: ${errMessage}`);
                    res.setHeader('X-Ollama-Error', errMessage);
                }

                res.writeHead(200, {
                    'Content-Type': 'application/json'
                });

                res.end(JSON.stringify(data));
            }
        );
    }

    /*
     * POST /v1/chat/completions
     */
    if (
        req.method === 'POST' &&
        req.url === '/v1/chat/completions'
    ) {
        let body = '';

        req.on('data', chunk => {
            body += chunk;
        });

        req.on('end', () => {
            try {
                const parsed = JSON.parse(body);

                if (parsed.stream === true) {
                    return proxyStreaming(parsed, res);
                }

                proxyRequest(
                    '/chat/completions',
                    'POST',
                    parsed,
                    (err, data, statusCode) => {
                        if (err) {
                            res.writeHead(500, {
                                'Content-Type': 'application/json'
                            });

                            return res.end(
                                JSON.stringify({
                                    error: err.message
                                })
                            );
                        }

                        // DeepSeek uses real HTTP status codes for billing/auth/etc,
                        // e.g. 402 Insufficient Balance, with body { error: { message, type } }
                        if (statusCode && statusCode >= 400) {
                            const errMessage =
                                data?.error?.message ||
                                data?.error?.type ||
                                `DeepSeek error (HTTP ${statusCode})`;

                            console.warn(`[DEEPSEEK ERROR] HTTP ${statusCode}: ${errMessage}`);
                            res.setHeader('X-Ollama-Error', errMessage);
                        }

                        res.writeHead(200, {
                            'Content-Type': 'application/json'
                        });

                        res.end(JSON.stringify(data));
                    }
                );

            } catch {
                res.writeHead(400, {
                    'Content-Type': 'application/json'
                });

                res.end(
                    JSON.stringify({
                        error: 'Invalid JSON body'
                    })
                );
            }
        });

        return;
    }

    /*
     * HEALTH
     */
    if (
        req.method === 'GET' &&
        req.url === '/health'
    ) {
        res.writeHead(200, {
            'Content-Type': 'application/json'
        });

        return res.end(
            JSON.stringify({
                status: 'UP'
            })
        );
    }

    res.writeHead(404, {
        'Content-Type': 'application/json'
    });

    res.end(
        JSON.stringify({
            error: 'Not Found'
        })
    );
});

server.listen(PORT, () => {
    console.log(
        `DeepSeek proxy running on http://localhost:${PORT}`
    );
});