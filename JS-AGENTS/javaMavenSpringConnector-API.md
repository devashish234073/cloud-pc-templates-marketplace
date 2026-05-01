# Java Maven Spring Connector – API Reference

**Port:** `3038`  
**Base URL:** `http://localhost:3038`

## Startup

```bash
node javaMavenSpringConnector.js [basedir]
```

- `basedir` (optional) – directory where Maven projects are stored. Defaults to `cwd`.
- On startup, scans `basedir` for existing Maven projects (subdirs with `pom.xml`) and registers them in memory.

---

## Requirement Checks

Every mutating endpoint first verifies:
1. **Java ≥ 11** – checks `java -version`; rejects if missing or < 11
2. **Maven** – checks `mvn --version`; rejects if missing

If either check fails, the endpoint returns `500` with an error message—no work is performed.

---

## Endpoints

### `GET /health`

Server status and requirement check result.

**Response 200:**
```json
{
  "status": "UP",
  "version": "1.0",
  "type": "java-maven-spring-agent",
  "baseDir": "/path/to/base",
  "projectCount": 2,
  "projects": ["my-app", "demo"],
  "requirements": { "ok": true, "javaVersion": "17.0.2", "javaMajor": 17, "mavenVersion": "3.9.6" }
}
```

---

### `GET /maven/projects`

List all tracked Maven projects.

**Response 200:**
```json
{
  "count": 1,
  "projects": [
    { "name": "my-app", "path": "/base/my-app", "groupId": "com.example", "artifactId": "my-app", "createdAt": "..." }
  ]
}
```

---

### `POST /maven/create`

Create a new Maven project via `mvn archetype:generate`.

**Body:**
```json
{
  "groupId": "com.example",
  "artifactId": "my-app",
  "version": "1.0-SNAPSHOT",
  "archetypeGroupId": "org.apache.maven.archetypes",
  "archetypeArtifactId": "maven-archetype-quickstart",
  "archetypeVersion": "1.4",
  "javaVersion": "17"
}
```

| Field | Required | Default |
|---|---|---|
| `groupId` | ✅ | – |
| `artifactId` | ✅ | – |
| `version` | | `1.0-SNAPSHOT` |
| `archetypeGroupId` | | `org.apache.maven.archetypes` |
| `archetypeArtifactId` | | `maven-archetype-quickstart` |
| `archetypeVersion` | | `1.4` |
| `javaVersion` | | `17` |

**Response 200:** Project metadata + last 500 chars of maven output.  
**Response 409:** Project or directory already exists.

---

### `POST /spring/create`

Create a configurable Spring Boot Maven application without relying on an archetype.

It generates:
- `pom.xml` from caller-supplied Maven metadata
- application class
- `/api/health` controller
- `application.properties`
- basic context-load test
- `.gitignore`
- `README.md`

**Body:**
```json
{
  "groupId": "com.example",
  "artifactId": "inventory-api",
  "packageName": "com.example.inventory",
  "appName": "InventoryApi",
  "version": "0.0.1-SNAPSHOT",
  "parent": {
    "groupId": "org.springframework.boot",
    "artifactId": "spring-boot-starter-parent",
    "version": "3.3.5",
    "relativePath": ""
  },
  "properties": {
    "java.version": "17"
  },
  "dependencies": [
    { "groupId": "org.springframework.boot", "artifactId": "spring-boot-starter-web" },
    { "groupId": "org.springframework.boot", "artifactId": "spring-boot-starter-test", "scope": "test" }
  ],
  "plugins": [
    { "groupId": "org.springframework.boot", "artifactId": "spring-boot-maven-plugin" }
  ],
  "applicationProperties": {
    "server.port": "8080"
  }
}
```

| Field | Required | Default |
|---|---|---|
| `groupId` | ✅ | – |
| `artifactId` | ✅ | – |
| `packageName` | | sanitized from `groupId.artifactId` |
| `appName` | | PascalCase from `artifactId` |
| `version` | | `0.0.1-SNAPSHOT` |
| `parent` | | none |
| `properties` | | `{}` |
| `dependencies` | | `[]` |
| `plugins` | | `[]` |
| `applicationProperties` | | `{}` |

No dependency names are hardcoded. The caller must pass exact Maven coordinates. Dependency objects support `groupId`, `artifactId`, `version`, `type`, `classifier`, `scope`, `optional`, and `exclusions`.

Plugin objects support `groupId`, `artifactId`, `version`, `extensions`, `configuration`, `configurationXml`, `executions`, `executionsXml`, or `rawXml`.

