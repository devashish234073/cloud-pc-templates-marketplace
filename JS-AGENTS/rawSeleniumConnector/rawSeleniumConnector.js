const express = require("express");
const { NodeVM } = require("vm2");
const { Builder } = require("selenium-webdriver");
const chrome = require("selenium-webdriver/chrome");
const fs = require("fs");
const path = require('path');
const cors = require("cors");
const app = express();
const PORT = 3035;

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

    let driver = null;

    try {
        const createDriver = async (headless = true) => {
            const options = new chrome.Options();
            if (headless) options.addArguments("--headless=new");
            options.addArguments("--no-sandbox");
            options.addArguments("--disable-dev-shm-usage");
            options.addArguments("--disable-gpu");
            options.addArguments("--window-size=1920,1080");

            driver = await new Builder()
                .forBrowser("chrome")
                .setChromeOptions(options)
                .build();

            return driver;
        };

        // ✅ wrappedCode calls __executor — which resolves vmDone when truly finished
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
                            try {
                                fs.writeFileSync("out.txt", JSON.stringify({ error: e.message, stack: e.stack }, null, 2));
                            } catch (_) {}
                            vmResolve(); // always resolve so request doesn't hang
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
                    "selenium-webdriver": require("selenium-webdriver"),
                    "selenium-webdriver/chrome": require("selenium-webdriver/chrome"),
                },
            },
        });

        try {
            vm.run(wrappedCode, __filename);
        } catch (vmRunErr) {
            clearTimeout(timeoutHandle);
            writeError(vmRunErr?.message ?? String(vmRunErr), { stack: vmRunErr?.stack });
            vmResolve();
        }

        // ✅ Waits until __executor's asyncFn fully completes
        await vmDone;

        if (driver) {
            try { await driver.quit(); } catch (_) { }
            driver = null;
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
        if (driver) {
            try { await driver.quit(); } catch (_) { }
        }
        console.error("Execution error:", err.message);
        return res.status(500).json({
            success: false,
            error: err.message,
            stack: process.env.NODE_ENV === "development" ? err.stack : undefined,
        });
    }
});

app.get("/health", (_, res) => res.json({ status: "UP", version: "3.0", port: PORT }));

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
            body_plain: "Your raw Selenium JS code",
            body_json: { code: "Your raw Selenium JS code" },
            note: "Use createDriver() inside your code to get a WebDriver instance. Use `return` to return results.",
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
    console.log(`Selenium Execution Server running on http://localhost:${PORT}`);
    console.log(`Visit http://localhost:${PORT}/ for usage instructions`);
});