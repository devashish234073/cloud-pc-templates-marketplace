NODE.JS CONNECTOR API (http://localhost:3041)

All endpoints scoped to a project use ?projectName=<name> where name is the project folder name shown in /node/projects.

GET /health
Returns: {"status":"UP","version":"1.0","type":"nodejs-connector-agent","baseDir":"/path","projectCount":2,"projects":["my-api","utils"],"requirements":{"ok":true,"version":"20.11.0","major":20}}

GET /node/projects
List all tracked projects.
Returns: {"count":2,"projects":[{"name":"my-api","type":"api","path":"/abs/path","createdAt":"...","running":false}]}

POST /node/create
Body: {"name":"my-api","type":"api"}
Create a new Node.js project. type is "api" (default, Express app with routes/middleware/health endpoint) or "standalone" (minimal index.js). After creation, run POST /node/npm-init-run to install dependencies.
Returns: {"message":"Project 'my-api' created successfully (type: api)","project":{...},"files":[...],"nextStep":"Run POST /node/npm-init-run?projectName=my-api to install dependencies"}

GET /node/rescan
Re-scan base directory for projects (detects dirs with package.json).
Returns: {"message":"Rescanned","projectCount":3,"projects":["my-api","utils","service"]}

GET /node/project-details?projectName=<name>
Full project info including package.json summary, node_modules status, and run state.
Returns: {"projectName":"my-api","projectInfo":{...},"packageJson":{"name":"my-api","version":"1.0.0","main":"app.js","scripts":{...},"dependencyCount":2,"devDependencyCount":1},"nodeModulesInstalled":true,"running":false}

POST /node/dependency?projectName=<name>
Body: {"package":"cors"} or {"packages":["cors","helmet"],"dev":false}
Install one or more npm packages. Set dev:true for devDependencies.
Returns: {"message":"Installed: cors, helmet","dependencies":{...},"devDependencies":{...}}

POST /node/dependency/remove?projectName=<name>
Body: {"package":"cors"} or {"packages":["cors","helmet"]}
Uninstall one or more npm packages.
Returns: {"message":"Removed: cors","dependencies":{...},"devDependencies":{...}}

GET /node/dependencies?projectName=<name>
List all dependencies and devDependencies from package.json.
Returns: {"dependencies":{"express":"^4.21.0"},"devDependencies":{"nodemon":"^3.1.0"},"totalCount":2}

POST /node/file?projectName=<name>&filePath=<relative/path>
Body: {"content":"const x = 1;"}
Create or overwrite a file. Parent directories are created automatically. filePath is relative to project root.
Returns: {"message":"File created","filePath":"src/utils.js","absolutePath":"/abs/path","overwritten":false,"size":14}

GET /node/file?projectName=<name>&filePath=<relative/path>
Read a single text file. Binary files are rejected.
Returns: {"filePath":"app.js","absolutePath":"/abs/path","content":"...","size":1024,"lastModified":"..."}

PUT /node/file?projectName=<name>&filePath=<relative/path>
Body: {"content":"..."}
Overwrite an existing file. Returns 404 if file doesn't exist (use POST to create).
Returns: {"message":"File updated","filePath":"app.js","size":1024}

PATCH /node/file?projectName=<name>&filePath=<relative/path>
Body: {"targetContent":"old code","replacementContent":"new code"} or {"replacements":[{"targetContent":"...","replacementContent":"..."}]}
Patch a file via search-and-replace. Each targetContent must appear exactly once in the file.
Returns: {"message":"File patched","filePath":"app.js","replacementsApplied":1}

GET /node/files?projectName=<name>
List all source files (excludes node_modules, .git, dist, build, coverage, hidden dirs).
Returns: {"totalCount":5,"files":[{"relativePath":"app.js","absolutePath":"/abs/path","size":1024,"extension":"js"}]}

GET /node/package-json?projectName=<name>&raw=true
Read package.json as parsed JSON. Add raw=true to include the raw string.
Returns: {"packageJson":{"name":"my-api","version":"1.0.0","dependencies":{...},"scripts":{...}},"rawJson":"..."}

PUT /node/script?projectName=<name>
Body: {"scripts":{"test":"jest","lint":"eslint ."}}
Add or update npm scripts in package.json. Merges with existing scripts.
Returns: {"message":"Scripts updated","scripts":{"start":"node app.js","test":"jest","lint":"eslint ."}}

POST /node/run?projectName=<name>&script=<scriptName>
Start the project in the background. script defaults to "start". Runs npm run <script>.
Returns: {"message":"Project 'my-api' started with 'npm run start'","pid":12345,"startedAt":"..."}

POST /node/stop?projectName=<name>
Stop a running project.
Returns: {"message":"Project 'my-api' stopped","pid":12345,"ranFor":"45s"}

GET /node/run-status?projectName=<name>
Check if a project is running and get stdout/stderr tail.
Returns: {"running":true,"pid":12345,"script":"start","startedAt":"...","stdoutTail":"...","stderrTail":"..."}
Returns: {"running":false} when not running.

POST /node/exec?projectName=<name>
Body: {"command":"npm test"}
Run an arbitrary command in the project directory. Returns 200 even on failure so orchestrator gets the error output.
Returns: {"message":"Command executed","command":"npm test","output":"..."} or {"message":"Command failed","success":false,"error":"...","stdout":"...","stderr":"..."}

GET /node/env?projectName=<name>
Read the .env file as parsed key-value pairs and raw string.
Returns: {"exists":true,"variables":{"PORT":"3000","NODE_ENV":"development"},"raw":"PORT=3000\nNODE_ENV=development\n"}

POST /node/env?projectName=<name>
Body: {"variables":{"PORT":"4000","DB_URL":"..."}} or {"raw":"PORT=4000\n..."}
Write or merge .env file. When using variables, merges with existing .env. When using raw, replaces entirely.
Returns: {"message":".env updated","envPath":"/abs/path/.env"}

POST /node/npm-init-run?projectName=<name>
Run npm install for a project. Use after creating a project or modifying package.json manually.
Returns: {"message":"npm install completed","nodeModulesExists":true,"npmOutput":"..."}
