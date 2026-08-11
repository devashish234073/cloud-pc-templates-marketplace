const http = require('http');
const url = require('url');
const fs = require('fs');
const path = require('path');
const { exec, execSync } = require('child_process');

const PORT = 3033;

/* ================================================================
   BASE DIR FROM CLI
   ================================================================ */

let BASE_DIR;

if (process.argv[2]) {
    const inputPath = path.resolve(process.argv[2]);
    if (!fs.existsSync(inputPath) || !fs.statSync(inputPath).isDirectory()) {
        console.error('Invalid directory provided:', inputPath);
        process.exit(1);
    }
    BASE_DIR = inputPath;
} else {
    BASE_DIR = process.cwd();
}

console.log('Git Explorer Base Directory:', BASE_DIR);

/* ================================================================
   FOLDER EXCLUSIONS
   ================================================================ */

const EXCLUDED_FOLDERS = new Set(['node_modules', 'target', 'dist', 'build', '.git']);

function shouldExcludeFolder(folderName) {
    return folderName.startsWith('.') || EXCLUDED_FOLDERS.has(folderName.toLowerCase());
}

/* ================================================================
   BINARY FILE DETECTION
   ================================================================ */

const BINARY_EXTENSIONS = new Set([
    'png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'ico', 'svg',
    'mp3', 'mp4', 'wav', 'ogg', 'avi', 'mov', 'mkv',
    'exe', 'dll', 'so', 'dylib',
    'zip', 'rar', '7z', 'tar', 'gz', 'bz2',
    'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
    'class', 'jar', 'pyc', 'wasm', 'bin', 'dat'
]);

function isBinary(filePath) {
    const ext = path.extname(filePath).replace('.', '').toLowerCase();
    return BINARY_EXTENSIONS.has(ext);
}

/* ================================================================
   REPO LIST & SCANNING
   ================================================================ */

let repos = [];

function scanRepos() {
    repos = [];
    let folders;
    try {
        folders = fs.readdirSync(BASE_DIR);
    } catch (err) {
        console.error('Failed to scan BASE_DIR:', err.message);
        return;
    }

    for (const folder of folders) {
        if (shouldExcludeFolder(folder)) continue;
        const fullPath = path.join(BASE_DIR, folder);
        const gitPath = path.join(fullPath, '.git');
        try {
            if (fs.statSync(fullPath).isDirectory() && fs.existsSync(gitPath)) {
                repos.push({ name: folder, path: fullPath });
            }
        } catch { /* skip unreadable entries */ }
    }
    console.log(`Repos found: ${repos.length}`, repos.map(r => r.name));
}

scanRepos();

/* ================================================================
   GIT HELPERS  (promise-wrapped exec)
   ================================================================ */

function git(repoPath, args) {
    return new Promise((resolve, reject) => {
        exec(`git -C "${repoPath}" ${args}`, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
            if (err) return reject(new Error(stderr.trim() || err.message));
            resolve(stdout.trim());
        });
    });
}

/** Return { remoteUrl, repoName } for a repo path, or nulls on failure */
async function getRemoteMeta(repoPath) {
    try {
        const remoteUrl = await git(repoPath, 'remote get-url origin');
        // derive a clean name: last segment, strip .git
        const repoName = remoteUrl.split('/').pop().replace(/\.git$/, '');
        return { remoteUrl, repoName };
    } catch {
        // no remote configured – use folder name
        const repoName = path.basename(repoPath);
        return { remoteUrl: null, repoName };
    }
}

/** Wrap any payload with repo context */
async function withRepoMeta(repoPath, payload) {
    const { remoteUrl, repoName } = await getRemoteMeta(repoPath);
    let currentBranch = null;
    try { currentBranch = await git(repoPath, 'rev-parse --abbrev-ref HEAD'); } catch { }
    return { repoName, remoteUrl, currentBranch, ...payload };
}

