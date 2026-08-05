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

const MAX_ORCHESTRATION_STEPS = 20;
const MAX_HISTORY_TURNS = 12;

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

function getHeaderValue(headers, headerName) {
  const normalizedName = String(headerName || '').toLowerCase();
  if (!headers) {
    return undefined;
  }

  if (headers[normalizedName] !== undefined) {
    return headers[normalizedName];
  }

  if (headers[headerName] !== undefined) {
    return headers[headerName];
  }

  const matchedEntry = Object.entries(headers).find(([key]) => String(key).toLowerCase() === normalizedName);
  return matchedEntry ? matchedEntry[1] : undefined;
}

function buildErrorResponse(errorMessage, errorCode, responseTimeMs, retryable = false) {
  return {
    isError: true,
    error: String(errorMessage || 'LLM call failed'),
    errorCode: errorCode !== undefined ? String(errorCode) : undefined,
    retryable,
    responseTimeMs,
  };
}

async function classifyRetryableError(baseUrl, errorMessage, errorCode, options = {}) {
  const classifierPrompt = `You are a classifier. Decide whether the following AI provider error is likely retryable. Return ONLY JSON in this shape: {"retryable": true/false, "reason": "brief reason"}.\nError code: ${errorCode ?? 'unknown'}\nError: ${errorMessage}`;

  try {
    const classifierResult = await callAiApiInternal(baseUrl, classifierPrompt, {
      ...options,
      temperature: 0,
      systemPrompt: 'You are an error classification assistant. Respond with strict JSON only.',
      messages: [{ role: 'user', content: classifierPrompt }],
    }, false);

    if (classifierResult.isError) {
      return false;
    }

    const parsed = typeof classifierResult.content === 'string'
      ? parseJsonLikeResponse(classifierResult.content)
      : null;

    return Boolean(parsed?.retryable);
  } catch (error) {
    return false;
  }
}

function callAiApi(baseUrl, prompt, options = {}) {
  return callAiApiInternal(baseUrl, prompt, options, true);
}

function callAiApiInternal(baseUrl, prompt, options = {}, shouldClassifyErrors = true) {
  return new Promise((resolve) => {
    const startMs = Date.now();
    const normalizedBaseUrl = String(baseUrl || '').trim();

    if (!normalizedBaseUrl) {
      resolve(buildErrorResponse('Missing aiApiEndpoint', 'missing_ai_api_endpoint', Date.now() - startMs, false));
      return;
    }

    let requestUrl;
    try {
      requestUrl = new URL(normalizedBaseUrl);
    } catch (error) {
      resolve(buildErrorResponse(`Invalid aiApiEndpoint: ${error.message}`, 'invalid_ai_api_endpoint', Date.now() - startMs, false));
      return;
    }

    const headers = { 'Content-Type': 'application/json' };

    if (options.token) {
      headers.Authorization = `Bearer ${options.token}`;
    }

    const messages = Array.isArray(options.messages) ? options.messages : [];
    if (!messages.length) {
      messages.push({ role: 'user', content: prompt });
    }

    if (options.systemPrompt && !messages.some((message) => message.role === 'system')) {
      messages.unshift({ role: 'system', content: options.systemPrompt });
    }

    const payload = {
      model: options.model || 'default',
      messages,
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
      async (response) => {
        let responseBody = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          responseBody += chunk;
        });
        response.on('end', async () => {
          const elapsedMs = Date.now() - startMs;
          const ollamaError = getHeaderValue(response.headers, 'x-ollama-error');
          if (ollamaError) {
            const retryable = shouldClassifyErrors
              ? await classifyRetryableError(normalizedBaseUrl, String(ollamaError), response.statusCode, options)
              : false;
            resolve(buildErrorResponse(String(ollamaError), response.statusCode, elapsedMs, retryable));
            return;
          }

          if (response.statusCode && response.statusCode >= 400) {
            const retryable = shouldClassifyErrors
              ? await classifyRetryableError(normalizedBaseUrl, responseBody || `LLM API error ${response.statusCode}`, response.statusCode, options)
              : false;
            resolve(buildErrorResponse(responseBody || `LLM API error ${response.statusCode}`, response.statusCode, elapsedMs, retryable));
            return;
          }

          try {
            const parsed = responseBody ? JSON.parse(responseBody) : {};
            const content = parsed?.choices?.[0]?.message?.content ?? parsed?.choices?.[0]?.text ?? '';
            resolve({ isError: false, content, responseTimeMs: elapsedMs, raw: parsed });
          } catch (error) {
            resolve({ isError: false, content: responseBody, responseTimeMs: elapsedMs, raw: responseBody });
          }
        });
      }
    );

    request.on('error', async (error) => {
      const elapsedMs = Date.now() - startMs;
      const retryable = shouldClassifyErrors
        ? await classifyRetryableError(normalizedBaseUrl, error.message || 'Network error', 'network_error', options)
        : false;
      resolve(buildErrorResponse(error.message || 'Network error', 'network_error', elapsedMs, retryable));
    });

    request.write(JSON.stringify(payload));
    request.end();
  });
}

