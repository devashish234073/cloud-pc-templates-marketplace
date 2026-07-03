const http = require('http');
const url = require('url');
const fs = require('fs');
const path = require('path');
const { exec, spawn } = require('child_process');

const PORT = 3041;

/* ================================================================
   BASE DIR INITIALIZATION
   ================================================================ */

const nodeProjectsDir = path.join(process.cwd(), 'nodeProjects');
if (!fs.existsSync(nodeProjectsDir)) {
    try {
        fs.mkdirSync(nodeProjectsDir, { recursive: true });
        console.log('Created nodeProjects directory:', nodeProjectsDir);
    } catch (e) {
        console.error('Failed to create nodeProjects directory:', e.message);
        process.exit(1);
    }
}

const BASE_DIR = nodeProjectsDir;
console.log('Node.js Connector Base Directory:', BASE_DIR);

/* ================================================================
   IN-MEMORY PROJECT MAP  (persisted to metadata.json)
   ================================================================ */

const projects = new Map();
const PROJECTS_FILE = path.join(BASE_DIR, 'metadata.json');

function saveProjects() {
    try {
        const obj = {};
        for (const [name, info] of projects) {
            // Don't persist process handles
            const { _process, ...rest } = info;
            obj[name] = rest;
        }
        fs.writeFileSync(PROJECTS_FILE, JSON.stringify(obj, null, 2), 'utf8');
    } catch (e) {
        console.error('Failed to save projects registry:', e.message);
    }
}

function loadProjects() {
    try {
        if (!fs.existsSync(PROJECTS_FILE)) return;
        const raw = fs.readFileSync(PROJECTS_FILE, 'utf8');
        const obj = JSON.parse(raw);
        for (const [name, info] of Object.entries(obj)) {
            projects.set(name, info);
        }
        console.log(`Loaded ${projects.size} project(s) from registry`);
    } catch (e) {
        console.error('Failed to load projects registry:', e.message);
    }
}

function parsePackageJson(pkgPath) {
    try {
        return JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    } catch { return null; }
}

function scanExistingProjects() {
    let folders;
    try { folders = fs.readdirSync(BASE_DIR); } catch { return; }

    for (const folder of folders) {
        const fullPath = path.join(BASE_DIR, folder);
        const pkgPath = path.join(fullPath, 'package.json');
        try {
            if (fs.statSync(fullPath).isDirectory() && fs.existsSync(pkgPath)) {
                const pkg = parsePackageJson(pkgPath);
                const existing = projects.get(folder) || {};
                projects.set(folder, {
                    name: folder,
                    path: fullPath,
                    type: existing.type || 'unknown',
                    createdAt: existing.createdAt || fs.statSync(fullPath).birthtime.toISOString(),
                    ...existing
                });
            }
        } catch { /* skip unreadable entries */ }
    }

    // Prune entries whose directories no longer exist
    for (const [name, info] of projects) {
        if (!fs.existsSync(path.join(info.path, 'package.json'))) {
            projects.delete(name);
        }
    }

    saveProjects();
    console.log(`Projects after scan: ${projects.size}`, [...projects.keys()]);
}

loadProjects();
scanExistingProjects();

/* ================================================================
   RUNNING PROCESSES MAP
   ================================================================ */

/** Map of projectName -> { process, stdout, stderr, startedAt } */
const runningProcesses = new Map();

/* ================================================================
   REQUIREMENT CHECK – Node.js (with 30-min cache)
   ================================================================ */

const CACHE_TTL_MS = 30 * 60 * 1000;
let nodeCache = null;

function checkNode() {
    if (nodeCache && (Date.now() - nodeCache.cachedAt) < CACHE_TTL_MS) {
        return Promise.resolve(nodeCache.status);
    }
    return new Promise((resolve) => {
        exec('node --version', (err, stdout) => {
            if (err) {
                return resolve({ ok: false, error: 'Node.js is not installed.' });
            }
            const version = stdout.trim().replace(/^v/, '');
            const major = parseInt(version.split('.')[0], 10);
            const status = { ok: true, version, major };
            nodeCache = { status, cachedAt: Date.now() };
            resolve(status);
        });
    });
}

/* ================================================================
   FOLDER EXCLUSIONS & BINARY DETECTION
   ================================================================ */

const EXCLUDED_FOLDERS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.nyc_output']);

function shouldExclude(name) {
    return name.startsWith('.') || EXCLUDED_FOLDERS.has(name);
}

const BINARY_EXTENSIONS = new Set([
    'png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'ico', 'svg',
    'mp3', 'mp4', 'wav', 'ogg', 'avi', 'mov', 'mkv',
    'exe', 'dll', 'so', 'dylib',
    'zip', 'rar', '7z', 'tar', 'gz', 'bz2',
    'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
    'wasm', 'bin', 'dat', 'class', 'jar', 'pyc'
]);

function isBinary(filePath) {
    const ext = path.extname(filePath).replace('.', '').toLowerCase();
    return BINARY_EXTENSIONS.has(ext);
}

