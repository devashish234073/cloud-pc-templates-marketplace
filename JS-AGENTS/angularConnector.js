const http = require('http');
const url = require('url');
const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');

const PORT = 3034;

/* ------------------ ANGULAR PROJECT DETECTION ------------------ */

const PROJECT_DIR = process.argv[2]
    ? path.resolve(process.argv[2])
    : process.cwd();

console.log("Checking Angular project at:", PROJECT_DIR);

if (!fs.existsSync(PROJECT_DIR) || !fs.statSync(PROJECT_DIR).isDirectory()) {
    console.error("ERROR: Provided path is not a valid directory:", PROJECT_DIR);
    process.exit(1);
}

const angularJsonPath = path.join(PROJECT_DIR, 'angular.json');
const packageJsonPath = path.join(PROJECT_DIR, 'package.json');

if (!fs.existsSync(angularJsonPath)) {
    console.error("ERROR: Not an Angular project - angular.json not found in:", PROJECT_DIR);
    process.exit(1);
}

if (!fs.existsSync(packageJsonPath)) {
    console.error("ERROR: package.json not found in:", PROJECT_DIR);
    process.exit(1);
}

// Verify @angular/core in package.json
try {
    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    if (!deps['@angular/core']) {
        console.error("ERROR: @angular/core not found in dependencies - not an Angular project.");
        process.exit(1);
    }
    console.log("Angular project detected. Version:", deps['@angular/core']);
} catch (e) {
    console.error("ERROR: Could not parse package.json:", e.message);
    process.exit(1);
}

/* ------------------ FIND ROUTES FILE ------------------ */

function findRoutesFile(dir) {
    // Common Angular route file patterns
    const candidates = [
        'app.routes.ts',
        'app-routing.module.ts',
        'app.routing.ts',
        'app.routing.module.ts'
    ];

    // Search recursively in src/
    function search(searchDir, depth = 0) {
        if (depth > 5) return null;
        try {
            const files = fs.readdirSync(searchDir);
            for (const file of files) {
                if (file.startsWith('.')) continue;
                const fullPath = path.join(searchDir, file);
                try {
                    const stat = fs.statSync(fullPath);
                    if (stat.isFile() && candidates.includes(file.toLowerCase())) {
                        return fullPath;
                    }
                } catch { }
            }
            for (const file of files) {
                if (file.startsWith('.') || file === 'node_modules') continue;
                const fullPath = path.join(searchDir, file);
                try {
                    const stat = fs.statSync(fullPath);
                    if (stat.isDirectory()) {
                        const found = search(fullPath, depth + 1);
                        if (found) return found;
                    }
                } catch { }
            }
        } catch { }
        return null;
    }

    const srcDir = path.join(dir, 'src');
    return search(fs.existsSync(srcDir) ? srcDir : dir);
}

const ROUTES_FILE = findRoutesFile(PROJECT_DIR);

if (!ROUTES_FILE) {
    console.warn("WARNING: Could not find a routes file (app.routes.ts / app-routing.module.ts). Route features will be limited.");
} else {
    console.log("Routes file found:", ROUTES_FILE);

    // Overwrite routes file with clean empty routes
    const cleanRoutes = `import { Routes } from '@angular/router';\n\nexport const routes: Routes = [];\n`;
    try {
        fs.writeFileSync(ROUTES_FILE, cleanRoutes, 'utf8');
        console.log("Routes file reset to empty routes.");
    } catch (e) {
        console.warn("WARNING: Could not overwrite routes file:", e.message);
    }
}

/* ------------------ COMPONENTS FOLDER SETUP ------------------ */

const COMPONENTS_DIR = path.join(PROJECT_DIR, 'src', 'app', 'components');

if (fs.existsSync(COMPONENTS_DIR)) {
    // Empty the folder
    for (const entry of fs.readdirSync(COMPONENTS_DIR)) {
        fs.rmSync(path.join(COMPONENTS_DIR, entry), { recursive: true, force: true });
    }
    console.log('components folder emptied:', COMPONENTS_DIR);
} else {
    fs.mkdirSync(COMPONENTS_DIR, { recursive: true });
    console.log('components folder created:', COMPONENTS_DIR);
}

/* ------------------ RESET APP HTML TO ROUTER OUTLET ------------------ */

