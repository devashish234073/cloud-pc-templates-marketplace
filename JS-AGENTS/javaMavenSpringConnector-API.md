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
  "scope": "compile"
}
```

| Field | Required |
|---|---|
| `groupId` | ✅ |
| `artifactId` | ✅ |
| `version` | |
| `scope` | |

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

### `GET /maven/build?projectName=&skipTests=true`

Build the project with `mvn package`.

**Query:**
| Param | Required | Default |
|---|---|---|
| `projectName` | ✅ | – |
| `skipTests` | | `false` |

**Response 200:** Build result, path to generated JAR, last 1000 chars of maven output.

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
