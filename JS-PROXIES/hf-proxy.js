#!/usr/bin/env node
const http = require('http');
const https = require('https');
const url = require('url');

const HF_API_URL = 'https://router.huggingface.co';
const PORT = 3003;

// Get HF token from command line or environment variable
let HF_TOKEN = process.env.HF_TOKEN || process.argv[2];

if (!HF_TOKEN) {
  console.error('Error: HuggingFace API token is required');
  console.error('Usage: HF_TOKEN=your_token node server.js or node server.js your_token');
  process.exit(1);
}

const server = http.createServer((req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, DELETE');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Expose-Headers', '*');

  // Handle OPTIONS
  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  const pathname = req.url.split('?')[0];

  // Proxy /v1/models and /v1/chat/completions
  if (pathname === '/v1/models' || pathname === '/v1/chat/completions') {
    proxyRequest(req, res, pathname);
  } else {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not Found' }));
  }
});

function proxyRequest(req, res, pathname) {
  let body = '';

  req.on('data', chunk => {
    body += chunk.toString();
  });

  req.on('end', () => {
    const options = {
      hostname: 'router.huggingface.co',
      path: pathname + (req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : ''),
      method: req.method,
      headers: {
        'Content-Type': 'application/json'
      }
    };

    // Always pass Authorization header with HF_TOKEN for /v1/chat/completions
    if (pathname === '/v1/chat/completions') {
      options.headers['Authorization'] = 'Bearer ' + HF_TOKEN;
    }

    if (body) {
      options.headers['Content-Length'] = Buffer.byteLength(body);
    }

    const proxyReq = https.request(options, (proxyRes) => {
      // Forward response headers
      const headers = { ...proxyRes.headers };
      delete headers['content-encoding'];
      res.writeHead(proxyRes.statusCode || 200, headers);
      proxyRes.pipe(res);
    });

    proxyReq.on('error', (error) => {
      console.error('Proxy error:', error);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal Server Error', details: error.message }));
    });

    if (body) {
      proxyReq.write(body);
    }

    proxyReq.end();
  });
}

server.listen(PORT, () => {
  console.log('✓ HuggingFace API Proxy Server running on http://localhost:' + PORT);
  console.log('✓ Proxying requests to: ' + HF_API_URL);
  console.log('✓ Set HF_TOKEN environment variable to your HuggingFace API token');
  console.log('');
  console.log('Examples:');
  console.log('  HF_TOKEN=your_token node server.js');
  console.log('  node server.js your_token');
  console.log('');
  console.log('Available endpoints:');
  console.log('  GET  http://localhost:3003/v1/models');
  console.log('  POST http://localhost:3003/v1/chat/completions');
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error('Error: Port ' + PORT + ' is already in use.');
    console.error('Either stop the process using the port or use PORT environment variable.');
  } else {
    console.error('Server error:', error);
  }
  process.exit(1);
});