function stripCodeFences(text) {
  const trimmed = String(text || '').trim();
  const fenceMatch = trimmed.match(/^```[\w-]*\n([\s\S]*?)\n?```$/);
  return fenceMatch ? fenceMatch[1].trim() : trimmed;
}

function parseJsonLikeResponse(rawText) {
  const cleaned = stripCodeFences(rawText);
  try {
    return JSON.parse(cleaned);
  } catch (error) {
    const candidateMatch = cleaned.match(/\{[\s\S]*\}/);
    if (!candidateMatch) {
      return null;
    }
    try {
      return JSON.parse(candidateMatch[0]);
    } catch (innerError) {
      return null;
    }
  }
}

function truncateText(text, max = 800) {
  return text && text.length > max ? `${text.slice(0, max)}…` : text;
}

function buildAgentBriefs() {
  return (Array.isArray(agentRegistryCache) ? agentRegistryCache : [])
    .map((agent) => `- ${agent.id} - "${agent.name || agent.id}" (port ${agent.port || 'n/a'}, risk: ${agent.risk || 'unknown'}): ${agent.description || 'No description provided.'}`)
    .join('\n') || '(no agents registered)';
}

function buildPlanningPrompt({ prompt, vectorContext, expandedApiDocs, executionHistory, actionsTakenSoFar }) {
  const historyBlock = (Array.isArray(executionHistory) ? executionHistory : [])
    .map((entry) => `Step ${entry.step}:\n${entry.requests.map((request, index) => {
      const result = entry.results[index];
      return `  ${request.httpMethod} ${request.apiUrl} → ${result?.success ? 'OK' : `FAILED: ${result?.error || 'unknown error'}`}\n  response: ${truncateText(JSON.stringify(result?.data ?? result?.error ?? null))}`;
    }).join('\n')}`)
    .join('\n\n') || '(no agent calls executed yet)';

  const expandedDocsBlock = Object.keys(expandedApiDocs || {}).length
    ? Object.entries(expandedApiDocs)
      .map(([agentId, doc]) => `### Full API doc - ${agentId}\n${doc}`)
      .join('\n\n')
    : '(none requested yet)';

  return `You are the planning brain of a multi-agent orchestrator. Decide the SINGLE next step needed to accomplish the user's task. Do not try to finish the whole task in one shot - return exactly one step, you will be asked again after it runs.\n\n## Current task\n${prompt || '(empty prompt)'}\n\n## Known agents (brief)\n${buildAgentBriefs()}\n\n## Full API docs pulled into context so far\n${expandedDocsBlock}\n\n## Agent calls executed so far, with results\n${historyBlock}\n\n## Vector DB context (retrieved for this step)\n${vectorContext || '(no relevant vector db context)'}\n\n## Actions taken by you so far based on previous reflections\n${(actionsTakenSoFar || []).join('\n') || '(none)'}\n\n## Your response\nRespond with ONLY strict JSON (no markdown fences, no commentary) matching exactly ONE of these three shapes:\n\n1) Execute one or more agent API calls:\n{\n  \"stepType\": \"execute\",\n  \"reasoning\": \"short reason\",\n  \"whatIsBeingDone\": \"I'm ... (first-person, 1-2 sentences)\",\n  \"requests\": [\n    {\n      \"agentId\": \"id of the agent from the list above\",\n      \"apiUrl\": \"full or relative endpoint URL to call\",\n      \"httpMethod\": \"GET\" | \"POST\" | \"PUT\" | \"DELETE\",\n      \"payload\": { }\n    }\n  ]\n}\n\n2) Request full API documentation before deciding (only the brief description is in context above):\n{\n  \"stepType\": \"more_info\",\n  \"reasoning\": \"short reason\",\n  \"whatIsBeingDone\": \"I'm ... (first-person, name what you're looking into and why)\",\n  \"agentIds\": [\"agentId1\", \"agentId2\"]\n}\n\n3) No agent action is needed - answer directly:\n{\n  \"stepType\": \"stop\",\n  \"reasoning\": \"short reason\",\n  \"whatIsBeingDone\": \"I'm ... (first-person, summarize what the answer covers or what all is done, not just 'providing an answer', reply as if you are talking to the user directly)\",\n  \"finalPrompt\": \"a fully self-contained prompt (including any needed context) to send to the LLM to produce the final answer for the user\"\n}\n\nOutput EXACTLY ONE JSON object matching one of the three shapes above.\n`;
}

