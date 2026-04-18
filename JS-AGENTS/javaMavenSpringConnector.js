const http = require('http');
const url = require('url');
const fs = require('fs');
const path = require('path');
const { exec, execSync } = require('child_process');

const PORT = 3038;

/* ================================================================
   BASE DIR FROM CLI
   ================================================================ */

let BASE_DIR;

if (process.argv[2]) {
    const inputPath = path.resolve(process.argv[2]);
    if (!fs.existsSync(inputPath)) {
        fs.mkdirSync(inputPath, { recursive: true });
    }
    if (!fs.statSync(inputPath).isDirectory()) {
        console.error('Invalid directory provided:', inputPath);
        process.exit(1);
    }
    BASE_DIR = inputPath;
} else {
    BASE_DIR = process.cwd();
}

console.log('Java Maven Spring Connector Base Directory:', BASE_DIR);

/* ================================================================
   IN-MEMORY PROJECT MAP  (persisted to .maven-projects.json)
   ================================================================ */

/**
 * Map of projectName -> { name, path, groupId, artifactId, createdAt }
 * Populated at startup from the persisted registry file + a live disk scan,
 * and updated when new projects are created via API.
 */
const projects = new Map();

/** Path to the persisted project registry */
const PROJECTS_FILE = path.join(BASE_DIR, '.maven-projects.json');

/** Save the current projects map to disk */
function saveProjects() {
    try {
        const obj = {};
        for (const [name, info] of projects) {
            obj[name] = info;
        }
        fs.writeFileSync(PROJECTS_FILE, JSON.stringify(obj, null, 2), 'utf8');
    } catch (e) {
        console.error('Failed to save projects registry:', e.message);
    }
}

/** Load projects from the persisted registry file */
function loadProjects() {
    try {
        if (!fs.existsSync(PROJECTS_FILE)) return;
        const raw = fs.readFileSync(PROJECTS_FILE, 'utf8');
        const obj = JSON.parse(raw);
        for (const [name, info] of Object.entries(obj)) {
            projects.set(name, info);
        }
        console.log(`Loaded ${projects.size} project(s) from registry file`);
    } catch (e) {
        console.error('Failed to load projects registry:', e.message);
    }
}

/**
 * Scan BASE_DIR for existing Maven projects (subdirs containing pom.xml).
 * Merges with any previously-loaded data and persists the result.
 */
function scanExistingProjects() {
    let folders;
    try { folders = fs.readdirSync(BASE_DIR); } catch { return; }

    for (const folder of folders) {
        const fullPath = path.join(BASE_DIR, folder);
        const pomPath = path.join(fullPath, 'pom.xml');
        try {
            if (fs.statSync(fullPath).isDirectory() && fs.existsSync(pomPath)) {
                projects.set(folder, {
                    name: folder,
                    path: fullPath,
                    groupId: parseGroupIdFromPom(pomPath),
                    artifactId: folder,
                    createdAt: fs.statSync(fullPath).birthtime.toISOString()
                });
            }
        } catch { /* skip unreadable entries */ }
    }

    // Prune entries whose directories no longer exist on disk
    for (const [name, info] of projects) {
        if (!fs.existsSync(path.join(info.path, 'pom.xml'))) {
            projects.delete(name);
        }
    }

    saveProjects();
    console.log(`Projects after scan: ${projects.size}`, [...projects.keys()]);
}

/** Extract groupId from a pom.xml (simple regex – not a full XML parser) */
function parseGroupIdFromPom(pomPath) {
    try {
        const content = fs.readFileSync(pomPath, 'utf8');
        const match = content.match(/<groupId>([^<]+)<\/groupId>/);
        return match ? match[1].trim() : 'unknown';
    } catch { return 'unknown'; }
}

// Startup: load persisted registry first, then merge with live disk scan
loadProjects();
scanExistingProjects();

/* ================================================================
   REQUIREMENT CHECK – Java 11+ & Maven  (with 30-min cache)
   ================================================================ */

/**
 * Per-tool cache for requirement checks.
 * Each entry: { status: <object>, cachedAt: <timestamp ms> }
 *
 * RULES:
 *  - Only SUCCESSFUL (found & valid) results are cached.
 *  - "Not found" / version-too-low results are NEVER cached so
 *    each call re-checks the system until the tool is installed.
 *  - Cache entries expire after CACHE_TTL_MS (30 minutes).
 */
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

