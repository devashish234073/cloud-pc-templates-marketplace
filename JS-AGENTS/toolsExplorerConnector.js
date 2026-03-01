const http = require('http');
const url = require('url');
const { exec } = require('child_process');

const PORT = 3032;

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
            version: '1.0',
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

    /* -------- 404 -------- */
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not Found' }));
});

server.listen(PORT, () => {
    console.log(`Tools Explorer running at http://localhost:${PORT}`);
});