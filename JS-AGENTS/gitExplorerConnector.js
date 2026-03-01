const http = require('http');
const url = require('url');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const PORT = 3033;

/* ------------------ BASE FOLDER FROM CLI ------------------ */

let BASE_DIR;

/* ------------------ FOLDER EXCLUSIONS ------------------ */

const EXCLUDED_FOLDERS = ['node_modules', 'target'];

function shouldExcludeFolder(folderName) {
    if (folderName.indexOf(".") == 0) {
        //console.log(`${folderName} excluded..`);
        return true;
    }
    if (EXCLUDED_FOLDERS.includes(folderName.toLowerCase())) {
        //console.log(`${folderName} excluded...`);
        return true;
    }
    //console.log(`including folder ${folderName}`);
    return false;
}

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

function readFilesContentInGitRepoByNames(fileNames) {
    const result = {};
    fileNames.forEach(name => {
        result[name] = [];
    });

    fileNames.forEach(name => {
        const isPathInput = name.includes(path.sep) || path.isAbsolute(name);
        // CASE 1: Specific file path passed
        if (isPathInput) {
            if (fs.existsSync(name) && fs.statSync(name).isFile()) {
                if (isBinary(name)) return;
                try {
                    const content = fs.readFileSync(name, 'utf8');
                    result[name].push({
                        path: name,
                        content: content
                    });
                } catch { }
            }
        }
        // CASE 2: Only file name passed (existing behavior)
        else {
            repos.forEach(repo => {
                walkDir(repo.path, (file) => {
                    const base = path.basename(file);
                    if (base === name) {
                        if (isBinary(file)) return;
                        try {
                            const content = fs.readFileSync(file, 'utf8');
                            result[name].push({
                                path: file,
                                content: content
                            });
                        } catch { }
                    }
                });
            });
        }
    });
    return result;
}

/* ------------------ REPO LIST ------------------ */

let repos = [];

/* Scan base folder for git repos */
function scanRepos() {
    repos = [];

    const folders = fs.readdirSync(BASE_DIR);

    let countExc = 0;
    let countInc = 0;
    for (const folder of folders) {
        if (shouldExcludeFolder(folder)) {
            countExc++;
            continue;
        }
        const fullPath = path.join(BASE_DIR, folder);
        const gitPath = path.join(fullPath, '.git');

        try {
            if (fs.statSync(fullPath).isDirectory() && fs.existsSync(gitPath)) {
                repos.push({
                    name: folder,
                    path: fullPath
                });
                countInc++;
            } else {
                countExc++;
            }
        } catch {
            countExc++;
        }
    }
    console.log(`scanned ${countInc + countExc} folders, ${countExc} excluded} found repos`, repos);
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
function getFileInRepoByName(name) {
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
function findTextInFilesInGitRepo(text) {
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
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS, POST');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    // Handle preflight requests
    if (req.method === 'OPTIONS') {
        res.writeHead(204); // No content
        return res.end();
    }

    const parsedUrl = url.parse(req.url, true);

    /* HEALTH */
    if (parsedUrl.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
            status: 'UP',
            version: '1.0',
            type: 'agent',
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
    if (parsedUrl.pathname === '/getFileInRepoByName') {
        const { name } = parsedUrl.query;

        if (!name) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: "Provide ?name=filename" }));
        }

        const results = getFileInRepoByName(name);

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

    if (parsedUrl.pathname === '/readFilesContentInGitRepo' && req.method === 'POST') {
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

                const result = readFilesContentInGitRepoByNames(fileNames);

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
    if (parsedUrl.pathname === '/findTextInFilesInGitRepo') {
        const { text } = parsedUrl.query;

        if (!text) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: "Provide ?text=searchText" }));
        }

        const results = findTextInFilesInGitRepo(text);

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