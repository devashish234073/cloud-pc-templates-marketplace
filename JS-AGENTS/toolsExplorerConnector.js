const http = require('http');
const url = require('url');
const { exec } = require('child_process');
const { randomUUID } = require('crypto');
const os = require('os');

const PORT = 3032;
const timerStarts = new Map();

/* ------------------ HELPER: EXEC COMMAND ------------------ */

function runCommand(command) {
    return new Promise((resolve) => {
        exec(command, (error, stdout, stderr) => {
            if (error) {
                return resolve({
                    installed: false,
                    error: error.message
                });
            }

            const output = stdout || stderr;

            resolve({
                installed: true,
                version: output.trim()
            });
        });
    });
}

/* ------------------ TOOL VERSION CHECKS ------------------ */

async function getJavaVersion() {
    return runCommand('java -version');
}

async function getMavenVersion() {
    return runCommand('mvn -version');
}

async function getNodeVersion() {
    return runCommand('node -v');
}

async function getNpmVersion() {
    return runCommand('npm -v');
}

async function getPythonVersion() {
    return runCommand('python --version || python3 --version');
}

/* ------------------ SERVER ------------------ */

const server = http.createServer(async (req, res) => {

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    const parsedUrl = url.parse(req.url, true);

    /* -------- HEALTH -------- */
    if (parsedUrl.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
            status: 'UP',
            version: '2.0',
            type: 'agent',
            service: 'Tools Explorer',
            port: PORT
        }));
    }

    /* -------- ALL VERSIONS -------- */
    if (parsedUrl.pathname === '/versions') {
        res.writeHead(200, { 'Content-Type': 'application/json' });

        const [java, maven, node, npm, python] = await Promise.all([
            getJavaVersion(),
            getMavenVersion(),
            getNodeVersion(),
            getNpmVersion(),
            getPythonVersion()
        ]);

        return res.end(JSON.stringify({
            java,
            maven,
            node,
            npm,
            python
        }));
    }

    /* -------- INDIVIDUAL TOOL -------- */
    if (parsedUrl.pathname === '/version') {
        const { tool } = parsedUrl.query;

        if (!tool) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({
                error: "Provide ?tool=java|maven|node|npm|python"
            }));
        }

        let result;

        switch (tool.toLowerCase()) {
            case 'java':
                result = await getJavaVersion();
                break;
            case 'maven':
                result = await getMavenVersion();
                break;
            case 'node':
                result = await getNodeVersion();
                break;
            case 'npm':
                result = await getNpmVersion();
                break;
            case 'python':
                result = await getPythonVersion();
                break;
            default:
                res.writeHead(400, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({
                    error: "Unsupported tool. Use java|maven|node|npm|python"
                }));
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
            tool,
            result
        }));
    }

    /* -------- TIMER -------- */
    if (parsedUrl.pathname === '/timer') {
        const { ref } = parsedUrl.query;
        const now = Date.now();

        if (!ref) {
            const uuid = randomUUID();
            timerStarts.set(uuid, now);

            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({
                timeMillis: now,
                date: new Date(now).toISOString(),
                uuid
            }));
        }

        const startTime = timerStarts.get(ref);
        const elapsedMs = typeof startTime === 'number' ? now - startTime : 0;

        if (typeof startTime !== 'number') {
            timerStarts.set(ref, now);
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
            ref,
            timeMillis: now,
            date: new Date(now).toISOString(),
            elapsedMs
        }));
    }

    /* -------- SYSTEM USAGE -------- */
    if (parsedUrl.pathname === '/system-usage') {
        const cpus = os.cpus();
        const cpuUsage = await new Promise((resolve) => {
            const start = cpus.map(c => ({ idle: c.times.idle, total: Object.values(c.times).reduce((a, b) => a + b, 0) }));
            setTimeout(() => {
                const end = os.cpus().map(c => ({ idle: c.times.idle, total: Object.values(c.times).reduce((a, b) => a + b, 0) }));
                const usage = start.map((s, i) => {
                    const idleDiff = end[i].idle - s.idle;
                    const totalDiff = end[i].total - s.total;
                    return parseFloat(((1 - idleDiff / totalDiff) * 100).toFixed(2));
                });
                resolve(parseFloat((usage.reduce((a, b) => a + b, 0) / usage.length).toFixed(2)));
            }, 200);
        });

        const totalMem = os.totalmem();
        const freeMem = os.freemem();
        const usedMem = totalMem - freeMem;

        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
            cpu: { usagePercent: cpuUsage, cores: cpus.length, model: cpus[0].model },
            ram: {
                totalMB: parseFloat((totalMem / 1024 / 1024).toFixed(2)),
                usedMB: parseFloat((usedMem / 1024 / 1024).toFixed(2)),
                freeMB: parseFloat((freeMem / 1024 / 1024).toFixed(2)),
                usagePercent: parseFloat(((usedMem / totalMem) * 100).toFixed(2))
            },
            platform: os.platform()
        }));
    }

    /* -------- 404 -------- */
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not Found' }));
});

server.listen(PORT, () => {
    console.log(`Tools Explorer running at http://localhost:${PORT}`);
});