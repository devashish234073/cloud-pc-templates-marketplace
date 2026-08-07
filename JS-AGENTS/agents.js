'use strict';

/**
 * Single-agent orchestration wrapper.
 *
 * Per call, this wrapper is scoped to exactly ONE agent (agentId passed by the
 * orchestrator). It does NOT plan across the whole registry. It:
 *
 *   1. Queries the vector DB (which holds chunked API-doc context for ALL
 *      agents) with the user prompt.
 *   2. Asks the LLM whether the returned context (a) actually matches the
 *      agentId given by the orchestrator, and (b) is sufficient on its own,
 *      or whether the full API doc for this agent needs to be pulled from
 *      the in-memory doc map.
 *   3. Iteratively asks the LLM for the next concrete API call (endpoint,
 *      method, payload) to progress the task, executes it for real, and
 *      feeds the result (or error) back in, until the LLM says the task is
 *      done.
 *   4. Any x-ollama-error header from the AI endpoint is an immediate,
 *      non-retryable failure.
 *   5. Every other exception (AI call failure, agent call failure, JSON
 *      parse failure, etc.) is pushed onto a single shared `errors` array
 *      for the whole task. Once that array has more than 3 entries, the
 *      wrapper asks the LLM to classify the error sequence as retryable or
 *      not, and returns that verdict.
 *
 * Final response shape is always one of:
 *   { isError: true,  errorMessage: string, retryable: boolean }
 *   { isError: false, tasksCompleted: string }
 */

const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const { URL } = require('url');

const port = Number(process.env.PORT) || 3060;
const host = '0.0.0.0';
const registryPath = path.join(__dirname, 'agent-registry.json');

const MAX_ORCHESTRATION_STEPS = 20; // safety cap on number of "next action" decisions
const ERROR_THRESHOLD = 3;          // once shared errors.length > this, escalate to classifier

// ---------------------------------------------------------------------------
// Registry / API doc loading (per-agent full docs, loaded once at boot)
// ---------------------------------------------------------------------------

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
      content: apiDocContent,
    };

    if (entry.port !== undefined && entry.port !== null) {
      portMap[entry.id] = entry.port;
    }
  }

  return { registryData, apiDocMap, portMap };
}

const {
  registryData: agentRegistryCache,
  apiDocMap: apiDocCacheByAgentId,
  portMap: portCacheByAgentId,
} = loadAgentRegistry();

function getAgentBrief(agentId) {
  const entry = (Array.isArray(agentRegistryCache) ? agentRegistryCache : []).find((a) => a.id === agentId);
  if (!entry) return `(no registry entry found for agent "${agentId}")`;
  return `- ${entry.id} - "${entry.name || entry.id}" (port ${entry.port || 'n/a'}, risk: ${entry.risk || 'unknown'}): ${entry.description || 'No description provided.'}`;
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': '*',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function parsePayload(rawBody) {
  if (!rawBody) return {};
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
  for (const [key, value] of Object.entries(query)) addParam(value, key);
  for (const [key, value] of Object.entries(body)) addParam(value, key);
  return params;
}

function getHeaderValue(headers, headerName) {
  const normalizedName = String(headerName || '').toLowerCase();
  if (!headers) return undefined;
  if (headers[normalizedName] !== undefined) return headers[normalizedName];
  if (headers[headerName] !== undefined) return headers[headerName];
  const matchedEntry = Object.entries(headers).find(([key]) => String(key).toLowerCase() === normalizedName);
  return matchedEntry ? matchedEntry[1] : undefined;
}

function sendHttpRequest(url, method, payload) {
  return new Promise((resolve) => {
    let parsedUrl;
    try {
      parsedUrl = new URL(url);
    } catch (error) {
      resolve({ error: true, text: `Invalid URL "${url}": ${error.message}` });
      return;
    }

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
        response.on('data', (chunk) => { responseBody += chunk; });
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

    if (requestBody) request.write(requestBody);
    request.end();
  });
}

function normalizeAgentApiUrl(apiUrl, agentId) {
  let normalizedUrl = String(apiUrl || '').trim();

  if (!normalizedUrl) {
    return { error: 'Missing endpoint in LLM response' };
  }

  if (/^https?:\/\//i.test(normalizedUrl)) {
    return { url: normalizedUrl };
  }

  if (normalizedUrl.startsWith('/')) {
    const agentPort = portCacheByAgentId[agentId];
    if (!agentPort) {
      return { error: `Relative URL "${normalizedUrl}" has no host, and no known port for agent "${agentId}" to resolve it against.` };
    }
    return { url: `http://localhost:${agentPort}${normalizedUrl}` };
  }

  return { url: `http://${normalizedUrl}` };
}

