GitExplorer: This tool provides APIs to manage and explore Git repositories. It allows cloning repositories into a specified base folder, listing detected repositories, and searching source code by file name or content. The application must be started as:

node git-explorer.js <foldername>

All cloned repositories will be stored inside the provided <foldername>. On startup, the application scans the folder and automatically detects any directory containing a .git folder and maintains an internal repository list.

Server Port
All APIs run on:
http://localhost:3033

Health Check

GET http://localhost:3033/health

Response:
{
"status": "UP",
"baseDir": "C:\path\to\your\folder",
"repoCount": 3
}

List All Repositories
2. GET http://localhost:3033/repos

Response:
{
"count": 3,
"repos": [
{
"name": "repo1",
"path": "C:\repos\repo1"
},
{
"name": "repo2",
"path": "C:\repos\repo2"
}
]
}

Clone Repository
3. GET http://localhost:3033/clone?url=https://github.com/user/repo.git

Response (Success):
{
"message": "Repository cloned successfully",
"repo": "repo"
}

Response (Already Exists):
{
"error": "Repository already exists"
}

Response (Clone Error):
{
"error": "fatal: repository not found"
}

Find File By Exact Name
4. GET http://localhost:3033/findByFileName?name=package.json

Response:
{
"count": 2,
"files": [
"C:\repos\repo1\package.json",
"C:\repos\repo2\package.json"
]
}

Find File By Partial Name
5. GET http://localhost:3033/findByPartialFileName?name=service

Response:
{
"count": 4,
"files": [
"C:\repos\repo1\src\userService.js",
"C:\repos\repo2\src\paymentService.js"
]
}

Search By File Content
6. GET http://localhost:3033/findByContent?text=database
 connection

Response:
{
"search": "database connection",
"count": 1,
"results": [
{
"file": "C:\repos\repo1\src\config.js",
"matches": [
{
"lineNumber": 12,
"line": "const databaseConnection = createConnection(...);"
}
]
}
]
}

Automatic Folder Exclusions
The following folders are automatically excluded from scanning:

Any folder starting with a dot (example: .git, .idea, .vscode)

node_modules

target

This improves performance and prevents scanning dependency or build folders.

Error Response (Missing Parameters Example)
{
"error": "Provide required query parameter"
}

404 Response
{
"error": "Not Found"
}