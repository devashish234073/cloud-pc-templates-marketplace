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

/** Extract groupId from a pom.xml safely */
function parseGroupIdFromPom(pomPath) {
    try {
        const content = fs.readFileSync(pomPath, 'utf8');
        const header = content
            .replace(/<parent>[\s\S]*?<\/parent>/g, '')
            .replace(/<dependencies>[\s\S]*?<\/dependencies>/g, '')
            .replace(/<dependencyManagement>[\s\S]*?<\/dependencyManagement>/g, '')
            .replace(/<build>[\s\S]*?<\/build>/g, '');
        const match = header.match(/<groupId>([^<]+)<\/groupId>/);
        if (match) return match[1].trim();
        // Fallback to parent groupId if root has none defined directly
        const parentBlock = content.match(/<parent>([\s\S]*?)<\/parent>/);
        if (parentBlock) {
            const parentMatch = parentBlock[1].match(/<groupId>([^<]+)<\/groupId>/);
            if (parentMatch) return parentMatch[1].trim();
        }
        return 'unknown';
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
                return resolve({ ok: false, error: 'Java is not installed. Please install a Java JDK.' });
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

            if (isNaN(majorVersion)) {
                return resolve({ ok: false, error: 'Could not parse Java major version from ' + rawVersion });
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
async function checkRequirements(minJavaVersion = 11) {
    const java = await checkJava();
    if (!java.ok) return { ok: false, error: java.error };

    if (java.major < minJavaVersion) {
        return {
            ok: false,
            error: `Java version ${java.version} (major ${java.major}) is older than the required version ${minJavaVersion}. Please upgrade your Java JDK.`,
            javaVersion: java.version,
            javaMajor: java.major
        };
    }

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
    if (status >= 400) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status, ...data }, null, 2));
    } else {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data, null, 2));
    }
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
        const type = (block.match(/<type>([^<]+)<\/type>/) || [])[1] || null;
        const classifier = (block.match(/<classifier>([^<]+)<\/classifier>/) || [])[1] || null;
        const scope = (block.match(/<scope>([^<]+)<\/scope>/) || [])[1] || null;
        const optional = (block.match(/<optional>([^<]+)<\/optional>/) || [])[1] || null;
        deps.push({
            groupId: gid.trim(),
            artifactId: aid.trim(),
            version: ver.trim() || null,
            type: type ? type.trim() : null,
            classifier: classifier ? classifier.trim() : null,
            scope: scope ? scope.trim() : null,
            optional: optional ? optional.trim() === 'true' : null,
            rawXml: block.trim()
        });
    }
    return deps;
}

function findDependencyBlockRange(content, groupId, artifactId) {
    const depRegex = /<dependency>([\s\S]*?)<\/dependency>/g;
    let match;
    const gEsc = escapeRegex(groupId);
    const aEsc = escapeRegex(artifactId);
    const gRegex = new RegExp(`<groupId>\\s*${gEsc}\\s*</groupId>`);
    const aRegex = new RegExp(`<artifactId>\\s*${aEsc}\\s*</artifactId>`);
    
    while ((match = depRegex.exec(content)) !== null) {
        const block = match[1];
        if (gRegex.test(block) && aRegex.test(block)) {
            return {
                start: match.index,
                end: match.index + match[0].length,
                content: match[0]
            };
        }
    }
    return null;
}

function findPluginBlockRange(content, groupId, artifactId) {
    const pluginRegex = /<plugin>([\s\S]*?)<\/plugin>/g;
    let match;
    const gEsc = escapeRegex(groupId);
    const aEsc = escapeRegex(artifactId);
    const gRegex = new RegExp(`<groupId>\\s*${gEsc}\\s*</groupId>`);
    const aRegex = new RegExp(`<artifactId>\\s*${aEsc}\\s*</artifactId>`);
    
    while ((match = pluginRegex.exec(content)) !== null) {
        const block = match[1];
        const hasGroupId = gRegex.test(block) || (!block.includes('<groupId>') && groupId === 'org.apache.maven.plugins');
        if (hasGroupId && aRegex.test(block)) {
            return {
                start: match.index,
                end: match.index + match[0].length,
                content: match[0]
            };
        }
    }
    return null;
}

/**
 * Add a dependency to pom.xml.
 * If the dependency already exists (same groupId:artifactId), its version is updated.
 */