**Response 200:**
```json
{
  "message": "Spring Boot project 'inventory-api' created successfully",
  "project": {
    "name": "inventory-api",
    "path": "/base/inventory-api",
    "groupId": "com.example",
    "artifactId": "inventory-api",
    "packageName": "com.example.inventory",
    "type": "spring-boot",
    "createdAt": "..."
  },
  "applicationClass": "com.example.inventory.InventoryApiApplication",
  "dependencies": [
    { "groupId": "org.springframework.boot", "artifactId": "spring-boot-starter-web" }
  ],
  "plugins": [
    { "groupId": "org.springframework.boot", "artifactId": "spring-boot-maven-plugin" }
  ],
  "files": ["/base/inventory-api/pom.xml"]
}
```

**Response 200** (with warnings):
```json
{
  "message": "Spring Boot project 'inventory-api' created successfully",
  "project": { ... },
  "applicationClass": "com.example.inventory.InventoryApiApplication",
  "dependencies": [ ... ],
  "plugins": [ ... ],
  "files": [ ... ],
  "validationWarnings": [
    "WARNING: Spring Boot dependencies detected without parent/BOM. Consider adding spring-boot-starter-parent as parent or using spring-boot-dependencies BOM."
  ]
}
```

**Validation:** If Spring Boot dependencies are detected without a parent/BOM or with unversioned dependencies, `validationWarnings` array is populated. This helps catch configuration issues that may cause Maven build failures.

**Response 409:** Project or directory already exists.

---

### `POST /spring/crud?projectName=`

Generate a complete CRUD resource inside a Spring Boot project.

It creates:
- JPA entity
- request/response DTOs
- Spring Data repository
- service with transactions and 404 handling
- REST controller with list/get/create/update/delete routes

**Query:** `?projectName=inventory-api`

**Body:**
```json
{
  "resourceName": "Product",
  "packageName": "com.example.inventory",
  "path": "products",
  "fields": [
    { "name": "name", "type": "String", "required": true },
    { "name": "price", "type": "BigDecimal", "required": true },
    { "name": "sku", "type": "String", "unique": true }
  ]
}
```

| Field | Required | Default |
|---|---|---|
| `resourceName` | ✅ | – |
| `packageName` | | project `packageName`, project `groupId`, or `com.example.demo` |
| `path` | | plural kebab-case from `resourceName` |
| `fields` | | `name` and `description` |

Common supported field types include `String`, `Integer`, `Long`, `Double`, `BigDecimal`, `Boolean`, `LocalDate`, `LocalDateTime`, and `UUID`.

**Response 200:**
```json
{
  "message": "CRUD resource 'Product' generated successfully",
  "projectName": "inventory-api",
  "packageName": "com.example.inventory",
  "resourceName": "Product",
  "endpoints": [
    "GET    /api/products",
    "GET    /api/products/{id}",
    "POST   /api/products",
    "PUT    /api/products/{id}",
    "DELETE /api/products/{id}"
  ],
  "fields": [
    { "name": "name", "type": "String", "required": true, "unique": false }
  ],
  "files": [
    { "file": "/base/inventory-api/src/main/java/com/example/inventory/entity/Product.java", "overwritten": false }
  ]
}
```

---

### `GET /maven/pom?projectName=&raw=true`

Read structured POM information, including parent, properties, dependencies, and plugins. Add `raw=true` to include the full `pom.xml`.

**Response 200:**
```json
{
  "projectName": "inventory-api",
  "pomPath": "/base/inventory-api/pom.xml",
  "summary": {
    "groupId": "com.example",
    "artifactId": "inventory-api",
    "version": "0.0.1-SNAPSHOT",
    "parent": { "groupId": "org.springframework.boot", "artifactId": "spring-boot-starter-parent", "version": "3.3.5" },
    "properties": { "java.version": "17" },
    "dependencies": [],
    "plugins": []
  },
  "rawXml": "<project>...</project>"
}
```

---

### `PUT /maven/properties?projectName=`

Add or update POM properties.

**Body:**
```json
{
  "properties": {
    "java.version": "21",
    "spring-cloud.version": "2023.0.3"
  }
}
```

---

### `PUT /maven/parent?projectName=`

Add or update the POM parent.

**Body:**
```json
{
  "groupId": "org.springframework.boot",
  "artifactId": "spring-boot-starter-parent",
  "version": "3.3.5",
  "relativePath": ""
}
```

---

### `POST /maven/class?projectName=&packageName=&className=`

Create (or overwrite) a Java class.

