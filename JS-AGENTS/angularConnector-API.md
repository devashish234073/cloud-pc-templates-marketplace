ANGULAR DEV API (http://localhost:3034)

Wraps an Angular project with a REST API. On startup it resets routes to empty, clears app.component.html to <router-outlet />, then spawns `npm start` in the background. All endpoints are JSON in/out.

Note when creating components make sure to include proper imports needed for code used e.g.

| Feature / Directive | Module to Import |
| :--- | :--- |
| `*ngIf` | `CommonModule` |
| `*ngFor` | `CommonModule` |
| `[ngClass]` / `[ngStyle]` | `CommonModule` |
| `[(ngModel)]` | `FormsModule` |
| `[formControl]` | `ReactiveFormsModule` |
Every component created gets a separate path in the routes file, info of the same is returned in api response when creating component. Always check logs after  component , creation/update and fix any errors before proceeding.
---

GET /health
Returns server status, paths, and Angular process PID.
Response: {"status":"UP","projectDir":"/path/to/project","routesFile":"/path/to/app.routes.ts","logFile":"angular-dev-2026-02-27_10-00-00.log","angularPid":12345}

---

POST /component/get
Retrieves file contents (ts, html, css) from an existing Angular component by name.
Content-Type: application/json

Request body:
{
  "componentName": "my-header",           // required - kebab-case or camelCase
  "fileTypes": ["ts", "html", "css"]     // optional - array of file types to retrieve (default: ["ts", "html", "css"])
                                         // accepted values: "ts", "html", "css"
}

Sample Response (success):
{
  "componentName": "my-header",
  "componentDir": "/project/src/app/my-header",
  "files": {
    "ts": { "path": "/project/src/app/my-header/my-header.ts", "content": "import { Component } from '@angular/core';\n..." },
    "html": { "path": "/project/src/app/my-header/my-header.html", "content": "<h1>Header</h1>" },
    "css": { "path": "/project/src/app/my-header/my-header.css", "content": "h1 { color: blue; }" }
  },
  "filesNotFound": []  // only present if some requested files don't exist
}

Sample Response (partial files found):
{
  "componentName": "my-header",
  "componentDir": "/project/src/app/my-header",
  "files": {
    "ts": { "path": "...", "content": "..." },
    "html": { "path": "...", "content": "..." }
  },
  "filesNotFound": ["css"]  // css file was requested but not found
}

Sample Response (component not found, 404):
{ "error": "Component 'my-header' not found", "searchedPath": "/project/src/app/my-header" }
---

POST /component/create
Creates an Angular component via `ng g c`, writes provided file contents, and auto-registers a route.
Content-Type: application/json

Request body:
{
  "componentName": "my-header",      // required - kebab-case or camelCase
  "ts": "...component class code...", // optional - full .ts file content
  "html": "<h1>Hello</h1>",          // optional - full .html file content
  "css": "h1 { color: red; }"        // optional - full .css/.scss file content
}

Behavior notes:
- componentName is converted to kebab-case internally (myHeader -> my-header)
- templateUrl and styleUrl values inside the ts payload are automatically rewritten to match the actual generated filenames (Angular 19+ drops .component. from filenames)
- A route is auto-registered after generation: kebab name is converted to camelCase for the route path (my-header -> myHeader) and PascalCase for the component class (MyHeaderComponent)
- If route already exists, component creation still succeeds; route result will have skipped:true
- Response includes a `logs` attribute containing the last 20 lines of the Angular dev server log

Sample Response (success):
{
  "message": "Component 'my-header' created successfully",
  "componentDir": "/project/src/app/my-header",
  "filesWritten": ["/project/src/app/my-header/my-header.ts", "..."],
  "route": { "path": "myHeader", "component": "MyHeaderComponent", "urlToTest": "http://localhost:4200/myHeader" },
  "errors": [],   // only present if individual file writes failed
  "logs": {
    "logFile": "angular-dev-2026-02-28_10-00-00.log",
    "totalLines": 142,
    "lines": ["[STDOUT] Angular is running...", "[STDERR] Warning: ...", "..."]
  }
}

if myHeader route is created the app can be accessed from http://localhost:4200/myHeader

Sample Response (route skipped):
{
  "message": "Component 'my-header' created successfully",
  "componentDir": "/project/src/app/my-header",
  "filesWritten": [...],
  "route": { "skipped": true, "reason": "Route 'myHeader' already exists in routes file" },
  "logs": {
    "logFile": "angular-dev-2026-02-28_10-00-00.log",
    "totalLines": 142,
    "lines": [...]
  }
}

Sample Response (ng generate failed, 500):
{ "error": "ng generate component failed", "details": "..." }

---

POST /component/update
Updates an existing Angular component's ts, html, and/or css file contents. Requires the component to already exist.
Content-Type: application/json

Request body:
{
  "componentName": "my-header",      // required - kebab-case or camelCase
  "ts": "...component class code...", // optional - full .ts file content
  "html": "<h1>Hello</h1>",          // optional - full .html file content
  "css": "h1 { color: red; }"        // optional - full .css/.scss file content
}

Behavior notes:
- componentName is converted to kebab-case internally (myHeader -> my-header)
- Component directory must exist; returns 404 if not found
- Only provided files are updated (ts, html, css) - null/undefined fields are skipped
- templateUrl and styleUrl values inside the ts payload are automatically rewritten to match the actual existing filenames
- Supports both Angular naming conventions: .component.ts and .ts, .component.html and .html, etc.
- At least one file (ts, html, or css) must be provided for the update to succeed
- Response includes a `logs` attribute containing the last 20 lines of the Angular dev server log

Sample Response (success):
{
  "message": "Component 'my-header' updated successfully",
  "componentDir": "/project/src/app/my-header",
  "filesUpdated": ["/project/src/app/my-header/my-header.ts", "/project/src/app/my-header/my-header.html"],
  "filesNotUpdated": [],  // only present if some files had write errors
  "logs": {
    "logFile": "angular-dev-2026-02-28_10-00-00.log",
    "totalLines": 142,
    "lines": ["[STDOUT] Angular is running...", "[STDERR] Warning: ...", "..."]
  }
}

Sample Response (component not found, 404):
{ "error": "Component 'my-header' not found", "searchedPath": "/project/src/app/my-header" }

Sample Response (no files provided, 400):
{ "error": "No files provided to update (ts, html, css are all null/undefined)", "componentDir": "/project/src/app/my-header" }
---

GET /logs
Returns the last 20 lines of the Angular dev server log file (stdout + stderr from npm start).
Response:
{
  "logFile": "angular-dev-2026-02-27_10-00-00.log",
  "totalLines": 142,
  "lines": [
    "[STDOUT] Angular is running...",
    "[STDERR] Warning: ...",
    ...
  ]
}

---

GET /routes
Returns the full content of the detected routes file (app.routes.ts or app-routing.module.ts).
Response:
{
  "routesFile": "/project/src/app/app.routes.ts",
  "content": "import { Routes } from '@angular/router';\n\nexport const routes: Routes = [\n  { path: 'myHeader', component: MyHeaderComponent }\n];\n"
}
Sample Response (no routes file found, 404): { "error": "Routes file not found in this project" }

---

POST /routes
Manually adds a route entry to the routes file and injects the import statement.
Content-Type: application/json

Request body:
{
  "route": "about",                  // required - URL path segment, leading slash optional
  "componentName": "AboutComponent"  // required - PascalCase component class name
}

Behavior notes:
- Inserts import statement after the last existing import line
- Supports both standalone routes (app.routes.ts) and NgModule style (app-routing.module.ts)
- Skips adding import if the component name is already present in the file

Sample Response (success):
{
  "message": "Route 'about' mapped to 'AboutComponent' added successfully",
  "routesFile": "/project/src/app/app.routes.ts",
  "addedRoute": { "path": "about", "component": "AboutComponent" }
}
Sample Response (already exists, 409): { "error": "Route 'about' already exists in routes file" }
Sample Response (no routes file, 404): { "error": "Routes file not found - cannot add route" }

---

STARTUP SIDE EFFECTS (happen once before server begins listening)
1. Validates angular.json and @angular/core exist - exits with error if not an Angular project
2. Locates routes file by scanning src/ for: app.routes.ts, app-routing.module.ts, app.routing.ts
3. Overwrites routes file with clean empty state:
     import { Routes } from '@angular/router';
     export const routes: Routes = [];
4. Overwrites app.component.html (or app.html) with: <router-outlet />
5. Spawns `npm start` and pipes all output to a timestamped log file in the project root
