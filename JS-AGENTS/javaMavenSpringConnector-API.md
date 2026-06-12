# Java Maven Spring Connector – API Reference

**Port:** `3038` | **Base URL:** `http://localhost:3038`

**Startup:** `node javaMavenSpringConnector.js [basedir]`
Scans `basedir` for existing Maven projects on startup. Defaults to `cwd`.

All mutating endpoints verify Java (≥ 11 or project target version) and Maven are installed.

---

## Quick Reference

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/health` | Server status + requirement check |
| GET | `/maven/projects` | List all tracked projects |
| POST | `/maven/create` | Create Maven project via archetype |
| POST | `/spring/create` | Create full Spring Boot app |
| POST | `/spring/crud` | Generate CRUD resource (entity/repo/service/controller) |
| GET | `/maven/pom` | Read pom.xml summary / raw XML |
| PUT | `/maven/properties` | Add/update POM properties |
| PUT | `/maven/parent` | Add/update POM parent |
| **GET** | **`/maven/class`** | **Read a Java class source file** |
| POST | `/maven/class` | Create (or overwrite) a Java class |
| PUT | `/maven/class` | Update (overwrite) a Java class |
| PATCH | `/maven/class` | Patch a Java class via search-and-replace |
| **GET** | **`/maven/classes`** | **List all Java source files in the project** |
| POST | `/maven/dependency` | Add/update one dependency in pom.xml |
| POST | `/maven/dependencies` | Add/update multiple dependencies |
| GET | `/maven/dependencies` | List pom dependencies + resolved versions |
| GET | `/maven/plugins` | List build plugins |
| POST | `/maven/plugin` | Add/update a build plugin |
| POST | `/maven/resource/file` | Create file in `src/main/resources` |
| GET | `/maven/resource/file` | Read file from `src/main/resources` |
| PUT | `/maven/resource/file` | Update file in `src/main/resources` |
| PATCH | `/maven/resource/file` | Patch resource file via search-and-replace |
| GET | `/maven/resources` | List all files in `src/main/resources` |
| GET | `/maven/build` | Build project (`mvn package`) |
| GET | `/maven/jar` | Download built JAR (binary) |
| GET | `/maven/artifact` | Get JAR path/metadata (no download) |
| GET | `/maven/project-details` | Complete project info (POM, dirs, JAR, last build) |
| GET | `/maven/rescan` | Rescan basedir for Maven projects |

---

## Endpoints

### `GET /health`
```json
{
  "status": "UP", "version": "4.0", "type": "java-maven-spring-agent",
  "baseDir": "/path/to/base", "projectCount": 2, "projects": ["my-app", "demo"],
  "requirements": { "ok": true, "javaVersion": "17.0.2", "javaMajor": 17, "mavenVersion": "3.9.6" }
}
```

---

### `GET /maven/projects`
```json
{ "count": 1, "projects": [{ "name": "my-app", "path": "/base/my-app", "groupId": "com.example", "artifactId": "my-app", "createdAt": "..." }] }
```

---

### `POST /maven/create`
Create via `mvn archetype:generate`.
```json
// Body
{ "groupId": "com.example", "artifactId": "my-app", "version": "1.0-SNAPSHOT",
  "archetypeGroupId": "org.apache.maven.archetypes", "archetypeArtifactId": "maven-archetype-quickstart",
  "archetypeVersion": "1.4", "javaVersion": "17" }
```

---

### `POST /spring/create`
Scaffold a full Spring Boot Maven app. `parent` defaults to `spring-boot-starter-parent:3.3.5` if omitted.
```json
// Body
{ "groupId": "com.example", "artifactId": "inventory-api", "packageName": "com.example.inventory",
  "appName": "InventoryApi", "version": "0.0.1-SNAPSHOT",
  "parent": { "groupId": "org.springframework.boot", "artifactId": "spring-boot-starter-parent", "version": "3.3.5", "relativePath": "" },
  "properties": { "java.version": "17" },
  "dependencies": [
    { "groupId": "org.springframework.boot", "artifactId": "spring-boot-starter-web" },
    { "groupId": "org.springframework.boot", "artifactId": "spring-boot-starter-test", "scope": "test" }
  ],
  "plugins": [{ "groupId": "org.springframework.boot", "artifactId": "spring-boot-maven-plugin" }],
  "applicationProperties": { "server.port": "8080" } }
```
Response includes `applicationClass`, `files[]`, and optional `validationWarnings[]`.

---

### `POST /spring/crud?projectName=`
Generate entity, DTOs, repository, service, and controller for one resource.
```json
// Body
{ "resourceName": "Product", "packageName": "com.example.inventory", "path": "products",
  "fields": [
    { "name": "name",  "type": "String",     "required": true },
    { "name": "price", "type": "BigDecimal", "required": true },
    { "name": "sku",   "type": "String",     "unique": true }
  ] }