// ---------------------------------------------------------------------------
// LLM call plumbing
// ---------------------------------------------------------------------------

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
    if (!candidateMatch) return null;
    try {
      return JSON.parse(candidateMatch[0]);
    } catch (innerError) {
      return null;
    }
  }
}

function truncateText(text, max = 1200) {
  return text && text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * Raw call to the AI endpoint. Never throws.
 * Returns one of:
 *   { isError: false, content }
 *   { isError: true, hardStop: true,  error }   <- x-ollama-error header present
 *   { isError: true, hardStop: false, error }   <- any other failure
 */
function callAiApiRaw(aiApiEndpoint, messages, options = {}) {
  return new Promise((resolve) => {
    let requestUrl;
    try {
      requestUrl = new URL(aiApiEndpoint);
    } catch (error) {
      resolve({ isError: true, hardStop: false, error: `Invalid aiApiEndpoint: ${error.message}` });
      return;
    }

    const headers = { 'Content-Type': 'application/json' };
    if (options.token) headers.Authorization = `Bearer ${options.token}`;

    const finalMessages = Array.isArray(messages) ? messages.slice() : [{ role: 'user', content: String(messages || '') }];
    if (options.systemPrompt && !finalMessages.some((m) => m.role === 'system')) {
      finalMessages.unshift({ role: 'system', content: options.systemPrompt });
    }

    const payload = {
      model: options.model || 'default',
      messages: finalMessages,
      temperature: options.temperature ?? 0.2,
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
        response.on('data', (chunk) => { responseBody += chunk; });
        response.on('end', () => {
          const ollamaError = getHeaderValue(response.headers, 'x-ollama-error');
          if (ollamaError) {
            resolve({ isError: true, hardStop: true, error: String(ollamaError) });
            return;
          }

          if (response.statusCode && response.statusCode >= 400) {
            resolve({ isError: true, hardStop: false, error: responseBody || `LLM API error ${response.statusCode}` });
            return;
          }

          try {
            const parsed = responseBody ? JSON.parse(responseBody) : {};
            const content = parsed?.choices?.[0]?.message?.content ?? parsed?.choices?.[0]?.text ?? responseBody;
            resolve({ isError: false, content });
          } catch (error) {
            resolve({ isError: false, content: responseBody });
          }
        });
      }
    );

    request.on('error', (error) => {
      resolve({ isError: true, hardStop: false, error: error.message || 'Network error calling AI endpoint.' });
    });

    request.write(JSON.stringify(payload));
    request.end();
  });
}

/**
 * Calls the AI endpoint, transparently retrying on non-hard-stop failures.
 * Every non-hard-stop failure is pushed onto `sharedErrors`. Once
 * `sharedErrors.length > ERROR_THRESHOLD`, asks the LLM to classify the
 * whole error sequence and bails out with that verdict.
 *
 * Returns:
 *   { bailed: false, content }
 *   { bailed: true, response: { isError: true, errorMessage, retryable } }
 */
async function callAiApiResilient(aiApiEndpoint, messages, options, sharedErrors, originalPrompt) {
  for (;;) {
    const result = await callAiApiRaw(aiApiEndpoint, messages, options);

    if (!result.isError) {
      return { bailed: false, content: result.content };
    }

    if (result.hardStop) {
      return { bailed: true, response: { isError: true, errorMessage: result.error, retryable: false } };
    }

    sharedErrors.push(`AI call failed: ${result.error}`);

    if (sharedErrors.length > ERROR_THRESHOLD) {
      const retryable = await classifyRetryable(sharedErrors, originalPrompt, aiApiEndpoint, options);
      return {
        bailed: true,
        response: { isError: true, errorMessage: sharedErrors[sharedErrors.length - 1], retryable },
      };
    }
    // else: loop and retry the same call
  }
}

