SQL CONNECTOR API (http://localhost:3037)

Credentials are configured server-side via environment variables (DB_HOST, DB_PORT, DB_USER, DB_PASSWORD).
No credentials are passed in any request.

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
Dual-purpose endpoint. No query params required — connection details are read from environment variables.
  - If MySQL is NOT reachable: attempts to install and start mysql-server via apt, then returns setup steps and final status.
  - If MySQL IS reachable: returns server status and list of databases.
Returns response like:
{
  "action": "status_reported",
  "message": "MySQL server is reachable.",
  "server": {
    "host": "127.0.0.1",
    "port": "3306",
    "user": "root",
    "clientVersion": "mysql  Ver 8.0.39 ...",
    "pingOutput": "mysqld is alive"
  },
  "databases": ["information_schema", "mydb"],
  "databaseCount": 2,
  "currentDatabase": null,
  "serverVersion": "8.0.39",
  "activeConnections": "3"
}

GET /mysql/query?q=SELECT+*+FROM+users&database=mydb
Runs a SQL query against the MySQL server. q is required; database is optional.
To include spaces in the query use + or %20 (e.g. SELECT+*+FROM+users or SELECT%20*%20FROM%20users).
First checks that the server is reachable, then executes the query via the mysql CLI.
Returns response like:
{
  "query": "SELECT * FROM users",
  "database": "mydb",
  "server": { "host": "127.0.0.1", "port": "3306", "user": "root" },
  "rowCount": 2,
  "headers": ["id", "name", "email"],
  "rows": [
    { "id": "1", "name": "Alice", "email": "alice@example.com" },
    { "id": "2", "name": "Bob",   "email": "bob@example.com"   }
  ]
}
If the server is not reachable, returns HTTP 503 with an error and instructions to run /mysql/setup-or-status first.
If the query fails (bad SQL, wrong database, etc.), returns HTTP 400 with the error details.