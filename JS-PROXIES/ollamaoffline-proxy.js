const http = require('http');
const { exec } = require('child_process');

const PORT = 3005;
const OLLAMA_HOST = 'localhost';
const OLLAMA_PORT = 11434;

/* =========================================================
   PARSE `ollama list`
========================================================= */

function parseOllamaList(output) {
    const lines = output.split('\n').slice(1); // skip header

    const models = [];

    lines.forEach(line => {
        if (!line.trim()) return;

        // Split by multiple spaces
        const parts = line.trim().split(/\s{2,}/);

        if (parts.length < 4) return;

        const [name, id, size, modified] = parts;

        // Skip models where size is "-"
        if (size === '-') return;

        models.push({
            name,
            id,
            size,
            modified
        });
    });

    return models;
}

/* =========================================================
   TRANSFORM MODELS → OpenAI Format
========================================================= */

function transformModels(models) {
    return {
        object: "list",
        data: models.map(model => ({
            id: model.name,
            object: "model",
            created: Math.floor(Date.now() / 1000),
            owned_by: "ollama",
            architecture: {
                input_modalities: ["text"],
                output_modalities: ["text"]
            },
            providers: [
                {
                    provider: "ollama-local",
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
   FETCH LOCAL MODELS USING CLI
========================================================= */

function fetchLocalModels(callback) {
    exec('ollama list', (err, stdout, stderr) => {
        if (err) return callback(err);

        try {
            const parsed = parseOllamaList(stdout);
            callback(null, parsed);
        } catch (e) {
            callback(e);
        }
    });
}

/* =========================================================
   CALL LOCAL OLLAMA CHAT
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
        port: OLLAMA_PORT,
        path: '/api/chat',
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload)
        }
    };

    const req = http.request(options, res => {
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
   STREAMING CHAT
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
        port: OLLAMA_PORT,
        path: '/api/chat',
        method: 'POST',
        headers: {
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

    const req = http.request(options, ollamaRes => {
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

                    if (content) {
                        const chunkResponse = {
                            id,
                            created,
                            object: 'chat.completion.chunk',
                            model: body.model,
                            choices: [{
                                index: 0,
                                delta: { role: 'assistant', content }
                            }]
                        };

                        res.write(`data: ${JSON.stringify(chunkResponse)}\n\n`);
                    }

                    if (ollamaChunk.done) {
                        res.end();
                    }
                } catch (e) {}
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
   TRANSFORM CHAT RESPONSE
========================================================= */

function transformChatResponse(ollamaResp, originalModel) {
    const content = ollamaResp?.message?.content || "";

    const created = Math.floor(Date.now() / 1000);
    const id = Date.now().toString();

    return {
        id,
        object: "chat.completion",
        created,
        model: originalModel,
        choices: [{
            index: 0,
            finish_reason: "stop",
            message: {
                role: "assistant",
                content
            }
        }],
        usage: {
            prompt_tokens: 0,
            completion_tokens: 0,
            total_tokens: 0
        }
    };
}

/* =========================================================
   SERVER
========================================================= */

const server = http.createServer((req, res) => {

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        return res.end();
    }

    /* -------- GET MODELS -------- */
    if (req.method === 'GET' && req.url === '/v1/models') {

        fetchLocalModels((err, models) => {
            if (err) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: err.message }));
            }

            const transformed = transformModels(models);

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(transformed));
        });

        return;
    }

    /* -------- CHAT -------- */
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
        return res.end(JSON.stringify({ status: "UP", mode: "ollama-local" }));
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: "Not Found" }));
});

server.listen(PORT, () => {
    console.log(`OpenAI-compatible Ollama LOCAL proxy running at http://localhost:${PORT}`);
});