function addDependencyToPom(pomPath, groupId, artifactId, version, scope, options = {}) {
    let content = fs.readFileSync(pomPath, 'utf8');
    const dependency = { groupId, artifactId, version, scope, ...options };

    const depBlock = renderDependencyBlock(dependency, 4);

    // Check if dependency already exists using robust range matching
    const range = findDependencyBlockRange(content, groupId, artifactId);

    if (range) {
        // Replace existing
        content = content.slice(0, range.start) + depBlock + content.slice(range.end);
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

function xmlTag(name, value, indent) {
    if (value === undefined || value === null || value === '') return '';
    return `${' '.repeat(indent)}<${name}>${xmlEscape(value)}</${name}>\n`;
}

function renderXmlNode(name, value, indent) {
    const pad = ' '.repeat(indent);
    if (value === undefined || value === null) return '';
    if (Array.isArray(value)) {
        return value.map(item => renderXmlNode(name, item, indent)).join('');
    }
    if (typeof value === 'object') {
        const children = Object.entries(value)
            .map(([key, child]) => renderXmlNode(key, child, indent + 2))
            .join('');
        return `${pad}<${name}>\n${children}${pad}</${name}>\n`;
    }
    return `${pad}<${name}>${xmlEscape(value)}</${name}>\n`;
}

function renderDependencyBlock(dep, indent = 4) {
    if (dep.rawXml) return dep.rawXml.trim().split('\n').map(line => `${' '.repeat(indent)}${line}`).join('\n');
    let xml = `${' '.repeat(indent)}<dependency>\n`;
    xml += xmlTag('groupId', dep.groupId, indent + 2);
    xml += xmlTag('artifactId', dep.artifactId, indent + 2);
    xml += xmlTag('version', dep.version, indent + 2);
    xml += xmlTag('type', dep.type, indent + 2);
    xml += xmlTag('classifier', dep.classifier, indent + 2);
    xml += xmlTag('scope', dep.scope, indent + 2);
    if (dep.optional !== undefined && dep.optional !== null) xml += xmlTag('optional', dep.optional ? 'true' : 'false', indent + 2);
    if (Array.isArray(dep.exclusions) && dep.exclusions.length) {
        xml += `${' '.repeat(indent + 2)}<exclusions>\n`;
        for (const exclusion of dep.exclusions) {
            xml += `${' '.repeat(indent + 4)}<exclusion>\n`;
            xml += xmlTag('groupId', exclusion.groupId, indent + 6);
            xml += xmlTag('artifactId', exclusion.artifactId, indent + 6);
            xml += `${' '.repeat(indent + 4)}</exclusion>\n`;
        }
        xml += `${' '.repeat(indent + 2)}</exclusions>\n`;
    }
    xml += `${' '.repeat(indent)}</dependency>`;
    return xml;
}

function renderPluginBlock(plugin, indent = 6) {
    if (plugin.rawXml) return plugin.rawXml.trim().split('\n').map(line => `${' '.repeat(indent)}${line}`).join('\n');
    let xml = `${' '.repeat(indent)}<plugin>\n`;
    xml += xmlTag('groupId', plugin.groupId, indent + 2);
    xml += xmlTag('artifactId', plugin.artifactId, indent + 2);
    xml += xmlTag('version', plugin.version, indent + 2);
    if (plugin.extensions !== undefined && plugin.extensions !== null) xml += xmlTag('extensions', plugin.extensions ? 'true' : 'false', indent + 2);
    if (plugin.configurationXml) {
        xml += plugin.configurationXml.trim().split('\n').map(line => `${' '.repeat(indent + 2)}${line}`).join('\n') + '\n';
    } else if (plugin.configuration) {
        xml += renderXmlNode('configuration', plugin.configuration, indent + 2);
    }
    if (plugin.executionsXml) {
        xml += plugin.executionsXml.trim().split('\n').map(line => `${' '.repeat(indent + 2)}${line}`).join('\n') + '\n';
    } else if (Array.isArray(plugin.executions) && plugin.executions.length) {
        xml += `${' '.repeat(indent + 2)}<executions>\n`;
        for (const execution of plugin.executions) {
            xml += `${' '.repeat(indent + 4)}<execution>\n`;
            xml += xmlTag('id', execution.id, indent + 6);
            xml += xmlTag('phase', execution.phase, indent + 6);
            if (Array.isArray(execution.goals) && execution.goals.length) {
                xml += `${' '.repeat(indent + 6)}<goals>\n`;
                for (const goal of execution.goals) xml += xmlTag('goal', goal, indent + 8);
                xml += `${' '.repeat(indent + 6)}</goals>\n`;
            }
            if (execution.configurationXml) {
                xml += execution.configurationXml.trim().split('\n').map(line => `${' '.repeat(indent + 6)}${line}`).join('\n') + '\n';
            } else if (execution.configuration) {
                xml += renderXmlNode('configuration', execution.configuration, indent + 6);
            }
            xml += `${' '.repeat(indent + 4)}</execution>\n`;
        }
        xml += `${' '.repeat(indent + 2)}</executions>\n`;
    }
    xml += `${' '.repeat(indent)}</plugin>`;
    return xml;
}

function parseXmlSection(content, tagName) {
    const match = content.match(new RegExp(`<${tagName}>([\\s\\S]*?)</${tagName}>`));
    return match ? match[1].trim() : null;
}

function parseSimpleTags(block) {
    const obj = {};
    if (!block) return obj;
    const tagRegex = /<([A-Za-z0-9_.-]+)>([^<]*)<\/\1>/g;
    let match;
    while ((match = tagRegex.exec(block)) !== null) {
        obj[match[1]] = match[2].trim();
    }
    return obj;
}

function parsePlugins(pomPath) {
    const content = fs.readFileSync(pomPath, 'utf8');
    const plugins = [];
    const pluginRegex = /<plugin>\s*([\s\S]*?)\s*<\/plugin>/g;
    let match;
    while ((match = pluginRegex.exec(content)) !== null) {
        const block = match[1];
        plugins.push({
            groupId: ((block.match(/<groupId>([^<]+)<\/groupId>/) || [])[1] || '').trim() || null,
            artifactId: ((block.match(/<artifactId>([^<]+)<\/artifactId>/) || [])[1] || '').trim() || null,
            version: ((block.match(/<version>([^<]+)<\/version>/) || [])[1] || '').trim() || null,
            configurationXml: parseXmlSection(block, 'configuration'),
            executionsXml: parseXmlSection(block, 'executions'),
            rawXml: block.trim()
        });
    }
    return plugins;
}

function parsePomSummary(pomPath) {
    const content = fs.readFileSync(pomPath, 'utf8');
    const projectHeader = content
        .replace(/<parent>[\s\S]*?<\/parent>/g, '')
        .replace(/<dependencies>[\s\S]*?<\/dependencies>/g, '')
        .replace(/<dependencyManagement>[\s\S]*?<\/dependencyManagement>/g, '')
        .replace(/<build>[\s\S]*?<\/build>/g, '');
    const parentBlock = parseXmlSection(content, 'parent');
    return {
        modelVersion: ((content.match(/<modelVersion>([^<]+)<\/modelVersion>/) || [])[1] || '').trim() || null,
        groupId: ((projectHeader.match(/<groupId>([^<]+)<\/groupId>/) || [])[1] || '').trim() || null,
        artifactId: ((projectHeader.match(/<artifactId>([^<]+)<\/artifactId>/) || [])[1] || '').trim() || null,
        version: ((projectHeader.match(/<version>([^<]+)<\/version>/) || [])[1] || '').trim() || null,
        packaging: ((content.match(/<packaging>([^<]+)<\/packaging>/) || [])[1] || '').trim() || null,
        name: ((content.match(/<name>([^<]+)<\/name>/) || [])[1] || '').trim() || null,
        description: ((content.match(/<description>([^<]+)<\/description>/) || [])[1] || '').trim() || null,
        parent: parentBlock ? parseSimpleTags(parentBlock) : null,
        properties: parseSimpleTags(parseXmlSection(content, 'properties')),
        dependencies: parseDependencies(pomPath),
        plugins: parsePlugins(pomPath)
    };
}

function upsertPropertiesInPom(pomPath, properties) {
    let content = fs.readFileSync(pomPath, 'utf8');
    let propsBlock = parseXmlSection(content, 'properties');
    if (propsBlock === null) {
        const rendered = `  <properties>\n${Object.entries(properties).map(([key, value]) => xmlTag(key, value, 4)).join('')}  </properties>\n`;
        if (content.includes('</parent>')) {
            content = content.replace('</parent>', '</parent>\n\n' + rendered);
        } else if (content.includes('</version>')) {
            content = content.replace('</version>', '</version>\n\n' + rendered);
        } else if (content.includes('</project>')) {
            content = content.replace('</project>', rendered + '\n</project>');
        }
    } else {
        for (const [key, value] of Object.entries(properties)) {
            const tagRegex = new RegExp(`<${escapeRegex(key)}>\\s*[\\s\\S]*?\\s*</${escapeRegex(key)}>`);
            const tag = xmlTag(key, value, 4).trim();
            if (tagRegex.test(propsBlock)) {
                propsBlock = propsBlock.replace(tagRegex, tag);
            } else {
                propsBlock += `\n${tag}`;
            }
        }
        content = content.replace(/<properties>[\s\S]*?<\/properties>/, `<properties>\n${propsBlock.trim()}\n  </properties>`);
    }
    fs.writeFileSync(pomPath, content, 'utf8');
}

function upsertParentInPom(pomPath, parent) {
    let content = fs.readFileSync(pomPath, 'utf8');
    const parentBlock = `  <parent>\n${xmlTag('groupId', parent.groupId, 4)}${xmlTag('artifactId', parent.artifactId, 4)}${xmlTag('version', parent.version, 4)}${xmlTag('relativePath', parent.relativePath, 4)}  </parent>`;
    if (content.match(/<parent>[\s\S]*?<\/parent>/)) {
        content = content.replace(/<parent>[\s\S]*?<\/parent>/, parentBlock.trim());
    } else if (content.includes('</modelVersion>')) {
        content = content.replace('</modelVersion>', `</modelVersion>\n\n${parentBlock}`);
    } else if (content.includes('<project')) {
        content = content.replace(/(<project[^>]*>)/, `$1\n${parentBlock}`);
    } else {
        return { error: 'Could not find insertion point in pom.xml' };
    }
    fs.writeFileSync(pomPath, content, 'utf8');
    return { action: 'updated', parent };
}

function upsertPluginInPom(pomPath, plugin) {
    let content = fs.readFileSync(pomPath, 'utf8');
    const groupId = plugin.groupId || 'org.apache.maven.plugins';
    const artifactId = plugin.artifactId;
    if (!artifactId && !plugin.rawXml) return { error: 'Provide plugin artifactId or rawXml' };
    const block = renderPluginBlock({ ...plugin, groupId }, 6);

    const range = findPluginBlockRange(content, groupId, artifactId);

    if (artifactId && range) {
        content = content.slice(0, range.start) + block + content.slice(range.end);
        fs.writeFileSync(pomPath, content, 'utf8');
        return { action: 'updated', groupId, artifactId };
    }

    if (content.includes('</plugins>')) {
        content = content.replace('</plugins>', `${block}\n    </plugins>`);
    } else if (content.includes('</build>')) {
        content = content.replace('</build>', `    <plugins>\n${block}\n    </plugins>\n  </build>`);
    } else if (content.includes('</project>')) {
        content = content.replace('</project>', `  <build>\n    <plugins>\n${block}\n    </plugins>\n  </build>\n</project>`);
    } else {
        return { error: 'Could not find insertion point in pom.xml' };
    }

    fs.writeFileSync(pomPath, content, 'utf8');
    return { action: 'added', groupId, artifactId };
}

function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/* ================================================================
   SPRING BOOT APP SCAFFOLDING HELPERS
   ================================================================ */

function xmlEscape(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

function toPascalCase(value) {
    return String(value || '')
        .replace(/[^a-zA-Z0-9]+/g, ' ')
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .map(part => part.charAt(0).toUpperCase() + part.slice(1))
        .join('');
}

function toCamelCase(value) {
    const pascal = toPascalCase(value);
    return pascal ? pascal.charAt(0).toLowerCase() + pascal.slice(1) : '';
}

function toKebabCase(value) {
    return String(value || '')
        .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
        .replace(/[^a-zA-Z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .toLowerCase();
}

function pluralizeKebab(value) {
    const kebab = toKebabCase(value);
    if (!kebab) return '';
    return kebab.endsWith('s') ? kebab : `${kebab}s`;
}

function isValidJavaIdentifier(value) {
    return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value);
}

function isValidPackageName(value) {
    return /^[a-zA-Z_$][a-zA-Z0-9_$]*(\.[a-zA-Z_$][a-zA-Z0-9_$]*)*$/.test(value);
}

function sanitizePackageName(value) {
    const cleaned = String(value || 'com.example.demo')
        .toLowerCase()
        .replace(/[^a-z0-9_.]+/g, '.')
        .replace(/\.+/g, '.')
        .replace(/^\.+|\.+$/g, '');
    const parts = cleaned.split('.')
        .filter(Boolean)
        .map(part => /^[a-z_$]/.test(part) ? part : `app${part}`);
    const pkg = parts.join('.') || 'com.example.demo';
    return isValidPackageName(pkg) ? pkg : 'com.example.demo';
}

function javaPackageDir(projectPath, packageName, suffix = '') {
    const packagePath = packageName.replace(/\./g, path.sep);
    return path.join(projectPath, 'src', 'main', 'java', packagePath, suffix);
}

function javaTestPackageDir(projectPath, packageName) {
    return path.join(projectPath, 'src', 'test', 'java', packageName.replace(/\./g, path.sep));
}

function writeTextFile(filePath, content) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
    return filePath;
}

function normalizeDependencies(dependencies) {
    if (!Array.isArray(dependencies)) return [];
    return dependencies.map(dep => {
        if (typeof dep === 'string') {
            const parts = dep.split(':');
            return { groupId: parts[0], artifactId: parts[1], version: parts[2], scope: parts[3] };
        }
        return dep;
    }).filter(dep => dep && (dep.rawXml || (dep.groupId && dep.artifactId)));
}

function normalizePlugins(plugins) {
    if (!Array.isArray(plugins)) return [];
    return plugins.filter(plugin => plugin && (plugin.rawXml || plugin.artifactId));
}

function renderPropertiesBlock(properties) {
    const entries = Object.entries(properties || {});
    if (!entries.length) return '';
    return `\n  <properties>\n${entries.map(([key, value]) => xmlTag(key, value, 4)).join('')}  </properties>\n`;
}

function renderSpringPom({ groupId, artifactId, version, packaging, appName, description, parent, properties, dependencies, plugins }) {
    const dependencyXml = normalizeDependencies(dependencies).map(dep => renderDependencyBlock(dep, 4)).join('\n');
    const pluginXml = normalizePlugins(plugins).map(plugin => renderPluginBlock(plugin, 6)).join('\n');
    const parentXml = parent ? `\n  <parent>\n${xmlTag('groupId', parent.groupId, 4)}${xmlTag('artifactId', parent.artifactId, 4)}${xmlTag('version', parent.version, 4)}${xmlTag('relativePath', parent.relativePath, 4)}  </parent>\n` : '';
    const buildXml = pluginXml ? `\n  <build>\n    <plugins>\n${pluginXml}\n    </plugins>\n  </build>\n` : '';
    return `<?xml version="1.0" encoding="UTF-8"?>\n<project xmlns="http://maven.apache.org/POM/4.0.0"\n         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"\n         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd">\n  <modelVersion>4.0.0</modelVersion>\n${parentXml}\n  <groupId>${xmlEscape(groupId)}</groupId>\n  <artifactId>${xmlEscape(artifactId)}</artifactId>\n  <version>${xmlEscape(version)}</version>\n${packaging ? `  <packaging>${xmlEscape(packaging)}</packaging>\n` : ''}  <name>${xmlEscape(appName)}</name>\n  <description>${xmlEscape(description || 'Generated Maven application')}</description>\n${renderPropertiesBlock(properties)}\n  <dependencies>\n${dependencyXml}\n  </dependencies>\n${buildXml}</project>\n`;
}

function renderApplicationProperties(properties) {
    if (typeof properties === 'string') return properties.endsWith('\n') ? properties : `${properties}\n`;
    return `${Object.entries(properties || {}).map(([key, value]) => `${key}=${value}`).join('\n')}\n`;
}

function normalizeFields(fields) {
    const source = Array.isArray(fields) && fields.length
        ? fields
        : [
            { name: 'name', type: 'String', required: true },
            { name: 'description', type: 'String' }
        ];

    const normalized = [];
    for (const field of source) {
        const name = toCamelCase(field.name);
        const type = String(field.type || 'String').trim();
        if (!isValidJavaIdentifier(name)) {
            throw new Error(`Invalid field name '${field.name}'`);
        }
        if (!/^[A-Za-z_$][A-Za-z0-9_$.<>?, ]*$/.test(type)) {
            throw new Error(`Invalid Java type '${field.type}' for field '${field.name}'`);
        }
        if (name === 'id') continue;
        normalized.push({
            name,
            type,
            required: Boolean(field.required),
            unique: Boolean(field.unique)
        });
    }
    return normalized;
}

function importsForTypes(fields) {
    const imports = new Set();
    for (const field of fields) {
        if (field.type.includes('BigDecimal')) imports.add('java.math.BigDecimal');
        if (field.type.includes('LocalDateTime')) imports.add('java.time.LocalDateTime');
        if (field.type.includes('LocalDate')) imports.add('java.time.LocalDate');
        if (field.type.includes('UUID')) imports.add('java.util.UUID');
    }
    return [...imports].sort();
}

function renderFieldAccessors(fields) {
    return fields.map(field => {
        const method = toPascalCase(field.name);
        return `\n    public ${field.type} get${method}() {\n        return ${field.name};\n    }\n\n    public void set${method}(${field.type} ${field.name}) {\n        this.${field.name} = ${field.name};\n    }`;
    }).join('\n');
}

function renderEntity(packageName, entityName, fields) {
    const imports = [
        'jakarta.persistence.Column',
        'jakarta.persistence.Entity',
        'jakarta.persistence.GeneratedValue',
        'jakarta.persistence.GenerationType',
        'jakarta.persistence.Id',
        'jakarta.persistence.Table',
        ...importsForTypes(fields)
    ].map(i => `import ${i};`).join('\n');
    const tableName = toKebabCase(entityName).replace(/-/g, '_');
    const declarations = fields.map(field => {
        const columnOptions = [];
        if (field.required) columnOptions.push('nullable = false');
        if (field.unique) columnOptions.push('unique = true');
        const column = columnOptions.length ? `\n    @Column(${columnOptions.join(', ')})` : '';
        return `${column}\n    private ${field.type} ${field.name};`;
    }).join('\n\n');

    return `package ${packageName}.entity;\n\n${imports}\n\n@Entity\n@Table(name = "${tableName}")\npublic class ${entityName} {\n\n    @Id\n    @GeneratedValue(strategy = GenerationType.IDENTITY)\n    private Long id;\n\n${declarations}\n\n    public Long getId() {\n        return id;\n    }\n\n    public void setId(Long id) {\n        this.id = id;\n    }\n${renderFieldAccessors(fields)}\n}\n`;
}

function renderRequestDto(packageName, entityName, fields) {
    const validationImport = fields.some(f => f.required)
        ? 'import jakarta.validation.constraints.NotBlank;\nimport jakarta.validation.constraints.NotNull;\n'
        : '';
    const typeImports = importsForTypes(fields).map(i => `import ${i};\n`).join('');
    const declarations = fields.map(field => {
        let annotation = '';
        if (field.required) annotation = field.type === 'String' ? '    @NotBlank\n' : '    @NotNull\n';
        return `${annotation}    private ${field.type} ${field.name};`;
    }).join('\n\n');

    return `package ${packageName}.dto;\n\n${validationImport}${typeImports}\npublic class ${entityName}Request {\n\n${declarations}\n${renderFieldAccessors(fields)}\n}\n`;
}

function renderResponseDto(packageName, entityName, fields) {
    const typeImports = importsForTypes(fields).map(i => `import ${i};\n`).join('');
    const declarations = fields.map(field => `    private ${field.type} ${field.name};`).join('\n\n');
    return `package ${packageName}.dto;\n\n${typeImports}\npublic class ${entityName}Response {\n\n    private Long id;\n\n${declarations}\n\n    public Long getId() {\n        return id;\n    }\n\n    public void setId(Long id) {\n        this.id = id;\n    }\n${renderFieldAccessors(fields)}\n}\n`;
}

function renderRepository(packageName, entityName) {
    return `package ${packageName}.repository;\n\nimport ${packageName}.entity.${entityName};\nimport org.springframework.data.jpa.repository.JpaRepository;\n\npublic interface ${entityName}Repository extends JpaRepository<${entityName}, Long> {\n}\n`;
}

function renderService(packageName, entityName, fields) {
    const varName = toCamelCase(entityName);
    const fieldAssignments = fields.map(field => `        ${varName}.set${toPascalCase(field.name)}(request.get${toPascalCase(field.name)}());`).join('\n');
    const responseAssignments = fields.map(field => `        response.set${toPascalCase(field.name)}(${varName}.get${toPascalCase(field.name)}());`).join('\n');
    return `package ${packageName}.service;\n\nimport ${packageName}.dto.${entityName}Request;\nimport ${packageName}.dto.${entityName}Response;\nimport ${packageName}.entity.${entityName};\nimport ${packageName}.repository.${entityName}Repository;\nimport java.util.List;\nimport org.springframework.http.HttpStatus;\nimport org.springframework.stereotype.Service;\nimport org.springframework.transaction.annotation.Transactional;\nimport org.springframework.web.server.ResponseStatusException;\n\n@Service\n@Transactional\npublic class ${entityName}Service {\n\n    private final ${entityName}Repository repository;\n\n    public ${entityName}Service(${entityName}Repository repository) {\n        this.repository = repository;\n    }\n\n    @Transactional(readOnly = true)\n    public List<${entityName}Response> findAll() {\n        return repository.findAll().stream().map(this::toResponse).toList();\n    }\n\n    @Transactional(readOnly = true)\n    public ${entityName}Response findById(Long id) {\n        return toResponse(findEntity(id));\n    }\n\n    public ${entityName}Response create(${entityName}Request request) {\n        ${entityName} ${varName} = new ${entityName}();\n${fieldAssignments}\n        return toResponse(repository.save(${varName}));\n    }\n\n    public ${entityName}Response update(Long id, ${entityName}Request request) {\n        ${entityName} ${varName} = findEntity(id);\n${fieldAssignments}\n        return toResponse(repository.save(${varName}));\n    }\n\n    public void delete(Long id) {\n        ${entityName} ${varName} = findEntity(id);\n        repository.delete(${varName});\n    }\n\n    private ${entityName} findEntity(Long id) {\n        return repository.findById(id)\n            .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "${entityName} not found"));\n    }\n\n    private ${entityName}Response toResponse(${entityName} ${varName}) {\n        ${entityName}Response response = new ${entityName}Response();\n        response.setId(${varName}.getId());\n${responseAssignments}\n        return response;\n    }\n}\n`;
}

function renderController(packageName, entityName, resourcePath) {
    return `package ${packageName}.controller;\n\nimport ${packageName}.dto.${entityName}Request;\nimport ${packageName}.dto.${entityName}Response;\nimport ${packageName}.service.${entityName}Service;\nimport jakarta.validation.Valid;\nimport java.net.URI;\nimport java.util.List;\nimport org.springframework.http.ResponseEntity;\nimport org.springframework.web.bind.annotation.DeleteMapping;\nimport org.springframework.web.bind.annotation.GetMapping;\nimport org.springframework.web.bind.annotation.PathVariable;\nimport org.springframework.web.bind.annotation.PostMapping;\nimport org.springframework.web.bind.annotation.PutMapping;\nimport org.springframework.web.bind.annotation.RequestBody;\nimport org.springframework.web.bind.annotation.RequestMapping;\nimport org.springframework.web.bind.annotation.RestController;\n\n@RestController\n@RequestMapping("/api/${resourcePath}")\npublic class ${entityName}Controller {\n\n    private final ${entityName}Service service;\n\n    public ${entityName}Controller(${entityName}Service service) {\n        this.service = service;\n    }\n\n    @GetMapping\n    public List<${entityName}Response> findAll() {\n        return service.findAll();\n    }\n\n    @GetMapping("/{id}")\n    public ${entityName}Response findById(@PathVariable Long id) {\n        return service.findById(id);\n    }\n\n    @PostMapping\n    public ResponseEntity<${entityName}Response> create(@Valid @RequestBody ${entityName}Request request) {\n        ${entityName}Response created = service.create(request);\n        return ResponseEntity.created(URI.create("/api/${resourcePath}/" + created.getId())).body(created);\n    }\n\n    @PutMapping("/{id}")\n    public ${entityName}Response update(@PathVariable Long id, @Valid @RequestBody ${entityName}Request request) {\n        return service.update(id, request);\n    }\n\n    @DeleteMapping("/{id}")\n    public ResponseEntity<Void> delete(@PathVariable Long id) {\n        service.delete(id);\n        return ResponseEntity.noContent().build();\n    }\n}\n`;
}

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
            version: '3.0',
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

        const targetJava = parseInt(javaVersion, 10) || 17;
        // Requirement check using the dynamic javaVersion requested
        const reqs = await checkRequirements(targetJava);
        if (!reqs.ok) return send(res, 500, { error: reqs.error });

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

    /* ── POST /spring/create – Create a full Spring Boot Maven app ─
       Body: {
         groupId: "com.example",
         artifactId: "inventory-api",
         packageName?: "com.example.inventory",
         appName?: "InventoryApi",
         version?: "0.0.1-SNAPSHOT",
         parent?: { groupId, artifactId, version, relativePath? },
         properties?: { "java.version": "17" },
         dependencies?: [{ groupId, artifactId, version?, scope? }],
         plugins?: [{ groupId?, artifactId, version?, configuration?, executions? }],
         applicationProperties?: { "server.port": "8080" } | "raw=file"
       }
       ─────────────────────────────────────────────────────────── */
    if (pathname === '/spring/create' && req.method === 'POST') {
        let body;
        try { body = await readBody(req); } catch { return err400(res, 'Invalid JSON body'); }

        const {
            groupId,
            artifactId,
            version = '0.0.1-SNAPSHOT',
            packaging,
            properties = {},
            dependencies,
            plugins,
            applicationProperties = {}
        } = body;

        // Default parent to spring-boot-starter-parent if omitted
        const parent = body.parent || {
            groupId: 'org.springframework.boot',
            artifactId: 'spring-boot-starter-parent',
            version: '3.3.5',
            relativePath: ''
        };

        // Determine minJavaVersion requirement dynamically
        const parentVersion = parent && parent.version ? String(parent.version) : '';
        const isSpringBoot3 = parentVersion.startsWith('3.');
        const targetJava = properties && properties['java.version'] ? parseInt(properties['java.version'], 10) : (isSpringBoot3 ? 17 : 11);

        const reqs = await checkRequirements(targetJava);
        if (!reqs.ok) return send(res, 500, { error: reqs.error });

        if (!groupId || !artifactId) return err400(res, 'Provide { groupId, artifactId } in body');
        if (!/^[A-Za-z0-9_.-]+$/.test(artifactId)) return err400(res, 'artifactId may contain only letters, numbers, dot, underscore, and hyphen');
        if (projects.has(artifactId)) {
            return send(res, 409, { error: `Project '${artifactId}' already exists`, path: projects.get(artifactId).path });
        }

        const projectPath = path.join(BASE_DIR, artifactId);
        if (fs.existsSync(projectPath)) {
            return send(res, 409, { error: `Directory '${artifactId}' already exists on disk`, path: projectPath });
        }

        // Validate Spring Boot configuration
        const normalizedDependencies = normalizeDependencies(dependencies);
        const hasParent = !!parent;
        const hasSpringBootDeps = normalizedDependencies.some(dep => 
            (dep.groupId === 'org.springframework.boot' || dep.groupId.includes('springframework.boot')) &&
            !dep.artifactId.includes('starter-test')
        );

        // Warn if Spring Boot dependencies exist without parent/version management
        let validationWarnings = [];
        if (hasSpringBootDeps) {
            if (!hasParent) {
                validationWarnings.push('WARNING: Spring Boot dependencies detected without parent/BOM. Consider adding spring-boot-starter-parent as parent or using spring-boot-dependencies BOM.');
            }
            const depsWithoutVersions = normalizedDependencies.filter(dep => 
                (dep.groupId === 'org.springframework.boot' || dep.groupId.includes('springframework.boot')) &&
                !dep.version
            );
            if (depsWithoutVersions.length > 0) {
                validationWarnings.push(`WARNING: ${depsWithoutVersions.length} Spring Boot dependencies have no explicit versions. Parent/BOM should manage them.`);
            }
        }

        const packageName = sanitizePackageName(body.packageName || `${groupId}.${artifactId}`);
        const appName = toPascalCase(body.appName || artifactId) || 'Application';
        const applicationClass = appName.endsWith('Application') ? appName : `${appName}Application`;
        const normalizedPlugins = normalizePlugins(plugins);

        try {
            fs.mkdirSync(projectPath, { recursive: true });

            const files = [];
            files.push(writeTextFile(
                path.join(projectPath, 'pom.xml'),
                renderSpringPom({
                    groupId,
                    artifactId,
                    version,
                    packaging,
                    appName,
                    description: body.description,
                    parent,
                    properties,
                    dependencies: normalizedDependencies,
                    plugins: normalizedPlugins
                })
            ));

            files.push(writeTextFile(
                path.join(javaPackageDir(projectPath, packageName), `${applicationClass}.java`),
                `package ${packageName};\n\nimport org.springframework.boot.SpringApplication;\nimport org.springframework.boot.autoconfigure.SpringBootApplication;\n\n@SpringBootApplication\npublic class ${applicationClass} {\n\n    public static void main(String[] args) {\n        SpringApplication.run(${applicationClass}.class, args);\n    }\n}\n`
            ));

            files.push(writeTextFile(
                path.join(javaPackageDir(projectPath, packageName, 'controller'), 'HealthController.java'),
                `package ${packageName}.controller;\n\nimport java.util.Map;\nimport org.springframework.web.bind.annotation.GetMapping;\nimport org.springframework.web.bind.annotation.RestController;\n\n@RestController\npublic class HealthController {\n\n    @GetMapping("/api/health")\n    public Map<String, String> health() {\n        return Map.of("status", "UP");\n    }\n}\n`
            ));

            files.push(writeTextFile(
                path.join(projectPath, 'src', 'main', 'resources', 'application.properties'),
                renderApplicationProperties(applicationProperties)
            ));

            files.push(writeTextFile(
                path.join(javaTestPackageDir(projectPath, packageName), `${applicationClass}Tests.java`),
                `package ${packageName};\n\nimport org.junit.jupiter.api.Test;\nimport org.springframework.boot.test.context.SpringBootTest;\n\n@SpringBootTest\nclass ${applicationClass}Tests {\n\n    @Test\n    void contextLoads() {\n    }\n}\n`
            ));

            files.push(writeTextFile(
                path.join(projectPath, '.gitignore'),
                `target/\n.mvn/wrapper/maven-wrapper.jar\n*.log\n.idea/\n*.iml\n.vscode/\n.DS_Store\n`
            ));

            files.push(writeTextFile(
                path.join(projectPath, 'README.md'),
                `# ${appName}\n\nGenerated Spring Boot Maven application.\n\n## Run\n\n\`\`\`bash\nmvn spring-boot:run\n\`\`\`\n\n## Build\n\n\`\`\`bash\nmvn package\n\`\`\`\n\nHealth endpoint: \`GET /api/health\`\n`
            ));

            projects.set(artifactId, {
                name: artifactId,
                path: projectPath,
                groupId,
                artifactId,
                packageName,
                type: 'spring-boot',
                createdAt: new Date().toISOString()
            });
            saveProjects();

            return send(res, 200, {
                message: `Spring Boot project '${artifactId}' created successfully`,
                project: projects.get(artifactId),
                applicationClass: `${packageName}.${applicationClass}`,
                dependencies: normalizedDependencies,
                plugins: normalizedPlugins,
                files,
                validationWarnings: validationWarnings.length > 0 ? validationWarnings : undefined
            });
        } catch (e) {
            return err500(res, `Spring Boot project creation failed: ${e.message}`);
        }
    }

    /* ── POST /spring/crud – Generate a CRUD resource ───────────
       Query: ?projectName=inventory-api
       Body: {
         resourceName: "Product",
         packageName?: "com.example.inventory",
         path?: "products",
         fields?: [
           { name: "name", type: "String", required: true },
           { name: "price", type: "BigDecimal", required: true }
         ]
       }
       ─────────────────────────────────────────────────────────── */
    if (pathname === '/spring/crud' && req.method === 'POST') {
        const reqs = await checkRequirements();
        if (!reqs.ok) return send(res, 500, { error: reqs.error });

        const { projectName } = query;
        if (!projectName) return err400(res, 'Provide ?projectName=<name>');
        if (!projects.has(projectName)) {
            return send(res, 404, { error: 'Project does not exist. Create the project first.', projectName });
        }

        let body;
        try { body = await readBody(req); } catch { return err400(res, 'Invalid JSON body'); }

        const entityName = toPascalCase(body.resourceName);
        if (!entityName || !isValidJavaIdentifier(entityName)) {
            return err400(res, 'Provide a valid { resourceName } such as "Product"');
        }

        const project = projects.get(projectName);
        const packageName = sanitizePackageName(body.packageName || project.packageName || project.groupId || 'com.example.demo');
        const resourcePath = body.path ? toKebabCase(body.path) : pluralizeKebab(entityName);
        if (!resourcePath) return err400(res, 'Could not determine REST path for resource');

        let fields;
        try { fields = normalizeFields(body.fields); } catch (e) { return err400(res, e.message); }

        const files = [
            {
                file: path.join(javaPackageDir(project.path, packageName, 'entity'), `${entityName}.java`),
                content: renderEntity(packageName, entityName, fields)
            },
            {
                file: path.join(javaPackageDir(project.path, packageName, 'dto'), `${entityName}Request.java`),
                content: renderRequestDto(packageName, entityName, fields)
            },
            {
                file: path.join(javaPackageDir(project.path, packageName, 'dto'), `${entityName}Response.java`),
                content: renderResponseDto(packageName, entityName, fields)
            },
            {
                file: path.join(javaPackageDir(project.path, packageName, 'repository'), `${entityName}Repository.java`),
                content: renderRepository(packageName, entityName)
            },
            {
                file: path.join(javaPackageDir(project.path, packageName, 'service'), `${entityName}Service.java`),
                content: renderService(packageName, entityName, fields)
            },
            {
                file: path.join(javaPackageDir(project.path, packageName, 'controller'), `${entityName}Controller.java`),
                content: renderController(packageName, entityName, resourcePath)
            }
        ];

        try {
            const written = files.map(({ file, content }) => {
                const overwritten = fs.existsSync(file);
                writeTextFile(file, content);
                return { file, overwritten };
            });

            return send(res, 200, {
                message: `CRUD resource '${entityName}' generated successfully`,
                projectName,
                packageName,
                resourceName: entityName,
                endpoints: [
                    `GET    /api/${resourcePath}`,
                    `GET    /api/${resourcePath}/{id}`,
                    `POST   /api/${resourcePath}`,
                    `PUT    /api/${resourcePath}/{id}`,
                    `DELETE /api/${resourcePath}/{id}`
                ],
                fields,
                files: written
            });
        } catch (e) {
            return err500(res, `CRUD resource generation failed: ${e.message}`);
        }
    }

    /* ── GET /maven/pom – Read pom.xml summary ────────────────
       Query: ?projectName=my-app&raw=true
       ─────────────────────────────────────────────────────────── */
    if (pathname === '/maven/pom' && req.method === 'GET') {
        const { projectName, raw } = query;
        if (!projectName) return err400(res, 'Provide ?projectName=<name>');
        if (!projects.has(projectName)) {
            return send(res, 404, { error: 'Project does not exist. Create the project first.', projectName });
        }

        const project = projects.get(projectName);
        const pomPath = path.join(project.path, 'pom.xml');
        if (!fs.existsSync(pomPath)) return err404(res, `pom.xml not found in project '${projectName}'`);

        try {
            return send(res, 200, {
                projectName,
                pomPath,
                summary: parsePomSummary(pomPath),
                rawXml: raw === 'true' || raw === '1' ? fs.readFileSync(pomPath, 'utf8') : undefined
            });
        } catch (e) {
            return err500(res, `Failed to read pom.xml: ${e.message}`);
        }
    }

    /* ── PUT /maven/properties – Add/update pom properties ─────
       Query: ?projectName=my-app
       Body: { properties: { "java.version": "17" } }
       ─────────────────────────────────────────────────────────── */
    if (pathname === '/maven/properties' && req.method === 'PUT') {
        const { projectName } = query;
        if (!projectName) return err400(res, 'Provide ?projectName=<name>');
        if (!projects.has(projectName)) {
            return send(res, 404, { error: 'Project does not exist. Create the project first.', projectName });
        }

        let body;
        try { body = await readBody(req); } catch { return err400(res, 'Invalid JSON body'); }
        const properties = body.properties || body;
        if (!properties || typeof properties !== 'object' || Array.isArray(properties)) {
            return err400(res, 'Provide { properties: { key: value } } in body');
        }

        const project = projects.get(projectName);
        const pomPath = path.join(project.path, 'pom.xml');
        if (!fs.existsSync(pomPath)) return err404(res, `pom.xml not found in project '${projectName}'`);

        try {
            upsertPropertiesInPom(pomPath, properties);
            return send(res, 200, {
                message: 'POM properties updated',
                projectName,
                properties: parsePomSummary(pomPath).properties
            });
        } catch (e) {
            return err500(res, `Failed to update POM properties: ${e.message}`);
        }
    }

    /* ── PUT /maven/parent – Add/update pom parent ─────────────
       Query: ?projectName=my-app
       Body: { groupId, artifactId, version, relativePath? }
       ─────────────────────────────────────────────────────────── */
    if (pathname === '/maven/parent' && req.method === 'PUT') {
        const { projectName } = query;
        if (!projectName) return err400(res, 'Provide ?projectName=<name>');
        if (!projects.has(projectName)) {
            return send(res, 404, { error: 'Project does not exist. Create the project first.', projectName });
        }

        let body;
        try { body = await readBody(req); } catch { return err400(res, 'Invalid JSON body'); }
        if (!body.groupId || !body.artifactId || !body.version) {
            return err400(res, 'Provide { groupId, artifactId, version, relativePath? } in body');
        }

        const project = projects.get(projectName);
        const pomPath = path.join(project.path, 'pom.xml');
        if (!fs.existsSync(pomPath)) return err404(res, `pom.xml not found in project '${projectName}'`);

        try {
            const result = upsertParentInPom(pomPath, body);
            if (result.error) return err500(res, result.error);
            return send(res, 200, {
                message: 'POM parent updated',
                projectName,
                parent: parsePomSummary(pomPath).parent
            });
        } catch (e) {
            return err500(res, `Failed to update POM parent: ${e.message}`);
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

    /* ── PATCH /maven/class – Patch/edit a Java class ──────────
       Query: ?projectName=my-app&packageName=com.example.service&className=UserService
       Body: {
         targetContent?: "...",
         replacementContent?: "...",
         replacements?: [{ targetContent, replacementContent }]
       }
       ─────────────────────────────────────────────────────────── */
    if (pathname === '/maven/class' && req.method === 'PATCH') {
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

        const project = projects.get(projectName);
        const packagePath = packageName.replace(/\./g, path.sep);
        const classDir = path.join(project.path, 'src', 'main', 'java', packagePath);
        const classFile = path.join(classDir, `${className}.java`);

        if (!fs.existsSync(classFile)) {
            return err404(res, `Class file '${className}.java' does not exist in package '${packageName}' of project '${projectName}'. Create it first with POST.`);
        }

        let code = fs.readFileSync(classFile, 'utf8');

        // Extract list of replacements
        let replacementsList = [];
        if (body.targetContent !== undefined && body.replacementContent !== undefined) {
            replacementsList.push({ targetContent: body.targetContent, replacementContent: body.replacementContent });
        } else if (Array.isArray(body.replacements)) {
            replacementsList = body.replacements;
        }

        if (replacementsList.length === 0) {
            return err400(res, 'Provide either { targetContent, replacementContent } or { replacements: [...] } in body');
        }

        // Apply replacements
        for (let i = 0; i < replacementsList.length; i++) {
            const { targetContent, replacementContent } = replacementsList[i];
            if (targetContent === undefined || replacementContent === undefined) {
                return err400(res, `Replacement at index ${i} is missing targetContent or replacementContent`);
            }

            // Find occurrence count of targetContent
            const occurrences = code.split(targetContent).length - 1;
            if (occurrences === 0) {
                return err400(res, `Target content not found in file: "${targetContent.substring(0, 100)}..."`);
            }
            if (occurrences > 1) {
                return err400(res, `Target content is not unique (found ${occurrences} occurrences): "${targetContent.substring(0, 100)}..."`);
            }

            code = code.replace(targetContent, replacementContent);
        }

        try {
            fs.writeFileSync(classFile, code, 'utf8');
            return send(res, 200, {
                message: `Class '${className}' patched successfully`,
                classFile,
                packageName,
                className,
                projectName,
                replacementsApplied: replacementsList.length
            });
        } catch (e) {
            return err500(res, `Failed to write patched class file: ${e.message}`);
        }
    }

    /* ── POST /maven/dependency – Add dependency to pom.xml ───
       Query: ?projectName=my-app
       Body: {
         groupId: "org.springframework.boot",
         artifactId: "spring-boot-starter-web",
         version?: "3.2.0",
         type?: "jar",
         classifier?: "...",
         scope?: "compile",
         optional?: false,
         exclusions?: [{ groupId, artifactId }]
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

        const { groupId, artifactId, version, type, classifier, scope, optional, exclusions, rawXml } = body;
        if (!groupId || !artifactId) {
            return err400(res, 'Provide { groupId, artifactId } in body');
        }

        const project = projects.get(projectName);
        const pomPath = path.join(project.path, 'pom.xml');

        if (!fs.existsSync(pomPath)) {
            return err404(res, `pom.xml not found in project '${projectName}'`);
        }

        try {
            const result = addDependencyToPom(
                pomPath,
                groupId.trim(),
                artifactId.trim(),
                version ? String(version).trim() : null,
                scope ? String(scope).trim() : null,
                {
                    type: type ? String(type).trim() : null,
                    classifier: classifier ? String(classifier).trim() : null,
                    optional,
                    exclusions,
                    rawXml
                }
            );
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

    /* ── POST /maven/dependencies – Add/update many dependencies ─
       Query: ?projectName=my-app
       Body: { dependencies: [{ groupId, artifactId, version?, scope?, exclusions? }] }
       ─────────────────────────────────────────────────────────── */
    if (pathname === '/maven/dependencies' && req.method === 'POST') {
        const { projectName } = query;
        if (!projectName) return err400(res, 'Provide ?projectName=<name>');
        if (!projects.has(projectName)) {
            return send(res, 404, { error: 'Project does not exist. Create the project first.', projectName });
        }

        let body;
        try { body = await readBody(req); } catch { return err400(res, 'Invalid JSON body'); }
        const dependencies = normalizeDependencies(body.dependencies);
        if (!dependencies.length) return err400(res, 'Provide { dependencies: [{ groupId, artifactId, ... }] } in body');

        const project = projects.get(projectName);
        const pomPath = path.join(project.path, 'pom.xml');
        if (!fs.existsSync(pomPath)) return err404(res, `pom.xml not found in project '${projectName}'`);

        try {
            const results = dependencies.map(dep => addDependencyToPom(
                pomPath,
                dep.groupId,
                dep.artifactId,
                dep.version || null,
                dep.scope || null,
                dep
            ));
            return send(res, 200, {
                message: 'Dependencies processed',
                projectName,
                results,
                dependencies: parseDependencies(pomPath)
            });
        } catch (e) {
            return err500(res, `Failed to add dependencies: ${e.message}`);
        }
    }

    /* ── GET /maven/plugins – List build plugins ───────────────
       Query: ?projectName=my-app
       ─────────────────────────────────────────────────────────── */
    if (pathname === '/maven/plugins' && req.method === 'GET') {
        const { projectName } = query;
        if (!projectName) return err400(res, 'Provide ?projectName=<name>');
        if (!projects.has(projectName)) {
            return send(res, 404, { error: 'Project does not exist. Create the project first.', projectName });
        }
        const project = projects.get(projectName);
        const pomPath = path.join(project.path, 'pom.xml');
        if (!fs.existsSync(pomPath)) return err404(res, `pom.xml not found in project '${projectName}'`);
        try {
            const plugins = parsePlugins(pomPath);
            return send(res, 200, { projectName, count: plugins.length, plugins });
        } catch (e) {
            return err500(res, `Failed to read plugins: ${e.message}`);
        }
    }

    /* ── POST /maven/plugin – Add/update build plugin ──────────
       Query: ?projectName=my-app
       Body: { groupId?, artifactId, version?, configuration?, executions?, rawXml? }
       ─────────────────────────────────────────────────────────── */
    if (pathname === '/maven/plugin' && req.method === 'POST') {
        const { projectName } = query;
        if (!projectName) return err400(res, 'Provide ?projectName=<name>');
        if (!projects.has(projectName)) {
            return send(res, 404, { error: 'Project does not exist. Create the project first.', projectName });
        }

        let body;
        try { body = await readBody(req); } catch { return err400(res, 'Invalid JSON body'); }
        if (!body.rawXml && !body.artifactId) return err400(res, 'Provide { artifactId } or { rawXml } in body');

        const project = projects.get(projectName);
        const pomPath = path.join(project.path, 'pom.xml');
        if (!fs.existsSync(pomPath)) return err404(res, `pom.xml not found in project '${projectName}'`);

        try {
            const result = upsertPluginInPom(pomPath, body);
            if (result.error) return err400(res, result.error);
            return send(res, 200, {
                message: `Plugin ${result.action}`,
                projectName,
                ...result,
                plugins: parsePlugins(pomPath)
            });
        } catch (e) {
            return err500(res, `Failed to add plugin: ${e.message}`);
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
        const { projectName, skipTests } = query;
        if (!projectName) return err400(res, 'Provide ?projectName=<name>');

        if (!projects.has(projectName)) {
            return send(res, 404, { error: 'Project does not exist. Create the project first.', projectName });
        }

        const project = projects.get(projectName);
        const pomPath = path.join(project.path, 'pom.xml');
        
        let minJavaVersion = 11;
        if (fs.existsSync(pomPath)) {
            try {
                const summary = parsePomSummary(pomPath);
                const parentVersion = summary.parent && summary.parent.version ? String(summary.parent.version) : '';
                const isSpringBoot3 = parentVersion.startsWith('3.');
                const pomJava = summary.properties && (summary.properties['java.version'] || summary.properties['maven.compiler.source'] || summary.properties['maven.compiler.target']);
                if (pomJava) {
                    minJavaVersion = parseInt(pomJava, 10) || minJavaVersion;
                } else if (isSpringBoot3) {
                    minJavaVersion = 17;
                }
            } catch (e) {
                // fallback to 11
            }
        }

        const reqs = await checkRequirements(minJavaVersion);
        if (!reqs.ok) return send(res, 500, { error: reqs.error });
        const skipTestsFlag = skipTests === 'true' || skipTests === '1' ? ' -DskipTests' : '';
        const mvnCmd = `mvn package${skipTestsFlag}`;

        let output = '';
        let buildSuccess = false;
        let fallbackError = '';
        try {
            output = await execPromise(mvnCmd, { cwd: project.path, timeout: 300000 });
            buildSuccess = output.includes('BUILD SUCCESS');
        } catch (e) {
            output = e.stdout || '';
            buildSuccess = false;
            fallbackError = e.message;
        }

        // Find the generated JAR
        const targetDir = path.join(project.path, 'target');
        let jarFile = null;
        if (buildSuccess && fs.existsSync(targetDir)) {
            const files = fs.readdirSync(targetDir);
            jarFile = files.find(f => f.endsWith('.jar') && !f.endsWith('-sources.jar') && !f.endsWith('-javadoc.jar'));
        }

        // Extract meaningful error lines if build failed
        let errorLines = [];
        if (!buildSuccess) {
            if (output) {
                errorLines = output.split('\n')
                    .filter(line => line.includes('[ERROR]') || line.includes('FAILURE') || line.includes('error'))
                    .slice(0, 10);
            }
            if (errorLines.length === 0) {
                errorLines = [fallbackError || 'Build failed with non-zero exit code'];
            }
        }

        // Return 200 even on compilation failure so the orchestrator gets the JSON body containing errorSummary
        return send(res, 200, {
            message: buildSuccess ? 'Build successful' : 'Build failed',
            projectName,
            buildSuccess,
            jarFile: jarFile ? path.join(targetDir, jarFile) : null,
            errorSummary: errorLines.length > 0 ? errorLines : null,
            mavenOutput: output.substring(Math.max(0, output.length - 1000)) // last 1000 chars
        });
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

    /* ── GET /maven/artifact – Get JAR file path and info ────
       Query: ?projectName=my-app
       Returns path to JAR and metadata instead of downloading binary.
       This is useful for "share jar location" use cases.
       ─────────────────────────────────────────────────────────── */
    if (pathname === '/maven/artifact' && req.method === 'GET') {
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
        const jarAbsolutePath = path.resolve(jarFilePath);
        const stat = fs.statSync(jarFilePath);

        return send(res, 200, {
            message: 'JAR artifact information',
            projectName,
            artifactName: jarFileName,
            jarPath: jarAbsolutePath,
            jarRelativePath: jarFilePath,
            jarAbsolutePath: jarAbsolutePath,
            jarSize: stat.size,
            jarSizeKB: Math.round(stat.size / 1024),
            groupId: project.groupId,
            artifactId: project.artifactId,
            packageName: project.packageName
        });
    }

    /* ── GET /maven/project-details – Get complete project info ──
       Query: ?projectName=my-app
       Returns all details: jar file path, src file paths, pom info, etc.
       ─────────────────────────────────────────────────────────── */
    if (pathname === '/maven/project-details' && req.method === 'GET') {
        const { projectName } = query;
        if (!projectName) return err400(res, 'Provide ?projectName=<name>');

        if (!projects.has(projectName)) {
            return send(res, 404, { error: 'Project does not exist. Create the project first.', projectName });
        }

        const project = projects.get(projectName);
        const pomPath = path.join(project.path, 'pom.xml');
        const srcMainJavaPath = path.join(project.path, 'src', 'main', 'java');
        const srcTestJavaPath = path.join(project.path, 'src', 'test', 'java');
        const targetDir = path.join(project.path, 'target');

        // Find JAR if exists
        let jarInfo = null;
        if (fs.existsSync(targetDir)) {
            const files = fs.readdirSync(targetDir);
            const jarFileName = files.find(f => f.endsWith('.jar') && !f.endsWith('-sources.jar') && !f.endsWith('-javadoc.jar'));
            if (jarFileName) {
                const jarFilePath = path.join(targetDir, jarFileName);
                const jarAbsPath = path.resolve(jarFilePath);
                const stat = fs.statSync(jarFilePath);
                jarInfo = {
                    name: jarFileName,
                    path: jarAbsPath,
                    relativePath: jarFilePath,
                    absolutePath: jarAbsPath,
                    size: stat.size,
                    sizeKB: Math.round(stat.size / 1024)
                };
            }
        }

        // Parse POM for additional info
        let pomInfo = {};
        if (fs.existsSync(pomPath)) {
            try {
                pomInfo = parsePomSummary(pomPath);
            } catch (e) {
                pomInfo = { error: e.message };
            }
        }

        const projectAbsolutePath = path.resolve(project.path);
        const pomAbsolutePath = path.resolve(pomPath);
        const srcMainJavaAbsPath = path.resolve(srcMainJavaPath);
        const srcTestJavaAbsPath = path.resolve(srcTestJavaPath);
        const targetDirAbsPath = path.resolve(targetDir);

        return send(res, 200, {
            message: 'Complete project details',
            projectName,
            projectInfo: {
                name: project.name,
                path: projectAbsolutePath,
                relativePath: project.path,
                absolutePath: projectAbsolutePath,
                groupId: project.groupId,
                artifactId: project.artifactId,
                packageName: project.packageName,
                type: project.type || 'maven',
                createdAt: project.createdAt
            },
            pomInfo: {
                path: pomAbsolutePath,
                relativePath: pomPath,
                exists: fs.existsSync(pomPath),
                summary: pomInfo
            },
            sourceDirs: {
                mainJava: srcMainJavaAbsPath,
                mainJavaRelative: srcMainJavaPath,
                testJava: srcTestJavaAbsPath,
                testJavaRelative: srcTestJavaPath,
                mainJavaExists: fs.existsSync(srcMainJavaPath),
                testJavaExists: fs.existsSync(srcTestJavaPath)
            },
            buildArtifact: jarInfo,
            targetDir: {
                path: targetDirAbsPath,
                relativePath: targetDir,
                exists: fs.existsSync(targetDir)
            }
        });
    }

    /* ── POST /maven/resource/file – Create/Add file in src/main/resources ──
       Query: ?projectName=my-app&filePath=application.yml
       Body: { content: "..." }
       ─────────────────────────────────────────────────────────── */
    if (pathname === '/maven/resource/file' && req.method === 'POST') {
        const { projectName, filePath: queryFilePath } = query;
        if (!projectName) return err400(res, 'Provide ?projectName=<name>');
        if (!queryFilePath) return err400(res, 'Provide ?filePath=<relative/path/to/file>');

        if (!projects.has(projectName)) {
            return send(res, 404, { error: 'Project does not exist. Create the project first.', projectName });
        }

        let body;
        try { body = await readBody(req); } catch { return err400(res, 'Invalid JSON body'); }

        const { content } = body;
        if (content === undefined || content === null) {
            return err400(res, 'Provide { content: "..." } in body');
        }

        const project = projects.get(projectName);
        const resourcesDir = path.join(project.path, 'src', 'main', 'resources');
        const fullFilePath = path.join(resourcesDir, queryFilePath);

        // Security: prevent path traversal
        if (!path.resolve(fullFilePath).startsWith(path.resolve(resourcesDir))) {
            return err400(res, 'File path must be within src/main/resources');
        }

        try {
            fs.mkdirSync(path.dirname(fullFilePath), { recursive: true });
            const exists = fs.existsSync(fullFilePath);
            fs.writeFileSync(fullFilePath, content, 'utf8');

            return send(res, 200, {
                message: exists ? 'Resource file updated' : 'Resource file created',
                projectName,
                filePath: queryFilePath,
                absolutePath: path.resolve(fullFilePath),
                relativePath: fullFilePath,
                exists: true,
                action: exists ? 'updated' : 'created'
            });
        } catch (e) {
            return err500(res, `Failed to write resource file: ${e.message}`);
        }
    }

    /* ── GET /maven/resource/file – Read file from src/main/resources ──
       Query: ?projectName=my-app&filePath=application.properties
       ─────────────────────────────────────────────────────────── */
    if (pathname === '/maven/resource/file' && req.method === 'GET') {
        const { projectName, filePath: queryFilePath } = query;
        if (!projectName) return err400(res, 'Provide ?projectName=<name>');
        if (!queryFilePath) return err400(res, 'Provide ?filePath=<relative/path/to/file>');

        if (!projects.has(projectName)) {
            return send(res, 404, { error: 'Project does not exist.', projectName });
        }

        const project = projects.get(projectName);
        const resourcesDir = path.join(project.path, 'src', 'main', 'resources');
        const fullFilePath = path.join(resourcesDir, queryFilePath);

        // Security: prevent path traversal
        if (!path.resolve(fullFilePath).startsWith(path.resolve(resourcesDir))) {
            return err400(res, 'File path must be within src/main/resources');
        }

        if (!fs.existsSync(fullFilePath)) {
            return err404(res, `Resource file '${queryFilePath}' not found in project '${projectName}'`);
        }

        try {
            const content = fs.readFileSync(fullFilePath, 'utf8');
            const stat = fs.statSync(fullFilePath);

            return send(res, 200, {
                message: 'Resource file read successfully',
                projectName,
                filePath: queryFilePath,
                absolutePath: path.resolve(fullFilePath),
                relativePath: fullFilePath,
                content,
                size: stat.size
            });
        } catch (e) {
            return err500(res, `Failed to read resource file: ${e.message}`);
        }
    }

    /* ── PUT /maven/resource/file – Modify/Update file in src/main/resources ──
       Query: ?projectName=my-app&filePath=application.yml
       Body: { content: "..." }
       ─────────────────────────────────────────────────────────── */
    if (pathname === '/maven/resource/file' && req.method === 'PUT') {
        const { projectName, filePath: queryFilePath } = query;
        if (!projectName) return err400(res, 'Provide ?projectName=<name>');
        if (!queryFilePath) return err400(res, 'Provide ?filePath=<relative/path/to/file>');

        if (!projects.has(projectName)) {
            return send(res, 404, { error: 'Project does not exist.', projectName });
        }

        let body;
        try { body = await readBody(req); } catch { return err400(res, 'Invalid JSON body'); }

        const { content } = body;
        if (content === undefined || content === null) {
            return err400(res, 'Provide { content: "..." } in body');
        }

        const project = projects.get(projectName);
        const resourcesDir = path.join(project.path, 'src', 'main', 'resources');
        const fullFilePath = path.join(resourcesDir, queryFilePath);

        // Security: prevent path traversal
        if (!path.resolve(fullFilePath).startsWith(path.resolve(resourcesDir))) {
            return err400(res, 'File path must be within src/main/resources');
        }

        if (!fs.existsSync(fullFilePath)) {
            return err404(res, `Resource file '${queryFilePath}' not found. Cannot update non-existent file.`);
        }

        try {
            const oldContent = fs.readFileSync(fullFilePath, 'utf8');
            fs.writeFileSync(fullFilePath, content, 'utf8');

            return send(res, 200, {
                message: 'Resource file updated successfully',
                projectName,
                filePath: queryFilePath,
                absolutePath: path.resolve(fullFilePath),
                relativePath: fullFilePath,
                oldContentSize: oldContent.length,
                newContentSize: content.length,
                action: 'updated'
            });
        } catch (e) {
            return err500(res, `Failed to update resource file: ${e.message}`);
        }
    }

    /* ── PATCH /maven/resource/file – Patch/edit a resource file ──
       Query: ?projectName=my-app&filePath=application.properties
       Body: {
         targetContent?: "...",
         replacementContent?: "...",
         replacements?: [{ targetContent, replacementContent }]
       }
       ─────────────────────────────────────────────────────────── */
    if (pathname === '/maven/resource/file' && req.method === 'PATCH') {
        const { projectName, filePath: queryFilePath } = query;
        if (!projectName) return err400(res, 'Provide ?projectName=<name>');
        if (!queryFilePath) return err400(res, 'Provide ?filePath=<relative/path/to/file>');

        if (!projects.has(projectName)) {
            return send(res, 404, { error: 'Project does not exist.', projectName });
        }

        let body;
        try { body = await readBody(req); } catch { return err400(res, 'Invalid JSON body'); }

        const project = projects.get(projectName);
        const resourcesDir = path.join(project.path, 'src', 'main', 'resources');
        const fullFilePath = path.join(resourcesDir, queryFilePath);

        // Security: prevent path traversal
        if (!path.resolve(fullFilePath).startsWith(path.resolve(resourcesDir))) {
            return err400(res, 'File path must be within src/main/resources');
        }

        if (!fs.existsSync(fullFilePath)) {
            return err404(res, `Resource file '${queryFilePath}' not found. Create it first.`);
        }

        let content = fs.readFileSync(fullFilePath, 'utf8');

        // Extract list of replacements
        let replacementsList = [];
        if (body.targetContent !== undefined && body.replacementContent !== undefined) {
            replacementsList.push({ targetContent: body.targetContent, replacementContent: body.replacementContent });
        } else if (Array.isArray(body.replacements)) {
            replacementsList = body.replacements;
        }

        if (replacementsList.length === 0) {
            return err400(res, 'Provide either { targetContent, replacementContent } or { replacements: [...] } in body');
        }

        // Apply replacements
        for (let i = 0; i < replacementsList.length; i++) {
            const { targetContent, replacementContent } = replacementsList[i];
            if (targetContent === undefined || replacementContent === undefined) {
                return err400(res, `Replacement at index ${i} is missing targetContent or replacementContent`);
            }

            // Find occurrence count of targetContent
            const occurrences = content.split(targetContent).length - 1;
            if (occurrences === 0) {
                return err400(res, `Target content not found in resource file: "${targetContent.substring(0, 100)}..."`);
            }
            if (occurrences > 1) {
                return err400(res, `Target content is not unique in resource file (found ${occurrences} occurrences): "${targetContent.substring(0, 100)}..."`);
            }

            content = content.replace(targetContent, replacementContent);
        }

        try {
            fs.writeFileSync(fullFilePath, content, 'utf8');
            return send(res, 200, {
                message: `Resource file '${queryFilePath}' patched successfully`,
                projectName,
                filePath: queryFilePath,
                absolutePath: path.resolve(fullFilePath),
                relativePath: fullFilePath,
                replacementsApplied: replacementsList.length
            });
        } catch (e) {
            return err500(res, `Failed to patch resource file: ${e.message}`);
        }
    }

    /* ── GET /maven/resources – List all files in src/main/resources ──
       Query: ?projectName=my-app
       ─────────────────────────────────────────────────────────── */
    if (pathname === '/maven/resources' && req.method === 'GET') {
        const { projectName } = query;
        if (!projectName) return err400(res, 'Provide ?projectName=<name>');

        if (!projects.has(projectName)) {
            return send(res, 404, { error: 'Project does not exist.', projectName });
        }

        const project = projects.get(projectName);
        const resourcesDir = path.join(project.path, 'src', 'main', 'resources');

        if (!fs.existsSync(resourcesDir)) {
            return send(res, 200, {
                message: 'No src/main/resources directory found',
                projectName,
                resourcesDir,
                exists: false,
                files: []
            });
        }

        try {
            const files = [];
            const walkDir = (dir, baseDir) => {
                const entries = fs.readdirSync(dir, { withFileTypes: true });
                for (const entry of entries) {
                    const fullPath = path.join(dir, entry.name);
                    const relativePath = path.relative(baseDir, fullPath);
                    if (entry.isDirectory()) {
                        walkDir(fullPath, baseDir);
                    } else {
                        const stat = fs.statSync(fullPath);
                        files.push({
                            name: entry.name,
                            relativePath,
                            absolutePath: path.resolve(fullPath),
                            size: stat.size,
                            type: path.extname(entry.name) || 'file'
                        });
                    }
                }
            };

            walkDir(resourcesDir, resourcesDir);

            return send(res, 200, {
                message: 'Resource files listed',
                projectName,
                resourcesDir: path.resolve(resourcesDir),
                fileCount: files.length,
                files
            });
        } catch (e) {
            return err500(res, `Failed to list resource files: ${e.message}`);
        }
    }

    /* ── 404 ──────────────────────────────────────────────────── */
    send(res, 404, {
        error: 'Endpoint not found',
        availableEndpoints: [
            'GET  /health',
            'GET  /maven/projects',
            'POST /maven/create                   { groupId, artifactId, version?, archetypeGroupId?, archetypeArtifactId?, archetypeVersion?, javaVersion? }',
            'POST /spring/create                  { groupId, artifactId, packageName?, parent?, properties?, dependencies?, plugins?, applicationProperties? }',
            'POST /spring/crud?projectName=       { resourceName, packageName?, path?, fields? }',
            'GET  /maven/pom?projectName=&raw=true',
            'PUT  /maven/properties?projectName=  { properties: { key: value } }',
            'PUT  /maven/parent?projectName=      { groupId, artifactId, version, relativePath? }',
            'POST /maven/class?projectName=&packageName=&className=    { code: "..." }',
            'PUT  /maven/class?projectName=&packageName=&className=    { code: "..." }',
            'PATCH /maven/class?projectName=&packageName=&className=   { targetContent?, replacementContent?, replacements? }',
            'POST /maven/dependency?projectName=   { groupId, artifactId, version?, scope? }',
            'POST /maven/dependencies?projectName= { dependencies: [...] }',
            'GET  /maven/dependencies?projectName=',
            'GET  /maven/plugins?projectName=',
            'POST /maven/plugin?projectName=       { groupId?, artifactId, version?, configuration?, executions? }',
            'POST /maven/resource/file?projectName=&filePath= { content: "..." }',
            'GET  /maven/resource/file?projectName=&filePath=',
            'PUT  /maven/resource/file?projectName=&filePath= { content: "..." }',
            'PATCH /maven/resource/file?projectName=&filePath= { targetContent?, replacementContent?, replacements? }',
            'GET  /maven/resources?projectName=',
            'GET  /maven/build?projectName=&skipTests=true',
            'GET  /maven/jar?projectName=',
            'GET  /maven/artifact?projectName=     -- Returns JAR path info (not binary download)',
            'GET  /maven/project-details?projectName= -- Returns complete project and JAR details',
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
    console.log('  POST /spring/create                  - Create a configurable Spring Boot Maven application');
    console.log('  POST /spring/crud?projectName=       - Generate entity/repository/service/controller CRUD');
    console.log('  GET  /maven/pom?projectName=         - Read POM summary/raw XML');
    console.log('  PUT  /maven/properties?projectName=  - Add/update POM properties');
    console.log('  PUT  /maven/parent?projectName=      - Add/update POM parent');
    console.log('  POST /maven/class?projectName=&...   - Create a Java class');
    console.log('  PUT  /maven/class?projectName=&...   - Update a Java class');
    console.log('  PATCH /maven/class?projectName=&...  - Patch a Java class (search & replace)');
    console.log('  POST /maven/dependency?projectName=  - Add/update dependency in pom.xml');
    console.log('  POST /maven/dependencies?projectName=- Add/update multiple dependencies');
    console.log('  GET  /maven/dependencies?projectName=- List project dependencies');
    console.log('  GET  /maven/plugins?projectName=     - List build plugins');
    console.log('  POST /maven/plugin?projectName=      - Add/update build plugin');
    console.log('  POST /maven/resource/file?projectName=&filePath= - Create/add file in src/main/resources');
    console.log('  GET  /maven/resource/file?projectName=&filePath= - Read file from src/main/resources');
    console.log('  PUT  /maven/resource/file?projectName=&filePath= - Modify file in src/main/resources');
    console.log('  PATCH /maven/resource/file?projectName=&filePath= - Patch file in src/main/resources (search & replace)');
    console.log('  GET  /maven/resources?projectName=   - List all files in src/main/resources');
    console.log('  GET  /maven/build?projectName=       - Build project (mvn package)');
    console.log('  GET  /maven/jar?projectName=         - Download built JAR');
    console.log('  GET  /maven/artifact?projectName=    - Get JAR file path info (not binary)');
    console.log('  GET  /maven/project-details?projectName= - Get complete project details (getProjectDetails alias)');
    console.log('  GET  /maven/rescan                   - Rescan for existing Maven projects');
});
