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
    BASE_DIR = process.platform === 'win32' ? 'C:\\' : '/';
}

console.log("Scanning Base Directory:", BASE_DIR);

/* ------------------ BINARY EXTENSION FILTER ------------------ */

const BLOCKED_EXTENSIONS = [
    'pdf','doc','docx','ppt','pptx','xls','xlsx',
    'png','jpg','jpeg','gif','bmp','webp',
    'mp3','mp4','wav','avi','mkv','mov',
    'exe','dll','bin','iso','zip','rar','7z'
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
            } catch {}
        }
    } catch {}

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
            } catch {}
        }
    } catch {}

    return results;
}

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
            baseDir: BASE_DIR
        }));
    }

    /* -------- FIND FILE -------- */
    if (parsedUrl.pathname === '/findFile') {
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

    /* -------- READ FILE (NEW) -------- */
    if (parsedUrl.pathname === '/readFile') {
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

server.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});