function normalizeAgentApiUrl(apiUrl, requestAgentId) {
  let normalizedUrl = String(apiUrl || '').trim();

  if (!normalizedUrl) {
    return { error: 'Missing apiUrl' };
  }

  if (/^https?:\/\//i.test(normalizedUrl)) {
    const idx = normalizedUrl.indexOf('http');
    if (idx > 0) {
      normalizedUrl = normalizedUrl.substring(idx);
    }
    return { url: normalizedUrl };
  }

  if (normalizedUrl.startsWith('/')) {
    const port = portCacheByAgentId[requestAgentId];
    if (!port) {
      return { error: `Relative URL "${normalizedUrl}" has no host, and no matching agent (agentId: "${requestAgentId || '(none)'}") to resolve it against.` };
    }

    return { url: `http://localhost:${port}${normalizedUrl}` };
  }

  return { url: `http://${normalizedUrl}` };
}

function sendHttpRequest(url, method, payload) {
  return new Promise((resolve) => {
    const parsedUrl = new URL(url);
    const requestBody = payload !== undefined && payload !== null ? JSON.stringify(payload) : undefined;
    const transport = parsedUrl.protocol === 'https:' ? https : http;
    const request = transport.request(
      {
        protocol: parsedUrl.protocol,
        hostname: parsedUrl.hostname,
        port: parsedUrl.port,
        path: `${parsedUrl.pathname}${parsedUrl.search}`,
        method: method || 'GET',
        headers: {
          'Content-Type': 'application/json',
          ...(requestBody ? { 'Content-Length': Buffer.byteLength(requestBody) } : {}),
        },
      },
      (response) => {
        let responseBody = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          responseBody += chunk;
        });
        response.on('end', () => {
          let parsedBody = null;
          try {
            parsedBody = responseBody ? JSON.parse(responseBody) : null;
          } catch (error) {
            parsedBody = responseBody;
          }
          resolve({ response, body: parsedBody, text: responseBody });
        });
      }
    );

    request.on('error', (error) => {
      resolve({ response: null, body: null, text: error.message, error: true });
    });

    if (requestBody) {
      request.write(requestBody);
    }
    request.end();
  });
}

async function fetchVectorDbContext(vectorDbEndpoint, promptText, topK = 3) {
  if (!vectorDbEndpoint || !promptText || !String(promptText).trim()) {
    return '';
  }

  try {
    const vectorDbUrl = new URL(`${String(vectorDbEndpoint).replace(/\/+$/, '')}/query`);
    const response = await sendHttpRequest(vectorDbUrl.toString(), 'POST', { prompt: promptText, topK });
    if (response.error || !response.response || response.response.statusCode >= 400) {
      return '';
    }

    const results = Array.isArray(response.body?.results) ? response.body.results : [];
    if (!results.length) {
      return '';
    }

    return results
      .map((result, index) => `[${index + 1}] ${result.metadata?.name || result.id || 'result'}\n${result.metadata?.text || result.text || ''}`)
      .join('\n\n---\n\n');
  } catch (error) {
    return '';
  }
}