/* ================================================================
   REQUEST BODY PARSER  (with LLM double-serialisation fix)
   ================================================================ */

function readBody(req) {
    return new Promise((resolve) => {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', () => {
            if (!body) return resolve({});
            let normalised = body;
            try {
                JSON.parse(body);
            } catch {
                normalised = body.replace(/\\\\\"/g, '\\"');
                try {
                    JSON.parse(normalised);
                } catch {
                    try {
                        const unwrapped = JSON.parse('"' + body.replace(/^"|"$/g, '') + '"');
                        if (typeof unwrapped === 'string') normalised = unwrapped;
                    } catch { /* fall through */ }
                }
            }
            try {
                resolve(JSON.parse(normalised));
            } catch {
                resolve({ __parseError: true, __rawBody: body.substring(0, 200) });
            }
        });
        req.on('error', () => resolve({ __parseError: true }));
    });
}

/* ================================================================
   RESPONSE HELPERS
   ================================================================ */

function send(res, status, data) {
    if (status >= 400) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status, ...data }, null, 2));
    } else {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data, null, 2));
    }
}

function err400(res, msg) { send(res, 400, { error: msg }); }
function err404(res, msg) { send(res, 404, { error: msg }); }
function err500(res, msg) { send(res, 500, { error: msg }); }

/* ================================================================
   EXEC PROMISE WRAPPER
   ================================================================ */

function execPromise(cmd, opts = {}) {
    return new Promise((resolve, reject) => {
        exec(cmd, { maxBuffer: 10 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
            if (err) {
                const error = new Error(stderr ? stderr.trim() : err.message);
                error.stdout = stdout;
                error.stderr = stderr;
                error.code = err.code;
                return reject(error);
            }
            resolve(stdout.trim());
        });
    });
}

/* ================================================================
   FILE SYSTEM HELPERS
   ================================================================ */

function writeTextFile(filePath, content) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
    return filePath;
}

function walkDir(dir, callback) {
    let entries;
    try { entries = fs.readdirSync(dir); } catch { return; }
    for (const entry of entries) {
        const fullPath = path.join(dir, entry);
        try {
            const stat = fs.statSync(fullPath);
            if (stat.isDirectory()) {
                if (!shouldExclude(entry)) walkDir(fullPath, callback);
            } else {
                callback(fullPath);
            }
        } catch { /* skip */ }
    }
}

/* ================================================================
   PROJECT SCAFFOLDING TEMPLATES
   ================================================================ */

function scaffoldApiProject(projectPath, projectName) {
    const files = [];

    // package.json
    files.push(writeTextFile(path.join(projectPath, 'package.json'), JSON.stringify({
        name: projectName,
        version: '1.0.0',
        description: `${projectName} — Express API`,
        main: 'app.js',
        scripts: {
            start: 'node app.js',
            dev: 'npx nodemon app.js'
        },
        keywords: [],
        license: 'ISC',
        dependencies: {
            express: '^4.21.0',
            dotenv: '^16.4.5'
        },
        devDependencies: {
            nodemon: '^3.1.0'
        }
    }, null, 2) + '\n'));

    // .env
    files.push(writeTextFile(path.join(projectPath, '.env'),
        `PORT=3000\nNODE_ENV=development\n`));

    // .gitignore
    files.push(writeTextFile(path.join(projectPath, '.gitignore'),
        `node_modules/\n.env\ndist/\nbuild/\ncoverage/\n*.log\n.DS_Store\n`));

    // app.js
    files.push(writeTextFile(path.join(projectPath, 'app.js'),
`require('dotenv').config();
const express = require('express');
const healthRouter = require('./routes/health');
const errorHandler = require('./middleware/errorHandler');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Routes
app.use('/api', healthRouter);

// Error handler
app.use(errorHandler);

app.listen(PORT, () => {
    console.log(\`Server running on http://localhost:\${PORT}\`);
});

module.exports = app;
`));

    // routes/health.js
    files.push(writeTextFile(path.join(projectPath, 'routes', 'health.js'),
`const express = require('express');
const router = express.Router();

router.get('/health', (req, res) => {
    res.json({ status: 'UP', timestamp: new Date().toISOString() });
});

module.exports = router;
`));

    // middleware/errorHandler.js
    files.push(writeTextFile(path.join(projectPath, 'middleware', 'errorHandler.js'),
`function errorHandler(err, req, res, next) {
    console.error(err.stack);
    res.status(err.status || 500).json({
        error: err.message || 'Internal Server Error'
    });
}

module.exports = errorHandler;
`));

    // README.md
    files.push(writeTextFile(path.join(projectPath, 'README.md'),
`# ${projectName}

Generated Express API application.

## Setup

\`\`\`bash
npm install
\`\`\`

## Run

\`\`\`bash
npm run dev    # development with hot reload
npm start      # production
\`\`\`

Health endpoint: \`GET /api/health\`
`));

    return files;
}