/** Find a repo object by name (exact) */
function findRepo(name) {
    return repos.find(r => r.name === name) || null;
}

/* ================================================================
   FILE SYSTEM HELPERS
   ================================================================ */

/** Recursively walk a directory, calling callback(fullPath) for every file */
function walkDir(dir, callback) {
    let files;
    try { files = fs.readdirSync(dir); } catch { return; }
    for (const file of files) {
        const fullPath = path.join(dir, file);
        try {
            const stat = fs.statSync(fullPath);
            if (stat.isDirectory()) {
                if (!shouldExcludeFolder(file)) walkDir(fullPath, callback);
            } else {
                callback(fullPath);
            }
        } catch { /* skip */ }
    }
}

/**
 * Build a nested directory tree object (respects EXCLUDED_FOLDERS).
 * Returns { name, type:'directory'|'file', children?, size? }
 */
function buildTree(dir, rootPath) {
    const name = path.basename(dir);
    const node = { name, type: 'directory', path: path.relative(rootPath, dir) || '.', children: [] };
    let entries;
    try { entries = fs.readdirSync(dir); } catch { return node; }

    for (const entry of entries) {
        if (shouldExcludeFolder(entry)) continue;
        const fullPath = path.join(dir, entry);
        try {
            const stat = fs.statSync(fullPath);
            if (stat.isDirectory()) {
                node.children.push(buildTree(fullPath, rootPath));
            } else {
                node.children.push({
                    name: entry,
                    type: 'file',
                    path: path.relative(rootPath, fullPath),
                    size: stat.size,
                    extension: path.extname(entry).replace('.', '').toLowerCase() || null
                });
            }
        } catch { /* skip */ }
    }
    return node;
}

/* ================================================================
   REQUEST BODY PARSER
   ================================================================ */

function readBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', () => {
            try { resolve(JSON.parse(body)); }
            catch { reject(new Error('Invalid JSON')); }
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

function err400(res, msg) { send(res, 400, { error: msg }); }
function err404(res, msg) { send(res, 404, { error: msg }); }
function err500(res, msg) { send(res, 500, { error: msg }); }

/* ================================================================
   API HIT TRACKING
   ================================================================ */

const apiHitCounts = {
    'GET /git/repos': 0,
    'GET /git/rescan': 0,
    'GET /git/clone': 0,
    'GET /git/branches': 0,
    'POST /git/switch': 0,
    'GET /git/tree': 0,
    'GET /git/file': 0,
    'GET /git/filesByExtension': 0,
    'GET /git/remoteUrl': 0,
    'GET /git/log': 0,
    'GET /git/status': 0,
    'GET /git/findByName': 0,
    'GET /git/findByPartialName': 0,
    'GET /git/search': 0,
    'POST /git/readFiles': 0,
    'GET /git/pull': 0,
    'POST /git/writeFile': 0,
    'POST /git/deleteFile': 0,
    'POST /git/createDir': 0,
    'POST /git/renameFile': 0,
    'GET /git/diff': 0,
    'GET /git/show': 0
};

/* ================================================================
   SERVER
   ================================================================ */

