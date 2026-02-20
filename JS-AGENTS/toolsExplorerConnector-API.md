ToolsExplorer: This tool provides apis that can be called to get the version of various tools, like java,maven,node,npm,python,etc.
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