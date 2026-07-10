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