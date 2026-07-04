'use strict';

const http = require('http');
const { URL } = require('url');
const VectorDB = require('./lib/vectordb');

const PORT = process.env.PORT || 4302;
const PERSIST_PATH = process.env.PERSIST_PATH || './data/vectors.json';
const METRIC = process.env.METRIC || 'cosine'; // cosine | euclidean | dot

const db = new VectorDB({ persistPath: PERSIST_PATH, metric: METRIC });

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

    // POST /insert { id, vector, metadata }
    if (req.method === 'POST' && parts[0] === 'insert') {
      const body = await readBody(req);
      if (!body.id || !body.vector) return sendJson(res, 400, { error: 'id and vector required' });
      return sendJson(res, 201, db.insert(body.id, body.vector, body.metadata || {}));
    }

    // POST /batch { items: [{id, vector, metadata}] }
    if (req.method === 'POST' && parts[0] === 'batch') {
      const body = await readBody(req);
      if (!Array.isArray(body.items)) return sendJson(res, 400, { error: 'items array required' });
      const results = db.insertBatch(body.items);
      return sendJson(res, 201, { inserted: results.length });
    }

    // POST /search { vector, topK, metadataEquals }
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

    // POST /save
    if (req.method === 'POST' && parts[0] === 'save') {
      return sendJson(res, 200, db.save());
    }

    return sendJson(res, 404, { error: 'not found' });
  } catch (err) {
    return sendJson(res, 500, { error: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`VectorDB agent listening on port ${PORT} (metric=${METRIC})`);
  console.log(`Persisting to ${PERSIST_PATH}`);
});

process.on('SIGINT', () => {
  console.log('\nSaving before shutdown...');
  try { db.save(); } catch (e) { console.error('Save failed:', e.message); }
  process.exit(0);
});