async function classifyRetryable(sharedErrors, originalPrompt, aiApiEndpoint, options) {
  const classifierPrompt = `A task failed after repeated errors. Based on the user's original task and the full sequence of errors encountered while attempting it, decide whether retrying the task from scratch is likely to succeed. Respond with ONLY strict JSON, no markdown fences, no commentary: {"retryable": true/false, "reason": "brief reason"}.

Original task:
${originalPrompt || '(empty prompt)'}

Error sequence (in order):
${sharedErrors.map((entry, index) => `${index + 1}. ${entry}`).join('\n')}`;

  const result = await callAiApiRaw(aiApiEndpoint, [{ role: 'user', content: classifierPrompt }], {
    ...options,
    temperature: 0,
    systemPrompt: 'You are an error classification assistant. Respond with strict JSON only.',
  });

  if (result.isError) return false; // if we can't even classify, default to non-retryable
  const parsed = parseJsonLikeResponse(result.content);
  return Boolean(parsed?.retryable);
}

// ---------------------------------------------------------------------------
// Vector DB
// ---------------------------------------------------------------------------

/**
 * Queries the vector DB and returns both the raw context text (for prompting)
 * and the distinct set of agentIds present in the returned chunks.
 *
 * ASSUMPTION: each result's metadata carries an `agentId` field identifying
 * which agent's API doc that chunk came from (e.g. metadata: { agentId, name, text }).
 * Adjust the `result.metadata?.agentId` accessor below if your vector DB uses
 * a different field name.
 */
async function fetchVectorDbContext(vectorDbEndpoint, promptText, topK = 5) {
  if (!vectorDbEndpoint || !promptText || !String(promptText).trim()) {
    return { contextText: '', agentIds: [] };
  }

  try {
    const vectorDbUrl = new URL(`${String(vectorDbEndpoint).replace(/\/+$/, '')}/query`);
    const response = await sendHttpRequest(vectorDbUrl.toString(), 'POST', { prompt: promptText, topK });

    if (response.error || !response.response || response.response.statusCode >= 400) {
      return { contextText: '', agentIds: [] };
    }

    const results = Array.isArray(response.body?.results) ? response.body.results : [];
    if (!results.length) {
      return { contextText: '', agentIds: [] };
    }

    const agentIdSet = new Set();
    const contextText = results
      .map((result, index) => {
        const resultAgentId = result.metadata?.agentId || result.agentId;
        if (resultAgentId) agentIdSet.add(resultAgentId);
        const label = resultAgentId ? `${resultAgentId} / ${result.metadata?.name || result.id || 'result'}` : (result.metadata?.name || result.id || 'result');
        return `[${index + 1}] (${label})\n${result.metadata?.text || result.text || ''}`;
      })
      .join('\n\n---\n\n');

    return { contextText, agentIds: Array.from(agentIdSet) };
  } catch (error) {
    return { contextText: '', agentIds: [] };
  }
}

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------

function buildAssessmentPrompt({ prompt, agentId, vectorContextText }) {
  return `You are checking whether a delegated agent can handle a task, using only chunked API-doc context retrieved from a vector DB.

## Task
${prompt || '(empty prompt)'}

## Agent this call is scoped to
${getAgentBrief(agentId)}

## Vector DB context retrieved for this task (may span multiple agents' API docs)
${vectorContextText || '(no context returned)'}

## Your job
1. Look at which agent(s) the retrieved chunks actually belong to.
2. Decide whether those chunks include an API belonging to agent "${agentId}" (the one this call is scoped to).
3. If they do, decide whether the chunked detail alone is enough to confidently pick the exact endpoint/method/payload for the next step, or whether you'd need the FULL API doc for "${agentId}" to be sure.

Respond with ONLY strict JSON, no markdown fences, no commentary:
{
  "agentMatches": true/false,
  "vectorAgentIds": ["agentId1", "agentId2"],
  "sufficientContext": true/false,
  "reasoning": "short reason"
}`;
}

function buildDecisionPrompt({ prompt, agentId, docContext, executionHistory, lastError }) {
  const historyBlock = executionHistory.length
    ? executionHistory
      .map((entry, index) => `${index + 1}. ${entry.httpMethod} ${entry.endpoint} → ${entry.success ? 'OK' : 'FAILED'}\n   response: ${truncateText(JSON.stringify(entry.success ? entry.data : entry.error))}`)
      .join('\n')
    : '(no calls executed yet)';

  const errorBlock = lastError ? `\n\n## Most recent call failed with\n${lastError}\nUse this to correct the next call.` : '';

  return `You are the execution brain for a single delegated agent, "${agentId}". Decide the SINGLE next step to progress the task below. You may only call this agent's APIs.

## Task
${prompt || '(empty prompt)'}

## API documentation available for this agent
${docContext || '(no API doc context available)'}

## Calls executed so far, with results
${historyBlock}${errorBlock}

## Your response
Respond with ONLY strict JSON (no markdown fences, no commentary) matching exactly ONE of these two shapes:

1) Make an API call:
{
  "stepType": "call",
  "reasoning": "short reason",
  "endpoint": "full or relative endpoint URL to call",
  "httpMethod": "GET" | "POST" | "PUT" | "DELETE",
  "payload": {}
}

2) The task is complete - no more calls needed:
{
  "stepType": "stop",
  "reasoning": "short reason",
  "finalPrompt": "a fully self-contained prompt (including any needed context) to send to the LLM to produce the final tasksCompleted summary for the user"
}`;
}