function findAppHtml(dir) {
    const candidates = [
        path.join(dir, 'src', 'app', 'app.component.html'),
        path.join(dir, 'src', 'app', 'app.html'),
    ];
    for (const c of candidates) {
        if (fs.existsSync(c)) return c;
    }
    return null;
}

const APP_HTML = findAppHtml(PROJECT_DIR);

if (!APP_HTML) {
    console.warn("WARNING: Could not find app.component.html - skipping reset.");
} else {
    console.log("App HTML found:", APP_HTML);
    try {
        fs.writeFileSync(APP_HTML, `<router-outlet />\n`, 'utf8');
        console.log("app.component.html reset to <router-outlet />.");
    } catch (e) {
        console.warn("WARNING: Could not overwrite app.component.html:", e.message);
    }
}

/* ------------------ START ANGULAR APP ------------------ */

function getTimestamp() {
    const now = new Date();
    return now.toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
}

const LOG_FILENAME = `angular-dev-${getTimestamp()}.log`;
const LOG_FILE_PATH = path.join(PROJECT_DIR, LOG_FILENAME);

console.log("Starting Angular app (npm start)...");
console.log("Log file:", LOG_FILE_PATH);

const logStream = fs.createWriteStream(LOG_FILE_PATH, { flags: 'a' });

const angularProcess = spawn(
    'npx',
    ['ng', 'serve', '--host=0.0.0.0', '--port=4200'],
    {
        cwd: PROJECT_DIR,
        //detached: true,
        shell: true,
        stdio: ['ignore', 'pipe', 'pipe']
    }
);

angularProcess.stdout.on('data', (data) => {
    logStream.write(`[STDOUT] ${data}`);
});

angularProcess.stderr.on('data', (data) => {
    logStream.write(`[STDERR] ${data}`);
});

angularProcess.on('close', (code) => {
    logStream.write(`[INFO] Angular process exited with code ${code}\n`);
    logStream.end();
});

angularProcess.on('error', (err) => {
    logStream.write(`[ERROR] Failed to start Angular process: ${err.message}\n`);
    console.error("Failed to start Angular:", err.message);
});

console.log(`Angular process spawned (PID: ${angularProcess.pid})`);

// Cleanup on server exit - kill Angular child process on any shutdown signal
function shutdown(signal) {
    console.log(`\n[${signal}] Shutting down - killing Angular process (PID: ${angularProcess.pid})...`);
    try {
        // Kill the entire process group to catch any child-of-child processes
        process.kill(-angularProcess.pid, 'SIGTERM');
    } catch {
        try { angularProcess.kill('SIGTERM'); } catch { }
    }
    logStream.write(`[INFO] Server received ${signal}, Angular process killed.\n`);
    logStream.end(() => process.exit(0));
}

process.on('SIGINT', () => shutdown('SIGINT'));   // Ctrl+C
process.on('SIGTERM', () => shutdown('SIGTERM'));  // kill <pid> / docker stop
process.on('SIGQUIT', () => shutdown('SIGQUIT'));  // kill -3 / graceful quit
process.on('SIGHUP', () => shutdown('SIGHUP'));   // terminal closed

process.on('uncaughtException', (err) => {
    console.error('[uncaughtException]', err);
    shutdown('uncaughtException');
});

process.on('unhandledRejection', (reason) => {
    console.error('[unhandledRejection]', reason);
    shutdown('unhandledRejection');
});

// Last-resort: 'exit' event fires synchronously - do a hard kill here
// since async operations (like logStream.end) won't work at this point
process.on('exit', () => {
    try { process.kill(-angularProcess.pid, 'SIGTERM'); } catch { }
    try { angularProcess.kill('SIGTERM'); } catch { }
});

/* ------------------ HELPERS ------------------ */

function readBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => body += chunk.toString());
        req.on('end', () => {
            try {
                resolve(body ? JSON.parse(body) : {});
            } catch (e) {
                reject(new Error('Invalid JSON body'));
            }
        });
        req.on('error', reject);
    });
}

function getComponentDir(componentName) {
    const kebab = componentName
        .replace(/([A-Z])/g, (m, l, i) => (i === 0 ? l : '-' + l).toLowerCase())
        .toLowerCase()
        .replace(/component$/, '')
        .replace(/-$/, '');
    // Primary: src/app/components/<kebab>
    const inComponents = path.join(COMPONENTS_DIR, kebab);
    if (fs.existsSync(inComponents)) return inComponents;
    // Fallback: src/app/<kebab> (legacy)
    const inApp = path.join(PROJECT_DIR, 'src', 'app', kebab);
    if (fs.existsSync(inApp)) return inApp;
    // Fallback: original name in components dir
    const altComponents = path.join(COMPONENTS_DIR, componentName);
    if (fs.existsSync(altComponents)) return altComponents;
    return inComponents; // return expected path even if not yet created
}

