GitExplorer: This tool provides APIs to manage and explore Git repositories. It allows cloning repositories into a specified base folder, listing detected repositories, searching source code by file name or content, and retrieving content of multiple files in a single request.

Server Port
All APIs run on:
http://localhost:3033

To Check Health of the git explorer agent call

GET http://localhost:3033/health

Response will look like:
{"status":"UP","baseDir":"C:\path\to\your\folder","repoCount":3}

To List All Repositories using git explorer agent call

GET http://localhost:3033/repos

Response will look like:
{"count":3,"repos":[{"name":"repo1","path":"C:\repos\repo1"},{"name":"repo2","path":"C:\repos\repo2"}]}

To Clone a Repository using git explorer agent call

GET http://localhost:3033/clone?url=https://github.com/user/repo.git

Response (Success) will look like:
{"message":"Repository cloned successfully","repo":"repo"}

Response (Already Exists):
{"error":"Repository already exists"}

Response (Clone Error):
{"error":"fatal: repository not found"}

To Find a File across repos using git explorer agent By Exact Name call

GET http://localhost:3033/findByFileName?name=package.json

Response will look like:
{"count":2,"files":["C:\repos\repo1\package.json","C:\repos\repo2\package.json"]}

To Find File in repositories using git explorer agent By Partial Name call

GET http://localhost:3033/findByPartialFileName?name=service

Response will look like:
{"count":4,"files":["C:\repos\repo1\src\userService.js","C:\repos\repo2\src\paymentService.js"]}

To Search By File Content using git explorer agent call

GET http://localhost:3033/findByContent?text=database
 connection

Response will look like:
{"search":"database connection","count":1,"results":[{"file":"C:\repos\repo1\src\config.js","matches":[{"lineNumber":12,"line":"const databaseConnection = createConnection(...);"}]}]}

To Retrieve Content of Multiple Files using git explorer agent call

POST http://localhost:3033/getFilesContent

Request Payload (raw JSON array):
["test.js","config.js"]

Response will look like:
{"test.js":[{"path":"C:\repos\repo1\test.js","content":"console.log('hello');"},{"path":"C:\repos\repo2\src\test.js","content":"export default function(){}"}],"config.js":[{"path":"C:\repos\repo1\config.js","content":"module.exports = {};"}]}

If a file name is not found, it will return empty array for that file:
{"unknown.js":[]}

Automatic Folder Exclusions
The following folders are automatically excluded from scanning:

Any folder starting with a dot (example: .git, .idea, .vscode)

node_modules

target

Error Response (Missing Parameters Example)
{"error":"Provide required query parameter"}

Invalid JSON Payload Example (For POST)
{"error":"Invalid JSON payload"}

404 Response
{"error":"Not Found"}