**Query Parameters:**
| Param | Required | Example |
|---|---|---|
| `projectName` | ✅ | `my-app` |
| `packageName` | ✅ | `com.example.service` |
| `className` | ✅ | `UserService` |

**Body:**
```json
{
  "code": "package com.example.service;\n\npublic class UserService {\n    // ...\n}"
}
```

**Response 200:**
```json
{
  "message": "Class 'UserService' created successfully",
  "overwritten": false,
  "classFile": "/base/my-app/src/main/java/com/example/service/UserService.java",
  "packageName": "com.example.service",
  "className": "UserService",
  "projectName": "my-app"
}
```

**Response 404:** `"Project does not exist. Create the project first."`

---

### `PUT /maven/class?projectName=&packageName=&className=`

Update (overwrite) a Java class. **Identical behaviour** to `POST /maven/class` — exists for semantic REST clarity.

---

### `POST /maven/dependency?projectName=`

Add or update a dependency in `pom.xml`.

**Query:** `?projectName=my-app`

**Body:**
```json
{
  "groupId": "org.springframework.boot",
  "artifactId": "spring-boot-starter-web",
  "version": "3.2.0",
  "type": "jar",
  "classifier": "",
  "scope": "compile",
  "optional": false,
  "exclusions": [
    { "groupId": "commons-logging", "artifactId": "commons-logging" }
  ]
}
```

| Field | Required |
|---|---|
| `groupId` | ✅ |
| `artifactId` | ✅ |
| `version` | |
| `type` | |
| `classifier` | |
| `scope` | |
| `optional` | |
| `exclusions` | |

If the dependency already exists (same `groupId:artifactId`), its version/scope is **updated**.

**Response 200:**
```json
{
  "message": "Dependency added: org.springframework.boot:spring-boot-starter-web:3.2.0",
  "projectName": "my-app",
  "action": "added",
  "groupId": "org.springframework.boot",
  "artifactId": "spring-boot-starter-web",
  "version": "3.2.0"
}
```

---

### `POST /maven/dependencies?projectName=`

Add or update multiple dependencies.

**Body:**
```json
{
  "dependencies": [
    { "groupId": "org.springframework.boot", "artifactId": "spring-boot-starter-web" },
    { "groupId": "org.projectlombok", "artifactId": "lombok", "version": "1.18.34", "scope": "provided", "optional": true }
  ]
}
```

---

### `GET /maven/dependencies?projectName=`

List all dependencies and their current versions from `pom.xml`.  
Also attempts `mvn dependency:list` for resolved (effective) versions.

**Response 200:**
```json
{
  "projectName": "my-app",
  "pomDependencies": [
    { "groupId": "junit", "artifactId": "junit", "version": "4.11", "scope": "test" }
  ],
  "count": 1,
  "resolvedDependencies": [
    { "groupId": "junit", "artifactId": "junit", "type": "jar", "resolvedVersion": "4.11", "scope": "test" }
  ]
}
```

---

### `GET /maven/plugins?projectName=`

List build plugins from `pom.xml`, including raw plugin XML and parsed configuration/executions XML where present.

**Response 200:**
```json
{
  "projectName": "my-app",
  "count": 1,
  "plugins": [
    {
      "groupId": "org.springframework.boot",
      "artifactId": "spring-boot-maven-plugin",
      "version": null,
      "configurationXml": null,
      "executionsXml": null
    }
  ]
}
```

---

### `POST /maven/plugin?projectName=`

Add or update a build plugin. If the same `groupId:artifactId` already exists, it is replaced.

**Body:**
```json
{
  "groupId": "org.apache.maven.plugins",
  "artifactId": "maven-compiler-plugin",
  "version": "3.13.0",
  "configuration": {
    "source": "21",
    "target": "21"
  },
  "executions": [
    {
      "id": "default-compile",
      "phase": "compile",
      "goals": ["compile"]
    }
  ]
}
```

For complex plugin XML, pass `configurationXml`, `executionsXml`, or `rawXml`.

---

### `GET /maven/build?projectName=&skipTests=true`

Build the project with `mvn package`. Extracts and returns meaningful error messages on build failure.

**Query:**
| Param | Required | Default |
|---|---|---|
| `projectName` | ✅ | – |
| `skipTests` | | `false` |

**Response 200:**
```json
{
  "message": "Build successful",
  "projectName": "my-app",
  "buildSuccess": true,
  "jarFile": "/base/my-app/target/my-app-1.0-SNAPSHOT.jar",
  "errorSummary": null,
  "mavenOutput": "...[last 1000 chars]..."
}
```