function scaffoldStandaloneProject(projectPath, projectName) {
    const files = [];

    // package.json
    files.push(writeTextFile(path.join(projectPath, 'package.json'), JSON.stringify({
        name: projectName,
        version: '1.0.0',
        description: `${projectName} — Node.js application`,
        main: 'index.js',
        scripts: {
            start: 'node index.js',
            dev: 'npx nodemon index.js'
        },
        keywords: [],
        license: 'ISC',
        dependencies: {},
        devDependencies: {}
    }, null, 2) + '\n'));

    // .gitignore
    files.push(writeTextFile(path.join(projectPath, '.gitignore'),
        `node_modules/\ndist/\nbuild/\ncoverage/\n*.log\n.DS_Store\n`));

    // index.js
    files.push(writeTextFile(path.join(projectPath, 'index.js'),
`'use strict';

function main() {
    console.log('${projectName} started');
}

main();
`));

    // README.md
    files.push(writeTextFile(path.join(projectPath, 'README.md'),
`# ${projectName}

Generated Node.js application.

## Run

\`\`\`bash
node index.js
\`\`\`
`));

    return files;
}

/* ================================================================
   SERVER
   ================================================================ */

const server = http.createServer(async (req, res) => {

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

    const parsed = url.parse(req.url, true);
    const { pathname, query } = parsed;

    /* ── GET /health ──────────────────────────────────────────── */
    if (pathname === '/health') {
        const nodeInfo = await checkNode();
        return send(res, 200, {
            status: 'UP',
            version: '1.0',
            type: 'nodejs-connector-agent',
            baseDir: BASE_DIR,
            projectCount: projects.size,
            projects: [...projects.keys()],
            requirements: nodeInfo
        });
    }

    /* ── GET /node/projects ───────────────────────────────────── */
    if (pathname === '/node/projects' && req.method === 'GET') {
        const list = [];
        for (const [name, info] of projects) {
            const running = runningProcesses.has(name);
            list.push({ name, type: info.type, path: info.path, createdAt: info.createdAt, running });
        }
        return send(res, 200, { count: list.length, projects: list });
    }

    /* ── POST /node/create ────────────────────────────────────── */
    if (pathname === '/node/create' && req.method === 'POST') {
        const nodeInfo = await checkNode();
        if (!nodeInfo.ok) return send(res, 500, { error: nodeInfo.error });

        let body;
        try { body = await readBody(req); } catch { return err400(res, 'Invalid JSON body'); }

        const { name, type = 'api' } = body;
        if (!name) return err400(res, 'Provide { name } in body');
        if (!/^[A-Za-z0-9_-]+$/.test(name)) return err400(res, 'name may contain only letters, numbers, underscore, and hyphen');
        if (type !== 'api' && type !== 'standalone') return err400(res, 'type must be "api" or "standalone"');

        if (projects.has(name)) {
            return send(res, 409, { error: `Project '${name}' already exists`, path: projects.get(name).path });
        }

        const projectPath = path.join(BASE_DIR, name);
        if (fs.existsSync(projectPath)) {
            return send(res, 409, { error: `Directory '${name}' already exists on disk`, path: projectPath });
        }

        try {
            fs.mkdirSync(projectPath, { recursive: true });

            let files;
            if (type === 'api') {
                files = scaffoldApiProject(projectPath, name);
            } else {
                files = scaffoldStandaloneProject(projectPath, name);
            }

            projects.set(name, {
                name,
                path: projectPath,
                type,
                createdAt: new Date().toISOString()
            });
            saveProjects();

            return send(res, 200, {
                message: `Project '${name}' created successfully (type: ${type})`,
                project: projects.get(name),
                files,
                nextStep: 'Run POST /node/npm-init-run?projectName=' + name + ' to install dependencies'
            });
        } catch (e) {
            return err500(res, `Project creation failed: ${e.message}`);
        }
    }

    /* ── GET /node/rescan ─────────────────────────────────────── */
    if (pathname === '/node/rescan' && req.method === 'GET') {
        projects.clear();
        scanExistingProjects();
        return send(res, 200, {
            message: 'Rescanned for Node.js projects',
            projectCount: projects.size,
            projects: [...projects.keys()]
        });
    }

    /* ── GET /node/project-details?projectName= ───────────────── */
    if (pathname === '/node/project-details' && req.method === 'GET') {
        const { projectName } = query;
        if (!projectName) return err400(res, 'Provide ?projectName=<name>');
        if (!projects.has(projectName)) return err404(res, `Project '${projectName}' not found`);

        const project = projects.get(projectName);
        const pkgPath = path.join(project.path, 'package.json');
        const pkg = fs.existsSync(pkgPath) ? parsePackageJson(pkgPath) : null;
        const hasNodeModules = fs.existsSync(path.join(project.path, 'node_modules'));
        const running = runningProcesses.has(projectName);

        return send(res, 200, {
            projectName,
            projectInfo: {
                name: project.name,
                path: project.path,
                type: project.type,
                createdAt: project.createdAt
            },
            packageJson: pkg ? {
                name: pkg.name,
                version: pkg.version,
                main: pkg.main,
                scripts: pkg.scripts,
                dependencyCount: Object.keys(pkg.dependencies || {}).length,
                devDependencyCount: Object.keys(pkg.devDependencies || {}).length
            } : null,
            nodeModulesInstalled: hasNodeModules,
            running,
            runInfo: running ? { startedAt: runningProcesses.get(projectName).startedAt } : null
        });
    }

    /* ── POST /node/dependency?projectName= ───────────────────── */
    if (pathname === '/node/dependency' && req.method === 'POST') {
        const { projectName } = query;
        if (!projectName) return err400(res, 'Provide ?projectName=<name>');
        if (!projects.has(projectName)) return err404(res, `Project '${projectName}' not found`);

        let body;
        try { body = await readBody(req); } catch { return err400(res, 'Invalid JSON body'); }

        const { package: pkgName, packages, dev = false } = body;
        const pkgList = packages || (pkgName ? [pkgName] : []);
        if (!pkgList.length) return err400(res, 'Provide { package: "express" } or { packages: ["express","cors"] }');

        const project = projects.get(projectName);
        const devFlag = dev ? ' --save-dev' : ' --save';
        const cmd = `npm install ${pkgList.join(' ')}${devFlag}`;

        try {
            const output = await execPromise(cmd, { cwd: project.path, timeout: 120000 });
            const pkg = parsePackageJson(path.join(project.path, 'package.json'));
            return send(res, 200, {
                message: `Installed: ${pkgList.join(', ')}`,
                projectName,
                dev,
                dependencies: pkg ? pkg.dependencies : null,
                devDependencies: pkg ? pkg.devDependencies : null,
                npmOutput: output.substring(Math.max(0, output.length - 500))
            });
        } catch (e) {
            return err500(res, `npm install failed: ${e.message}`);
        }
    }

    /* ── POST /node/dependency/remove?projectName= ────────────── */
    if (pathname === '/node/dependency/remove' && req.method === 'POST') {
        const { projectName } = query;
        if (!projectName) return err400(res, 'Provide ?projectName=<name>');
        if (!projects.has(projectName)) return err404(res, `Project '${projectName}' not found`);

        let body;
        try { body = await readBody(req); } catch { return err400(res, 'Invalid JSON body'); }

        const { package: pkgName, packages } = body;
        const pkgList = packages || (pkgName ? [pkgName] : []);
        if (!pkgList.length) return err400(res, 'Provide { package: "express" } or { packages: ["express","cors"] }');

        const project = projects.get(projectName);
        const cmd = `npm uninstall ${pkgList.join(' ')}`;

        try {
            const output = await execPromise(cmd, { cwd: project.path, timeout: 120000 });
            const pkg = parsePackageJson(path.join(project.path, 'package.json'));
            return send(res, 200, {
                message: `Removed: ${pkgList.join(', ')}`,
                projectName,
                dependencies: pkg ? pkg.dependencies : null,
                devDependencies: pkg ? pkg.devDependencies : null,
                npmOutput: output.substring(Math.max(0, output.length - 500))
            });
        } catch (e) {
            return err500(res, `npm uninstall failed: ${e.message}`);
        }
    }

    /* ── GET /node/dependencies?projectName= ──────────────────── */
    if (pathname === '/node/dependencies' && req.method === 'GET') {
        const { projectName } = query;
        if (!projectName) return err400(res, 'Provide ?projectName=<name>');
        if (!projects.has(projectName)) return err404(res, `Project '${projectName}' not found`);

        const project = projects.get(projectName);
        const pkg = parsePackageJson(path.join(project.path, 'package.json'));
        if (!pkg) return err404(res, 'package.json not found');

        return send(res, 200, {
            projectName,
            dependencies: pkg.dependencies || {},
            devDependencies: pkg.devDependencies || {},
            totalCount: Object.keys(pkg.dependencies || {}).length + Object.keys(pkg.devDependencies || {}).length
        });
    }

    /* ── POST /node/file?projectName=&filePath= ───────────────── */
    if (pathname === '/node/file' && req.method === 'POST') {
        const { projectName, filePath } = query;
        if (!projectName) return err400(res, 'Provide ?projectName=<name>');
        if (!filePath) return err400(res, 'Provide ?filePath=<relative/path>');
        if (!projects.has(projectName)) return err404(res, `Project '${projectName}' not found`);

        let body;
        try { body = await readBody(req); } catch { return err400(res, 'Invalid JSON body'); }

        const { content } = body;
        if (content === undefined || content === null) return err400(res, 'Provide { content: "..." } in body');

        const project = projects.get(projectName);
        const absPath = path.join(project.path, filePath);

        if (!path.resolve(absPath).startsWith(path.resolve(project.path))) {
            return err400(res, 'File path must be within the project directory');
        }

        try {
            const exists = fs.existsSync(absPath);
            writeTextFile(absPath, content);
            return send(res, 200, {
                message: exists ? 'File overwritten' : 'File created',
                projectName, filePath,
                absolutePath: path.resolve(absPath),
                overwritten: exists,
                size: Buffer.byteLength(content, 'utf8')
            });
        } catch (e) {
            return err500(res, `Failed to write file: ${e.message}`);
        }
    }

    /* ── GET /node/file?projectName=&filePath= ────────────────── */
    if (pathname === '/node/file' && req.method === 'GET') {
        const { projectName, filePath } = query;
        if (!projectName) return err400(res, 'Provide ?projectName=<name>');
        if (!filePath) return err400(res, 'Provide ?filePath=<relative/path>');
        if (!projects.has(projectName)) return err404(res, `Project '${projectName}' not found`);

        const project = projects.get(projectName);
        const absPath = path.join(project.path, filePath);

        if (!path.resolve(absPath).startsWith(path.resolve(project.path))) {
            return err400(res, 'File path must be within the project directory');
        }

        if (!fs.existsSync(absPath) || !fs.statSync(absPath).isFile()) {
            return err404(res, `File not found: ${filePath}`);
        }

        if (isBinary(absPath)) return err400(res, 'File is binary');

        try {
            const content = fs.readFileSync(absPath, 'utf8');
            const stat = fs.statSync(absPath);
            return send(res, 200, {
                projectName, filePath,
                absolutePath: path.resolve(absPath),
                content,
                size: stat.size,
                lastModified: stat.mtime.toISOString()
            });
        } catch (e) {
            return err500(res, `Failed to read file: ${e.message}`);
        }
    }

    /* ── PUT /node/file?projectName=&filePath= ────────────────── */
    if (pathname === '/node/file' && req.method === 'PUT') {
        const { projectName, filePath } = query;
        if (!projectName) return err400(res, 'Provide ?projectName=<name>');
        if (!filePath) return err400(res, 'Provide ?filePath=<relative/path>');
        if (!projects.has(projectName)) return err404(res, `Project '${projectName}' not found`);

        let body;
        try { body = await readBody(req); } catch { return err400(res, 'Invalid JSON body'); }

        const { content } = body;
        if (content === undefined || content === null) return err400(res, 'Provide { content: "..." } in body');

        const project = projects.get(projectName);
        const absPath = path.join(project.path, filePath);

        if (!path.resolve(absPath).startsWith(path.resolve(project.path))) {
            return err400(res, 'File path must be within the project directory');
        }

        if (!fs.existsSync(absPath)) {
            return err404(res, `File not found: ${filePath}. Use POST to create.`);
        }

        try {
            fs.writeFileSync(absPath, content, 'utf8');
            return send(res, 200, {
                message: 'File updated',
                projectName, filePath,
                absolutePath: path.resolve(absPath),
                size: Buffer.byteLength(content, 'utf8')
            });
        } catch (e) {
            return err500(res, `Failed to update file: ${e.message}`);
        }
    }

    /* ── PATCH /node/file?projectName=&filePath= ──────────────── */
    if (pathname === '/node/file' && req.method === 'PATCH') {
        const { projectName, filePath } = query;
        if (!projectName) return err400(res, 'Provide ?projectName=<name>');
        if (!filePath) return err400(res, 'Provide ?filePath=<relative/path>');
        if (!projects.has(projectName)) return err404(res, `Project '${projectName}' not found`);

        let body;
        try { body = await readBody(req); } catch { return err400(res, 'Invalid JSON body'); }

        const project = projects.get(projectName);
        const absPath = path.join(project.path, filePath);

        if (!path.resolve(absPath).startsWith(path.resolve(project.path))) {
            return err400(res, 'File path must be within the project directory');
        }

        if (!fs.existsSync(absPath)) {
            return err404(res, `File not found: ${filePath}`);
        }

        let content = fs.readFileSync(absPath, 'utf8');

        let replacementsList = [];
        if (body.targetContent !== undefined && body.replacementContent !== undefined) {
            replacementsList.push({ targetContent: body.targetContent, replacementContent: body.replacementContent });
        } else if (Array.isArray(body.replacements)) {
            replacementsList = body.replacements;
        }

        if (replacementsList.length === 0) {
            return err400(res, 'Provide { targetContent, replacementContent } or { replacements: [...] }');
        }

        for (let i = 0; i < replacementsList.length; i++) {
            const { targetContent, replacementContent } = replacementsList[i];
            if (targetContent === undefined || replacementContent === undefined) {
                return err400(res, `Replacement at index ${i} is missing targetContent or replacementContent`);
            }
            const occurrences = content.split(targetContent).length - 1;
            if (occurrences === 0) {
                return err400(res, `Target content not found: "${targetContent.substring(0, 100)}..."`);
            }
            if (occurrences > 1) {
                return err400(res, `Target content not unique (${occurrences} occurrences): "${targetContent.substring(0, 100)}..."`);
            }
            content = content.replace(targetContent, replacementContent);
        }

        try {
            fs.writeFileSync(absPath, content, 'utf8');
            return send(res, 200, {
                message: 'File patched',
                projectName, filePath,
                absolutePath: path.resolve(absPath),
                replacementsApplied: replacementsList.length
            });
        } catch (e) {
            return err500(res, `Failed to patch file: ${e.message}`);
        }
    }

    /* ── GET /node/files?projectName=  ─────────────────────────── */
    if (pathname === '/node/files' && req.method === 'GET') {
        const { projectName } = query;
        if (!projectName) return err400(res, 'Provide ?projectName=<name>');
        if (!projects.has(projectName)) return err404(res, `Project '${projectName}' not found`);

        const project = projects.get(projectName);
        const files = [];

        walkDir(project.path, (filePath) => {
            const stat = fs.statSync(filePath);
            files.push({
                relativePath: path.relative(project.path, filePath),
                absolutePath: path.resolve(filePath),
                size: stat.size,
                extension: path.extname(filePath).replace('.', '') || null
            });
        });

        return send(res, 200, {
            projectName,
            totalCount: files.length,
            files
        });
    }

    /* ── GET /node/package-json?projectName=&raw=true ──────────── */
    if (pathname === '/node/package-json' && req.method === 'GET') {
        const { projectName, raw } = query;
        if (!projectName) return err400(res, 'Provide ?projectName=<name>');
        if (!projects.has(projectName)) return err404(res, `Project '${projectName}' not found`);

        const project = projects.get(projectName);
        const pkgPath = path.join(project.path, 'package.json');

        if (!fs.existsSync(pkgPath)) return err404(res, 'package.json not found');

        try {
            const pkg = parsePackageJson(pkgPath);
            return send(res, 200, {
                projectName,
                packageJson: pkg,
                rawJson: (raw === 'true' || raw === '1') ? fs.readFileSync(pkgPath, 'utf8') : undefined
            });
        } catch (e) {
            return err500(res, `Failed to read package.json: ${e.message}`);
        }
    }

    /* ── PUT /node/script?projectName= ────────────────────────── */
    if (pathname === '/node/script' && req.method === 'PUT') {
        const { projectName } = query;
        if (!projectName) return err400(res, 'Provide ?projectName=<name>');
        if (!projects.has(projectName)) return err404(res, `Project '${projectName}' not found`);

        let body;
        try { body = await readBody(req); } catch { return err400(res, 'Invalid JSON body'); }

        const { scripts } = body;
        if (!scripts || typeof scripts !== 'object') return err400(res, 'Provide { scripts: { "dev": "nodemon app.js" } }');

        const project = projects.get(projectName);
        const pkgPath = path.join(project.path, 'package.json');

        if (!fs.existsSync(pkgPath)) return err404(res, 'package.json not found');

        try {
            const pkg = parsePackageJson(pkgPath);
            pkg.scripts = { ...(pkg.scripts || {}), ...scripts };
            fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
            return send(res, 200, {
                message: 'Scripts updated',
                projectName,
                scripts: pkg.scripts
            });
        } catch (e) {
            return err500(res, `Failed to update scripts: ${e.message}`);
        }
    }

    /* ── POST /node/run?projectName=&script= ──────────────────── */
    if (pathname === '/node/run' && req.method === 'POST') {
        const { projectName, script = 'start' } = query;
        if (!projectName) return err400(res, 'Provide ?projectName=<name>');
        if (!projects.has(projectName)) return err404(res, `Project '${projectName}' not found`);

        if (runningProcesses.has(projectName)) {
            return send(res, 409, {
                error: `Project '${projectName}' is already running`,
                startedAt: runningProcesses.get(projectName).startedAt
            });
        }

        const project = projects.get(projectName);

        if (!fs.existsSync(path.join(project.path, 'node_modules'))) {
            return err400(res, `node_modules not found. Run POST /node/npm-init-run?projectName=${projectName} first.`);
        }

        try {
            const child = spawn('npm', ['run', script], {
                cwd: project.path,
                env: { ...process.env, FORCE_COLOR: '0' },
                stdio: ['ignore', 'pipe', 'pipe'],
                detached: false
            });

            const entry = {
                process: child,
                pid: child.pid,
                script,
                startedAt: new Date().toISOString(),
                stdout: '',
                stderr: ''
            };

            child.stdout.on('data', (data) => {
                entry.stdout += data.toString();
                // Keep only last 5000 chars
                if (entry.stdout.length > 5000) entry.stdout = entry.stdout.slice(-5000);
            });

            child.stderr.on('data', (data) => {
                entry.stderr += data.toString();
                if (entry.stderr.length > 5000) entry.stderr = entry.stderr.slice(-5000);
            });

            child.on('close', (code) => {
                entry.exitCode = code;
                entry.exitedAt = new Date().toISOString();
                runningProcesses.delete(projectName);
            });

            child.on('error', (err) => {
                entry.stderr += `\nProcess error: ${err.message}`;
                runningProcesses.delete(projectName);
            });

            runningProcesses.set(projectName, entry);

            return send(res, 200, {
                message: `Project '${projectName}' started with 'npm run ${script}'`,
                projectName,
                pid: child.pid,
                script,
                startedAt: entry.startedAt
            });
        } catch (e) {
            return err500(res, `Failed to start project: ${e.message}`);
        }
    }

    /* ── POST /node/stop?projectName= ─────────────────────────── */
    if (pathname === '/node/stop' && req.method === 'POST') {
        const { projectName } = query;
        if (!projectName) return err400(res, 'Provide ?projectName=<name>');

        if (!runningProcesses.has(projectName)) {
            return err404(res, `Project '${projectName}' is not running`);
        }

        const entry = runningProcesses.get(projectName);
        try {
            entry.process.kill('SIGTERM');
            // Give it 3 seconds, then force kill
            setTimeout(() => {
                try { entry.process.kill('SIGKILL'); } catch { /* already dead */ }
            }, 3000);
            runningProcesses.delete(projectName);

            return send(res, 200, {
                message: `Project '${projectName}' stopped`,
                projectName,
                pid: entry.pid,
                ranFor: `${Math.round((Date.now() - new Date(entry.startedAt).getTime()) / 1000)}s`
            });
        } catch (e) {
            runningProcesses.delete(projectName);
            return err500(res, `Failed to stop project: ${e.message}`);
        }
    }

    /* ── GET /node/run-status?projectName= ────────────────────── */
    if (pathname === '/node/run-status' && req.method === 'GET') {
        const { projectName } = query;
        if (!projectName) return err400(res, 'Provide ?projectName=<name>');

        if (!runningProcesses.has(projectName)) {
            return send(res, 200, { projectName, running: false });
        }

        const entry = runningProcesses.get(projectName);
        return send(res, 200, {
            projectName,
            running: true,
            pid: entry.pid,
            script: entry.script,
            startedAt: entry.startedAt,
            stdoutTail: entry.stdout.slice(-2000),
            stderrTail: entry.stderr.slice(-2000)
        });
    }

    /* ── POST /node/exec?projectName= ─────────────────────────── */
    if (pathname === '/node/exec' && req.method === 'POST') {
        const { projectName } = query;
        if (!projectName) return err400(res, 'Provide ?projectName=<name>');
        if (!projects.has(projectName)) return err404(res, `Project '${projectName}' not found`);

        let body;
        try { body = await readBody(req); } catch { return err400(res, 'Invalid JSON body'); }

        const { command } = body;
        if (!command) return err400(res, 'Provide { command: "npm test" }');

        const project = projects.get(projectName);

        try {
            const output = await execPromise(command, { cwd: project.path, timeout: 300000 });
            return send(res, 200, {
                message: 'Command executed',
                projectName,
                command,
                output: output.substring(Math.max(0, output.length - 3000))
            });
        } catch (e) {
            // Return 200 so the orchestrator gets the error output
            return send(res, 200, {
                message: 'Command failed',
                projectName,
                command,
                success: false,
                error: e.message,
                stdout: (e.stdout || '').substring(Math.max(0, (e.stdout || '').length - 2000)),
                stderr: (e.stderr || '').substring(Math.max(0, (e.stderr || '').length - 2000))
            });
        }
    }

    /* ── GET /node/env?projectName= ───────────────────────────── */
    if (pathname === '/node/env' && req.method === 'GET') {
        const { projectName } = query;
        if (!projectName) return err400(res, 'Provide ?projectName=<name>');
        if (!projects.has(projectName)) return err404(res, `Project '${projectName}' not found`);

        const project = projects.get(projectName);
        const envPath = path.join(project.path, '.env');

        if (!fs.existsSync(envPath)) {
            return send(res, 200, { projectName, exists: false, variables: {}, raw: '' });
        }

        try {
            const raw = fs.readFileSync(envPath, 'utf8');
            const variables = {};
            raw.split('\n').forEach(line => {
                const trimmed = line.trim();
                if (!trimmed || trimmed.startsWith('#')) return;
                const eqIdx = trimmed.indexOf('=');
                if (eqIdx > 0) {
                    variables[trimmed.substring(0, eqIdx).trim()] = trimmed.substring(eqIdx + 1).trim();
                }
            });
            return send(res, 200, { projectName, exists: true, variables, raw });
        } catch (e) {
            return err500(res, `Failed to read .env: ${e.message}`);
        }
    }

    /* ── POST /node/env?projectName= ──────────────────────────── */
    if (pathname === '/node/env' && req.method === 'POST') {
        const { projectName } = query;
        if (!projectName) return err400(res, 'Provide ?projectName=<name>');
        if (!projects.has(projectName)) return err404(res, `Project '${projectName}' not found`);

        let body;
        try { body = await readBody(req); } catch { return err400(res, 'Invalid JSON body'); }

        const { variables, raw } = body;
        if (!variables && !raw) return err400(res, 'Provide { variables: { KEY: "value" } } or { raw: "KEY=value\\n..." }');

        const project = projects.get(projectName);
        const envPath = path.join(project.path, '.env');

        try {
            let content;
            if (raw) {
                content = raw;
            } else {
                // Merge with existing .env if it exists
                const existing = {};
                if (fs.existsSync(envPath)) {
                    const existingRaw = fs.readFileSync(envPath, 'utf8');
                    existingRaw.split('\n').forEach(line => {
                        const trimmed = line.trim();
                        if (!trimmed || trimmed.startsWith('#')) return;
                        const eqIdx = trimmed.indexOf('=');
                        if (eqIdx > 0) {
                            existing[trimmed.substring(0, eqIdx).trim()] = trimmed.substring(eqIdx + 1).trim();
                        }
                    });
                }
                const merged = { ...existing, ...variables };
                content = Object.entries(merged).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
            }
            fs.writeFileSync(envPath, content, 'utf8');
            return send(res, 200, {
                message: '.env updated',
                projectName,
                envPath: path.resolve(envPath)
            });
        } catch (e) {
            return err500(res, `Failed to write .env: ${e.message}`);
        }
    }

    /* ── POST /node/npm-init-run?projectName= ─────────────────── */
    if (pathname === '/node/npm-init-run' && req.method === 'POST') {
        const { projectName } = query;
        if (!projectName) return err400(res, 'Provide ?projectName=<name>');
        if (!projects.has(projectName)) return err404(res, `Project '${projectName}' not found`);

        const project = projects.get(projectName);

        try {
            const output = await execPromise('npm install', { cwd: project.path, timeout: 120000 });
            return send(res, 200, {
                message: `npm install completed for '${projectName}'`,
                projectName,
                nodeModulesExists: fs.existsSync(path.join(project.path, 'node_modules')),
                npmOutput: output.substring(Math.max(0, output.length - 1000))
            });
        } catch (e) {
            return err500(res, `npm install failed: ${e.message}`);
        }
    }

    /* ── 404 ──────────────────────────────────────────────────── */
    send(res, 404, {
        error: 'Endpoint not found',
        availableEndpoints: [
            'GET  /health',
            'GET  /node/projects',
            'POST /node/create                     { name, type? }',
            'GET  /node/rescan',
            'GET  /node/project-details?projectName=',
            'POST /node/dependency?projectName=     { package, dev? } or { packages:[], dev? }',
            'POST /node/dependency/remove?projectName= { package } or { packages:[] }',
            'GET  /node/dependencies?projectName=',
            'POST /node/file?projectName=&filePath=  { content }',
            'GET  /node/file?projectName=&filePath=',
            'PUT  /node/file?projectName=&filePath=  { content }',
            'PATCH /node/file?projectName=&filePath= { targetContent, replacementContent } or { replacements:[] }',
            'GET  /node/files?projectName=',
            'GET  /node/package-json?projectName=&raw=true',
            'PUT  /node/script?projectName=          { scripts: { key: cmd } }',
            'POST /node/run?projectName=&script=start',
            'POST /node/stop?projectName=',
            'GET  /node/run-status?projectName=',
            'POST /node/exec?projectName=            { command }',
            'GET  /node/env?projectName=',
            'POST /node/env?projectName=             { variables: { KEY: val } } or { raw }',
            'POST /node/npm-init-run?projectName='
        ]
    });
});