```
Response includes `endpoints[]` and `files[]` (with `overwritten` flag per file).

---

### `GET /maven/pom?projectName=&raw=true`
Returns structured POM summary. Add `raw=true` to include full XML.
```json
{ "summary": { "groupId": "...", "artifactId": "...", "version": "...", "parent": {}, "properties": {}, "dependencies": [], "plugins": [] }, "rawXml": "..." }
```

---

### `PUT /maven/properties?projectName=`
```json
// Body
{ "properties": { "java.version": "21", "spring-cloud.version": "2023.0.3" } }
```

---

### `PUT /maven/parent?projectName=`
```json
// Body
{ "groupId": "org.springframework.boot", "artifactId": "spring-boot-starter-parent", "version": "3.3.5", "relativePath": "" }
```

---

### `GET /maven/class?projectName=&packageName=&className=` ⭐ NEW
Read the full source of a Java class. Use before PATCH to verify current content, or to inspect a generated file.

**Query params:** `projectName` · `packageName` (e.g. `com.example.service`) · `className` (without `.java`)
```json
// Response
{ "projectName": "my-app", "packageName": "com.example.service", "className": "UserService",
  "classFile": "/base/my-app/src/main/java/com/example/service/UserService.java",
  "code": "package com.example.service;\n\npublic class UserService { ... }",
  "size": 1842, "lastModified": "2026-06-13T10:22:00.000Z" }
```

---

### `POST /maven/class?projectName=&packageName=&className=`
Create (or overwrite) a Java class.
```json
// Body
{ "code": "package com.example.service;\n\npublic class UserService {\n    // ...\n}" }
```
Response includes `classFile`, `overwritten` (bool).

---

### `PUT /maven/class?projectName=&packageName=&className=`
Same as POST — overwrites the file unconditionally.

---

### `PATCH /maven/class?projectName=&packageName=&className=`
Search-and-replace inside an existing class. Each `targetContent` must appear exactly once.
```json
// Body – single replacement
{ "targetContent": "// old content", "replacementContent": "// new content" }

// Body – multiple replacements
{ "replacements": [{ "targetContent": "...", "replacementContent": "..." }] }
```
Response includes `replacementsApplied` count.

---

### `GET /maven/classes?projectName=&type=main` ⭐ NEW
List all Java source files in the project. Use to discover existing classes before creating or patching.

**Query params:** `projectName` · `type` = `main` (default) | `test` | `both`
```json
// Response
{ "projectName": "my-app", "totalCount": 5,
  "classes": {
    "main": [
      { "className": "UserService", "packageName": "com.example.service",
        "relativePath": "com/example/service/UserService.java",
        "absolutePath": "/base/my-app/src/main/java/com/example/service/UserService.java",
        "size": 1842 }
    ],
    "test": [ ... ]
  }
}
```

---

### `POST /maven/dependency?projectName=`
```json
// Body
{ "groupId": "org.springframework.boot", "artifactId": "spring-boot-starter-web", "version": "3.2.0", "scope": "compile" }
```
Response: `{ "action": "added"|"updated", "groupId", "artifactId", "version" }`

---

### `POST /maven/dependencies?projectName=`
```json
// Body
{ "dependencies": [
    { "groupId": "org.springframework.boot", "artifactId": "spring-boot-starter-web" },
    { "groupId": "org.projectlombok", "artifactId": "lombok", "version": "1.18.34", "scope": "provided" }
  ] }
```

---

### `GET /maven/dependencies?projectName=`
Returns `pomDependencies[]` and `resolvedDependencies[]` (from `mvn dependency:list`, may be null if project not yet built).

---

### `GET /maven/plugins?projectName=`
Lists plugins with `groupId`, `artifactId`, `version`, `configurationXml`, `executionsXml`.

---

### `POST /maven/plugin?projectName=`
Add or update a build plugin. Provide `artifactId` (and optional `groupId`, `version`, `configuration`, `executions`) or `rawXml`.

---

### Resource file endpoints (`src/main/resources`)

| Method | Path | Body / Notes |
|--------|------|-------------|
| POST | `/maven/resource/file?projectName=&filePath=` | `{ "content": "..." }` – create |
| GET  | `/maven/resource/file?projectName=&filePath=` | Returns `content`, `size` |
| PUT  | `/maven/resource/file?projectName=&filePath=` | `{ "content": "..." }` – full replace |
| PATCH | `/maven/resource/file?projectName=&filePath=` | `{ targetContent, replacementContent }` or `{ replacements: [...] }` |
| GET  | `/maven/resources?projectName=` | Lists all files with `relativePath`, `size`, `type` |

`filePath` is relative to `src/main/resources` (e.g. `application.yml`, `static/index.html`). Path traversal is blocked.

---

### `GET /maven/build?projectName=&skipTests=true`
Runs `mvn package`. Returns 200 even on failure — check `buildSuccess`.
```json
{ "buildSuccess": true, "jarFile": "/base/my-app/target/my-app-1.0-SNAPSHOT.jar",
  "errorSummary": null, "mavenOutput": "... last 1000 chars ..." }
```

---

### `GET /maven/jar?projectName=`
Binary download of built JAR (`Content-Type: application/java-archive`). Build first.

---

### `GET /maven/artifact?projectName=`
JAR metadata without binary download.
```json
{ "artifactName": "my-app-1.0-SNAPSHOT.jar", "jarAbsolutePath": "/...", "jarSize": 52428800, "jarSizeKB": 51200 }
```

---

### `GET /maven/project-details?projectName=`
Combined snapshot: project info, POM summary, source dir paths, JAR artifact info, last build result, target dir.

---

### `GET /maven/rescan`
Rescans `basedir` for Maven projects (detects directories with `pom.xml`). Updates the in-memory registry.
```json
{ "projectCount": 3, "projects": ["my-app", "demo", "api-service"] }
```