**Response 500 (on failure):** Includes `errorSummary` array with first 10 error lines extracted from Maven output:
```json
{
  "message": "Build failed",
  "projectName": "my-app",
  "buildSuccess": false,
  "jarFile": null,
  "errorSummary": [
    "[ERROR] COMPILATION ERROR",
    "[ERROR] /path/to/file.java:[line] error message"
  ],
  "mavenOutput": "...[last 1000 chars]..."
}
```

**Error Extraction:** Filters Maven output for lines containing `[ERROR]`, `FAILURE`, or `error` keywords to surface actual compilation/build errors instead of warnings.

---

### `GET /maven/artifact?projectName=`

Retrieve JAR artifact metadata (path, size, coordinates) without downloading the binary.

**Query:** `?projectName=my-app`

**Sample Response 200:**
```json
{
  "message": "JAR artifact information",
  "projectName": "my-app",
  "artifactName": "my-app-1.0-SNAPSHOT.jar",
  "jarPath": "/home/user/projects/my-app/target/my-app-1.0-SNAPSHOT.jar",
  "jarRelativePath": "target/my-app-1.0-SNAPSHOT.jar",
  "jarAbsolutePath": "/home/user/projects/my-app/target/my-app-1.0-SNAPSHOT.jar",
  "jarSize": 52428800,
  "jarSizeKB": 51200,
  "groupId": "com.example",
  "artifactId": "my-app",
  "packageName": "com.example.myapp"
}
```

**Response 404:** No JAR found – build the project first with `/maven/build`.

**Path Fields:** `jarPath` returns the **absolute system path** (full path to JAR). Use this for CI/CD pipelines and file operations. `jarRelativePath` is the relative path from the project directory for reference.


---

### `GET /maven/project-details?projectName=`

Retrieve complete project information including POM details, source directories, and build artifacts. All path fields return **absolute system paths** for CI/CD integration.

**Query:** `?projectName=my-app`

**Response 200:**
```json
{
  "message": "Complete project details",
  "projectName": "my-app",
  "projectInfo": {
    "name": "my-app",
    "path": "/home/user/projects/my-app",
    "relativePath": "my-app",
    "absolutePath": "/home/user/projects/my-app",
    "groupId": "com.example",
    "artifactId": "my-app",
    "packageName": "com.example.myapp",
    "type": "spring-boot",
    "createdAt": "2026-05-01T12:00:00.000Z"
  },
  "pomInfo": {
    "path": "/home/user/projects/my-app/pom.xml",
    "relativePath": "pom.xml",
    "exists": true,
    "summary": {
      "groupId": "com.example",
      "artifactId": "my-app",
      "version": "1.0-SNAPSHOT",
      "parent": { "groupId": "org.springframework.boot", "artifactId": "spring-boot-starter-parent", "version": "3.3.5" },
      "properties": { "java.version": "17" },
      "dependencies": [ ... ],
      "plugins": [ ... ]
    }
  },
  "sourceDirs": {
    "mainJava": "/home/user/projects/my-app/src/main/java",
    "mainJavaRelative": "src/main/java",
    "testJava": "/home/user/projects/my-app/src/test/java",
    "testJavaRelative": "src/test/java",
    "mainJavaExists": true,
    "testJavaExists": true
  },
  "buildArtifact": {
    "name": "my-app-1.0-SNAPSHOT.jar",
    "path": "/home/user/projects/my-app/target/my-app-1.0-SNAPSHOT.jar",
    "relativePath": "target/my-app-1.0-SNAPSHOT.jar",
    "absolutePath": "/home/user/projects/my-app/target/my-app-1.0-SNAPSHOT.jar",
    "size": 52428800,
    "sizeKB": 51200
  },
  "targetDir": {
    "path": "/home/user/projects/my-app/target",
    "relativePath": "target",
    "exists": true
  }
}
```

**Path Fields:** All `.path` fields return the **absolute system path** (recommended for scripts and automation). `.relativePath` fields provide relative paths from the project root for reference.

Built as the `getProjectDetails` API to return all relevant project information in one call.

---

### `GET /maven/jar?projectName=`

Download the built JAR file from `target/` as a binary attachment.

**Response 200:** Binary stream with `Content-Type: application/java-archive`.  
**Response 404:** No target dir or no JAR found – build first.

---

### `GET /maven/rescan`

Clear the in-memory project map and re-scan `basedir` for Maven projects.

**Response 200:**
```json
{
  "message": "Rescanned for Maven projects",
  "projectCount": 3,
  "projects": ["my-app", "demo", "api-service"]
}
```