server.listen(PORT, () => {
    console.log(`\nNode.js Connector v1.0 running at http://localhost:${PORT}`);
    console.log('\nAvailable endpoints:');
    console.log('  GET  /health                         - Server status & Node.js version');
    console.log('  GET  /node/projects                  - List all tracked projects');
    console.log('  POST /node/create                    - Create a new Node.js project (api|standalone)');
    console.log('  GET  /node/rescan                    - Rescan for existing projects');
    console.log('  GET  /node/project-details?projectName= - Complete project info');
    console.log('  POST /node/dependency?projectName=   - Install npm package(s)');
    console.log('  POST /node/dependency/remove?projectName= - Uninstall npm package(s)');
    console.log('  GET  /node/dependencies?projectName= - List dependencies from package.json');
    console.log('  POST /node/file?projectName=&filePath= - Create/write a file');
    console.log('  GET  /node/file?projectName=&filePath=  - Read a file');
    console.log('  PUT  /node/file?projectName=&filePath=  - Overwrite a file');
    console.log('  PATCH /node/file?projectName=&filePath= - Patch file (search & replace)');
    console.log('  GET  /node/files?projectName=        - List all source files');
    console.log('  GET  /node/package-json?projectName=  - Read package.json');
    console.log('  PUT  /node/script?projectName=       - Add/update npm scripts');
    console.log('  POST /node/run?projectName=          - Start the project');
    console.log('  POST /node/stop?projectName=         - Stop a running project');
    console.log('  GET  /node/run-status?projectName=   - Check if project is running');
    console.log('  POST /node/exec?projectName=         - Run arbitrary command');
    console.log('  GET  /node/env?projectName=          - Read .env file');
    console.log('  POST /node/env?projectName=          - Write/merge .env file');
    console.log('  POST /node/npm-init-run?projectName= - Run npm install');
});
