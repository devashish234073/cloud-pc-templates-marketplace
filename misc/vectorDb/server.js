'use strict';

const http = require('http');
const https = require('https');
const { execFile } = require('child_process');
const { URL } = require('url');
const VectorDB = require('./vectorDb');

const PORT = process.env.PORT || 4302;
const PERSIST_PATH = process.env.PERSIST_PATH || './data/vectors.json';
const METRIC = process.env.METRIC || 'cosine';
const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://localhost:11434';
const EMBED_MODEL = process.env.EMBED_MODEL || 'nomic-embed-text';

const AGENT_REGISTRY_URL =
  'https://raw.githubusercontent.com/devashish234073/cloud-pc-templates-marketplace/refs/heads/main/JS-AGENTS/agent-registry.json';

const db = new VectorDB({ persistPath: PERSIST_PATH, metric: METRIC });

// ---------------------------------------------------------------------------
// Ollama init — pulls the embed model once, sets a flag on success so that
// every subsequent call skips straight through without re-running the pull.
// ---------------------------------------------------------------------------

let ollamaReady = false;
let ollamaInitPromise = null; // deduplicate concurrent callers

function ollamaInit() {
  // Already succeeded — fast path, no async needed
  if (ollamaReady) return Promise.resolve();

  // Already in-flight — return the same promise so callers queue behind it
  if (ollamaInitPromise) return ollamaInitPromise;

  ollamaInitPromise = new Promise((resolve, reject) => {
    console.log(`[init] Running: ollama pull ${EMBED_MODEL}`);
    execFile('ollama', ['pull', EMBED_MODEL], { timeout: 5 * 60 * 1000 }, (err, stdout, stderr) => {
      if (err) {
        ollamaInitPromise = null; // allow retry on next call
        const msg = stderr?.trim() || err.message;
        console.error('[init] ollama pull failed:', msg);
        return reject(new Error(`ollama pull ${EMBED_MODEL} failed: ${msg}`));
      }
      console.log(`[init] ollama pull ${EMBED_MODEL} succeeded`);
      ollamaReady = true;
      resolve();
    });
  });

  return ollamaInitPromise;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Fetch a URL and return the response body as a string. Works for http/https. */
function fetchText(url) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const transport = parsed.protocol === 'https:' ? https : http;
    transport.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        // Follow one redirect
        return fetchText(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      let body = '';
      res.on('data', chunk => (body += chunk));
      res.on('end', () => resolve(body));
      res.on('error', reject);
    }).on('error', reject);
  });
}

