const http = require('http');
const url = require('url');
const { exec, execSync } = require('child_process');
const { randomUUID } = require('crypto');
const os = require('os');
const fs = require('fs');
const path = require('path');

const PORT = 3032;
const timerStarts = new Map();

const HOME_DIR = os.homedir();
const NPM_LOG_DIR = path.join(HOME_DIR, '.npm', '_logs');
const NPM_NPX_CACHE = path.join(HOME_DIR, '.npm', '_npx');
const ROOT_DIRS = [HOME_DIR];
const MAX_WALK_DEPTH = 20;
const SKIP_DIR_NAMES = new Set(['.git']);

function parseDate(dateString) {
    if (!dateString) {
        return new Date(new Date().toISOString().slice(0, 10));
    }
    const parsed = new Date(`${dateString}T00:00:00`);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatTime(d) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
        `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function isMatchingDay(mtime, dayStart, dayEnd) {
    return mtime >= dayStart && mtime <= dayEnd;
}

function getVersion(pkgDir) {
    const pkgJsonPath = path.join(pkgDir, 'package.json');
    try {
        const raw = fs.readFileSync(pkgJsonPath, 'utf8');
        const parsed = JSON.parse(raw);
        return parsed.version || null;
    } catch {
        return null;
    }
}

function statOrNull(p) {
    try {
        return fs.statSync(p);
    } catch {
        return null;
    }
}

function scanNodeModulesDir(nmDir, dayStart, dayEnd) {
    const results = [];
    let entries;
    try {
        entries = fs.readdirSync(nmDir, { withFileTypes: true });
    } catch {
        return results;
    }

    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name.startsWith('.')) continue;

        if (entry.name.startsWith('@')) {
            const scopeDir = path.join(nmDir, entry.name);
            let subEntries;
            try {
                subEntries = fs.readdirSync(scopeDir, { withFileTypes: true });
            } catch {
                continue;
            }
            for (const sub of subEntries) {
                if (!sub.isDirectory()) continue;
                const full = path.join(scopeDir, sub.name);
                const stat = statOrNull(full);
                if (stat && isMatchingDay(stat.mtime, dayStart, dayEnd)) {
                    results.push({ dir: full, name: `${entry.name}/${sub.name}`, mtime: stat.mtime });
                }
            }
        } else {
            const full = path.join(nmDir, entry.name);
            const stat = statOrNull(full);
            if (stat && isMatchingDay(stat.mtime, dayStart, dayEnd)) {
                results.push({ dir: full, name: entry.name, mtime: stat.mtime });
            }
        }
    }
    return results;
}

function walkForNodeModules(root, depth, out, dayStart, dayEnd) {
    if (depth > MAX_WALK_DEPTH) return;
    let entries;
    try {
        entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
        return;
    }

    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (SKIP_DIR_NAMES.has(entry.name)) continue;
        const full = path.join(root, entry.name);

        if (entry.name === 'node_modules') {
            const hits = scanNodeModulesDir(full, dayStart, dayEnd);
            for (const hit of hits) {
                out.push({ ...hit, project: root });
            }
        }
        walkForNodeModules(full, depth + 1, out, dayStart, dayEnd);
    }
}

function reportNpmCommands(date) {
    const DATE = date.toISOString().slice(0, 10);
    const prefix = `${DATE}T`;
    const reports = [];

    if (!fs.existsSync(NPM_LOG_DIR)) {
        return reports;
    }

    const files = fs.readdirSync(NPM_LOG_DIR)
        .filter((f) => f.startsWith(prefix) && f.includes('-debug-'))
        .sort();

    for (const file of files) {
        const tsMatch = file.match(new RegExp(`^${DATE}T(.*)-debug-`));
        const ts = tsMatch ? tsMatch[1].replace(/_/g, ':') : file;
        let contents = '';
        try {
            contents = fs.readFileSync(path.join(NPM_LOG_DIR, file), 'utf8');
        } catch {
            reports.push({ file, timestamp: ts, command: null, error: 'could not read log file' });
            continue;
        }

        const lines = contents.split('\n');
        let line = lines.find((l) => /^\d+\s+verbose title\s/.test(l));
        if (!line) line = lines.find((l) => /^\d+\s+verbose cli\s/.test(l));
        let cmd = '(could not parse — see log file)';
        if (line) {
            cmd = line.replace(/^\d+\s+(verbose title|verbose cli)\s/, '');
        }
        reports.push({ file, timestamp: ts, command: cmd });
    }

    return reports;
}

function reportNodeModulesChanges(date, rootDirs = ROOT_DIRS) {
    const dayStart = new Date(`${date.toISOString().slice(0, 10)}T00:00:00`);
    const dayEnd = new Date(`${date.toISOString().slice(0, 10)}T23:59:59.999`);
    const hits = [];

    for (const root of rootDirs) {
        if (!fs.existsSync(root)) continue;
        walkForNodeModules(root, 0, hits, dayStart, dayEnd);
    }

    return hits.map((hit) => ({
        project: hit.project,
        name: hit.name,
        version: getVersion(hit.dir) || '?',
        mtime: hit.mtime,
        path: hit.dir
    })).sort((a, b) => a.mtime - b.mtime);
}

function reportNpxCache(date) {
    const dayStart = new Date(`${date.toISOString().slice(0, 10)}T00:00:00`);
    const dayEnd = new Date(`${date.toISOString().slice(0, 10)}T23:59:59.999`);
    const hits = [];

    if (!fs.existsSync(NPM_NPX_CACHE)) {
        return hits;
    }

    walkForNodeModules(NPM_NPX_CACHE, 0, hits, dayStart, dayEnd);
    return hits.map((hit) => ({
        name: hit.name,
        version: getVersion(hit.dir) || '?',
        mtime: hit.mtime,
        path: hit.dir
    })).sort((a, b) => a.mtime - b.mtime);
}

function reportGlobalPackages(date) {
    const dayStart = new Date(`${date.toISOString().slice(0, 10)}T00:00:00`);
    const dayEnd = new Date(`${date.toISOString().slice(0, 10)}T23:59:59.999`);
    let globalPrefix = '';

    try {
        globalPrefix = execSync('npm config get prefix', { encoding: 'utf8' }).trim();
    } catch {
        return { error: 'could not determine npm global prefix' };
    }

    const globalNmDir = path.join(globalPrefix, 'lib', 'node_modules');
    if (!fs.existsSync(globalNmDir)) {
        return { error: `no global node_modules found at ${globalNmDir}` };
    }

    const hits = scanNodeModulesDir(globalNmDir, dayStart, dayEnd);
    return hits.map((hit) => ({
        name: hit.name,
        version: getVersion(hit.dir) || '?',
        mtime: hit.mtime,
        path: hit.dir
    })).sort((a, b) => a.mtime - b.mtime);
}

function getNpmActivityReport(date, roots) {
    const reportDate = date || new Date(new Date().toISOString().slice(0, 10));
    return {
        date: reportDate.toISOString().slice(0, 10),
        npmCommands: reportNpmCommands(reportDate),
        nodeModulesChanges: reportNodeModulesChanges(reportDate, roots),
        npxCache: reportNpxCache(reportDate),
        globalPackages: reportGlobalPackages(reportDate)
    };
}

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
            version: '3.0',
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

    /* -------- NPM ACTIVITY REPORT -------- */
    if (parsedUrl.pathname === '/npm-activity') {
        const { date, roots } = parsedUrl.query;
        const parsedDate = parseDate(date);

        if (!parsedDate) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'Invalid date. Use YYYY-MM-DD.' }));
        }

        const rootDirs = roots ? roots.split(',').map((r) => r.trim()).filter(Boolean) : ROOT_DIRS;
        const report = getNpmActivityReport(parsedDate, rootDirs);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(report));
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