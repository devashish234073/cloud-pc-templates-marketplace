# Java Maven Spring Connector – API Reference

**Port:** `3038`  
**Base URL:** `http://localhost:3038`

## Startup
```bash
node javaMavenSpringConnector.js [basedir]
```
- `basedir` (optional) – directory where Maven projects are stored. Defaults to `cwd`.
- Scans `basedir` for existing Maven projects on startup.

---

## Requirement Checks
Mutating endpoints verify Java (>= 11 by default, or project target version) and Maven are installed.

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
**Response 200:**
```json
{
  "message": "Project 'my-app' created successfully",
  "project": { "name": "my-app", "path": "/base/my-app", "groupId": "com.example", "artifactId": "my-app" },
  "mavenOutput": "..."
}
```

---

### `POST /spring/create`
Create a configurable Spring Boot Maven application.
- `parent` (optional) – Defaults to `org.springframework.boot:spring-boot-starter-parent` version `3.3.5` if omitted to ensure dependency versions are resolved correctly.
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
  "files": ["/base/inventory-api/pom.xml"],
  "validationWarnings": [
    "WARNING: Spring Boot dependencies detected without parent/BOM. Consider adding spring-boot-starter-parent as parent."
  ]
}
```

---

### `POST /spring/crud?projectName=`
Generate entity, request/response DTOs, repository, service, and controller CRUD resources.
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
Read structured POM information. Add `raw=true` to include full `pom.xml`.
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
**Response 200:**
```json
{
  "message": "POM properties updated",
  "projectName": "my-app",
  "properties": { "java.version": "21", "spring-cloud.version": "2023.0.3" }
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
**Response 200:**
```json
{
  "message": "POM parent updated",
  "projectName": "my-app",
  "parent": { "groupId": "org.springframework.boot", "artifactId": "spring-boot-starter-parent", "version": "3.3.5" }
}
```

---

### `POST /maven/class?projectName=&packageName=&className=`
Create (or overwrite) a Java class.
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

---

### `PUT /maven/class?projectName=&packageName=&className=`
Update (overwrite) a Java class. Identical behaviour to `POST /maven/class`.

---

### `PATCH /maven/class?projectName=&packageName=&className=`
Patch an existing Java class using search-and-replace block replacements.
**Body (Single replacement):**
```json
{
  "targetContent": "public class UserService {\n    // old content\n}",
  "replacementContent": "public class UserService {\n    // new content\n}"
}
```
**Body (Multiple replacements):**
```json
{
  "replacements": [
    {
      "targetContent": "private final UserRepository repository;",
      "replacementContent": "private final UserRepository repository;\n    private final LogService logService;"
    }
  ]
}
```
**Response 200:**
```json
{
  "message": "Class 'UserService' patched successfully",
  "classFile": "/base/my-app/src/main/java/com/example/service/UserService.java",
  "packageName": "com.example.service",
  "className": "UserService",
  "projectName": "my-app",
  "replacementsApplied": 1
}
```

---

### `POST /maven/dependency?projectName=`
Add or update a dependency in `pom.xml`.
**Body:**
```json
{
  "groupId": "org.springframework.boot",
  "artifactId": "spring-boot-starter-web",
  "version": "3.2.0",
  "scope": "compile"
}
```
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
    { "groupId": "org.projectlombok", "artifactId": "lombok", "version": "1.18.34", "scope": "provided" }
  ]
}
```
**Response 200:**
```json
{
  "message": "Dependencies processed",
  "projectName": "my-app",
  "dependencies": [ ... ]
}
```

---

### `GET /maven/dependencies?projectName=`
List all dependencies from `pom.xml` (including resolved versions).
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
List build plugins from `pom.xml`.
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
Add or update a build plugin.
**Body:**
```json
{
  "groupId": "org.apache.maven.plugins",
  "artifactId": "maven-compiler-plugin",
  "version": "3.13.0",
  "configuration": { "source": "21", "target": "21" }
}
```
**Response 200:**
```json
{
  "message": "Plugin added/updated",
  "projectName": "my-app",
  "plugins": [ ... ]
}
```

---

### `GET /maven/build?projectName=&skipTests=true`
Build the project with `mvn package`.
**Response 200:**
```json
{
  "message": "Build successful",
  "projectName": "my-app",
  "buildSuccess": true,
  "jarFile": "/base/my-app/target/my-app-1.0-SNAPSHOT.jar",
  "errorSummary": null,
  "mavenOutput": "..."
}
```

---

### `GET /maven/artifact?projectName=`
Retrieve JAR artifact metadata.
**Response 200:**
```json
{
  "message": "JAR artifact information",
  "projectName": "my-app",
  "artifactName": "my-app-1.0-SNAPSHOT.jar",
  "jarPath": "/home/user/projects/my-app/target/my-app-1.0-SNAPSHOT.jar",
  "jarRelativePath": "target/my-app-1.0-SNAPSHOT.jar",
  "jarAbsolutePath": "/home/user/projects/my-app/target/my-app-1.0-SNAPSHOT.jar",
  "jarSize": 52428800,
  "groupId": "com.example",
  "artifactId": "my-app",
  "packageName": "com.example.myapp"
}
```

---

### `GET /maven/project-details?projectName=`
Retrieve complete project details (POM info, source directories, JAR artifacts, target directory).
**Response 200:**
```json
{
  "message": "Complete project details",
  "projectName": "my-app",
  "projectInfo": { "name": "my-app", "path": "/home/user/projects/my-app", "groupId": "com.example", "type": "spring-boot" },
  "pomInfo": { "exists": true, "summary": { ... } },
  "sourceDirs": { "mainJava": "...", "testJava": "...", "mainJavaExists": true, "testJavaExists": true },
  "buildArtifact": { "name": "...", "path": "...", "size": 52428800 },
  "targetDir": { "path": "...", "exists": true }
}
```

---

### `POST /maven/resource/file?projectName=&filePath=`
Create or add a new file to `src/main/resources`.
**Query Parameters:** `?projectName=my-app&filePath=application.properties`
**Body:**
```json
{
  "content": "spring.application.name=my-app\nserver.port=8080"
}
```
**Response 200:**
```json
{
  "message": "Resource file created",
  "projectName": "my-app",
  "filePath": "application.properties",
  "absolutePath": "/base/my-app/src/main/resources/application.properties",
  "exists": true,
  "action": "created"
}
```

---

### `GET /maven/resource/file?projectName=&filePath=`
Read content of a file from `src/main/resources`.
**Response 200:**
```json
{
  "message": "Resource file read successfully",
  "projectName": "my-app",
  "filePath": "application.properties",
  "content": "spring.application.name=my-app\nserver.port=8080",
  "size": 98
}
```

---

### `PUT /maven/resource/file?projectName=&filePath=`
Modify or update an existing file in `src/main/resources`.
**Body:**
```json
{
  "content": "spring.application.name=my-app-updated\nserver.port=9090"
}
```
**Response 200:**
```json
{
  "message": "Resource file updated successfully",
  "projectName": "my-app",
  "filePath": "application.properties",
  "oldContentSize": 98,
  "newContentSize": 72,
  "action": "updated"
}
```

---

### `PATCH /maven/resource/file?projectName=&filePath=`
Patch an existing resource file using search-and-replace block replacements.
**Body (Single replacement):**
```json
{
  "targetContent": "server.port=8080",
  "replacementContent": "server.port=9090"
}
```
**Body (Multiple replacements):**
```json
{
  "replacements": [
    {
      "targetContent": "spring.application.name=my-app",
      "replacementContent": "spring.application.name=my-cool-app"
    }
  ]
}
```
**Response 200:**
```json
{
  "message": "Resource file 'application.properties' patched successfully",
  "projectName": "my-app",
  "filePath": "application.properties",
  "absolutePath": "/base/my-app/src/main/resources/application.properties",
  "replacementsApplied": 1
}
```

---

### `GET /maven/resources?projectName=`
List all files recursively in the `src/main/resources` directory.
**Response 200:**
```json
{
  "message": "Resource files listed",
  "projectName": "my-app",
  "resourcesDir": "/base/my-app/src/main/resources",
  "fileCount": 1,
  "files": [
    { "name": "application.properties", "relativePath": "application.properties", "size": 98, "type": ".properties" }
  ]
}
```

---

### `GET /maven/jar?projectName=`
Download built JAR file from `target/`.
**Response 200:** Binary stream with `Content-Type: application/java-archive`.

---

### `GET /maven/rescan`
Rescan `basedir` for Maven projects.
**Response 200:**
```json
{
  "message": "Rescanned for Maven projects",
  "projectCount": 3,
  "projects": ["my-app", "demo", "api-service"]
}
```