function toKebabCase(name) {
    return name
        .replace(/([A-Z])/g, (m, l, i) => (i === 0 ? l : '-' + l).toLowerCase())
        .toLowerCase();
}

/* ------------------ GET LOGS HELPER ------------------ */

function getLogs() {
    try {
        if (!fs.existsSync(LOG_FILE_PATH)) {
            return { logFile: LOG_FILE_PATH, lines: [], totalLines: 0 };
        }

        const content = fs.readFileSync(LOG_FILE_PATH, 'utf8');
        const lines = content.split(/\r?\n/).filter(l => l.trim() !== '');
        const last20 = lines.slice(-20);

        return {
            logFile: LOG_FILE_PATH,
            totalLines: lines.length,
            lines: last20
        };
    } catch (e) {
        return { logFile: LOG_FILE_PATH, lines: [], totalLines: 0, error: e.message };
    }
}

/* ------------------ HOMEPAGE LINK HELPER ------------------ */

function addHomepageLink(routePath, label) {
    if (!APP_HTML) return { error: 'app.component.html not found' };
    try {
        // --- Update HTML ---
        let html = fs.readFileSync(APP_HTML, 'utf8');
        const linkTag = '<a routerLink="/' + routePath + '">' + label + '</a>';
        if (!html.includes('routerLink="/' + routePath + '"')) {
            html = html.replace(/(<router-outlet[\s\S]*?\/?>)/, linkTag + '\n' + '$1');
            fs.writeFileSync(APP_HTML, html, 'utf8');
        }

        // --- Update app.component.ts ---
        const appTs = APP_HTML.replace(/\.html$/, '.ts');
        if (!fs.existsSync(appTs)) return { success: true, link: linkTag };
        let ts = fs.readFileSync(appTs, 'utf8');

        // 1. Add RouterLink to the ES import from @angular/router
        if (!ts.includes('RouterLink')) {
            if (ts.includes('@angular/router')) {
                // Append RouterLink inside the existing { ... } from @angular/router import
                ts = ts.replace(/(from\s*['"]@angular\/router['"])/g, function(match) {
                    return match;
                });
                ts = ts.replace(/(import\s*\{)([^}]+)(\}\s*from\s*['"]@angular\/router['"]\s*;)/, function(_, a, b, c) {
                    return a + b.trimEnd() + ', RouterLink' + c;
                });
            } else {
                ts = 'import { RouterLink } from \'@angular/router\';\n' + ts;
            }
        }

        // 2. Add RouterLink to the @Component imports array
        if (!ts.includes('RouterLink')) {
            // already handled above, skip
        }
        var hasInDecoratorImports = /imports\s*:\s*\[[^\]]*RouterLink/.test(ts);
        if (!hasInDecoratorImports) {
            ts = ts.replace(/(imports\s*:\s*\[)([^\]]*)(\])/, function(_, open, middle, close) {
                var trimmed = middle.trimEnd();
                var comma = (trimmed === '' || trimmed.endsWith(',')) ? '' : ',';
                return open + trimmed + comma + ' RouterLink' + close;
            });
        }

        fs.writeFileSync(appTs, ts, 'utf8');
        return { success: true, link: linkTag };
    } catch (e) {
        return { error: e.message };
    }
}

/* ------------------ ADD ROUTE HELPER ------------------ */

