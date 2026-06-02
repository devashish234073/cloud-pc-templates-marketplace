SQL CONNECTOR API (http://localhost:3037)

All credentials and database name are hardcoded server-side. No credentials or database details are passed in any request.
Database in use: cloud_pc_templates_agent

All endpoints always return HTTP 200. Errors are indicated by the presence of an "error" field in the response body, never by the HTTP status code.

GET /health
Returns: {"status":"UP","version":"1.0","type":"agent","service":"SQL Connector","port":3037}

GET /mysql/check
Checks if the mysql and mysqladmin CLI binaries are installed on the system.
Returns response like:
{
  "mysqlClient": {
    "installed": true,
    "version": "mysql  Ver 8.0.39 for Linux on x86_64 (MySQL Community Server - GPL)",
    "error": null
  },
  "mysqladmin": {
    "installed": true,
    "version": "mysqladmin  Ver 8.0.39 for Linux on x86_64",
    "error": null
  }
}

GET /mysql/setup-or-status
Dual-purpose endpoint. No query params required.
  - If MySQL is NOT reachable: attempts to install and start mysql-server via apt, creates the app user, then returns setup steps and final status.
  - If MySQL IS reachable: checks if the app user exists and creates it if missing, then returns server status and list of databases.
Returns response like:
{
  "action": "status_reported",
  "message": "MySQL server is reachable.",
  "server": {
    "host": "localhost",
    "port": "3306",
    "user": "devas",
    "clientVersion": "mysql  Ver 8.0.39 ...",
    "pingOutput": "mysqld is alive"
  },
  "userCheck": {
    "step": "check user exists",
    "exists": true,
    "message": "User 'devas'@'localhost' already exists."
  },
  "databases": ["information_schema", "cloud_pc_templates_agent"],
  "databaseCount": 2,
  "currentDatabase": null,
  "serverVersion": "8.0.39",
  "activeConnections": "3"
}
On failure returns HTTP 200 with an error field like:
{
  "error": "MySQL was not reachable and automatic setup also failed. Manual intervention required."
}

GET /mysql/query?q=SELECT+*+FROM+employee
Runs a SQL query against the cloud_pc_templates_agent database. q is the only required param.
To include spaces in the query use + or %20 (e.g. SELECT+*+FROM+employee or SELECT%20*%20FROM%20employee).
First checks that the server is reachable, then executes the query via the mysql CLI.
Returns response like:
{
  "query": "SELECT * FROM employee",
  "database": "cloud_pc_templates_agent",
  "server": { "host": "localhost", "port": "3306", "user": "devas" },
  "rowCount": 2,
  "headers": ["id", "name", "email"],
  "rows": [
    { "id": "1", "name": "Alice", "email": "alice@example.com" },
    { "id": "2", "name": "Bob",   "email": "bob@example.com"   }
  ]
}
On failure always returns HTTP 200 with an error object like:
{
  "error": "Query execution failed",
  "query": "CREATE TABLE ...",
  "database": "cloud_pc_templates_agent",
  "errorCode": "1064",
  "sqlState": "42000",
  "errorMessage": "ERROR 1064 (42000): You have an error in your SQL syntax...",
  "hint": "SQL syntax error - check your query for typos or missing keywords."
}