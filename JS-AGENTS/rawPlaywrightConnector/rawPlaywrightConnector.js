const express = require("express");
const { NodeVM } = require("vm2");
const { chromium } = require("playwright");
const fs = require("fs");
const path = require('path');
const cors = require("cors");

const app = express();
const PORT = 3036;

// ✅ Global safety net — prevents ANY unhandled rejection from crashing the process
process.on("unhandledRejection", (reason, promise) => {
    console.error("⚠️  Unhandled rejection (caught globally):", reason?.message ?? reason);
});

process.on("uncaughtException", (err) => {
    console.error("⚠️  Uncaught exception (caught globally):", err.message);
});

const corsOptions = {
    origin: process.env.CORS_ORIGIN || "*",
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    optionsSuccessStatus: 204,
};

app.use(cors(corsOptions));
app.options("/{*path}", cors(corsOptions));
app.use(express.json({ limit: "10mb" }));
app.use(express.text({ limit: "10mb" }));

/* ------------------ API HIT TRACKING ------------------ */

const apiHitCounts = {
    'POST /execute': 0,
    'GET /': 0
};

function writeError(message, extra = {}) {
    try {
        fs.writeFileSync("out.txt", JSON.stringify({ error: message, ...extra }, null, 2));
    } catch (_) {}
}

function getApiDocContent() {
  const scriptPath = process.argv[1];
  const dir = path.dirname(scriptPath);
  const baseName = path.basename(scriptPath, path.extname(scriptPath));
  const apiFileName = `${baseName}-API.md`;
  const sameDirPath = path.join(dir, apiFileName);
  if (fs.existsSync(sameDirPath)) return fs.readFileSync(sameDirPath, 'utf-8');
  const parentDirPath = path.join(dir, '..', apiFileName);
  if (fs.existsSync(parentDirPath)) return fs.readFileSync(parentDirPath, 'utf-8');
  return null;
}

app.post("/execute", async (req, res) => {
    apiHitCounts['POST /execute']++;
    fs.writeFileSync("out.txt", JSON.stringify({ error: "No results" }, null, 2));

    let code = typeof req.body === "string" ? req.body : req.body?.code;

    if (!code || typeof code !== "string") {
        return res.status(400).json({
            success: false,
            error: 'No code provided. Send raw JS code as text/plain or JSON { "code": "..." }',
        });
    }

    console.log("\nReceived code to execute:");
    console.log("─".repeat(50));
    console.log(code);
    console.log("─".repeat(50));

    let browser = null;

    try {
        const createDriver = async (headless = true) => {
            browser = await chromium.launch({
                headless,
                args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
            });
            const context = await browser.newContext({
                viewport: { width: 1920, height: 1080 },
            });
            browser._defaultContext = context;
            browser.get = async (url) => {
                const page = await context.newPage();
                browser._currentPage = page;
                await page.goto(url);
            };
            browser.getTitle = async () => {
                return browser._currentPage ? browser._currentPage.title() : null;
            };
            browser.getPageSource = async () => {
                return browser._currentPage ? browser._currentPage.content() : null;
            };
            browser.quit = async () => {
                await browser.close();
            };
            return browser;
        };

        const wrappedCode = `
__executor(async () => {
    const __userFn = async () => {
        ${code}
    };
    const results = await __userFn();
    if (results !== undefined) {
        const _fs = require("fs");
        _fs.writeFileSync("out.txt", JSON.stringify(results, null, 2));
    }
});
`;

        let vmResolve;
        const vmDone = new Promise((res) => { vmResolve = res; });

        const vm = new NodeVM({
            timeout: 60000,
            sandbox: {
                createDriver,
                __executor: (asyncFn) => {
                    asyncFn()
                        .then(vmResolve)
                        .catch((e) => {
                            writeError(e.message, { stack: e.stack });
                            vmResolve();
                        });
                },
                console: {
                    log: (...args) => console.log("  [sandbox]", ...args),
                    error: (...args) => console.error("  [sandbox]", ...args),
                    warn: (...args) => console.warn("  [sandbox]", ...args),
                },
            },
            require: {
                external: true,
                builtin: ["path", "fs", "url"],
                mock: {
                    playwright: require("playwright"),
                },
            },
        });

        try {
            vm.run(wrappedCode, __filename);
        } catch (vmRunErr) {
            writeError(vmRunErr?.message ?? String(vmRunErr), { stack: vmRunErr?.stack });
            vmResolve();
        }

        await vmDone;

        if (browser) {
            try { await browser.close(); } catch (_) {}
            browser = null;
        }

        console.log("✅ Execution successful");

        try {
            return res.status(200).json({
                success: true,
                result: String(fs.readFileSync("out.txt")) ?? null,
            });
        } catch (e) {
            return res.status(200).json({ success: false, result: e.message });
        }

    } catch (err) {
        if (browser) {
            try { await browser.close(); } catch (_) {}
        }
        console.error("Execution error:", err.message);
        return res.status(500).json({
            success: false,
            error: err.message,
            stack: process.env.NODE_ENV === "development" ? err.stack : undefined,
        });
    }
});

app.get("/health", (_, res) => res.json({ status: "UP", version: "1.0", port: PORT }));

app.get("/insights", (_, res) => res.json({ apiHitCounts }));

app.get('/apidoc', (req, res) => {
  const content = getApiDocContent();
  if (!content) {
    return res.status(404).json({ error: 'API doc not found' });
  }
  res.status(200).type('text/markdown').send(content);
});

app.get("/", (_, res) => {
    apiHitCounts['GET /']++;
    res.json({
        usage: {
            endpoint: "POST /execute",
            contentType: "text/plain  OR  application/json",
            body_plain: "Your raw Playwright JS code",
            body_json: { code: "Your raw Playwright JS code" },
            note: "Use createDriver() inside your code to get a browser instance. Use `return` to return results.",
        },
        example_code: `
const driver = await createDriver();
await driver.get("https://example.com");
const title = await driver.getTitle();
const html  = await driver.getPageSource();
await driver.quit();
return { title, htmlLength: html.length };
    `.trim(),
    });
});

app.listen(PORT, () => {
    console.log(`Playwright Execution Server running on http://localhost:${PORT}`);
    console.log(`Visit http://localhost:${PORT}/ for usage instructions`);
});