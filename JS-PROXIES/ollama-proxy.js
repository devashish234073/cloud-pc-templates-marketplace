const http = require('http');
const https = require('https');

const PORT = 3004;
const OLLAMA_HOST = 'ollama.com';
const API_KEY = process.argv[2];

if (!API_KEY) {
    console.error("Usage: node server.js <OLLAMA_API_KEY>");
    process.exit(1);
}

/* =========================================================
   TRANSFORM MODELS
========================================================= */

function transformOllamaModels(ollamaResponse) {
    if (!ollamaResponse.models) {
        return { object: "list", data: [] };
    }

    return {
        object: "list",
        data: ollamaResponse.models.map(model => ({
            id: model.name,
            object: "model",
            created: Math.floor(new Date(model.modified_at).getTime() / 1000),
            owned_by: model.name.includes('/')
                ? model.name.split('/')[0]
                : "ollama",
            architecture: {
                input_modalities: ["text"],
                output_modalities: ["text"]
            },
            providers: [
                {
                    provider: "ollama",
                    status: "live",
                    context_length: 8192,
                    pricing: { input: 0, output: 0 },
                    supports_tools: false,
                    supports_structured_output: false,
                    is_model_author: true
                }
            ]
        }))
    };
}

/* =========================================================
   TRANSFORM CHAT RESPONSE
========================================================= */

function transformChatResponse(ollamaResp, originalModel) {

    // Ollama cloud may return:
    // { message: { role, content }, created_at, model, ... }
    // or OpenAI-like format already
    // We normalize everything.

    const content =
        ollamaResp?.message?.content ||
        ollamaResp?.choices?.[0]?.message?.content ||
        "";

    const reasoning =
        ollamaResp?.message?.reasoning_content ||
        ollamaResp?.choices?.[0]?.message?.reasoning_content ||
        "";

    const created = Math.floor(Date.now() / 1000);
    const id = Date.now().toString();

    return {
        id: id,
        object: "chat.completion",
        created: created,
        model: originalModel,
        request_id: id,
        choices: [
            {
                index: 0,
                finish_reason: "stop",
                message: {
                    role: "assistant",
                    content: content,
                    reasoning_content: reasoning
                }
            }
        ],
        usage: {
            prompt_tokens: ollamaResp?.usage?.prompt_tokens || 0,
            completion_tokens: ollamaResp?.usage?.completion_tokens || 0,
            total_tokens: ollamaResp?.usage?.total_tokens || 0,
            prompt_tokens_details: {
                cached_tokens: 0
            }
        }
    };
}

/* =========================================================
   FETCH MODELS FROM OLLAMA CLOUD
========================================================= */

function fetchModels(callback) {
    const options = {
        hostname: OLLAMA_HOST,
        path: '/api/tags',
        method: 'GET',
        headers: {
            'Authorization': `Bearer ${API_KEY}`,
            'Content-Type': 'application/json'
        }
    };

    const req = https.request(options, res => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
            try {
                callback(null, JSON.parse(data));
            } catch (err) {
                callback(err);
            }
        });
    });

    req.on('error', err => callback(err));
    req.end();
}

/* =========================================================
   CALL OLLAMA CHAT
========================================================= */

function callOllamaChat(body, callback) {

    const payload = JSON.stringify({
        model: body.model,
        messages: body.messages,
        temperature: body.temperature,
        top_p: body.top_p,
        stream: false
    });

    const options = {
        hostname: OLLAMA_HOST,
        path: '/api/chat',
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${API_KEY}`,
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload)
        }
    };

    const req = https.request(options, res => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
            try {
                callback(null, JSON.parse(data));
            } catch (err) {
                callback(err);
            }
        });
    });

    req.on('error', err => callback(err));
    req.write(payload);
    req.end();
}

/* =========================================================
   CALL OLLAMA CHAT STREAMING
========================================================= */

function callOllamaChatStreaming(body, res) {
    const payload = JSON.stringify({
        model: body.model,
        messages: body.messages,
        temperature: body.temperature,
        top_p: body.top_p,
        stream: true
    });

    const options = {
        hostname: OLLAMA_HOST,
        path: '/api/chat',
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${API_KEY}`,
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload)
        }
    };

    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
    });

    const id = Date.now().toString();
    const created = Math.floor(Date.now() / 1000);

    const req = https.request(options, ollamaRes => {
        let buffer = '';

        ollamaRes.on('data', chunk => {
            buffer += chunk.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop();

            lines.forEach(line => {
                if (!line.trim()) return;
                try {
                    const ollamaChunk = JSON.parse(line);
                    const content = ollamaChunk.message?.content || '';
                    const reasoning = ollamaChunk.message?.reasoning_content || '';
                    
                    if (content || reasoning) {
                        const hfChunk = {
                            id: id,
                            created: created,
                            object: 'chat.completion.chunk',
                            model: body.model,
                            choices: [{
                                index: 0,
                                delta: {
                                    role: 'assistant',
                                    content: content || undefined,
                                    reasoning_content: reasoning || undefined
                                }
                            }]
                        };
                        res.write(`data: ${JSON.stringify(hfChunk)}\n\n`);
                    }

                    if (ollamaChunk.done) {
                        res.end();
                    }
                } catch (err) {
                    // Skip invalid JSON
                }
            });
        });

        ollamaRes.on('end', () => res.end());
    });

    req.on('error', err => {
        res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
        res.end();
    });

    req.write(payload);
    req.end();
}

/* =========================================================
   MAIN SERVER
========================================================= */

const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        return res.end();
    }

    /* -------- GET /v1/models -------- */
    if (req.method === 'GET' && req.url === '/v1/models') {

        fetchModels((err, data) => {
            if (err) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: err.message }));
            }

            const transformed = transformOllamaModels(data);

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(transformed));
        });

        return;
    }

    /* -------- POST /v1/chat/completions -------- */
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {

        let body = '';

        req.on('data', chunk => body += chunk);

        req.on('end', () => {
            try {
                const parsedBody = JSON.parse(body);

                if (parsedBody.stream === true) {
                    return callOllamaChatStreaming(parsedBody, res);
                }

                callOllamaChat(parsedBody, (err, ollamaResp) => {
                    if (err) {
                        res.writeHead(500, { 'Content-Type': 'application/json' });
                        return res.end(JSON.stringify({ error: err.message }));
                    }

                    const transformed =
                        transformChatResponse(ollamaResp, parsedBody.model);
                    if (!transformed.choices[0].message.content) {
                        console.warn(`[EMPTY RESPONSE] Model: ${parsedBody.model} returned empty content`,'API key usage limit reached. Please retry after sometime.');
                    }
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify(transformed));
                });

            } catch (err) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: "Invalid JSON body" }));
            }
        });

        return;
    }

    /* -------- HEALTH -------- */
    if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ status: "UP" }));
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: "Not Found" }));
});

server.listen(PORT, () => {
    console.log(`OpenAI-compatible Ollama proxy running at http://localhost:${PORT}`);
});
