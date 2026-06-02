/**
 * GloVe Word Vector Arithmetic - Express API
 *
 * Startup: loads the full GloVe model into memory once.
 * Then serves fast, synchronous requests.
 *
 * POST /evaluate
 * {
 *   "expression": "king - man + woman",
 *   "compareWith": ["queen", "car", "bus"]
 * }
 */

"use strict";

const fs       = require("fs");
const path     = require("path");
const https    = require("https");
const readline = require("readline");
const http     = require("http");

const PORT      = 4300;
const GLOVE_URL = "https://nlp.stanford.edu/data/glove.6B.zip";
const GLOVE_FILE = "glove.6B.100d.txt";
const CACHE_DIR  = path.join(__dirname, ".glove-cache");
const CACHE_PATH = path.join(CACHE_DIR, GLOVE_FILE);

// ── Global model (loaded once at startup) ────────────────────────────────────
/** @type {Map<string, Float32Array>} */
let MODEL = null;
let MODEL_STATUS = "not_loaded"; // "not_loaded" | "loading" | "ready" | "error"

// ── Math helpers ──────────────────────────────────────────────────────────────
function norm(v) {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  return Math.sqrt(s);
}

function cosineSim(a, b) {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot / (norm(a) * norm(b));
}

function vecOp(a, b, op) {
  const r = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) r[i] = op === "+" ? a[i] + b[i] : a[i] - b[i];
  return r;
}

// ── Expression evaluator ──────────────────────────────────────────────────────
/**
 * Parses "king - man + woman" or "king-man+woman" → result vector.
 * Returns { vector, wordsUsed } or throws { message, word } on unknown word.
 */
function evaluateExpression(expr, model) {
  const tokens = expr.match(/\w+|[+\-]/g);
  if (!tokens || tokens.length === 0) throw { status: 400, message: "Expression is empty or has no words." };

  let result = null;
  let op = "+";
  const wordsUsed = [];

  for (const token of tokens) {
    if (token === "+" || token === "-") { op = token; continue; }

    if (!model.has(token)) throw { status: 404, message: `Word '${token}' not found in GloVe vocabulary.`, word: token };

    wordsUsed.push(token);
    const vec = model.get(token);

    if (result === null) {
      result = Float32Array.from(vec);
    } else {
      result = vecOp(result, vec, op);
    }
  }

  if (!result) throw { status: 400, message: "No valid words found in expression." };
  return { vector: result, wordsUsed };
}

// ── Similarity scorer ─────────────────────────────────────────────────────────
function scoreWords(vector, candidates, model, options = {}) {
  const includeVectors = Boolean(options.includeVectors);

  return candidates
    .map((word) => {
      const w = word.toLowerCase().trim();
      if (!model.has(w)) return { word, inVocab: false, similarity: null };
      const embedding = model.get(w);
      return {
        word,
        inVocab: true,
        similarity: parseFloat(cosineSim(vector, embedding).toFixed(6)),
        ...(includeVectors ? { vector: Array.from(embedding) } : {}),
      };
    })
    .sort((a, b) => {
      if (!a.inVocab && !b.inVocab) return 0;
      if (!a.inVocab) return 1;
      if (!b.inVocab) return -1;
      return b.similarity - a.similarity;
    });
}

// ── GloVe loader ─────────────────────────────────────────────────────────────
async function loadFullGlove(filePath) {
  console.log("[glove] Reading vectors from disk (this takes ~30–60s)…");
  const model = new Map();
  const rl = readline.createInterface({ input: fs.createReadStream(filePath, { encoding: "utf8" }), crlfDelay: Infinity });

  let count = 0;
  for await (const line of rl) {
    if (!line.trim()) continue;
    const spaceIdx = line.indexOf(" ");
    const word = line.slice(0, spaceIdx);
    const parts = line.slice(spaceIdx + 1).split(" ");
    const vec = new Float32Array(parts.length);
    for (let i = 0; i < parts.length; i++) vec[i] = parseFloat(parts[i]);
    model.set(word, vec);
    if (++count % 50000 === 0) process.stdout.write(`\r[glove]   ${count.toLocaleString()} words loaded…`);
  }

  console.log(`\r[glove] Loaded ${model.size.toLocaleString()} word vectors.`);
  return model;
}

