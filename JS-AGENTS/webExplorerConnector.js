const http = require("http");
const https = require("https");
const { URL } = require("url");
const url = require('url');
const PORT = 3031;

/**
 * Perform HTTPS GET request
 */
function fetch(url) {
    return new Promise((resolve, reject) => {
        const parsedUrl = new URL(url);

        const options = {
            hostname: parsedUrl.hostname,
            path: parsedUrl.pathname + parsedUrl.search,
            headers: {
                "User-Agent": "Mozilla/5.0"
            }
        };

        https.get(options, (res) => {
            let data = "";

            res.on("data", chunk => data += chunk);
            res.on("end", () => resolve(data));
        }).on("error", reject);
    });
}

function decodeUrl(redirectUrl) {
  try {
    // Add protocol if missing (for URLs starting with //)
    if (redirectUrl.startsWith("//")) {
      redirectUrl = "https:" + redirectUrl;
    }

    const url = new URL(redirectUrl);
    const encodedTarget = url.searchParams.get("uddg");

    if (!encodedTarget) return null;

    return decodeURIComponent(encodedTarget);
  } catch (error) {
    return null;
  }
}

/**
 * Extract search results from DuckDuckGo HTML
 */
function extractResults(html) {
    const results = [];
    const regex = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/g;

    let match;
    while ((match = regex.exec(html)) !== null && results.length < 5) {
        const url = decodeUrl(match[1]);
        const title = match[2]
            .replace(/<[^>]+>/g, "")
            .replace(/&[^;]+;/g, "")
            .trim();

        results.push({ title, url });
    }

    return results;
}

/**
 * Create HTTP Server
 */
const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    const requestUrl = new URL(req.url, `http://${req.headers.host}`);

    // Handle preflight requests
    if (req.method === 'OPTIONS') {
        res.writeHead(204); // No content
        return res.end();
    }

    const parsedUrl = url.parse(req.url, true);

    /* -------- HEALTH -------- */
    if (parsedUrl.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
            status: 'UP',
            version: '1.0',
            type: 'agent'
        }));
    } else if (requestUrl.pathname === "/search" && req.method === "GET") {
        const query = requestUrl.searchParams.get("q");

        if (!query) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Missing query parameter 'q'" }));
            return;
        }

        try {
            const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
            const html = await fetch(searchUrl);
            const results = extractResults(html);

            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
                query,
                count: results.length,
                results
            }, null, 2));

        } catch (err) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: err.message }));
        }

    } else {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Not Found" }));
    }
});

const message = `
╔══════════════════════════════════════════════════════════════╗
║               ⚠️  IMPORTANT INFO  ║
╠══════════════════════════════════════════════════════════════╣
║                                                              ║
║  🚫 Scraping websites without permission is NOT ethical.     ║
║                                                              ║
║  This is only for demo we discourage misuse and highlight    ║
║      responsible API usage.                                  ║
║  ✅ What you should do instead:                             ║
║     • Use official search APIs (Google, Bing, Brave, etc.)  ║
║     • Respect robots.txt and websites' Terms of Service      ║
║     • Always attribute data sources properly                 ║
║                                                              ║
║  📚 This is a DEMO application for learning purposes only.  ║
║                                                              ║
╚══════════════════════════════════════════════════════════════╝
  `;

server.listen(PORT, () => {
    console.log(`Web Search API running on http://localhost:${PORT}\n${message}`);
});