const requirementCache = {
    java: null, // { status: { version, major }, cachedAt }
    maven: null  // { status: { version },        cachedAt }
};

/** Returns true if a cache entry is still valid. */
function isCacheValid(entry) {
    return entry !== null && (Date.now() - entry.cachedAt) < CACHE_TTL_MS;
}

/**
 * Check that Java (≥ 11) is installed.
 * Resolves to { ok: true, version, major } or { ok: false, error }.
 */
function checkJava() {
    if (isCacheValid(requirementCache.java)) {
        return Promise.resolve(requirementCache.java.status);
    }

    return new Promise((resolve) => {
        exec('java -version 2>&1', (jErr, jOut) => {
            if (jErr && !jOut) {
                // NOT found – do NOT cache
                return resolve({ ok: false, error: 'Java is not installed. Please install Java 11 or newer.' });
            }

            const javaOutput = (jOut || '').toString();
            const versionMatch = javaOutput.match(/(?:java|openjdk)\s+version\s+"([^"]+)"/i)
                || javaOutput.match(/(?:java|openjdk)\s+(\d[\d.]*)/i);

            if (!versionMatch) {
                return resolve({ ok: false, error: 'Could not determine Java version. Output: ' + javaOutput });
            }

            const rawVersion = versionMatch[1];
            let majorVersion;
            if (rawVersion.startsWith('1.')) {
                majorVersion = parseInt(rawVersion.split('.')[1], 10);
            } else {
                majorVersion = parseInt(rawVersion.split('.')[0], 10);
            }

            if (isNaN(majorVersion) || majorVersion < 11) {
                // Version too low – do NOT cache
                return resolve({
                    ok: false,
                    error: `Java version ${rawVersion} (major ${majorVersion}) is older than 11. Please upgrade to Java 11 or newer.`
                });
            }

            // Valid – cache the result
            const status = { ok: true, version: rawVersion, major: majorVersion };
            requirementCache.java = { status, cachedAt: Date.now() };
            return resolve(status);
        });
    });
}

/**
 * Check that Maven is installed.
 * Resolves to { ok: true, version } or { ok: false, error }.
 */
function checkMaven() {
    if (isCacheValid(requirementCache.maven)) {
        return Promise.resolve(requirementCache.maven.status);
    }

    return new Promise((resolve) => {
        exec('mvn --version 2>&1', (mErr, mOut) => {
            if (mErr && !mOut) {
                // NOT found – do NOT cache
                return resolve({ ok: false, error: 'Maven is not installed. Please install Apache Maven.' });
            }

            const mavenOutput = (mOut || '').toString();
            const mvnMatch = mavenOutput.match(/Apache Maven\s+([\d.]+)/i);
            const mavenVersion = mvnMatch ? mvnMatch[1] : 'not installed';

            const status = { ok: true, version: mavenVersion };

            // Only cache when version was actually determined
            if (mavenVersion !== 'not installed') {
                requirementCache.maven = { status, cachedAt: Date.now() };
            }
            return resolve(status);
        });
    });
}

/**
 * Returns a promise that resolves to { ok: true, javaVersion, mavenVersion }
 * or { ok: false, error: '...' }.
 *
 * Uses per-tool 30-minute caches; failures are never cached.
 */
async function checkRequirements() {
    const java = await checkJava();
    if (!java.ok) return { ok: false, error: java.error };

    const maven = await checkMaven();
    if (!maven.ok) return { ok: false, error: maven.error, javaVersion: java.version };

    return {
        ok: true,
        javaVersion: java.version,
        javaMajor: java.major,
        mavenVersion: maven.version,
        cached: {
            java: isCacheValid(requirementCache.java),
            maven: isCacheValid(requirementCache.maven)
        }
    };
}

/* ================================================================
   REQUEST BODY PARSER
   ================================================================ */

function readBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', () => {
            try { resolve(body ? JSON.parse(body) : {}); }
            catch { reject(new Error('Invalid JSON body')); }
        });
        req.on('error', reject);
    });
}

/* ================================================================
   RESPONSE HELPERS
   ================================================================ */

function send(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data, null, 2));
}

