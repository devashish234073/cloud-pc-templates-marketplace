ToolsExplorer: This tool provides apis that can be called to get the version of various tools, like java,maven,node,npm,python,etc.
"agentId": "tools-explorer"
Health Check
1. GET http://localhost:3032/health

Response:

{
  "status": "UP",
  "service": "Tools Explorer",
  "port": 3032
}
2. Get All Tool Versions
GET http://localhost:3032/versions
3. Get Specific Tool Version
GET http://localhost:3032/version?tool=java
GET http://localhost:3032/version?tool=maven
GET http://localhost:3032/version?tool=node
GET http://localhost:3032/version?tool=npm
GET http://localhost:3032/version?tool=python
Example Response (Installed)
{
  "tool": "node",
  "result": {
    "installed": true,
    "version": "v20.11.1"
  }
}
💡 Example Response (Not Installed)
{
  "tool": "maven",
  "result": {
    "installed": false,
    "error": "Command failed: mvn -version"
  }
}

4. Timer Endpoint
GET http://localhost:3032/timer

Behavior:
- Calling /timer without a ref query parameter creates a new timer reference and returns the current time in milliseconds plus a unique uuid.
- Calling /timer?ref=<uuid> later returns the current time and the elapsed milliseconds since the first call for that uuid.

Example Response (first call)
{
  "timeMillis": 1720456789123,
  "date": "2026-07-08T12:34:49.123Z",
  "uuid": "8f3f8d2b-7a11-4d85-bd7b-17b5278a2f3d"
}

Example Response (subsequent call)
{
  "ref": "8f3f8d2b-7a11-4d85-bd7b-17b5278a2f3d",
  "timeMillis": 1720456791123,
  "date": "2026-07-08T12:34:51.123Z",
  "elapsedMs": 2000
}

5. System Usage
GET http://localhost:3032/system-usage

Behavior:
- Returns real-time CPU and RAM usage of the system.
- Works on both Windows and Linux. No additional npm packages required.
- CPU usage is calculated by sampling os.cpus() twice over 200ms and computing the average idle/total time delta across all cores.

Example Response:
{
  "cpu": {
    "usagePercent": 12.45,
    "cores": 8,
    "model": "Intel(R) Core(TM) i7-8750H CPU @ 2.20GHz"
  },
  "ram": {
    "totalMB": 16384,
    "usedMB": 9200.5,
    "freeMB": 7183.5,
    "usagePercent": 56.15
  },
  "platform": "linux"
}

6. NPM Activity Report
GET http://localhost:3032/npm-activity

Query Parameters:
- `date` (optional): `YYYY-MM-DD` to report activity for a specific day. Defaults to today.
- `roots` (optional): comma-separated list of absolute root directories to scan for `node_modules` package activity. Defaults to the current user's home directory.

Behavior:
- Reads npm debug log entries from `~/.npm/_logs` for the requested date.
- Scans `node_modules` trees under the given root directories for folders whose modification time falls within the requested date.
- Checks the npx cache at `~/.npm/_npx` for package activity on that date.
- Reads global npm packages from the npm prefix's `lib/node_modules` tree for packages touched on that date.

Example Requests:
GET http://localhost:3032/npm-activity
GET http://localhost:3032/npm-activity?date=2026-08-04
GET http://localhost:3032/npm-activity?date=2026-08-04&roots=/home/me,/opt/projects

Example Response:
{
  "date": "2026-08-04",
  "npmCommands": [
    {
      "file": "2026-08-04T09_12_33_123-debug-12345.log",
      "timestamp": "09:12:33:123",
      "command": "npm install express"
    }
  ],
  "nodeModulesChanges": [
    {
      "project": "/home/me/projects/my-app",
      "name": "express",
      "version": "4.18.2",
      "mtime": "2026-08-04T09:12:33.123Z",
      "path": "/home/me/projects/my-app/node_modules/express"
    }
  ],
  "npxCache": [
    {
      "name": "create-react-app",
      "version": "5.0.1",
      "mtime": "2026-08-04T10:00:00.000Z",
      "path": "/home/me/.npm/_npx/12345/create-react-app"
    }
  ],
  "globalPackages": [
    {
      "name": "npm",
      "version": "10.3.0",
      "mtime": "2026-08-04T11:00:00.000Z",
      "path": "/usr/local/lib/node_modules/npm"
    }
  ]
}
