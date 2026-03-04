# Git Explorer API Documentation

**Base URL:** `http://localhost:3033`  
**Version:** 2.0

Git Explorer scans a base directory for local git repositories and exposes them over HTTP. All endpoints are prefixed with `/git/` so agents can unambiguously identify these as git repository operations, not raw filesystem paths.

Every response that is scoped to a specific repo includes these top-level fields:

```json
{
  "repoName": "my-app",
  "remoteUrl": "https://github.com/org/my-app",
  "currentBranch": "main",
  ...
}
```

If no remote is configured, `remoteUrl` is `null` and `repoName` falls back to the folder name.

```

The server scans the base directory on startup for any immediate subdirectories that contain a `.git` folder. Hidden folders, `node_modules`, `target`, `dist`, and `build` are excluded from all scans.

---

## Endpoints

### GET `/health`
Check server status and see all discovered repos.

**Response**
```json
{
  "status": "UP",
  "version": "2.0",
  "type": "git-explorer-agent",
  "baseDir": "/home/user/projects",
  "repoCount": 3,
  "repos": ["my-app", "api-service", "shared-lib"]
}
```

---

### GET `/git/repos`
List all discovered repos with their remote URLs and current branch.

**Response**
```json
{
  "count": 2,
  "repos": [
    {
      "folderName": "my-app",
      "repoName": "my-app",
      "remoteUrl": "https://github.com/org/my-app",
      "currentBranch": "main",
      "path": "/home/user/projects/my-app"
    },
    {
      "folderName": "api-service",
      "repoName": "api-service",
      "remoteUrl": "https://github.com/org/api-service",
      "currentBranch": "develop",
      "path": "/home/user/projects/api-service"
    }
  ]
}
```

---

### GET `/git/rescan`
Re-scan the base directory for new or removed repositories without restarting the server. Useful after manually cloning or deleting a repo on disk.

**Response**
```json
{
  "message": "Rescanned",
  "repoCount": 4,
  "repos": ["my-app", "api-service", "shared-lib", "new-repo"]
}
```

---

### GET `/git/clone?url=<gitUrl>`
Clone a remote git repository into the base directory.

**Query Parameters**

| Param | Required | Description |
|-------|----------|-------------|
| `url` | Yes | Full git remote URL (HTTPS or SSH) |

**Response**
```json
{
  "repoName": "my-app",
  "remoteUrl": "https://github.com/org/my-app",
  "currentBranch": "main",
  "message": "Cloned successfully"
}
```

---

### GET `/git/branches?repo=<repoName>`
List all local and remote branches for a repository, with the currently checked-out branch highlighted.

**Query Parameters**

| Param | Required | Description |
|-------|----------|-------------|
| `repo` | Yes | Folder name of the repository |

**Response**
```json
{
  "repoName": "my-app",
  "remoteUrl": "https://github.com/org/my-app",
  "currentBranch": "main",
  "localBranches": ["main", "feature/auth", "bugfix/login"],
  "remoteBranches": ["origin/main", "origin/feature/auth", "origin/develop"]
}
```

---

### POST `/git/switch`
Switch the working branch of a repository. Runs `git checkout` on the server.

**Request Body**
```json
{
  "repo": "my-app",
  "branch": "feature/auth"
}
```

**Response**
```json
{
  "repoName": "my-app",
  "remoteUrl": "https://github.com/org/my-app",
  "currentBranch": "feature/auth",
  "message": "Switched to branch \"feature/auth\""
}
```

---

### GET `/git/tree?repo=<repoName>`
Return the full nested file and directory tree of a repository. Excluded folders (`node_modules`, `dist`, `build`, hidden dirs) are omitted.

**Query Parameters**

| Param | Required | Description |
|-------|----------|-------------|
| `repo` | Yes | Folder name of the repository |

**Response**
```json
{
  "repoName": "my-app",
  "remoteUrl": "https://github.com/org/my-app",
  "currentBranch": "main",
  "tree": {
    "name": "my-app",
    "type": "directory",
    "path": ".",
    "children": [
      {
        "name": "src",
        "type": "directory",
        "path": "src",
        "children": [
          {
            "name": "index.js",
            "type": "file",
            "path": "src/index.js",
            "size": 1024,
            "extension": "js"
          }
        ]
      },
      {
        "name": "package.json",
        "type": "file",
        "path": "package.json",
        "size": 512,
        "extension": "json"
      }
    ]
  }
}
```

---

### GET `/git/file?path=<filePath>`
Read the full text content of a single file. Accepts an absolute path or a path relative to the base directory. Binary files are rejected.

**Query Parameters**

| Param | Required | Description |
|-------|----------|-------------|
| `path` | Yes | Absolute path, or path relative to base directory |

**Response**
```json
{
  "repoName": "my-app",
  "remoteUrl": "https://github.com/org/my-app",
  "currentBranch": "main",
  "filePath": "/home/user/projects/my-app/src/index.js",
  "size": 1024,
  "extension": "js",
  "content": "const express = require('express');\n..."
}
```

> If the file does not belong to any known repo, `repoName` and `remoteUrl` will be `null`.

---

### GET `/git/filesByExtension?repo=<repoName>&ext=<ext>`
Return the absolute paths of all files in a repo that match one or more file extensions. Useful for finding all source files of a given type.

**Query Parameters**

| Param | Required | Description |
|-------|----------|-------------|
| `repo` | Yes | Folder name of the repository |
| `ext` | Yes | Single extension or comma-separated list — e.g. `js` or `js,ts,jsx` |

**Response**
```json
{
  "repoName": "my-app",
  "remoteUrl": "https://github.com/org/my-app",
  "currentBranch": "main",
  "extensions": ["js", "ts"],
  "count": 42,
  "files": [
    "/home/user/projects/my-app/src/index.js",
    "/home/user/projects/my-app/src/app.ts",
    "/home/user/projects/my-app/src/utils/helpers.js"
  ]
}
```

---

### GET `/git/remoteUrl?repo=<repoName>`
Return all configured remotes and their fetch/push URLs for a repository.

**Query Parameters**

| Param | Required | Description |
|-------|----------|-------------|
| `repo` | Yes | Folder name of the repository |

**Response**
```json
{
  "repoName": "my-app",
  "remoteUrl": "https://github.com/org/my-app",
  "remotes": {
    "origin": {
      "fetch": "https://github.com/org/my-app.git",
      "push": "https://github.com/org/my-app.git"
    },
    "upstream": {
      "fetch": "https://github.com/upstream/my-app.git",
      "push": "https://github.com/upstream/my-app.git"
    }
  }
}
```

---

### GET `/git/log?repo=<repoName>&branch=<branch>&limit=<n>`
Return the commit history for a branch.

**Query Parameters**

| Param | Required | Default | Description |
|-------|----------|---------|-------------|
| `repo` | Yes | — | Folder name of the repository |
| `branch` | No | `HEAD` | Branch name to read history from |
| `limit` | No | `20` | Max commits to return (capped at 200) |

**Response**
```json
{
  "repoName": "my-app",
  "remoteUrl": "https://github.com/org/my-app",
  "currentBranch": "main",
  "branch": "main",
  "count": 3,
  "commits": [
    {
      "hash": "a1b2c3d4e5f6...",
      "author": "Jane Doe",
      "email": "jane@example.com",
      "date": "2024-11-01 10:22:31 +0000",
      "message": "feat: add user authentication"
    },
    {
      "hash": "b2c3d4e5f6a1...",
      "author": "John Smith",
      "email": "john@example.com",
      "date": "2024-10-30 08:15:00 +0000",
      "message": "fix: resolve login redirect bug"
    }
  ]
}
```

---

### GET `/git/status?repo=<repoName>`
Return the working tree status — staged, unstaged, and untracked file changes.

**Query Parameters**

| Param | Required | Description |
|-------|----------|-------------|
| `repo` | Yes | Folder name of the repository |

**Status codes** follow git's porcelain format: `M` = modified, `A` = added, `D` = deleted, `?` = untracked, `R` = renamed, etc.

**Response**
```json
{
  "repoName": "my-app",
  "remoteUrl": "https://github.com/org/my-app",
  "currentBranch": "feature/auth",
  "clean": false,
  "changedFileCount": 2,
  "files": [
    { "status": "M", "file": "src/index.js" },
    { "status": "?", "file": "notes.txt" }
  ]
}
```

---

### GET `/git/findByName?repo=<repoName>&name=<fileName>`
Find files by exact file name. If `repo` is omitted, searches across all known repositories.

**Query Parameters**

| Param | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Exact file name to match (e.g. `index.js`) |
| `repo` | No | Scope search to a single repo |

**Response** *(with repo scoped)*
```json
{
  "repoName": "my-app",
  "remoteUrl": "https://github.com/org/my-app",
  "currentBranch": "main",
  "query": "index.js",
  "count": 2,
  "files": [
    "/home/user/projects/my-app/src/index.js",
    "/home/user/projects/my-app/test/index.js"
  ]
}
```

**Response** *(cross-repo, no repo param)*
```json
{
  "query": "index.js",
  "count": 3,
  "files": [
    "/home/user/projects/my-app/src/index.js",
    "/home/user/projects/api-service/src/index.js",
    "/home/user/projects/shared-lib/index.js"
  ]
}
```

---

### GET `/git/findByPartialName?repo=<repoName>&name=<partial>`
Find files whose name contains the given substring (case-insensitive). If `repo` is omitted, searches across all known repositories.

**Query Parameters**

| Param | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Partial file name to match (e.g. `auth`) |
| `repo` | No | Scope search to a single repo |

**Response** *(with repo scoped)*
```json
{
  "repoName": "my-app",
  "remoteUrl": "https://github.com/org/my-app",
  "currentBranch": "main",
  "query": "auth",
  "count": 3,
  "files": [
    "/home/user/projects/my-app/src/auth.js",
    "/home/user/projects/my-app/src/authMiddleware.js",
    "/home/user/projects/my-app/test/auth.test.js"
  ]
}
```

---

### GET `/git/search?repo=<repoName>&text=<searchText>`
Full-text search across all non-binary files. Returns matching lines with line numbers and context snippets. If `repo` is omitted, searches across all known repositories.

**Query Parameters**

| Param | Required | Description |
|-------|----------|-------------|
| `text` | Yes | Text to search for (case-insensitive) |
| `repo` | No | Scope search to a single repo |

**Response** *(with repo scoped)*
```json
{
  "repoName": "my-app",
  "remoteUrl": "https://github.com/org/my-app",
  "currentBranch": "main",
  "searchText": "getUserById",
  "totalFiles": 2,
  "totalMatches": 4,
  "results": [
    {
      "file": "/home/user/projects/my-app/src/userService.js",
      "matchCount": 3,
      "matches": [
        { "lineNumber": 12, "snippet": "async function getUserById(id) {" },
        { "lineNumber": 45, "snippet": "const user = await getUserById(req.params.id);" },
        { "lineNumber": 78, "snippet": "module.exports = { getUserById };" }
      ]
    },
    {
      "file": "/home/user/projects/my-app/test/user.test.js",
      "matchCount": 1,
      "matches": [
        { "lineNumber": 9, "snippet": "const { getUserById } = require('../src/userService');" }
      ]
    }
  ]
}
```

---

### POST `/git/readFiles`
Batch-read the full content of multiple files in a single request. Accepts absolute paths or paths relative to the base directory.

**Request Body**
```json
[
  "/home/user/projects/my-app/src/index.js",
  "/home/user/projects/my-app/package.json"
]
```

**Response**
```json
{
  "count": 2,
  "files": {
    "/home/user/projects/my-app/src/index.js": {
      "content": "const express = require('express');\n..."
    },
    "/home/user/projects/my-app/package.json": {
      "content": "{\n  \"name\": \"my-app\",\n  \"version\": \"1.0.0\"\n}"
    }
  }
}
```

> Note: This endpoint does not wrap in repo meta since the batch may span multiple repos. Use `/git/file` for single-file reads with full repo context.

---

### GET `/git/pull?repo=<repoName>`
Pull the latest changes from the remote for the currently checked-out branch.

**Query Parameters**

| Param | Required | Description |
|-------|----------|-------------|
| `repo` | Yes | Folder name of the repository |

**Response**
```json
{
  "repoName": "my-app",
  "remoteUrl": "https://github.com/org/my-app",
  "currentBranch": "main",
  "message": "Already up to date."
}
```

---

## Notes for Agents

- **`repo` param is always the folder name** of the repository on disk, which is the key shown in `/git/repos` under `folderName`. It is not the GitHub repo name (though they are often the same).
- **All file paths in responses are absolute** paths on the server's filesystem. Pass these directly back into `/git/file` or `/git/readFiles`.
- **`repoName` vs `folderName`** — `repoName` is derived from the remote URL (e.g. the GitHub repo name). `folderName` is the local directory name. Use `folderName` when calling endpoints.
- **Binary files** (images, archives, executables, etc.) are excluded from all search and read operations.
- **Excluded directories** — `node_modules`, `target`, `dist`, `build`, and all hidden directories (starting with `.`) are excluded from file tree, search, and extension scans.