const http = require('http');
const url = require('url');
const fs = require('fs');
const path = require('path');

const PORT = 3030;

/* ------------------ BASE DIR FROM CLI ------------------ */

let BASE_DIR;

if (process.argv[2]) {
    const inputPath = path.resolve(process.argv[2]);

    if (!fs.existsSync(inputPath) || !fs.statSync(inputPath).isDirectory()) {
        console.error("Invalid directory provided:", inputPath);
        process.exit(1);
    }

    BASE_DIR = inputPath;
} else {
    BASE_DIR = process.cwd(); // current working directory
}

console.log("Scanning Base Directory:", BASE_DIR);

/* ------------------ BINARY EXTENSION FILTER ------------------ */

const BLOCKED_EXTENSIONS = [
    'pdf', 'doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx',
    'png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp',
    'mp3', 'mp4', 'wav', 'avi', 'mkv', 'mov',
    'exe', 'dll', 'bin', 'iso', 'zip', 'rar', '7z'
];

function isBinaryFile(filePath) {
    const ext = path.extname(filePath).toLowerCase().replace('.', '');
    return BLOCKED_EXTENSIONS.includes(ext);
}

/* ------------------ HELPERS ------------------ */

function shouldExclude(folderName, excludeFolders) {
    if (folderName.startsWith('.')) return true;
    if (!excludeFolders || excludeFolders.length === 0) return false;
    return excludeFolders.includes(folderName.toLowerCase());
}

function findFilesByExtension(dir, extension, excludeFolders, results = []) {
    try {
        const files = fs.readdirSync(dir);

        for (const file of files) {
            const fullPath = path.join(dir, file);

            try {
                const stat = fs.statSync(fullPath);

                if (stat.isDirectory()) {
                    if (!shouldExclude(file, excludeFolders)) {
                        findFilesByExtension(fullPath, extension, excludeFolders, results);
                    }
                } else if (file.toLowerCase().endsWith('.' + extension.toLowerCase())) {
                    results.push(fullPath);
                }
            } catch { }
        }
    } catch { }

    return results;
}

function findFileByExactName(dir, filename, excludeFolders, results = []) {
    try {
        const files = fs.readdirSync(dir);

        for (const file of files) {
            const fullPath = path.join(dir, file);

            try {
                const stat = fs.statSync(fullPath);

                if (stat.isDirectory()) {
                    if (!shouldExclude(file, excludeFolders)) {
                        findFileByExactName(fullPath, filename, excludeFolders, results);
                    }
                } else if (file === filename) {
                    results.push(fullPath);
                }
            } catch { }
        }
    } catch { }

    return results;
}

function findTextInFiles(dir, searchText, excludeFolders, results = []) {
    try {
        const files = fs.readdirSync(dir);

        for (const file of files) {
            const fullPath = path.join(dir, file);

            try {
                const stat = fs.statSync(fullPath);

                if (stat.isDirectory()) {
                    if (!shouldExclude(file, excludeFolders)) {
                        findTextInFiles(fullPath, searchText, excludeFolders, results);
                    }
                } else {
                    if (isBinaryFile(fullPath)) continue;

                    try {
                        const content = fs.readFileSync(fullPath, 'utf8');
                        const lines = content.split(/\r?\n/);

                        const matches = [];
                        const lowerSearch = searchText.toLowerCase();

                        lines.forEach((line, index) => {
                            const lowerLine = line.toLowerCase();
                            const foundIndex = lowerLine.indexOf(lowerSearch);

                            if (foundIndex !== -1) {
                                let resultLine = line;

                                if (line.length > 70) {
                                    const start = Math.max(0, foundIndex - 35);
                                    const end = Math.min(line.length, foundIndex + lowerSearch.length + 35);
                                    resultLine = line.substring(start, end);
                                }

                                matches.push({
                                    lineNumber: index + 1,
                                    line: resultLine
                                });
                            }
                        });

                        if (matches.length > 0) {
                            results.push({
                                file: fullPath,
                                matches: matches
                            });
                        }

                    } catch { }
                }
            } catch { }
        }
    } catch { }

    return results;
}

