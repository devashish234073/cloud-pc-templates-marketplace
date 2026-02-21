const http = require('http');
const url = require('url');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const PORT = 3033;

/* ------------------ BASE FOLDER FROM CLI ------------------ */

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

if (!fs.existsSync(BASE_DIR)) {
    fs.mkdirSync(BASE_DIR, { recursive: true });
}

if (!fs.statSync(BASE_DIR).isDirectory()) {
    console.error("Provided path is not a directory");
    process.exit(1);
}

console.log("Git Explorer Base Directory:", BASE_DIR);

function getFilesContentByNames(fileNames) {
    const result = {};
    fileNames.forEach(name => {
        result[name] = [];
    });

    repos.forEach(repo => {
        walkDir(repo.path, (file) => {
            const base = path.basename(file);

            if (fileNames.includes(base)) {

                if (isBinary(file)) return;

                try {
                    const content = fs.readFileSync(file, 'utf8');

                    result[base].push({
                        path: file,
                        content: content
                    });

                } catch { }
            }
        });
    });

    return result;
}

/* ------------------ REPO LIST ------------------ */

let repos = [];

/* Scan base folder for git repos */
function scanRepos() {
    repos = [];

    const folders = fs.readdirSync(BASE_DIR);

    for (const folder of folders) {
        const fullPath = path.join(BASE_DIR, folder);
        const gitPath = path.join(fullPath, '.git');

        try {
            if (!shouldExcludeFolder(folder) && fs.statSync(fullPath).isDirectory() && fs.existsSync(gitPath)) {
                repos.push({
                    name: folder,
                    path: fullPath
                });
            }
        } catch { }
    }
    console.log("found repos", repos);
}

scanRepos();

/* ------------------ GIT CLONE ------------------ */

function cloneRepo(repoUrl) {
    return new Promise((resolve) => {
        const repoName = repoUrl.split('/').pop().replace('.git', '');
        const targetPath = path.join(BASE_DIR, repoName);

        if (fs.existsSync(targetPath)) {
            return resolve({ error: "Repository already exists" });
        }

        exec(`git clone ${repoUrl} "${targetPath}"`, (error, stdout, stderr) => {
            if (error) {
                return resolve({ error: stderr || error.message });
            }

            scanRepos();

            resolve({
                message: "Repository cloned successfully",
                repo: repoName
            });
        });
    });
}

/* ------------------ SEARCH HELPERS ------------------ */

const BLOCKED_EXTENSIONS = [
    'png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp',
    'mp3', 'mp4', 'exe', 'dll', 'zip', 'rar', '7z'
];

function isBinary(filePath) {
    const ext = path.extname(filePath).replace('.', '').toLowerCase();
    return BLOCKED_EXTENSIONS.includes(ext);
}

/* ------------------ FOLDER EXCLUSIONS ------------------ */

const EXCLUDED_FOLDERS = ['node_modules', 'target'];

function shouldExcludeFolder(folderName) {
    if (folderName.indexOf(".") == 0) return true;
    return EXCLUDED_FOLDERS.includes(folderName.toLowerCase());
}

/* ------------------ SAFE WALK ------------------ */

function walkDir(dir, callback) {
    let files;

    try {
        files = fs.readdirSync(dir);
    } catch {
        return;
    }

    for (const file of files) {
        const fullPath = path.join(dir, file);

        try {
            const stat = fs.statSync(fullPath);

            if (stat.isDirectory()) {
                if (shouldExcludeFolder(file)) continue;
                walkDir(fullPath, callback);
            } else {
                callback(fullPath);
            }
        } catch { }
    }
}

/* Exact file name */
function findByFileName(name) {
    const results = [];

    repos.forEach(repo => {
        walkDir(repo.path, (file) => {
            if (path.basename(file) === name) {
                results.push(file);
            }
        });
    });

    return results;
}

/* Partial file name */
function findByPartialFileName(name) {
    const lower = name.toLowerCase();
    const results = [];

    repos.forEach(repo => {
        walkDir(repo.path, (file) => {
            if (path.basename(file).toLowerCase().includes(lower)) {
                results.push(file);
            }
        });
    });

    return results;
}

/* Search by content */
function findByContent(text) {
    const results = [];
    const lowerSearch = text.toLowerCase();

    repos.forEach(repo => {
        walkDir(repo.path, (file) => {
            if (isBinary(file)) return;

            try {
                const content = fs.readFileSync(file, 'utf8');
                const lines = content.split(/\r?\n/);
                const matches = [];

                lines.forEach((line, index) => {
                    const lowerLine = line.toLowerCase();
                    const foundIndex = lowerLine.indexOf(lowerSearch);

                    if (foundIndex !== -1) {
                        let snippet = line;

                        if (line.length > 70) {
                            const start = Math.max(0, foundIndex - 35);
                            const end = Math.min(line.length, foundIndex + lowerSearch.length + 35);
                            snippet = line.substring(start, end);
                        }

                        matches.push({
                            lineNumber: index + 1,
                            line: snippet
                        });
                    }
                });

                if (matches.length > 0) {
                    results.push({
                        file,
                        matches
                    });
                }

            } catch { }
        });
    });

    return results;
}

/* ------------------ SERVER ------------------ */

const server = http.createServer(async (req, res) => {

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    const parsedUrl = url.parse(req.url, true);

    /* HEALTH */
    if (parsedUrl.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
            status: 'UP',
            baseDir: BASE_DIR,
            repoCount: repos.length
        }));
    }

    /* LIST REPOS */
    if (parsedUrl.pathname === '/repos') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
            count: repos.length,
            repos
        }));
    }

    /* CLONE */
    if (parsedUrl.pathname === '/clone') {
        const { url: repoUrl } = parsedUrl.query;

        if (!repoUrl) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({
                error: "Provide ?url=<git-repo-url>"
            }));
        }

        const result = await cloneRepo(repoUrl);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(result));
    }

    /* FIND EXACT */
    if (parsedUrl.pathname === '/findByFileName') {
        const { name } = parsedUrl.query;

        if (!name) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: "Provide ?name=filename" }));
        }

        const results = findByFileName(name);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
            count: results.length,
            files: results
        }));
    }

    /* FIND PARTIAL */
    if (parsedUrl.pathname === '/findByPartialFileName') {
        const { name } = parsedUrl.query;

        if (!name) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: "Provide ?name=partialName" }));
        }

        const results = findByPartialFileName(name);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
            count: results.length,
            files: results
        }));
    }

    if (parsedUrl.pathname === '/getFilesContent' && req.method === 'POST') {
        let body = '';

        req.on('data', chunk => {
            body += chunk.toString();
        });

        req.on('end', () => {

            try {
                const fileNames = JSON.parse(body);

                if (!Array.isArray(fileNames) || fileNames.length === 0) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({
                        error: "Payload must be a non-empty array of file names"
                    }));
                }

                const result = getFilesContentByNames(fileNames);

                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify(result));

            } catch (err) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({
                    error: "Invalid JSON payload"
                }));
            }
        });

        return;
    }

    /* FIND CONTENT */
    if (parsedUrl.pathname === '/findByContent') {
        const { text } = parsedUrl.query;

        if (!text) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: "Provide ?text=searchText" }));
        }

        const results = findByContent(text);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
            search: text,
            count: results.length,
            results
        }));
    }

    /* 404 */
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not Found' }));
});

server.listen(PORT, () => {
    console.log(`Git Explorer running at http://localhost:${PORT}`);
});