async function executeAgentApiCalls(requests) {
  const results = [];

  for (const request of Array.isArray(requests) ? requests : []) {
    if (request.errorMessage) {
      results.push({ success: false, error: request.errorMessage });
      continue;
    }

    let payload = undefined;
    if (request.httpMethod !== 'GET') {
      if (request.payload && typeof request.payload === 'object') {
        payload = request.payload;
      } else if (request.payload && typeof request.payload === 'string') {
        try {
          payload = JSON.parse(request.payload);
        } catch (error) {
          try {
            payload = JSON.parse(stripCodeFences(request.payload));
          } catch (innerError) {
            results.push({ success: false, error: `Failed to parse payload: ${innerError.message}` });
            continue;
          }
        }
      }
    }

    const normalizedUrl = normalizeAgentApiUrl(request.apiUrl, request.agentId);
    if (normalizedUrl.error) {
      results.push({ success: false, error: normalizedUrl.error });
      continue;
    }

    const response = await sendHttpRequest(normalizedUrl.url, request.httpMethod || 'GET', payload);
    if (response.error || !response.response || !response.response.statusCode || response.response.statusCode >= 400) {
      results.push({ success: false, error: response.text || 'Request failed' });
      continue;
    }

    results.push({ success: true, data: response.body, error: undefined });
  }

  return results;
}

async function resolveFinalAnswer({ aiApiEndpoint, prompt, model, token, temperature, executionHistory, plannerFinalPrompt }) {
  const executionBlock = (executionHistory || []).length
    ? executionHistory
      .map((entry) => `Step ${entry.step}:\n${entry.requests.map((request, index) => {
        const result = entry.results[index];
        return `  ${request.httpMethod} ${request.apiUrl} → ${result?.success ? 'OK' : `FAILED: ${result?.error}`}`;
      }).join('\n')}`)
      .join('\n\n')
    : '(no agent calls were executed for this task)';

  const synthesisPrompt = `The task below has already been completed via agent orchestration. Write the final answer for the user based on what was ACTUALLY done, per the execution log - do not restate the task as something upcoming.\n## Original task\n${prompt || '(empty prompt)'}\n## Agent calls executed and their results\n${executionBlock}\n## Planner's guidance for the final answer\n${plannerFinalPrompt || '(none - infer the answer from the execution log above)'}\nRespond directly with the final answer for the user, in plain text.`;

  const llmResponse = await callAiApi(aiApiEndpoint, synthesisPrompt, {
    model,
    token,
    temperature,
    systemPrompt: 'You are a helpful assistant delivering the final result of a task that has already been completed. Speak about the work in the past tense - do not describe it as something you are about to do.',
  });

  if (llmResponse.isError) {
    return llmResponse.error || 'Task completed.';
  }

  return llmResponse.content || 'Task completed.';
}