/** Call the Ollama embeddings endpoint and return a number[]. */
async function embed(text) {
  const payload = JSON.stringify({ model: EMBED_MODEL, prompt: text });
  return new Promise((resolve, reject) => {
    const url = new URL(`${OLLAMA_HOST}/api/embeddings`);
    const transport = url.protocol === 'https:' ? https : http;
    const req = transport.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        }
      },
      (res) => {
        let body = '';
        res.on('data', chunk => (body += chunk));
        res.on('end', () => {
          try {
            const parsed = JSON.parse(body);
            if (!parsed.embedding) return reject(new Error('No embedding in Ollama response'));
            resolve(parsed.embedding);
          } catch (e) {
            reject(new Error('Failed to parse Ollama response: ' + e.message));
          }
        });
        res.on('error', reject);
      }
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

/** Build a rich text blob from an agent registry entry for embedding. */
function agentToText(agent) {
  const parts = [
    `Agent: ${agent.name || agent.id}`,
    agent.description ? `Description: ${agent.description}` : '',
    agent.risk ? `Risk: ${agent.risk}` : '',
    agent.stepsToInstall ? `Installation: ${agent.stepsToInstall}` : '',
    agent.port ? `Port: ${agent.port}` : '',
    agent.currentVersion ? `Version: ${agent.currentVersion}` : ''
  ];
  return parts.filter(Boolean).join('\n');
}

// ---------------------------------------------------------------------------
// Startup seeding
// ---------------------------------------------------------------------------

async function seedFromRegistry() {
  console.log('[seed] Fetching agent registry from GitHub...');
  let registryText;
  try {
    registryText = await fetchText(AGENT_REGISTRY_URL);
  } catch (err) {
    console.error('[seed] Failed to fetch agent registry:', err.message);
    return;
  }

  let agents;
  try {
    agents = JSON.parse(registryText);
    if (!Array.isArray(agents)) throw new Error('Registry is not an array');
  } catch (err) {
    console.error('[seed] Failed to parse agent registry JSON:', err.message);
    return;
  }

  console.log(`[seed] Found ${agents.length} agents. Embedding agent metadata...`);

  for (const agent of agents) {
    const agentId = agent.id || agent.name;

    // 1. Embed the agent's own metadata
    const metaText = agentToText(agent);
    try {
      const vector = await embed(metaText);
      db.insert(`agent:${agentId}:meta`, vector, {
        type: 'agent-meta',
        agentId,
        name: agent.name,
        description: agent.description,
        port: agent.port,
        version: agent.currentVersion,
        risky: agent.risky,
        healthCheckUrl: agent.healthCheckUrl,
        text: metaText
      });
      console.log(`[seed]   ✓ Embedded metadata for "${agentId}"`);
    } catch (err) {
      console.error(`[seed]   ✗ Failed to embed metadata for "${agentId}":`, err.message);
    }

    // 2. Fetch and embed the API doc
    if (agent.apiDocUrl) {
      let apiDocText;
      try {
        apiDocText = await fetchText(agent.apiDocUrl);
      } catch (err) {
        console.error(`[seed]   ✗ Failed to fetch API doc for "${agentId}":`, err.message);
        continue;
      }

      // Split large docs into chunks of ~1500 chars with 200-char overlap
      const chunks = chunkText(apiDocText, 1500, 200);
      console.log(`[seed]   Embedding ${chunks.length} API doc chunk(s) for "${agentId}"...`);

      for (let i = 0; i < chunks.length; i++) {
        try {
          const vector = await embed(chunks[i]);
          db.insert(`agent:${agentId}:apidoc:${i}`, vector, {
            type: 'agent-apidoc',
            agentId,
            name: agent.name,
            chunkIndex: i,
            totalChunks: chunks.length,
            text: chunks[i]
          });
        } catch (err) {
          console.error(`[seed]   ✗ Failed to embed API doc chunk ${i} for "${agentId}":`, err.message);
        }
      }
      console.log(`[seed]   ✓ Embedded API doc for "${agentId}"`);
    }
  }

  try {
    const saved = db.save();
    console.log(`[seed] Done. ${db.size()} vectors persisted to ${saved.path}`);
  } catch (err) {
    console.error('[seed] Failed to persist DB:', err.message);
  }
}

/** Split text into overlapping chunks. */
function chunkText(text, chunkSize = 1500, overlap = 200) {
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    chunks.push(text.slice(start, start + chunkSize));
    start += chunkSize - overlap;
    if (start + overlap >= text.length) break;
  }
  // Include any trailing content not yet captured
  if (start < text.length && (chunks.length === 0 || chunks[chunks.length - 1] !== text.slice(start))) {
    chunks.push(text.slice(start));
  }
  return chunks;
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 50 * 1024 * 1024) {
        req.destroy();
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (e) {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  const payload = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    'Access-Control-Allow-Origin': '*'
  });
  res.end(payload);
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const parts = url.pathname.split('/').filter(Boolean);

  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
      });
      return res.end();
    }

    // Ensure Ollama model is available before handling any API request.
    // Fast no-op after the first successful pull (ollamaReady flag is set).
    await ollamaInit();

    // GET /health
    if (req.method === 'GET' && parts[0] === 'health') {
      return sendJson(res, 200, {
        status: 'ok',
        version: '1.0.0',
        type: 'vectordb',
        port: PORT,
        size: db.size(),
        dimension: db.dimension,
        metric: db.metric
      });
    }

    // POST /insert  { id, vector, metadata }
    if (req.method === 'POST' && parts[0] === 'insert') {
      const body = await readBody(req);
      if (!body.id || !body.vector) return sendJson(res, 400, { error: 'id and vector required' });
      return sendJson(res, 201, db.insert(body.id, body.vector, body.metadata || {}));
    }

    // POST /batch  { items: [{id, vector, metadata}] }
    if (req.method === 'POST' && parts[0] === 'batch') {
      const body = await readBody(req);
      if (!Array.isArray(body.items)) return sendJson(res, 400, { error: 'items array required' });
      const results = db.insertBatch(body.items);
      return sendJson(res, 201, { inserted: results.length });
    }

    // POST /search  { vector, topK, metadataEquals }
    if (req.method === 'POST' && parts[0] === 'search') {
      const body = await readBody(req);
      if (!body.vector) return sendJson(res, 400, { error: 'vector required' });
      const filter = body.metadataEquals
        ? (meta) => Object.entries(body.metadataEquals).every(([k, v]) => meta[k] === v)
        : null;
      const results = db.search(body.vector, { topK: body.topK, filter });
      return sendJson(res, 200, { results });
    }

    // GET /vectors/:id
    if (req.method === 'GET' && parts[0] === 'vectors' && parts[1]) {
      const entry = db.get(decodeURIComponent(parts[1]));
      return entry ? sendJson(res, 200, entry) : sendJson(res, 404, { error: 'not found' });
    }

    // DELETE /vectors/:id
    if (req.method === 'DELETE' && parts[0] === 'vectors' && parts[1]) {
      const existed = db.delete(decodeURIComponent(parts[1]));
      return sendJson(res, existed ? 200 : 404, { deleted: existed });
    }

    // POST /query  { prompt, topK, metadataEquals }
    // Convenience endpoint: embeds the prompt via Ollama then searches the DB.
    if (req.method === 'POST' && parts[0] === 'query') {
      const body = await readBody(req);
      if (!body.prompt) return sendJson(res, 400, { error: 'prompt required' });
      const vector = await embed(body.prompt);
      const filter = body.metadataEquals
        ? (meta) => Object.entries(body.metadataEquals).every(([k, v]) => meta[k] === v)
        : null;
      const results = db.search(vector, { topK: body.topK, filter });
      return sendJson(res, 200, { results });
    }

    // POST /save
    if (req.method === 'POST' && parts[0] === 'save') {
      return sendJson(res, 200, db.save());
    }

    return sendJson(res, 404, { error: 'not found' });
  } catch (err) {
    return sendJson(res, 500, { error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

server.listen(PORT, async () => {
  console.log(`VectorDB agent listening on port ${PORT} (metric=${METRIC})`);
  console.log(`Persisting to ${PERSIST_PATH}`);
  console.log(`Ollama host: ${OLLAMA_HOST}, embed model: ${EMBED_MODEL}`);

  // Ensure the embed model is present before seeding
  try {
    await ollamaInit();
  } catch (err) {
    console.error('[startup] Ollama init failed, seeding skipped:', err.message);
    return;
  }

  // Seed the DB from the remote agent registry on every cold start
  await seedFromRegistry();
});

process.on('SIGINT', () => {
  console.log('\nSaving before shutdown...');
  try { db.save(); } catch (e) { console.error('Save failed:', e.message); }
  process.exit(0);
});