const server = http.createServer(async (req, res) => {

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

    const parsed = url.parse(req.url, true);
    const { pathname, query } = parsed;

    /* ── GET /insights ─────────────────────────────────────────── */
    if (pathname === '/insights') {
        return send(res, 200, { apiHitCounts });
    }

    /* ── GET /health ──────────────────────────────────────────── */
    if (pathname === '/health') {
        return send(res, 200, {
            status: 'UP',
            version: '3.0',
            type: 'git-explorer-agent',
            baseDir: BASE_DIR,
            repoCount: repos.length,
            repos: repos.map(r => r.name)
        });
    }

    if (pathname === '/apidoc' && req.method === 'GET') {
        const content = getApiDocContent();
        if (!content) return send(res, 404, { error: 'API doc not found' });
        res.writeHead(200, { 'Content-Type': 'text/markdown' });
        return res.end(content);
    }

    /* ── GET /repos ───────────────────────────────────────────── */
    if (pathname === '/git/repos') {
        apiHitCounts['GET /git/repos']++;
        const list = await Promise.all(repos.map(async r => {
            const { remoteUrl, repoName } = await getRemoteMeta(r.path);
            let currentBranch = null;
            try { currentBranch = await git(r.path, 'rev-parse --abbrev-ref HEAD'); } catch { }
            return { folderName: r.name, repoName, remoteUrl, currentBranch, path: r.path };
        }));
        return send(res, 200, { count: list.length, repos: list });
    }

    /* ── GET /rescan ──────────────────────────────────────────── */
    if (pathname === '/git/rescan') {
        apiHitCounts['GET /git/rescan']++;
        scanRepos();
        return send(res, 200, { message: 'Rescanned', repoCount: repos.length, repos: repos.map(r => r.name) });
    }

    /* ── GET /clone?url=<gitUrl> ──────────────────────────────── */
    if (pathname === '/git/clone') {
        apiHitCounts['GET /git/clone']++;
        const repoUrl = query.url;
        if (!repoUrl) return err400(res, 'Provide ?url=<git-repo-url>');

        const repoName = repoUrl.split('/').pop().replace(/\.git$/, '');
        const targetPath = path.join(BASE_DIR, repoName);

        if (fs.existsSync(targetPath)) {
            return send(res, 200, { error: 'Repository already exists locally', repoName, path: targetPath });
        }

        exec(`git clone "${repoUrl}" "${targetPath}"`, { maxBuffer: 50 * 1024 * 1024 }, async (error, stdout, stderr) => {
            if (error) return err500(res, stderr.trim() || error.message);
            scanRepos();
            const repo = findRepo(repoName);
            const meta = repo ? await withRepoMeta(repo.path, { message: 'Cloned successfully' }) : { message: 'Cloned successfully', repoName };
            return send(res, 200, meta);
        });
        return; // async, response sent inside callback
    }

    /* ── GET /branches?repo=<name> ───────────────────────────── */
    if (pathname === '/git/branches') {
        apiHitCounts['GET /git/branches']++;
        const repo = findRepo(query.repo);
        if (!query.repo) return err400(res, 'Provide ?repo=<repoName>');
        if (!repo) return err404(res, `Repo "${query.repo}" not found`);

        try {
            const [localRaw, remoteRaw, currentBranch] = await Promise.all([
                git(repo.path, 'branch --format=%(refname:short)'),
                git(repo.path, 'branch -r --format=%(refname:short)'),
                git(repo.path, 'rev-parse --abbrev-ref HEAD')
            ]);

            const local = localRaw ? localRaw.split('\n').map(s => s.trim()).filter(Boolean) : [];
            const remote = remoteRaw ? remoteRaw.split('\n').map(s => s.trim()).filter(Boolean) : [];

            return send(res, 200, await withRepoMeta(repo.path, {
                currentBranch,
                localBranches: local,
                remoteBranches: remote
            }));
        } catch (e) { return err500(res, e.message); }
    }

    /* ── POST /switch  body: { repo, branch } ────────────────── */
    if (pathname === '/git/switch' && req.method === 'POST') {
        apiHitCounts['POST /git/switch']++;
        let body;
        try { body = await readBody(req); } catch { return err400(res, 'Invalid JSON body'); }

        const { repo: repoName, branch } = body;
        if (!repoName || !branch) return err400(res, 'Provide { repo, branch }');

        const repo = findRepo(repoName);
        if (!repo) return err404(res, `Repo "${repoName}" not found`);

        try {
            await git(repo.path, `checkout "${branch}"`);
            const currentBranch = await git(repo.path, 'rev-parse --abbrev-ref HEAD');
            return send(res, 200, await withRepoMeta(repo.path, {
                message: `Switched to branch "${branch}"`,
                currentBranch
            }));
        } catch (e) { return err500(res, e.message); }
    }

    /* ── GET /tree?repo=<name> ───────────────────────────────── */
    if (pathname === '/git/tree') {
        apiHitCounts['GET /git/tree']++;
        if (!query.repo) return err400(res, 'Provide ?repo=<repoName>');
        const repo = findRepo(query.repo);
        if (!repo) return err404(res, `Repo "${query.repo}" not found`);

        const tree = buildTree(repo.path, repo.path);
        return send(res, 200, await withRepoMeta(repo.path, { tree }));
    }

    /* ── GET /file?path=<absoluteOrRelative> ─────────────────── */
    /*   Returns full content of a single file.
         path can be absolute OR relative to BASE_DIR.           */
    if (pathname === '/git/file') {
        apiHitCounts['GET /git/file']++;
        const filePath = query.path;
        if (!filePath) return err400(res, 'Provide ?path=<filePath>');

        const absPath = path.isAbsolute(filePath) ? filePath : path.join(BASE_DIR, filePath);

        if (!fs.existsSync(absPath) || !fs.statSync(absPath).isFile()) {
            return err404(res, `File not found: ${absPath}`);
        }
        if (isBinary(absPath)) return err400(res, 'File is binary – cannot return content');

        // Figure out which repo this file belongs to (if any)
        const ownerRepo = repos.find(r => absPath.startsWith(r.path + path.sep));

        try {
            const content = fs.readFileSync(absPath, 'utf8');
            const stat = fs.statSync(absPath);
            const base = { filePath: absPath, size: stat.size, extension: path.extname(absPath).replace('.', '') || null, content };

            if (ownerRepo) {
                return send(res, 200, await withRepoMeta(ownerRepo.path, base));
            }
            return send(res, 200, { repoName: null, remoteUrl: null, ...base });
        } catch (e) { return err500(res, e.message); }
    }

    /* ── GET /filesByExtension?repo=<name>&ext=<ext[,ext2]> ──── */
    /*   Returns full paths of all files matching given extension(s).
         ext can be comma-separated: js,ts,jsx                    */
    if (pathname === '/git/filesByExtension') {
        apiHitCounts['GET /git/filesByExtension']++;
        if (!query.repo) return err400(res, 'Provide ?repo=<repoName>');
        if (!query.ext)  return err400(res, 'Provide ?ext=<extension> (e.g. js or js,ts,jsx)');

        const repo = findRepo(query.repo);
        if (!repo) return err404(res, `Repo "${query.repo}" not found`);

        const exts = new Set(query.ext.toLowerCase().split(',').map(e => e.trim().replace(/^\./, '')));
        const matched = [];

        walkDir(repo.path, file => {
            const ext = path.extname(file).replace('.', '').toLowerCase();
            if (exts.has(ext)) matched.push(file);
        });

        return send(res, 200, await withRepoMeta(repo.path, {
            extensions: [...exts],
            count: matched.length,
            files: matched
        }));
    }

    /* ── GET /remoteUrl?repo=<name> ──────────────────────────── */
    if (pathname === '/git/remoteUrl') {
        apiHitCounts['GET /git/remoteUrl']++;
        if (!query.repo) return err400(res, 'Provide ?repo=<repoName>');
        const repo = findRepo(query.repo);
        if (!repo) return err404(res, `Repo "${query.repo}" not found`);

        try {
            const remotes = await git(repo.path, 'remote -v');
            const lines = remotes.split('\n').filter(Boolean);
            const parsed_remotes = {};
            for (const line of lines) {
                // format: origin\thttps://... (fetch)
                const m = line.match(/^(\S+)\s+(\S+)\s+\((\w+)\)$/);
                if (m) {
                    if (!parsed_remotes[m[1]]) parsed_remotes[m[1]] = {};
                    parsed_remotes[m[1]][m[3]] = m[2];
                }
            }
            const { remoteUrl, repoName } = await getRemoteMeta(repo.path);
            return send(res, 200, { repoName, remoteUrl, remotes: parsed_remotes });
        } catch (e) { return err500(res, e.message); }
    }

    /* ── GET /log?repo=<name>&branch=<branch>&limit=<n> ──────── */
    if (pathname === '/git/log') {
        apiHitCounts['GET /git/log']++;
        if (!query.repo) return err400(res, 'Provide ?repo=<repoName>');
        const repo = findRepo(query.repo);
        if (!repo) return err404(res, `Repo "${query.repo}" not found`);

        const limit = Math.min(parseInt(query.limit) || 20, 200);
        const branchArg = query.branch ? `"${query.branch}"` : 'HEAD';

        try {
            const raw = await git(repo.path,
                `log ${branchArg} --pretty=format:"%H|%an|%ae|%ad|%s" --date=iso -n ${limit}`);
            const commits = raw.split('\n').filter(Boolean).map(line => {
                const [hash, author, email, date, ...msgParts] = line.split('|');
                return { hash, author, email, date, message: msgParts.join('|') };
            });
            return send(res, 200, await withRepoMeta(repo.path, { branch: query.branch || 'HEAD', count: commits.length, commits }));
        } catch (e) { return err500(res, e.message); }
    }

    /* ── GET /status?repo=<name> ─────────────────────────────── */
    if (pathname === '/git/status') {
        apiHitCounts['GET /git/status']++;
        if (!query.repo) return err400(res, 'Provide ?repo=<repoName>');
        const repo = findRepo(query.repo);
        if (!repo) return err404(res, `Repo "${query.repo}" not found`);

        try {
            const raw = await git(repo.path, 'status --porcelain');
            const lines = raw.split('\n').filter(Boolean);
            const files = lines.map(l => ({
                status: l.substring(0, 2).trim(),
                file: l.substring(3).trim()
            }));
            return send(res, 200, await withRepoMeta(repo.path, {
                clean: files.length === 0,
                changedFileCount: files.length,
                files
            }));
        } catch (e) { return err500(res, e.message); }
    }

    /* ── GET /findByName?repo=<name>&name=<fileName> ─────────── */
    /*   Exact file name match across one repo (or all if no repo given) */
    if (pathname === '/git/findByName') {
        apiHitCounts['GET /git/findByName']++;
        const name = query.name;
        if (!name) return err400(res, 'Provide ?name=<fileName>');

        const targetRepos = query.repo ? [findRepo(query.repo)].filter(Boolean) : repos;
        if (query.repo && targetRepos.length === 0) return err404(res, `Repo "${query.repo}" not found`);

        const results = [];
        targetRepos.forEach(repo => {
            walkDir(repo.path, file => {
                if (path.basename(file) === name) results.push(file);
            });
        });

        // If single repo, wrap with meta
        if (query.repo && targetRepos.length === 1) {
            return send(res, 200, await withRepoMeta(targetRepos[0].path, { query: name, count: results.length, files: results }));
        }
        return send(res, 200, { query: name, count: results.length, files: results });
    }

    /* ── GET /findByPartialName?repo=<name>&name=<partial> ───── */
    if (pathname === '/git/findByPartialName') {
        apiHitCounts['GET /git/findByPartialName']++;
        const name = query.name;
        if (!name) return err400(res, 'Provide ?name=<partialName>');

        const lower = name.toLowerCase();
        const targetRepos = query.repo ? [findRepo(query.repo)].filter(Boolean) : repos;
        if (query.repo && targetRepos.length === 0) return err404(res, `Repo "${query.repo}" not found`);

        const results = [];
        targetRepos.forEach(repo => {
            walkDir(repo.path, file => {
                if (path.basename(file).toLowerCase().includes(lower)) results.push(file);
            });
        });

        if (query.repo && targetRepos.length === 1) {
            return send(res, 200, await withRepoMeta(targetRepos[0].path, { query: name, count: results.length, files: results }));
        }
        return send(res, 200, { query: name, count: results.length, files: results });
    }

    /* ── GET /search?repo=<name>&text=<text> ─────────────────── */
    /*   Full text search across files, returns line matches      */
    if (pathname === '/git/search') {
        apiHitCounts['GET /git/search']++;
        const text = query.text;
        if (!text) return err400(res, 'Provide ?text=<searchText>');

        const targetRepos = query.repo ? [findRepo(query.repo)].filter(Boolean) : repos;
        if (query.repo && targetRepos.length === 0) return err404(res, `Repo "${query.repo}" not found`);

        const lowerSearch = text.toLowerCase();
        const results = [];

        targetRepos.forEach(repo => {
            walkDir(repo.path, file => {
                if (isBinary(file)) return;
                try {
                    const content = fs.readFileSync(file, 'utf8');
                    const lines = content.split(/\r?\n/);
                    const matches = [];
                    lines.forEach((line, idx) => {
                        const foundAt = line.toLowerCase().indexOf(lowerSearch);
                        if (foundAt !== -1) {
                            const start = Math.max(0, foundAt - 40);
                            const end = Math.min(line.length, foundAt + lowerSearch.length + 40);
                            matches.push({
                                lineNumber: idx + 1,
                                snippet: line.length > 80 ? line.substring(start, end) : line
                            });
                        }
                    });
                    if (matches.length) results.push({ file, matchCount: matches.length, matches });
                } catch { /* unreadable file */ }
            });
        });

        if (query.repo && targetRepos.length === 1) {
            return send(res, 200, await withRepoMeta(targetRepos[0].path, {
                searchText: text, totalFiles: results.length,
                totalMatches: results.reduce((a, r) => a + r.matchCount, 0),
                results
            }));
        }
        return send(res, 200, {
            searchText: text, totalFiles: results.length,
            totalMatches: results.reduce((a, r) => a + r.matchCount, 0),
            results
        });
    }

    /* ── POST /readFiles   body: ["/abs/path1", "/abs/path2"] ── */
    /*   Batch read multiple files by absolute path              */
    if (pathname === '/git/readFiles' && req.method === 'POST') {
        apiHitCounts['POST /git/readFiles']++;
        let filePaths;
        try { filePaths = await readBody(req); } catch { return err400(res, 'Invalid JSON body'); }
        if (!Array.isArray(filePaths) || filePaths.length === 0) {
            return err400(res, 'Body must be a non-empty array of file paths');
        }

        const result = {};
        for (const fp of filePaths) {
            const absPath = path.isAbsolute(fp) ? fp : path.join(BASE_DIR, fp);
            if (!fs.existsSync(absPath) || !fs.statSync(absPath).isFile()) {
                result[fp] = { error: 'Not found' };
            } else if (isBinary(absPath)) {
                result[fp] = { error: 'Binary file' };
            } else {
                try { result[fp] = { content: fs.readFileSync(absPath, 'utf8') }; }
                catch (e) { result[fp] = { error: e.message }; }
            }
        }
        return send(res, 200, { count: filePaths.length, files: result });
    }

    /* ── GET /pull?repo=<name> ───────────────────────────────── */
    if (pathname === '/git/pull') {
        apiHitCounts['GET /git/pull']++;
        if (!query.repo) return err400(res, 'Provide ?repo=<repoName>');
        const repo = findRepo(query.repo);
        if (!repo) return err404(res, `Repo "${query.repo}" not found`);

        try {
            const output = await git(repo.path, 'pull');
            return send(res, 200, await withRepoMeta(repo.path, { message: output }));
        } catch (e) { return err500(res, e.message); }
    }

    /* ── POST /writeFile  body: { repo, path, content } ──────── */
    if (pathname === '/git/writeFile' && req.method === 'POST') {
        apiHitCounts['POST /git/writeFile']++;
        let body;
        try { body = await readBody(req); } catch { return err400(res, 'Invalid JSON body'); }

        const { repo: repoName, path: filePath, content } = body;
        if (!repoName || !filePath || content === undefined) return err400(res, 'Provide { repo, path, content }');

        const repo = findRepo(repoName);
        if (!repo) return err404(res, `Repo "${repoName}" not found`);

        const absPath = path.join(repo.path, filePath);
        if (!absPath.startsWith(repo.path + path.sep) && absPath !== repo.path) {
            return err400(res, 'Path escapes repository boundary');
        }

        try {
            fs.mkdirSync(path.dirname(absPath), { recursive: true });
            fs.writeFileSync(absPath, content, 'utf8');
            const stat = fs.statSync(absPath);
            return send(res, 200, await withRepoMeta(repo.path, {
                message: `File written: ${filePath}`,
                filePath: absPath,
                size: stat.size
            }));
        } catch (e) { return err500(res, e.message); }
    }

    /* ── POST /deleteFile  body: { repo, path } ─────────────── */
    if (pathname === '/git/deleteFile' && req.method === 'POST') {
        apiHitCounts['POST /git/deleteFile']++;
        let body;
        try { body = await readBody(req); } catch { return err400(res, 'Invalid JSON body'); }

        const { repo: repoName, path: filePath } = body;
        if (!repoName || !filePath) return err400(res, 'Provide { repo, path }');

        const repo = findRepo(repoName);
        if (!repo) return err404(res, `Repo "${repoName}" not found`);

        const absPath = path.join(repo.path, filePath);
        if (!absPath.startsWith(repo.path + path.sep)) {
            return err400(res, 'Path escapes repository boundary');
        }

        if (!fs.existsSync(absPath)) return err404(res, `File not found: ${filePath}`);

        try {
            const stat = fs.statSync(absPath);
            if (stat.isDirectory()) {
                fs.rmSync(absPath, { recursive: true });
            } else {
                fs.unlinkSync(absPath);
            }
            return send(res, 200, await withRepoMeta(repo.path, {
                message: `Deleted: ${filePath}`,
                deletedPath: absPath
            }));
        } catch (e) { return err500(res, e.message); }
    }

    /* ── POST /createDir  body: { repo, path } ──────────────── */
    if (pathname === '/git/createDir' && req.method === 'POST') {
        apiHitCounts['POST /git/createDir']++;
        let body;
        try { body = await readBody(req); } catch { return err400(res, 'Invalid JSON body'); }

        const { repo: repoName, path: dirPath } = body;
        if (!repoName || !dirPath) return err400(res, 'Provide { repo, path }');

        const repo = findRepo(repoName);
        if (!repo) return err404(res, `Repo "${repoName}" not found`);

        const absPath = path.join(repo.path, dirPath);
        if (!absPath.startsWith(repo.path + path.sep)) {
            return err400(res, 'Path escapes repository boundary');
        }

        try {
            fs.mkdirSync(absPath, { recursive: true });
            return send(res, 200, await withRepoMeta(repo.path, {
                message: `Directory created: ${dirPath}`,
                dirPath: absPath
            }));
        } catch (e) { return err500(res, e.message); }
    }

    /* ── POST /renameFile  body: { repo, oldPath, newPath } ──── */
    if (pathname === '/git/renameFile' && req.method === 'POST') {
        apiHitCounts['POST /git/renameFile']++;
        let body;
        try { body = await readBody(req); } catch { return err400(res, 'Invalid JSON body'); }

        const { repo: repoName, oldPath, newPath } = body;
        if (!repoName || !oldPath || !newPath) return err400(res, 'Provide { repo, oldPath, newPath }');

        const repo = findRepo(repoName);
        if (!repo) return err404(res, `Repo "${repoName}" not found`);

        const absOld = path.join(repo.path, oldPath);
        const absNew = path.join(repo.path, newPath);
        if (!absOld.startsWith(repo.path + path.sep) || !absNew.startsWith(repo.path + path.sep)) {
            return err400(res, 'Path escapes repository boundary');
        }

        if (!fs.existsSync(absOld)) return err404(res, `Source not found: ${oldPath}`);

        try {
            fs.mkdirSync(path.dirname(absNew), { recursive: true });
            await git(repo.path, `mv "${oldPath}" "${newPath}"`);
            return send(res, 200, await withRepoMeta(repo.path, {
                message: `Renamed: ${oldPath} → ${newPath}`,
                oldPath: absOld,
                newPath: absNew
            }));
        } catch (e) { return err500(res, e.message); }
    }

    /* ── GET /diff?repo=&staged=&branch=&commit= ────────────── */
    if (pathname === '/git/diff') {
        apiHitCounts['GET /git/diff']++;
        if (!query.repo) return err400(res, 'Provide ?repo=<repoName>');
        const repo = findRepo(query.repo);
        if (!repo) return err404(res, `Repo "${query.repo}" not found`);

        try {
            let args = 'diff';
            if (query.staged === 'true') args += ' --staged';
            else if (query.branch) args += ` ${query.branch}`;
            else if (query.commit) args += ` ${query.commit}`;

            const raw = await git(repo.path, args);
            return send(res, 200, await withRepoMeta(repo.path, {
                diffType: query.staged === 'true' ? 'staged' : query.branch ? 'branch' : query.commit ? 'commit' : 'unstaged',
                diff: raw
            }));
        } catch (e) { return err500(res, e.message); }
    }

    /* ── GET /show?repo=&commit= ─────────────────────────────── */
    if (pathname === '/git/show') {
        apiHitCounts['GET /git/show']++;
        if (!query.repo) return err400(res, 'Provide ?repo=<repoName>');
        if (!query.commit) return err400(res, 'Provide ?commit=<commitHash>');
        const repo = findRepo(query.repo);
        if (!repo) return err404(res, `Repo "${query.repo}" not found`);

        try {
            const raw = await git(repo.path, `show "${query.commit}"`);
            const lines = raw.split('\n');
            const diffStart = lines.findIndex((l, i) => i > 3 && l.startsWith('diff --git'));
            const header = diffStart > 0 ? lines.slice(0, diffStart).join('\n') : raw;
            const patch = diffStart > 0 ? lines.slice(diffStart).join('\n') : '';

            return send(res, 200, await withRepoMeta(repo.path, {
                commit: query.commit,
                header,
                patch
            }));
        } catch (e) { return err500(res, e.message); }
    }

    /* ── 404 ──────────────────────────────────────────────────── */
    send(res, 404, {
        error: 'Endpoint not found',
        availableEndpoints: [
            'GET  /health',
            'GET  /git/repos',
            'GET  /git/rescan',
            'GET  /git/clone?url=',
            'GET  /git/branches?repo=',
            'POST /git/switch  { repo, branch }',
            'GET  /git/tree?repo=',
            'GET  /git/file?path=',
            'GET  /git/filesByExtension?repo=&ext=',
            'GET  /git/remoteUrl?repo=',
            'GET  /git/log?repo=&branch=&limit=',
            'GET  /git/status?repo=',
            'GET  /git/findByName?repo=&name=',
            'GET  /git/findByPartialName?repo=&name=',
            'GET  /git/search?repo=&text=',
            'POST /git/readFiles  ["/abs/path1", ...]',
            'GET  /git/pull?repo=',
            'POST /git/writeFile  { repo, path, content }',
            'POST /git/deleteFile  { repo, path }',
            'POST /git/createDir  { repo, path }',
            'POST /git/renameFile  { repo, oldPath, newPath }',
            'GET  /git/diff?repo=&staged=&branch=&commit=',
            'GET  /git/show?repo=&commit='
        ]
    });
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
    console.log(`Git Explorer v2.0 running at http://localhost:${PORT}`);
    console.log('Endpoints: GET /health for full API listing');
});