/* ------------------ API HIT TRACKING ------------------ */

const apiHitCounts = {
    'GET /findFile': 0,
    'GET /searchText': 0,
    'GET /readFile': 0
};

/* ------------------ SERVER ------------------ */

const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    const parsedUrl = url.parse(req.url, true);

    /* -------- HEALTH -------- */
    if (parsedUrl.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
            status: 'UP',
            version: '1.0',
            type: 'agent',
            baseDir: BASE_DIR
        }));
    }

    if (parsedUrl.pathname === '/apidoc' && req.method === 'GET') {
        const content = getApiDocContent();
        if (!content) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'API doc not found' })); }
        res.writeHead(200, { 'Content-Type': 'text/markdown' });
        return res.end(content);
    }

    /* -------- INSIGHT -------- */
    if (parsedUrl.pathname === '/insights') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ apiHitCounts }));
    }

    /* -------- FIND FILE -------- */
    if (parsedUrl.pathname === '/findFile') {
        apiHitCounts['GET /findFile']++;
        const { type, name, excludeFolder } = parsedUrl.query;

        let excludeFolders = [];
        if (excludeFolder) {
            excludeFolders = excludeFolder
                .split(',')
                .map(f => f.trim().toLowerCase());
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });

        try {
            if (type) {
                const results = findFilesByExtension(BASE_DIR, type, excludeFolders);
                return res.end(JSON.stringify({ count: results.length, files: results }));
            } else if (name) {
                const results = findFileByExactName(BASE_DIR, name, excludeFolders);
                return res.end(JSON.stringify({ count: results.length, files: results }));
            } else {
                return res.end(JSON.stringify({
                    error: 'Provide ?type=ext or ?name=filename'
                }));
            }
        } catch (err) {
            res.writeHead(500);
            return res.end(JSON.stringify({ error: err.message }));
        }
    }

    /* -------- SEARCH TEXT -------- */
    if (parsedUrl.pathname === '/searchText') {
        apiHitCounts['GET /searchText']++;
        const { text, excludeFolder } = parsedUrl.query;

        let excludeFolders = [];
        if (excludeFolder) {
            excludeFolders = excludeFolder
                .split(',')
                .map(f => f.trim().toLowerCase());
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });

        if (!text) {
            return res.end(JSON.stringify({
                error: "Provide ?text=yourSearchText"
            }));
        }

        try {
            const results = findTextInFiles(BASE_DIR, text, excludeFolders);

            return res.end(JSON.stringify({
                search: text,
                count: results.length,
                results: results
            }));
        } catch (err) {
            res.writeHead(500);
            return res.end(JSON.stringify({ error: err.message }));
        }
    }


    /* -------- READ FILE (NEW) -------- */
    if (parsedUrl.pathname === '/readFile') {
        apiHitCounts['GET /readFile']++;
        const { path: filePath } = parsedUrl.query;

        res.writeHead(200, { 'Content-Type': 'application/json' });

        if (!filePath) {
            return res.end(JSON.stringify({ error: "Provide ?path=/full/path/to/file" }));
        }

        try {
            const resolvedPath = path.resolve(filePath);

            if (!fs.existsSync(resolvedPath)) {
                return res.end(JSON.stringify({ error: "File does not exist" }));
            }

            if (!fs.statSync(resolvedPath).isFile()) {
                return res.end(JSON.stringify({ error: "Not a valid file" }));
            }

            if (isBinaryFile(resolvedPath)) {
                return res.end(JSON.stringify({
                    error: "Binary file format not allowed"
                }));
            }

            const content = fs.readFileSync(resolvedPath, 'utf8');

            return res.end(JSON.stringify({
                path: resolvedPath,
                size: content.length,
                content: content
            }));

        } catch (err) {
            res.writeHead(500);
            return res.end(JSON.stringify({ error: err.message }));
        }
    }

    /* -------- 404 -------- */
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not Found' }));
});

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

server.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});