function addRouteToFile(cleanRoute, cleanComponent, componentDir) {
    if (!ROUTES_FILE) return { error: 'Routes file not found' };

    try {
        let content = fs.readFileSync(ROUTES_FILE, 'utf8');

        // Check if route already exists
        if (content.includes(`path: '${cleanRoute}'`) || content.includes(`path: "${cleanRoute}"`)) {
            return { error: `Route '${cleanRoute}' already exists in routes file` };
        }

        const isStandaloneRoutes = content.includes('export const routes') || content.includes('Routes = [');
        const isNgModule = content.includes('RouterModule.forRoot');

        // Build import path - try to detect if Angular 19+ (no .component suffix)
        const kebab = toKebabCase(cleanComponent.replace(/Component$/, ''));
        const relDir = componentDir
            ? './' + path.relative(path.dirname(ROUTES_FILE), componentDir).replace(/\\/g, '/')
            : `./${kebab}`;

        // Detect whether generated file uses .component suffix or not
        const hasComponentSuffix = fs.existsSync(path.join(componentDir || '', `${kebab}.component.ts`));
        const importFile = hasComponentSuffix ? `${relDir}/${kebab}.component` : `${relDir}/${kebab}`;
        const importStatement = `import { ${cleanComponent} } from '${importFile}';`;

        if (!content.includes(cleanComponent)) {
            const lines = content.split('\n');
            let lastImportIdx = 0;
            lines.forEach((line, i) => { if (line.trim().startsWith('import ')) lastImportIdx = i; });
            lines.splice(lastImportIdx + 1, 0, importStatement);
            content = lines.join('\n');
        }

        const newRouteEntry = `  { path: '${cleanRoute}', component: ${cleanComponent} }`;

        if (isStandaloneRoutes || isNgModule) {
            const routesArrayMatch = content.match(/(Routes\s*=\s*\[|forRoot\s*\(\s*\[)([\s\S]*?)(\])/);
            if (routesArrayMatch) {
                const fullMatch = routesArrayMatch[0];
                const prefix = routesArrayMatch[1];
                const middle = routesArrayMatch[2];
                const suffix = routesArrayMatch[3];

                if (middle.trim() === '') {
                    content = content.replace(fullMatch, prefix + `\n${newRouteEntry}\n` + suffix);
                } else {
                    const trimmedMiddle = middle.trimEnd();
                    const comma = trimmedMiddle.endsWith(',') ? '' : ',';
                    content = content.replace(fullMatch, prefix + trimmedMiddle + comma + '\n' + newRouteEntry + '\n' + suffix);
                }
            } else {
                const lastBracket = content.lastIndexOf(']');
                if (lastBracket === -1) return { error: 'Could not locate routes array in file' };
                const before = content.substring(0, lastBracket).trimEnd();
                const after = content.substring(lastBracket);
                const comma = before.endsWith(',') || before.endsWith('[') ? '' : ',';
                content = before + comma + '\n' + newRouteEntry + '\n' + after;
            }
        } else {
            return { error: 'Unrecognized routes file format' };
        }

        fs.writeFileSync(ROUTES_FILE, content, 'utf8');
        return { success: true, path: cleanRoute, component: cleanComponent, importStatement };

    } catch (e) {
        return { error: e.message };
    }
}

/* ------------------ SERVER ------------------ */

const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        return res.end();
    }

    const parsedUrl = url.parse(req.url, true);
    const respond = (statusCode, data) => {
        res.writeHead(statusCode, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data, null, 2));
    };

    /* -------- HEALTH -------- */
    if (parsedUrl.pathname === '/health' && req.method === 'GET') {
        return respond(200, {
            status: 'UP',
            version: '3.1',
            type: 'agent',
            projectDir: PROJECT_DIR,
            routesFile: ROUTES_FILE || null,
            logFile: LOG_FILE_PATH,
            angularPid: angularProcess.pid
        });
    }

    /* -------- 0. GET COMPONENT FILES (POST /component/get) -------- */
    if (parsedUrl.pathname === '/component/get') {
        let body;
        try {
            body = await readBody(req);
        } catch (e) {
            return respond(400, { error: e.message });
        }

        const { componentName, fileTypes = ['ts', 'html', 'css'] } = body;

        if (!componentName || typeof componentName !== 'string' || !componentName.trim()) {
            return respond(400, { error: 'componentName is required' });
        }

        // Validate fileTypes
        if (!Array.isArray(fileTypes)) {
            return respond(400, { error: 'fileTypes must be an array' });
        }
        const validTypes = ['ts', 'html', 'css'];
        for (const fileType of fileTypes) {
            if (!validTypes.includes(fileType)) {
                return respond(400, { error: `Invalid fileType: '${fileType}'. Accepted values are: ts, html, css` });
            }
        }

        const safeName = componentName.trim();
        const kebab = toKebabCase(safeName.replace(/Component$/, ''));

        // Check if component exists
        const componentDir = getComponentDir(safeName);
        if (!fs.existsSync(componentDir)) {
            return respond(404, {
                error: `Component '${safeName}' not found`,
                searchedPath: componentDir
            });
        }

        // Find existing component files
        const fileMap = {
            ts: null,
            html: null,
            css: null
        };

        // Find TS file
        for (const name of [`${kebab}.component.ts`, `${kebab}.ts`]) {
            const candidate = path.join(componentDir, name);
            if (fs.existsSync(candidate)) { fileMap.ts = candidate; break; }
        }

        // Find HTML file
        for (const name of [`${kebab}.component.html`, `${kebab}.html`]) {
            const candidate = path.join(componentDir, name);
            if (fs.existsSync(candidate)) { fileMap.html = candidate; break; }
        }

        // Find CSS file
        for (const prefix of [`${kebab}.component`, kebab]) {
            for (const ext of ['css', 'scss', 'sass', 'less']) {
                const candidate = path.join(componentDir, `${prefix}.${ext}`);
                if (fs.existsSync(candidate)) { fileMap.css = candidate; break; }
            }
            if (fileMap.css) break;
        }

        // Read requested files
        const result = {
            componentName: safeName,
            componentDir,
            files: {}
        };

        const notFound = [];
        for (const fileType of fileTypes) {
            const filePath = fileMap[fileType];
            if (filePath && fs.existsSync(filePath)) {
                try {
                    const content = fs.readFileSync(filePath, 'utf8');
                    result.files[fileType] = {
                        path: filePath,
                        content
                    };
                } catch (e) {
                    return respond(500, {
                        error: `Failed to read ${fileType} file`,
                        details: e.message
                    });
                }
            } else {
                notFound.push(fileType);
            }
        }

        if (notFound.length > 0) {
            result.filesNotFound = notFound;
        }

        if (Object.keys(result.files).length === 0) {
            return respond(404, {
                error: `No requested files found for component '${safeName}'`,
                requestedFileTypes: fileTypes,
                componentDir
            });
        }

        return respond(200, result);
    }

    /* -------- 1. CREATE COMPONENT (POST /component/create) -------- */
    if (parsedUrl.pathname === '/component/create' && req.method === 'POST') {
        let body;
        try {
            body = await readBody(req);
        } catch (e) {
            return respond(400, { error: e.message });
        }

        const { componentName } = body;
        let { ts, html, css } = body;

        if (!componentName || typeof componentName !== 'string' || !componentName.trim()) {
            return respond(400, { error: 'componentName is required' });
        }

        const safeName = componentName.trim();

        // Run ng g c - capture stdout so we can parse which files were created
        let ngOutput = '';
        try {
            console.log(`Generating component: ${safeName}`);
            ngOutput = execSync(
                `npx ng g c ${safeName} --skip-tests --path src/app/components`,
                { cwd: PROJECT_DIR, timeout: 30000 }
            ).toString();
            console.log(ngOutput);
        } catch (e) {
            return respond(500, {
                error: 'ng generate component failed',
                details: e.stderr ? e.stderr.toString() : e.message
            });
        }

        // Strip ANSI color/escape codes from ng output before parsing
        // ng g c output contains terminal color codes like \x1B[32m that break regex
        const cleanNgOutput = ngOutput.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '');
        console.log('ng output (clean):', cleanNgOutput);

        // Parse ng output to find the actual generated file paths
        // ng g c prints lines like: "CREATE src/app/my-header/my-header.component.ts"
        const generatedFiles = {};
        for (const line of cleanNgOutput.split('\n')) {
            const match = line.match(/CREATE\s+(.+\.(ts|html|css|scss|sass|less))\s/);
            if (match) {
                const relPath = match[1].trim();
                const ext = match[2];
                const absPath = path.join(PROJECT_DIR, relPath);
                if (ext === 'ts') generatedFiles.ts = absPath;
                else if (ext === 'html') generatedFiles.html = absPath;
                else generatedFiles.css = absPath;
            }
        }
        console.log('parsed generatedFiles:', generatedFiles);

        // Fallback: scan the component directory if parsing yielded nothing
        const kebab = toKebabCase(safeName);
        const componentDir = generatedFiles.ts
            ? path.dirname(generatedFiles.ts)
            : path.join(COMPONENTS_DIR, kebab);

        if (!fs.existsSync(componentDir)) {
            return respond(500, {
                error: `Component directory not found after generation: ${componentDir}`,
                ngOutput
            });
        }

        // If parsing missed any file, scan the directory as fallback
        // Support both Angular 19+ (my-header.ts) and older (.component.ts) naming
        if (!generatedFiles.ts) {
            for (const name of [`${kebab}.component.ts`, `${kebab}.ts`]) {
                const candidate = path.join(componentDir, name);
                if (fs.existsSync(candidate)) { generatedFiles.ts = candidate; break; }
            }
        }
        if (!generatedFiles.html) {
            for (const name of [`${kebab}.component.html`, `${kebab}.html`]) {
                const candidate = path.join(componentDir, name);
                if (fs.existsSync(candidate)) { generatedFiles.html = candidate; break; }
            }
        }
        if (!generatedFiles.css) {
            for (const prefix of [`${kebab}.component`, kebab]) {
                for (const ext of ['css', 'scss', 'sass', 'less']) {
                    const candidate = path.join(componentDir, `${prefix}.${ext}`);
                    if (fs.existsSync(candidate)) { generatedFiles.css = candidate; break; }
                }
                if (generatedFiles.css) break;
            }
        }

        const written = [];
        const errors = [];

        // Fix templateUrl and styleUrl in TS content to match actual generated filenames
        function fixComponentDecorator(tsContent) {
            if (!tsContent) return tsContent;

            // Detect actual html and css filenames from generatedFiles
            const actualHtml = generatedFiles.html ? path.basename(generatedFiles.html) : null;
            const actualCss = generatedFiles.css ? path.basename(generatedFiles.css) : null;

            // Replace templateUrl value with actual generated html filename
            if (actualHtml) {
                tsContent = tsContent.replace(
                    /templateUrl\s*:\s*['"]([^'"]+)['"]/,
                    `templateUrl: './${actualHtml}'`
                );
            }

            // Replace styleUrl / styleUrls value with actual generated css filename
            if (actualCss) {
                // styleUrl: '...' (Angular 17+)
                tsContent = tsContent.replace(
                    /styleUrl\s*:\s*['"]([^'"]+)['"]/,
                    `styleUrl: './${actualCss}'`
                );
                // styleUrls: ['...'] (older style)
                tsContent = tsContent.replace(
                    /styleUrls\s*:\s*\[\s*['"]([^'"]+)['"]\s*\]/,
                    `styleUrls: ['./${actualCss}']`
                );
            }

            return tsContent;
        }

        // Write TS file
        if (ts !== undefined && ts !== null) {
            ts = fixComponentDecorator(ts);
            if (generatedFiles.ts && fs.existsSync(generatedFiles.ts)) {
                try { fs.writeFileSync(generatedFiles.ts, ts, 'utf8'); written.push(generatedFiles.ts); }
                catch (e) { errors.push({ file: generatedFiles.ts, error: e.message }); }
            } else {
                errors.push({ file: generatedFiles.ts || `${kebab}.component.ts`, error: 'TS file not found after generation' });
            }
        }

        // Write HTML file
        if (html !== undefined && html !== null) {
            if (generatedFiles.html && fs.existsSync(generatedFiles.html)) {
                try { fs.writeFileSync(generatedFiles.html, html, 'utf8'); written.push(generatedFiles.html); }
                catch (e) { errors.push({ file: generatedFiles.html, error: e.message }); }
            } else {
                errors.push({ file: generatedFiles.html || `${kebab}.component.html`, error: 'HTML file not found after generation' });
            }
        }

        // Write CSS file
        if (css !== undefined && css !== null) {
            if (generatedFiles.css && fs.existsSync(generatedFiles.css)) {
                try { fs.writeFileSync(generatedFiles.css, css, 'utf8'); written.push(generatedFiles.css); }
                catch (e) { errors.push({ file: generatedFiles.css, error: e.message }); }
            } else {
                errors.push({ file: generatedFiles.css || `${kebab}.component.css`, error: 'No CSS/SCSS file found after generation' });
            }
        }

        // Auto-register route using camelCase derived from componentName
        // e.g. "my-header" -> path "myHeader", component "MyHeaderComponent"
        let routeResult = null;
        if (ROUTES_FILE) {
            const camelRoute = kebab.replace(/-([a-z])/g, (_, l) => l.toUpperCase());
            // Derive PascalCase component class name from kebab
            const pascalName = kebab
                .split('-')
                .map(p => p.charAt(0).toUpperCase() + p.slice(1))
                .join('') + 'Component';

            routeResult = addRouteToFile(camelRoute, pascalName, componentDir);
            if (routeResult.success) {
                console.log(`Route '${camelRoute}' -> ${pascalName} registered in routes file.`);
                addHomepageLink(camelRoute, pascalName.replace(/Component$/, ''));
            } else {
                console.warn(`Route registration skipped: ${routeResult.error}`);
            }
        }

        return respond(200, {
            message: `Component '${safeName}' created successfully`,
            componentDir,
            filesWritten: written,
            route: routeResult && routeResult.success
                ? { path: routeResult.path, component: routeResult.component, urlToTest: `http://localhost/${routeResult.path}` }
                : { skipped: true, reason: routeResult ? routeResult.error : 'No routes file found' },
            errors: errors.length ? errors : undefined,
            logs: getLogs()
        });
    }

    /* -------- 2. UPDATE COMPONENT (POST /component/update) -------- */
    if (parsedUrl.pathname === '/component/update' && req.method === 'POST') {
        let body;
        try {
            body = await readBody(req);
        } catch (e) {
            return respond(400, { error: e.message });
        }

        const { componentName } = body;
        let { ts, html, css } = body;

        if (!componentName || typeof componentName !== 'string' || !componentName.trim()) {
            return respond(400, { error: 'componentName is required' });
        }

        const safeName = componentName.trim();
        const kebab = toKebabCase(safeName.replace(/Component$/, ''));

        // Check if component exists
        const componentDir = getComponentDir(safeName);
        if (!fs.existsSync(componentDir)) {
            return respond(404, {
                error: `Component '${safeName}' not found`,
                searchedPath: componentDir
            });
        }

        // Find existing component files
        const existingFiles = {};
        for (const name of [`${kebab}.component.ts`, `${kebab}.ts`]) {
            const candidate = path.join(componentDir, name);
            if (fs.existsSync(candidate)) { existingFiles.ts = candidate; break; }
        }
        for (const name of [`${kebab}.component.html`, `${kebab}.html`]) {
            const candidate = path.join(componentDir, name);
            if (fs.existsSync(candidate)) { existingFiles.html = candidate; break; }
        }
        for (const prefix of [`${kebab}.component`, kebab]) {
            for (const ext of ['css', 'scss', 'sass', 'less']) {
                const candidate = path.join(componentDir, `${prefix}.${ext}`);
                if (fs.existsSync(candidate)) { existingFiles.css = candidate; break; }
            }
            if (existingFiles.css) break;
        }

        // Helper to fix templateUrl and styleUrl (reuse from create component)
        function fixComponentDecorator(tsContent) {
            if (!tsContent) return tsContent;

            // Detect actual html and css filenames from existing files
            const actualHtml = existingFiles.html ? path.basename(existingFiles.html) : null;
            const actualCss = existingFiles.css ? path.basename(existingFiles.css) : null;

            // Replace templateUrl value with actual generated html filename
            if (actualHtml) {
                tsContent = tsContent.replace(
                    /templateUrl\s*:\s*['"]([^'"]+)['"]/,
                    `templateUrl: './${actualHtml}'`
                );
            }

            // Replace styleUrl / styleUrls value with actual generated css filename
            if (actualCss) {
                // styleUrl: '...' (Angular 17+)
                tsContent = tsContent.replace(
                    /styleUrl\s*:\s*['"]([^'"]+)['"]/,
                    `styleUrl: './${actualCss}'`
                );
                // styleUrls: ['...'] (older style)
                tsContent = tsContent.replace(
                    /styleUrls\s*:\s*\[\s*['"]([^'"]+)['"]\s*\]/,
                    `styleUrls: ['./${actualCss}']`
                );
            }

            return tsContent;
        }

        const written = [];
        const errors = [];

        // Write TS file (only if provided and not null/undefined)
        if (ts !== undefined && ts !== null) {
            ts = fixComponentDecorator(ts);
            if (existingFiles.ts && fs.existsSync(existingFiles.ts)) {
                try {
                    fs.writeFileSync(existingFiles.ts, ts, 'utf8');
                    written.push(existingFiles.ts);
                } catch (e) {
                    errors.push({ file: existingFiles.ts, error: e.message });
                }
            } else {
                errors.push({ file: existingFiles.ts || `${kebab}.component.ts`, error: 'TS file not found' });
            }
        }

        // Write HTML file (only if provided and not null/undefined)
        if (html !== undefined && html !== null) {
            if (existingFiles.html && fs.existsSync(existingFiles.html)) {
                try {
                    fs.writeFileSync(existingFiles.html, html, 'utf8');
                    written.push(existingFiles.html);
                } catch (e) {
                    errors.push({ file: existingFiles.html, error: e.message });
                }
            } else {
                errors.push({ file: existingFiles.html || `${kebab}.component.html`, error: 'HTML file not found' });
            }
        }

        // Write CSS file (only if provided and not null/undefined)
        if (css !== undefined && css !== null) {
            if (existingFiles.css && fs.existsSync(existingFiles.css)) {
                try {
                    fs.writeFileSync(existingFiles.css, css, 'utf8');
                    written.push(existingFiles.css);
                } catch (e) {
                    errors.push({ file: existingFiles.css, error: e.message });
                }
            } else {
                errors.push({ file: existingFiles.css || `${kebab}.component.css`, error: 'CSS/SCSS file not found' });
            }
        }

        if (written.length === 0) {
            return respond(400, {
                error: 'No files provided to update (ts, html, css are all null/undefined)',
                componentDir
            });
        }

        return respond(200, {
            message: `Component '${safeName}' updated successfully`,
            componentDir,
            filesUpdated: written,
            filesNotUpdated: errors.length ? errors : undefined,
            logs: getLogs()
        });
    }

    /* -------- 3. GET LAST 20 LINES OF LOG (GET /logs) -------- */
    if (parsedUrl.pathname === '/logs' && req.method === 'GET') {
        try {
            if (!fs.existsSync(LOG_FILE_PATH)) {
                return respond(200, { logFile: LOG_FILE_PATH, lines: [] });
            }

            const content = fs.readFileSync(LOG_FILE_PATH, 'utf8');
            const lines = content.split(/\r?\n/).filter(l => l.trim() !== '');
            const last20 = lines.slice(-20);

            return respond(200, {
                logFile: LOG_FILE_PATH,
                totalLines: lines.length,
                lines: last20
            });
        } catch (e) {
            return respond(500, { error: e.message });
        }
    }

    /* -------- 4. GET ROUTES FILE CONTENT (GET /routes) -------- */
    if (parsedUrl.pathname === '/routes' && req.method === 'GET') {
        if (!ROUTES_FILE) {
            return respond(404, { error: 'Routes file not found in this project' });
        }

        try {
            const content = fs.readFileSync(ROUTES_FILE, 'utf8');
            return respond(200, {
                routesFile: ROUTES_FILE,
                content
            });
        } catch (e) {
            return respond(500, { error: e.message });
        }
    }

    /* -------- 5. ADD ROUTE (POST /routes) -------- */
    if (parsedUrl.pathname === '/routes' && req.method === 'POST') {
        if (!ROUTES_FILE) {
            return respond(404, { error: 'Routes file not found - cannot add route' });
        }

        let body;
        try {
            body = await readBody(req);
        } catch (e) {
            return respond(400, { error: e.message });
        }

        const { route, componentName } = body;

        if (!route || typeof route !== 'string' || !route.trim()) {
            return respond(400, { error: 'route is required (e.g. "about")' });
        }
        if (!componentName || typeof componentName !== 'string' || !componentName.trim()) {
            return respond(400, { error: 'componentName is required (e.g. "AboutComponent")' });
        }

        const cleanRoute = route.trim().replace(/^\//, '');
        const cleanComponent = componentName.trim();

        const result = addRouteToFile(cleanRoute, cleanComponent, null);

        if (result.error) {
            const status = result.error.includes('already exists') ? 409 : 500;
            return respond(status, { error: result.error });
        }

        return respond(200, {
            message: `Route '${cleanRoute}' mapped to '${cleanComponent}' added successfully`,
            routesFile: ROUTES_FILE,
            addedRoute: { path: cleanRoute, component: cleanComponent }
        });
    }

    /* -------- 404 -------- */
    return respond(404, { error: 'Not Found' });
});

server.listen(PORT, () => {
    console.log(`\nAngular Dev API Server running at http://localhost:${PORT}`);
    console.log('\nAvailable endpoints:');
    console.log('  GET  /health             - Server status');
    console.log('  POST /component/get      - Get component files (ts, html, css)');
    console.log('  POST /component          - Create Angular component');
    console.log('  POST /component/update   - Update Angular component (ts, html, css)');
    console.log('  GET  /logs               - Last 20 lines of Angular dev log');
    console.log('  GET  /routes             - Get routes file content');
    console.log('  POST /routes             - Add a new route');
});