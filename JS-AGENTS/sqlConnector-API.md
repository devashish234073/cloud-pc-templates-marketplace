SQL CONNECTOR API (http://localhost:3037)

All credentials and database name are hardcoded server-side. No credentials or database details are passed in any request.
Database in use: cloud_pc_templates_agent

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
If the server is not reachable, returns HTTP 503 with an error and instructions to run /mysql/setup-or-status first.
If the query fails (bad SQL, etc.), returns HTTP 400 with the error details.