function sendFile(res, filePath) {
    const stat = fs.statSync(filePath);
    res.writeHead(200, {
        'Content-Type': 'application/java-archive',
        'Content-Disposition': `attachment; filename="${path.basename(filePath)}"`,
        'Content-Length': stat.size
    });
    fs.createReadStream(filePath).pipe(res);
}

function err400(res, msg) { send(res, 400, { error: msg }); }
function err404(res, msg) { send(res, 404, { error: msg }); }
function err500(res, msg) { send(res, 500, { error: msg }); }

/* ================================================================
   POM.XML HELPERS
   ================================================================ */

/**
 * Parse all <dependency> entries from a pom.xml.
 * Returns [{ groupId, artifactId, version, scope? }]
 */
function parseDependencies(pomPath) {
    const content = fs.readFileSync(pomPath, 'utf8');
    const deps = [];
    const depRegex = /<dependency>\s*([\s\S]*?)\s*<\/dependency>/g;
    let match;
    while ((match = depRegex.exec(content)) !== null) {
        const block = match[1];
        const gid = (block.match(/<groupId>([^<]+)<\/groupId>/) || [])[1] || '';
        const aid = (block.match(/<artifactId>([^<]+)<\/artifactId>/) || [])[1] || '';
        const ver = (block.match(/<version>([^<]+)<\/version>/) || [])[1] || '';
        const scope = (block.match(/<scope>([^<]+)<\/scope>/) || [])[1] || null;
        deps.push({ groupId: gid.trim(), artifactId: aid.trim(), version: ver.trim() || null, scope });
    }
    return deps;
}

/**
 * Add a dependency to pom.xml.
 * If the dependency already exists (same groupId:artifactId), its version is updated.
 */
function addDependencyToPom(pomPath, groupId, artifactId, version, scope) {
    let content = fs.readFileSync(pomPath, 'utf8');

    // Build dependency XML block
    let depBlock = `    <dependency>\n      <groupId>${groupId}</groupId>\n      <artifactId>${artifactId}</artifactId>`;
    if (version) depBlock += `\n      <version>${version}</version>`;
    if (scope) depBlock += `\n      <scope>${scope}</scope>`;
    depBlock += `\n    </dependency>`;

    // Check if dependency already exists
    const existingRegex = new RegExp(
        `<dependency>\\s*<groupId>\\s*${escapeRegex(groupId)}\\s*</groupId>\\s*<artifactId>\\s*${escapeRegex(artifactId)}\\s*</artifactId>[\\s\\S]*?</dependency>`,
        'g'
    );

    if (existingRegex.test(content)) {
        // Replace existing
        content = content.replace(existingRegex, depBlock);
        fs.writeFileSync(pomPath, content, 'utf8');
        return { action: 'updated', groupId, artifactId, version };
    }

    // Insert new dependency – find </dependencies> or create <dependencies> section
    if (content.includes('</dependencies>')) {
        content = content.replace('</dependencies>', depBlock + '\n  </dependencies>');
    } else if (content.includes('</project>')) {
        content = content.replace('</project>', '  <dependencies>\n' + depBlock + '\n  </dependencies>\n</project>');
    } else {
        return { error: 'Could not find insertion point in pom.xml' };
    }

    fs.writeFileSync(pomPath, content, 'utf8');
    return { action: 'added', groupId, artifactId, version };
}

function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/* ================================================================
   EXEC PROMISE WRAPPER
   ================================================================ */

function execPromise(cmd, opts = {}) {
    return new Promise((resolve, reject) => {
        exec(cmd, { maxBuffer: 10 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
            if (err) return reject(new Error(stderr ? stderr.trim() : err.message));
            resolve(stdout.trim());
        });
    });
}

/* ================================================================
   SERVER
   ================================================================ */

