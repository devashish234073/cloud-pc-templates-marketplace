'use strict';

const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const { URL } = require('url');

const port = Number(process.env.PORT) || 3060;
const host = '0.0.0.0';
const registryPath = path.join(__dirname, 'agent-registry.json');

function getFileNameFromUrl(apiDocUrl) {
  try {
    const parsedUrl = new URL(apiDocUrl);
    const segments = parsedUrl.pathname.split('/');
    const fileName = segments[segments.length - 1];
    return fileName ? decodeURIComponent(fileName) : '';
  } catch (error) {
    return '';
  }
}

function loadAgentRegistry() {
  let registryData = [];

  try {
    const rawContent = fs.readFileSync(registryPath, 'utf8');
    registryData = JSON.parse(rawContent);
  } catch (error) {
    console.error(`Failed to load agent registry from ${registryPath}: ${error.message}`);
    process.exit(1);
  }

  const apiDocMap = {};
  const portMap = {};

  for (const entry of Array.isArray(registryData) ? registryData : []) {
    if (!entry || !entry.id || !entry.apiDocUrl) {
      continue;
    }

    const fileName = getFileNameFromUrl(entry.apiDocUrl);
    const localFilePath = fileName ? path.join(__dirname, fileName) : '';
    let apiDocContent = '';

    if (localFilePath) {
      try {
        apiDocContent = fs.readFileSync(localFilePath, 'utf8');
      } catch (error) {
        console.error(`Failed to load API doc for ${entry.id} from ${localFilePath}: ${error.message}`);
      }
    }

    apiDocMap[entry.id] = {
      agentId: entry.id,
      apiDocUrl: entry.apiDocUrl,
      fileName,
      content: apiDocContent
    };

    if (entry.port !== undefined && entry.port !== null) {
      portMap[entry.id] = entry.port;
    }
  }

  return { registryData, apiDocMap, portMap };
}

const { registryData: agentRegistryCache, apiDocMap: apiDocCacheByAgentId, portMap: portCacheByAgentId } = loadAgentRegistry();

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': '*' 
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';

    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      data += chunk;
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function parsePayload(rawBody) {
  if (!rawBody) {
    return {};
  }

  try {
    return JSON.parse(rawBody);
  } catch (error) {
    return {};
  }
}

function normalizeParams(query, body) {
  const params = {};

  const addParam = (value, name) => {
    if (value !== undefined && value !== null && value !== '') {
      params[name] = value;
    }
  };

  for (const [key, value] of Object.entries(query)) {
    addParam(value, key);
  }

  for (const [key, value] of Object.entries(body)) {
    addParam(value, key);
  }

  return params;
}

function callAiApi(baseUrl, prompt, options = {}) {
  return new Promise((resolve, reject) => {
    const startMs = Date.now();
    const normalizedBaseUrl = String(baseUrl || '').trim();

    if (!normalizedBaseUrl) {
      reject(new Error('Missing aiApiEndpoint'));
      return;
    }

    const requestUrl = new URL(`${normalizedBaseUrl.replace(/\/+$/, '')}/v1/chat/completions`);
    const headers = { 'Content-Type': 'application/json' };

    if (options.token) {
      headers.Authorization = `Bearer ${options.token}`;
    }

    const payload = {
      model: options.model || 'default',
      messages: [{ role: 'user', content: prompt }],
      temperature: options.temperature ?? 0.7,
      stream: false,
    };

    const transport = requestUrl.protocol === 'https:' ? https : http;
    const request = transport.request(
      {
        protocol: requestUrl.protocol,
        hostname: requestUrl.hostname,
        port: requestUrl.port,
        path: `${requestUrl.pathname}${requestUrl.search}`,
        method: 'POST',
        headers,
      },
      (response) => {
        let responseBody = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          responseBody += chunk;
        });
        response.on('end', () => {
          const elapsedMs = Date.now() - startMs;
          if (response.statusCode && response.statusCode >= 400) {
            reject(new Error(`LLM API error ${response.statusCode}: ${responseBody}`));
            return;
          }

          try {
            const parsed = responseBody ? JSON.parse(responseBody) : {};
            const content = parsed?.choices?.[0]?.message?.content ?? parsed?.choices?.[0]?.text ?? '';
            resolve({ content, responseTimeMs: elapsedMs, raw: parsed });
          } catch (error) {
            resolve({ content: responseBody, responseTimeMs: elapsedMs, raw: responseBody });
          }
        });
      }
    );

    request.on('error', (error) => {
      reject(new Error(`Network error: ${error.message}`));
    });

    request.write(JSON.stringify(payload));
    request.end();
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    sendJson(res, 204, {});
    return;
  }

  if (req.method !== 'GET' && req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = parsedUrl.pathname;

  if (pathname === '/health' && req.method === 'GET') {
    sendJson(res, 200, {
      status: 'UP',
      version: '1.0'
    });
    return;
  }

  if (pathname !== '/execute') {
    sendJson(res, 404, { error: 'Not found' });
    return;
  }

  const query = Object.fromEntries(parsedUrl.searchParams.entries());
  let body = {};

  if (req.method === 'POST') {
    const rawBody = await readBody(req);
    body = parsePayload(rawBody);
  }

  const params = normalizeParams(query, body);
  const agentId = params.agentId;
  const sessionId = params.sessionId;
  const aiEndpointPort = params.aiEndpointPort;
  const globalHost = params.globalHost || 'http://localhost';
  const vectorDbPort = params.vectorDbPort;
  const prompt = params.prompt;

  if (!agentId || !sessionId || !aiEndpointPort || !vectorDbPort || !prompt) {
    sendJson(res, 400, {
      error: 'Missing required parameters',
      required: ['agentId', 'sessionId', 'aiEndpointPort', 'vectorDbPort', 'prompt']
    });
    return;
  }
  const vectorDbEndpoint = `${globalHost}:${vectorDbPort}`;

  try {
    const aiApiEndpoint = globalHost + `:${aiEndpointPort}/v1/chat/completions`;
    const llmResult = await callAiApi(aiApiEndpoint, prompt, {
      model: params.model,
      token: params.token,
      temperature: params.temperature,
    });

    sendJson(res, 200, {
      ok: true,
      message: 'Execute request received',
      received: {
        'agent-id': agentId,
        'session-id': sessionId,
        'ai-api-endpoint': aiApiEndpoint,
        'vector-db-endpoint': vectorDbEndpoint,
        prompt
      },
      llm: {
        content: llmResult.content,
        responseTimeMs: llmResult.responseTimeMs
      }
    });
  } catch (error) {
    sendJson(res, 502, {
      error: 'LLM API call failed',
      message: error.message
    });
  }
});

server.listen(port, host, () => {
  console.log(`Agent server running on http://${host}:${port}`);
  console.log(`Loaded ${Array.isArray(agentRegistryCache) ? agentRegistryCache.length : 0} agent registry entries, ${Object.keys(apiDocCacheByAgentId).length} API docs, and ${Object.keys(portCacheByAgentId).length} ports.`);
});