function buildSummaryPrompt({ prompt, executionHistory, finalPrompt }) {
  const historyBlock = executionHistory.length
    ? executionHistory
      .map((entry, index) => `${index + 1}. ${entry.httpMethod} ${entry.endpoint} → ${entry.success ? 'OK' : `FAILED: ${entry.error}`}`)
      .join('\n')
    : '(no calls were executed for this task)';

  return `The task below has already been completed. Write a concise summary of what was actually done, based on the execution log - speak in the past tense, do not describe it as upcoming.

## Original task
${prompt || '(empty prompt)'}

## Calls executed
${historyBlock}

## Guidance
${finalPrompt || '(none - infer the summary from the execution log above)'}

Respond directly with the summary text, in plain text (no JSON, no markdown fences).`;
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

async function orchestrateSingleAgentTask({ prompt, agentId, aiApiEndpoint, vectorDbEndpoint, model, token, temperature }) {
  const sharedErrors = [];
  const aiOptions = { model, token, temperature };
  const executionHistory = [];

  // --- Step 1: vector DB context + agent-match / sufficiency assessment ---
  const { contextText: vectorContextText, agentIds: vectorAgentIds } = await fetchVectorDbContext(vectorDbEndpoint, prompt);

  const assessmentResult = await callAiApiResilient(
    aiApiEndpoint,
    [{ role: 'user', content: buildAssessmentPrompt({ prompt, agentId, vectorContextText }) }],
    { ...aiOptions, systemPrompt: 'Respond with strict JSON only - no markdown fences, no commentary.' },
    sharedErrors,
    prompt
  );
  if (assessmentResult.bailed) return assessmentResult.response;

  const assessment = parseJsonLikeResponse(assessmentResult.content);
  if (!assessment) {
    return { isError: true, errorMessage: 'The assessment step returned an invalid response.', retryable: true };
  }

  const resolvedVectorAgentIds = Array.isArray(assessment.vectorAgentIds) && assessment.vectorAgentIds.length
    ? assessment.vectorAgentIds
    : vectorAgentIds;

  if (!assessment.agentMatches) {
    return {
      isError: true,
      errorMessage: `I don't think this agent is helpful for this task with as I am only seeing these agent ids in vector db suggestion ${resolvedVectorAgentIds.join(', ') || '(none)'}`,
      retryable: false,
    };
  }

  // --- Step 2: pull full API doc if the chunked context wasn't enough ---
  let docContext = vectorContextText;
  if (!assessment.sufficientContext) {
    const fullDoc = apiDocCacheByAgentId[agentId]?.content;
    if (fullDoc) {
      docContext = `### Full API doc - ${agentId}\n${fullDoc}`;
    }
  }

  // --- Step 3: iterative call/stop loop ---
  let lastError = null;

  for (let step = 1; step <= MAX_ORCHESTRATION_STEPS; step += 1) {
    const decisionResult = await callAiApiResilient(
      aiApiEndpoint,
      [{ role: 'user', content: buildDecisionPrompt({ prompt, agentId, docContext, executionHistory, lastError }) }],
      { ...aiOptions, systemPrompt: 'Respond with strict JSON only - no markdown fences, no commentary.' },
      sharedErrors,
      prompt
    );
    if (decisionResult.bailed) return decisionResult.response;

    const decision = parseJsonLikeResponse(decisionResult.content);
    if (!decision || !['call', 'stop'].includes(decision.stepType)) {
      sharedErrors.push('Decision step returned an invalid response.');
      if (sharedErrors.length > ERROR_THRESHOLD) {
        const retryable = await classifyRetryable(sharedErrors, prompt, aiApiEndpoint, aiOptions);
        return { isError: true, errorMessage: sharedErrors[sharedErrors.length - 1], retryable };
      }
      continue;
    }

    if (decision.stepType === 'stop') {
      const summaryResult = await callAiApiResilient(
        aiApiEndpoint,
        [{ role: 'user', content: buildSummaryPrompt({ prompt, executionHistory, finalPrompt: decision.finalPrompt }) }],
        { ...aiOptions, systemPrompt: 'You summarize completed work in the past tense.' },
        sharedErrors,
        prompt
      );
      if (summaryResult.bailed) return summaryResult.response;

      return { isError: false, tasksCompleted: summaryResult.content || 'Task completed.' };
    }

    // stepType === 'call'
    const normalizedUrl = normalizeAgentApiUrl(decision.endpoint, agentId);
    if (normalizedUrl.error) {
      sharedErrors.push(normalizedUrl.error);
      lastError = normalizedUrl.error;
      if (sharedErrors.length > ERROR_THRESHOLD) {
        const retryable = await classifyRetryable(sharedErrors, prompt, aiApiEndpoint, aiOptions);
        return { isError: true, errorMessage: sharedErrors[sharedErrors.length - 1], retryable };
      }
      continue;
    }

    const httpResult = await sendHttpRequest(normalizedUrl.url, decision.httpMethod || 'GET', decision.payload);
    const callFailed = httpResult.error || !httpResult.response || httpResult.response.statusCode >= 400;

    if (callFailed) {
      const errorText = httpResult.text || 'Agent API call failed';
      executionHistory.push({ httpMethod: decision.httpMethod || 'GET', endpoint: decision.endpoint, success: false, error: errorText });
      sharedErrors.push(`Agent call ${decision.httpMethod || 'GET'} ${decision.endpoint} failed: ${errorText}`);
      lastError = errorText;

      if (sharedErrors.length > ERROR_THRESHOLD) {
        const retryable = await classifyRetryable(sharedErrors, prompt, aiApiEndpoint, aiOptions);
        return { isError: true, errorMessage: sharedErrors[sharedErrors.length - 1], retryable };
      }
      // loop back: next decision prompt will see this failure in executionHistory + lastError
      continue;
    }

    executionHistory.push({ httpMethod: decision.httpMethod || 'GET', endpoint: decision.endpoint, success: true, data: httpResult.body });
    lastError = null;
  }

  return {
    isError: true,
    errorMessage: `Stopped after ${MAX_ORCHESTRATION_STEPS} steps without completing the task.`,
    retryable: false,
  };
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

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
      version: '2.0',
      summary: 'Single-agent execution wrapper. Given an agentId from the orchestrator, checks vector DB context for a matching API, falls back to the full in-memory API doc if needed, then iteratively calls that agent\'s real endpoints (with LLM-guided retry on failure) until the task is complete.',
      schema: {
        endpoint: '/execute',
        method: 'POST',
        requiredFields: ['agentId', 'sessionId', 'aiEndpointPort', 'vectorDbPort', 'prompt'],
        optionalFields: ['globalHost', 'model', 'token', 'temperature'],
        responseShapes: [
          '{ isError: true, errorMessage: string, retryable: boolean }',
          '{ isError: false, tasksCompleted: string }',
        ],
      },
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
    body = parsePayload(await readBody(req));
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
      required: ['agentId', 'sessionId', 'aiEndpointPort', 'vectorDbPort', 'prompt'],
    });
    return;
  }

  const aiApiEndpoint = `${globalHost}:${aiEndpointPort}/v1/chat/completions`;
  const vectorDbEndpoint = `${globalHost}:${vectorDbPort}`;

  try {
    const result = await orchestrateSingleAgentTask({
      prompt,
      agentId,
      aiApiEndpoint,
      vectorDbEndpoint,
      model: params.model,
      token: params.token,
      temperature: params.temperature,
    });

    sendJson(res, result.isError ? 502 : 200, result);
  } catch (error) {
    sendJson(res, 502, {
      isError: true,
      errorMessage: error instanceof Error ? error.message : 'Wrapper failed.',
      retryable: false,
    });
  }
});

server.listen(port, host, () => {
  console.log(`Agent wrapper running on http://${host}:${port}`);
  console.log(`Loaded ${Array.isArray(agentRegistryCache) ? agentRegistryCache.length : 0} agent registry entries and ${Object.keys(apiDocCacheByAgentId).length} API docs.`);
});