// ── Download + extract ────────────────────────────────────────────────────────
function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    console.log(`[glove] Downloading ${url}`);
    console.log("[glove] (one-time ~800 MB download, cached afterwards)");

    const file = fs.createWriteStream(dest);
    const get = (u) =>
      https.get(u, (res) => {
        if ([301, 302].includes(res.statusCode)) { get(res.headers.location); return; }
        if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode}`)); return; }

        const total = parseInt(res.headers["content-length"] || "0", 10);
        let received = 0;
        res.on("data", (chunk) => {
          received += chunk.length;
          if (total) process.stdout.write(`\r[glove]   ${((received / total) * 100).toFixed(1)}%  (${(received / 1e6).toFixed(0)} MB)`);
        });
        res.pipe(file);
        file.on("finish", () => { file.close(); console.log("\n[glove] Download complete."); resolve(); });
      }).on("error", reject);
    get(url);
  });
}

async function ensureGlove() {
  if (fs.existsSync(CACHE_PATH)) return;
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const zipPath = path.join(CACHE_DIR, "glove.6B.zip");
  await downloadFile(GLOVE_URL, zipPath);
  console.log("[glove] Extracting glove.6B.100d.txt…");
  const { execSync } = require("child_process");
  execSync(`unzip -p "${zipPath}" "${GLOVE_FILE}" > "${CACHE_PATH}"`);
  fs.unlinkSync(zipPath);
  console.log("[glove] Extraction done.");
}

// ── Minimal HTTP router (no framework needed) ─────────────────────────────────
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => { data += c; if (data.length > 1e6) reject(new Error("Request too large")); });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function send(res, status, body) {
  const json = JSON.stringify(body, null, 2);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(json) });
  res.end(json);
}

async function handleRequest(req, res) {
  const url = req.url.split("?")[0];
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  // ── OPTIONS preflight (required for CORS POST requests) ────────────────────
  if (req.method === "OPTIONS") {
    return send(res, 200, {});
  }
  
  // ── GET /health ──────────────────────────────────────────────────────────
  if (req.method === "GET" && url === "/health") {
    return send(res, 200, {
      status: MODEL_STATUS,
      vocabSize: MODEL ? MODEL.size : 0,
      message: MODEL_STATUS === "ready" ? "Model loaded and ready." : "Model is still loading…",
    });
  }

  // ── GET /vocab?word=king ─────────────────────────────────────────────────
  if (req.method === "GET" && url.startsWith("/vocab")) {
    if (MODEL_STATUS !== "ready") return send(res, 503, { error: "Model not ready yet.", status: MODEL_STATUS });
    const word = new URL(req.url, "http://x").searchParams.get("word");
    if (!word) return send(res, 400, { error: "Provide ?word=<term>" });
    const w = word.toLowerCase().trim();
    return send(res, 200, { word: w, inVocab: MODEL.has(w) });
  }

  // ── POST /evaluate ───────────────────────────────────────────────────────
  if (req.method === "POST" && url === "/evaluate") {
    if (MODEL_STATUS !== "ready") return send(res, 503, { error: "Model not ready yet. Check console of the backend server for download % and wait for it to complete.", status: MODEL_STATUS });

    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return send(res, 400, { error: "Invalid JSON body." });
    }

    const { expression, compareWith, includeVectors } = body;

    if (typeof expression !== "string" || !expression.trim())
      return send(res, 400, { error: "'expression' must be a non-empty string." });

    if (!Array.isArray(compareWith) || compareWith.length === 0)
      return send(res, 400, { error: "'compareWith' must be a non-empty array of strings." });

    if (compareWith.some((w) => typeof w !== "string"))
      return send(res, 400, { error: "All items in 'compareWith' must be strings." });

    // Normalise expression: lowercase, ensure spaces around operators
    const normExpr = expression.toLowerCase().trim().replace(/([+\-])/g, " $1 ").replace(/\s+/g, " ");

    let vector, wordsUsed;
    try {
      ({ vector, wordsUsed } = evaluateExpression(normExpr, MODEL));
    } catch (err) {
      return send(res, err.status || 500, { error: err.message, ...(err.word ? { unknownWord: err.word } : {}) });
    }

    const results = scoreWords(vector, compareWith, MODEL, { includeVectors });

    return send(res, 200, {
      expression: expression.trim(),
      normalised: normExpr.trim(),
      wordsUsed,
      ...(includeVectors ? { expressionVector: Array.from(vector) } : {}),
      results,
    });
  }

  // ── 404 ──────────────────────────────────────────────────────────────────
  return send(res, 404, {
    error: "Not found.",
    routes: [
      "GET  /health              - model load status",
      "GET  /vocab?word=<term>   - check if a word is in vocab",
      "POST /evaluate            - word vector arithmetic",
    ],
  });
}

// ── Boot ──────────────────────────────────────────────────────────────────────
async function boot() {
  // Start HTTP server immediately so /health works even while loading
  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      console.error("[server] Unhandled error:", err);
      send(res, 500, { error: "Internal server error." });
    });
  });

  server.listen(PORT, () => console.log(`[server] Listening on http://localhost:${PORT}`));

  // Load GloVe in background
  MODEL_STATUS = "loading";
  try {
    await ensureGlove();
    MODEL = await loadFullGlove(CACHE_PATH);
    MODEL_STATUS = "ready";
    console.log(`[server] ✓ Model ready - ${MODEL.size.toLocaleString()} words in vocabulary.`);
  } catch (err) {
    MODEL_STATUS = "error";
    console.error("[server] Failed to load GloVe model:", err);
  }
}

boot();