async function orchestrateTask({ prompt, aiApiEndpoint, vectorDbEndpoint, model, token, temperature }) {
  const executionHistory = [];
  const expandedApiDocs = {};
  const actionsTakenSoFar = [];
  let lastExecuteSignature = null;
  let stagnantStreak = 0;

  for (let step = 1; step <= MAX_ORCHESTRATION_STEPS; step += 1) {
    const vectorContext = await fetchVectorDbContext(vectorDbEndpoint, prompt);
    const planningPrompt = buildPlanningPrompt({
      prompt,
      vectorContext,
      expandedApiDocs,
      executionHistory,
      actionsTakenSoFar,
    });

    const llmResponse = await callAiApi(aiApiEndpoint, planningPrompt, {
      model,
      token,
      temperature,
      systemPrompt: 'You are the planning brain of a multi-agent orchestrator. Always respond with strict JSON only - no markdown fences, no commentary, no text outside the JSON object.',
    });

    if (llmResponse.isError) {
      return {
        ok: false,
        error: llmResponse.error || 'The planner call failed.',
        retryable: Boolean(llmResponse.retryable),
        executionHistory,
        steps: step,
      };
    }

    const plan = parseJsonLikeResponse(llmResponse.content);
    if (!plan || !['execute', 'more_info', 'stop'].includes(plan.stepType)) {
      return {
        ok: false,
        error: 'The planner returned an invalid response.',
        executionHistory,
        steps: step,
      };
    }

    if (plan.whatIsBeingDone) {
      actionsTakenSoFar.push(plan.whatIsBeingDone);
    }

    if (plan.stepType === 'stop') {
      const finalMessage = await resolveFinalAnswer({
        aiApiEndpoint,
        prompt,
        model,
        token,
        temperature,
        executionHistory,
        plannerFinalPrompt: plan.finalPrompt,
      });

      return {
        ok: true,
        finalMessage,
        executionHistory,
        steps: step,
        actionsTakenSoFar,
      };
    }

    if (plan.stepType === 'more_info') {
      const requestedIds = Array.isArray(plan.agentIds) ? plan.agentIds.filter(Boolean) : [];
      for (const agentId of requestedIds) {
        const docEntry = apiDocCacheByAgentId[agentId];
        if (docEntry?.content) {
          expandedApiDocs[agentId] = docEntry.content;
        }
      }
      continue;
    }

    const requests = Array.isArray(plan.requests) ? plan.requests : [];
    if (!requests.length) {
      continue;
    }

    const results = await executeAgentApiCalls(requests);
    executionHistory.push({ step, requests, results });

    const signature = new Set(requests.map((request) => `${(request.httpMethod || 'GET').toUpperCase()} ${String(request.apiUrl || '').split('?')[0]}`));
    if (lastExecuteSignature && signature.size === lastExecuteSignature.size && Array.from(signature).every((item) => lastExecuteSignature.has(item))) {
      stagnantStreak += 1;
    } else {
      stagnantStreak = 0;
    }
    lastExecuteSignature = signature;

    if (stagnantStreak >= 2) {
      return {
        ok: false,
        error: 'Orchestration stalled: repeated the same call(s) without verifying success in between.',
        executionHistory,
        steps: step,
      };
    }
  }

  return {
    ok: false,
    error: `Stopped after ${MAX_ORCHESTRATION_STEPS} steps without a final answer.`,
    executionHistory,
    steps: MAX_ORCHESTRATION_STEPS,
  };
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
      version: '1.0',
      summary: 'This agent hosts the orchestration runtime for multi-step agent workflows. It plans tasks, requests fuller API documentation when needed, queries vector DB context, executes agent API calls, and synthesizes a final user-facing answer. It is designed to coordinate tool agents around a single prompt and return structured orchestration results. The endpoint accepts an execute request with agent, session, AI endpoint, vector DB, and prompt fields.',
      schema: {
        endpoint: '/execute',
        method: 'POST',
        requiredFields: ['agentId', 'sessionId', 'aiEndpointPort', 'vectorDbPort', 'prompt'],
        optionalFields: ['globalHost', 'model', 'token', 'temperature']
      }
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
    const orchestrationResult = await orchestrateTask({
      prompt,
      aiApiEndpoint,
      vectorDbEndpoint,
      model: params.model,
      token: params.token,
      temperature: params.temperature,
    });

    if (orchestrationResult.ok) {
      sendJson(res, 200, {
        ok: true,
        message: 'Orchestration completed',
        received: {
          'agent-id': agentId,
          'session-id': sessionId,
          'ai-api-endpoint': aiApiEndpoint,
          'vector-db-endpoint': vectorDbEndpoint,
          prompt
        },
        orchestration: {
          finalMessage: orchestrationResult.finalMessage,
          steps: orchestrationResult.steps,
          executionHistory: orchestrationResult.executionHistory,
          actionsTakenSoFar: orchestrationResult.actionsTakenSoFar,
        },
        llm: {
          content: orchestrationResult.finalMessage || '',
          responseTimeMs: 0
        }
      });
      return;
    }

    sendJson(res, 502, {
      error: 'Orchestration failed',
      message: orchestrationResult.error || 'Unknown orchestration error',
      orchestration: {
        steps: orchestrationResult.steps,
        executionHistory: orchestrationResult.executionHistory,
      }
    });
  } catch (error) {
    sendJson(res, 502, {
      error: 'Orchestration failed',
      message: error.message
    });
  }
});

server.listen(port, host, () => {
  console.log(`Agent server running on http://${host}:${port}`);
  console.log(`Loaded ${Array.isArray(agentRegistryCache) ? agentRegistryCache.length : 0} agent registry entries, ${Object.keys(apiDocCacheByAgentId).length} API docs, and ${Object.keys(portCacheByAgentId).length} ports.`);
});