const server = http.createServer(async (req, res) => {

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

    const parsed = url.parse(req.url, true);
    const { pathname, query } = parsed;

    /* ── GET /health ──────────────────────────────────────────── */
    if (pathname === '/health') {
        const reqs = await checkRequirements();
        return send(res, 200, {
            status: 'UP',
            version: '1.0',
            type: 'java-maven-spring-agent',
            baseDir: BASE_DIR,
            projectCount: projects.size,
            projects: [...projects.keys()],
            requirements: reqs
        });
    }

    /* ── GET /projects ────────────────────────────────────────── */
    if (pathname === '/maven/projects' && req.method === 'GET') {
        const list = [];
        for (const [name, info] of projects) {
            list.push({ name, ...info });
        }
        return send(res, 200, { count: list.length, projects: list });
    }

    /* ── POST /maven/create – Create a new Maven project ──────
       Body: {
         groupId: "com.example",
         artifactId: "my-app",
         version?: "1.0-SNAPSHOT",
         archetypeGroupId?: "org.apache.maven.archetypes",
         archetypeArtifactId?: "maven-archetype-quickstart",
         archetypeVersion?: "1.4",
         javaVersion?: "17"
       }
       ─────────────────────────────────────────────────────────── */
    if (pathname === '/maven/create' && req.method === 'POST') {
        // Requirement check
        const reqs = await checkRequirements();
        if (!reqs.ok) return send(res, 500, { error: reqs.error });

        let body;
        try { body = await readBody(req); } catch { return err400(res, 'Invalid JSON body'); }

        const {
            groupId,
            artifactId,
            version = '1.0-SNAPSHOT',
            archetypeGroupId = 'org.apache.maven.archetypes',
            archetypeArtifactId = 'maven-archetype-quickstart',
            archetypeVersion = '1.4',
            javaVersion = '17'
        } = body;

        if (!groupId || !artifactId) {
            return err400(res, 'Provide { groupId, artifactId } in body');
        }

        if (projects.has(artifactId)) {
            return send(res, 409, { error: `Project '${artifactId}' already exists`, path: projects.get(artifactId).path });
        }

        const projectPath = path.join(BASE_DIR, artifactId);

        if (fs.existsSync(projectPath)) {
            return send(res, 409, { error: `Directory '${artifactId}' already exists on disk`, path: projectPath });
        }

        // Build mvn archetype:generate command
        const mvnCmd = [
            'mvn', 'archetype:generate',
            `-DgroupId=${groupId}`,
            `-DartifactId=${artifactId}`,
            `-Dversion=${version}`,
            `-DarchetypeGroupId=${archetypeGroupId}`,
            `-DarchetypeArtifactId=${archetypeArtifactId}`,
            `-DarchetypeVersion=${archetypeVersion}`,
            '-DinteractiveMode=false'
        ].join(' ');

        try {
            const output = await execPromise(mvnCmd, { cwd: BASE_DIR, timeout: 120000 });

            // Update java.version in pom.xml if project was created
            const pomPath = path.join(projectPath, 'pom.xml');
            if (fs.existsSync(pomPath)) {
                let pomContent = fs.readFileSync(pomPath, 'utf8');

                // Add maven.compiler.source and target properties if not present
                if (!pomContent.includes('maven.compiler.source')) {
                    const propsBlock = `  <properties>\n    <maven.compiler.source>${javaVersion}</maven.compiler.source>\n    <maven.compiler.target>${javaVersion}</maven.compiler.target>\n    <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>\n  </properties>`;

                    if (pomContent.includes('<properties>')) {
                        // Add inside existing <properties>
                        pomContent = pomContent.replace(/<properties>/, `<properties>\n    <maven.compiler.source>${javaVersion}</maven.compiler.source>\n    <maven.compiler.target>${javaVersion}</maven.compiler.target>`);
                    } else if (pomContent.includes('</project>')) {
                        pomContent = pomContent.replace('</project>', propsBlock + '\n</project>');
                    }
                    fs.writeFileSync(pomPath, pomContent, 'utf8');
                }
            }

            // Register in projects map and persist
            projects.set(artifactId, {
                name: artifactId,
                path: projectPath,
                groupId,
                artifactId,
                createdAt: new Date().toISOString()
            });
            saveProjects();

            return send(res, 200, {
                message: `Project '${artifactId}' created successfully`,
                project: projects.get(artifactId),
                mavenOutput: output.substring(output.length - 500) // last 500 chars
            });
        } catch (e) {
            return err500(res, `Maven project creation failed: ${e.message}`);
        }
    }

    /* ── POST /maven/class – Create a Java class ──────────────
       Query: ?projectName=my-app&packageName=com.example.service&className=UserService
       Body: { code: "package com.example.service;\n\npublic class UserService { ... }" }
       ─────────────────────────────────────────────────────────── */
    if (pathname === '/maven/class' && req.method === 'POST') {
        // Requirement check
        const reqs = await checkRequirements();
        if (!reqs.ok) return send(res, 500, { error: reqs.error });

        const { projectName, packageName, className } = query;

        if (!projectName) return err400(res, 'Provide ?projectName=<name>');
        if (!packageName) return err400(res, 'Provide ?packageName=<package>');
        if (!className) return err400(res, 'Provide ?className=<ClassName>');

        // Check if project exists
        if (!projects.has(projectName)) {
            return send(res, 404, { error: 'Project does not exist. Create the project first.', projectName });
        }

        let body;
        try { body = await readBody(req); } catch { return err400(res, 'Invalid JSON body'); }

        const { code } = body;
        if (!code || typeof code !== 'string') {
            return err400(res, 'Provide { code: "<java source code>" } in body');
        }

        const project = projects.get(projectName);
        const packagePath = packageName.replace(/\./g, path.sep);
        const classDir = path.join(project.path, 'src', 'main', 'java', packagePath);
        const classFile = path.join(classDir, `${className}.java`);

        const overwritten = fs.existsSync(classFile);

        try {
            fs.mkdirSync(classDir, { recursive: true });
            fs.writeFileSync(classFile, code, 'utf8');

            return send(res, 200, {
                message: overwritten
                    ? `Class '${className}' overwritten successfully`
                    : `Class '${className}' created successfully`,
                overwritten,
                classFile,
                packageName,
                className,
                projectName
            });
        } catch (e) {
            return err500(res, `Failed to write class file: ${e.message}`);
        }
    }

    /* ── PUT /maven/class – Update a Java class (same logic) ──
       Query: ?projectName=my-app&packageName=com.example.service&className=UserService
       Body: { code: "..." }
       ─────────────────────────────────────────────────────────── */
    if (pathname === '/maven/class' && req.method === 'PUT') {
        // Requirement check
        const reqs = await checkRequirements();
        if (!reqs.ok) return send(res, 500, { error: reqs.error });

        const { projectName, packageName, className } = query;

        if (!projectName) return err400(res, 'Provide ?projectName=<name>');
        if (!packageName) return err400(res, 'Provide ?packageName=<package>');
        if (!className) return err400(res, 'Provide ?className=<ClassName>');

        // Check if project exists
        if (!projects.has(projectName)) {
            return send(res, 404, { error: 'Project does not exist. Create the project first.', projectName });
        }

        let body;
        try { body = await readBody(req); } catch { return err400(res, 'Invalid JSON body'); }

        const { code } = body;
        if (!code || typeof code !== 'string') {
            return err400(res, 'Provide { code: "<java source code>" } in body');
        }

        const project = projects.get(projectName);
        const packagePath = packageName.replace(/\./g, path.sep);
        const classDir = path.join(project.path, 'src', 'main', 'java', packagePath);
        const classFile = path.join(classDir, `${className}.java`);

        const overwritten = fs.existsSync(classFile);

        try {
            fs.mkdirSync(classDir, { recursive: true });
            fs.writeFileSync(classFile, code, 'utf8');

            return send(res, 200, {
                message: overwritten
                    ? `Class '${className}' updated (overwritten) successfully`
                    : `Class '${className}' created successfully (did not exist before)`,
                overwritten,
                classFile,
                packageName,
                className,
                projectName
            });
        } catch (e) {
            return err500(res, `Failed to write class file: ${e.message}`);
        }
    }

    /* ── POST /maven/dependency – Add dependency to pom.xml ───
       Query: ?projectName=my-app
       Body: {
         groupId: "org.springframework.boot",
         artifactId: "spring-boot-starter-web",
         version?: "3.2.0",
         scope?: "compile"
       }
       ─────────────────────────────────────────────────────────── */
    if (pathname === '/maven/dependency' && req.method === 'POST') {
        // Requirement check
        const reqs = await checkRequirements();
        if (!reqs.ok) return send(res, 500, { error: reqs.error });

        const { projectName } = query;
        if (!projectName) return err400(res, 'Provide ?projectName=<name>');

        if (!projects.has(projectName)) {
            return send(res, 404, { error: 'Project does not exist. Create the project first.', projectName });
        }

        let body;
        try { body = await readBody(req); } catch { return err400(res, 'Invalid JSON body'); }

        const { groupId, artifactId, version, scope } = body;
        if (!groupId || !artifactId) {
            return err400(res, 'Provide { groupId, artifactId } in body');
        }

        const project = projects.get(projectName);
        const pomPath = path.join(project.path, 'pom.xml');

        if (!fs.existsSync(pomPath)) {
            return err404(res, `pom.xml not found in project '${projectName}'`);
        }

        try {
            const result = addDependencyToPom(pomPath, groupId.trim(), artifactId.trim(), version ? version.trim() : null, scope ? scope.trim() : null);
            if (result.error) {
                return err500(res, result.error);
            }

            return send(res, 200, {
                message: `Dependency ${result.action}: ${groupId}:${artifactId}${version ? ':' + version : ''}`,
                projectName,
                ...result
            });
        } catch (e) {
            return err500(res, `Failed to add dependency: ${e.message}`);
        }
    }

    /* ── GET /maven/dependencies – List all dependencies ──────
       Query: ?projectName=my-app
       Returns all dependencies with their current versions from pom.xml.
       ─────────────────────────────────────────────────────────── */
    if (pathname === '/maven/dependencies' && req.method === 'GET') {
        // Requirement check
        const reqs = await checkRequirements();
        if (!reqs.ok) return send(res, 500, { error: reqs.error });

        const { projectName } = query;
        if (!projectName) return err400(res, 'Provide ?projectName=<name>');

        if (!projects.has(projectName)) {
            return send(res, 404, { error: 'Project does not exist. Create the project first.', projectName });
        }

        const project = projects.get(projectName);
        const pomPath = path.join(project.path, 'pom.xml');

        if (!fs.existsSync(pomPath)) {
            return err404(res, `pom.xml not found in project '${projectName}'`);
        }

        try {
            const dependencies = parseDependencies(pomPath);

            // Also try to get effective versions using mvn dependency:list
            let effectiveDeps = null;
            try {
                const output = await execPromise(
                    'mvn dependency:list -DoutputAbsoluteArtifactFilename=false -q',
                    { cwd: project.path, timeout: 120000 }
                );
                // Parse lines like "   com.example:artifact:jar:1.0:compile"
                const depLines = output.split('\n')
                    .filter(l => l.trim().match(/^[a-zA-Z]/))
                    .map(l => {
                        const parts = l.trim().split(':');
                        if (parts.length >= 4) {
                            return {
                                groupId: parts[0],
                                artifactId: parts[1],
                                type: parts[2],
                                resolvedVersion: parts[3],
                                scope: parts[4] || null
                            };
                        }
                        return null;
                    })
                    .filter(Boolean);
                effectiveDeps = depLines;
            } catch { /* mvn dependency:list may fail if not yet compiled, that's OK */ }

            return send(res, 200, {
                projectName,
                pomDependencies: dependencies,
                count: dependencies.length,
                resolvedDependencies: effectiveDeps
            });
        } catch (e) {
            return err500(res, `Failed to read dependencies: ${e.message}`);
        }
    }

    /* ── GET /maven/build – Build the project (mvn package) ───
       Query: ?projectName=my-app&skipTests=true
       ─────────────────────────────────────────────────────────── */
    if (pathname === '/maven/build' && req.method === 'GET') {
        // Requirement check
        const reqs = await checkRequirements();
        if (!reqs.ok) return send(res, 500, { error: reqs.error });

        const { projectName, skipTests } = query;
        if (!projectName) return err400(res, 'Provide ?projectName=<name>');

        if (!projects.has(projectName)) {
            return send(res, 404, { error: 'Project does not exist. Create the project first.', projectName });
        }

        const project = projects.get(projectName);
        const skipTestsFlag = skipTests === 'true' || skipTests === '1' ? ' -DskipTests' : '';
        const mvnCmd = `mvn package${skipTestsFlag}`;

        try {
            const output = await execPromise(mvnCmd, { cwd: project.path, timeout: 300000 });
            const buildSuccess = output.includes('BUILD SUCCESS');

            // Find the generated JAR
            const targetDir = path.join(project.path, 'target');
            let jarFile = null;
            if (fs.existsSync(targetDir)) {
                const files = fs.readdirSync(targetDir);
                jarFile = files.find(f => f.endsWith('.jar') && !f.endsWith('-sources.jar') && !f.endsWith('-javadoc.jar'));
            }

            return send(res, buildSuccess ? 200 : 500, {
                message: buildSuccess ? 'Build successful' : 'Build failed',
                projectName,
                buildSuccess,
                jarFile: jarFile ? path.join(targetDir, jarFile) : null,
                mavenOutput: output.substring(output.length - 1000) // last 1000 chars
            });
        } catch (e) {
            return err500(res, `Build failed: ${e.message}`);
        }
    }

    /* ── GET /maven/jar – Download the JAR from target/ ───────
       Query: ?projectName=my-app
       Sends the JAR file as a binary download.
       ─────────────────────────────────────────────────────────── */
    if (pathname === '/maven/jar' && req.method === 'GET') {
        // Requirement check
        const reqs = await checkRequirements();
        if (!reqs.ok) return send(res, 500, { error: reqs.error });

        const { projectName } = query;
        if (!projectName) return err400(res, 'Provide ?projectName=<name>');

        if (!projects.has(projectName)) {
            return send(res, 404, { error: 'Project does not exist. Create the project first.', projectName });
        }

        const project = projects.get(projectName);
        const targetDir = path.join(project.path, 'target');

        if (!fs.existsSync(targetDir)) {
            return err404(res, `No target/ directory found. Build the project first using GET /maven/build?projectName=${projectName}`);
        }

        // Find the JAR file in target/
        const files = fs.readdirSync(targetDir);
        const jarFileName = files.find(f => f.endsWith('.jar') && !f.endsWith('-sources.jar') && !f.endsWith('-javadoc.jar'));

        if (!jarFileName) {
            return err404(res, `No JAR file found in target/. Build the project first using GET /maven/build?projectName=${projectName}`);
        }

        const jarFilePath = path.join(targetDir, jarFileName);
        return sendFile(res, jarFilePath);
    }

    /* ── GET /maven/rescan ────────────────────────────────────── */
    if (pathname === '/maven/rescan' && req.method === 'GET') {
        projects.clear();
        scanExistingProjects(); // also saves to registry file
        return send(res, 200, {
            message: 'Rescanned for Maven projects',
            projectCount: projects.size,
            projects: [...projects.keys()]
        });
    }

    /* ── 404 ──────────────────────────────────────────────────── */
    send(res, 404, {
        error: 'Endpoint not found',
        availableEndpoints: [
            'GET  /health',
            'GET  /maven/projects',
            'POST /maven/create                   { groupId, artifactId, version?, archetypeGroupId?, archetypeArtifactId?, archetypeVersion?, javaVersion? }',
            'POST /maven/class?projectName=&packageName=&className=    { code: "..." }',
            'PUT  /maven/class?projectName=&packageName=&className=    { code: "..." }',
            'POST /maven/dependency?projectName=   { groupId, artifactId, version?, scope? }',
            'GET  /maven/dependencies?projectName=',
            'GET  /maven/build?projectName=&skipTests=true',
            'GET  /maven/jar?projectName=',
            'GET  /maven/rescan'
        ]
    });
});

server.listen(PORT, () => {
    console.log(`\nJava Maven Spring Connector v1.0 running at http://localhost:${PORT}`);
    console.log('\nAvailable endpoints:');
    console.log('  GET  /health                         - Server status & requirement check');
    console.log('  GET  /maven/projects                 - List all tracked projects');
    console.log('  POST /maven/create                   - Create a new Maven project');
    console.log('  POST /maven/class?projectName=&...   - Create a Java class');
    console.log('  PUT  /maven/class?projectName=&...   - Update a Java class');
    console.log('  POST /maven/dependency?projectName=  - Add/update dependency in pom.xml');
    console.log('  GET  /maven/dependencies?projectName=- List project dependencies');
    console.log('  GET  /maven/build?projectName=       - Build project (mvn package)');
    console.log('  GET  /maven/jar?projectName=         - Download built JAR');
    console.log('  GET  /maven/rescan                   - Rescan for existing Maven projects');
});
