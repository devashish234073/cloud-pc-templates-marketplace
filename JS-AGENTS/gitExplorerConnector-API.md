GIT EXPLORER API (http://localhost:3033)

All repo-scoped responses include: repoName, remoteUrl, currentBranch.
The "repo" param is always the local folder name (as shown in /git/repos under "folderName").

GET /health
Returns: {"status":"UP","version":"2.0","type":"git-explorer-agent","baseDir":"/path","repoCount":3,"repos":["repo1","repo2"]}

GET /git/repos
List all discovered repos with remote URLs and current branches.
Returns: {"count":2,"repos":[{"folderName":"my-app","repoName":"my-app","remoteUrl":"https://...","currentBranch":"main","path":"/abs/path"}]}

GET /git/rescan
Re-scan base directory for new/removed repos.
Returns: {"message":"Rescanned","repoCount":4,"repos":["repo1","repo2"]}

GET /git/clone?url=<gitUrl>
Clone a remote repo into the base directory.
Returns: {"repoName":"my-app","remoteUrl":"https://...","currentBranch":"main","message":"Cloned successfully"}

GET /git/branches?repo=<folderName>
List local and remote branches.
Returns: {"currentBranch":"main","localBranches":["main","dev"],"remoteBranches":["origin/main"]}

POST /git/switch
Body: {"repo":"my-app","branch":"dev"}
Checkout a different branch.
Returns: {"currentBranch":"dev","message":"Switched to branch \"dev\""}

GET /git/tree?repo=<folderName>
Full nested file/directory tree (excludes node_modules, dist, build, hidden dirs).
Returns: {"tree":{"name":"my-app","type":"directory","path":".","children":[{"name":"src","type":"directory","path":"src","children":[{"name":"index.js","type":"file","path":"src/index.js","size":1024,"extension":"js"}]}]}}

GET /git/file?path=<absoluteOrRelativePath>
Read a single text file's content. Binary files are rejected.
Returns: {"filePath":"/abs/path","size":1024,"extension":"js","content":"..."}

GET /git/filesByExtension?repo=<folderName>&ext=<ext1[,ext2]>
List all files matching given extension(s). Comma-separated for multiple.
Returns: {"extensions":["js","ts"],"count":42,"files":["/abs/path/file.js"]}

GET /git/remoteUrl?repo=<folderName>
All configured git remotes with fetch/push URLs.
Returns: {"repoName":"my-app","remoteUrl":"https://...","remotes":{"origin":{"fetch":"https://...","push":"https://..."}}}

GET /git/log?repo=<folderName>&branch=<branch>&limit=<n>
Commit history. branch defaults to HEAD, limit defaults to 20 (max 200).
Returns: {"branch":"main","count":3,"commits":[{"hash":"a1b2c3...","author":"Name","email":"a@b.com","date":"2024-11-01 10:22:31 +0000","message":"feat: ..."}]}

GET /git/status?repo=<folderName>
Working tree status. Status codes: M=modified, A=added, D=deleted, ?=untracked, R=renamed.
Returns: {"clean":false,"changedFileCount":2,"files":[{"status":"M","file":"src/index.js"}]}

GET /git/findByName?name=<exactFileName>&repo=<folderName>
Find files by exact name. repo is optional — omit to search all repos.
Returns: {"query":"index.js","count":2,"files":["/abs/path/index.js"]}

GET /git/findByPartialName?name=<partialName>&repo=<folderName>
Find files whose name contains substring (case-insensitive). repo is optional.
Returns: {"query":"auth","count":3,"files":["/abs/path/auth.js"]}

GET /git/search?text=<searchText>&repo=<folderName>
Full-text search across non-binary files (case-insensitive). repo is optional.
Returns: {"searchText":"getUserById","totalFiles":2,"totalMatches":4,"results":[{"file":"/abs/path","matchCount":3,"matches":[{"lineNumber":12,"snippet":"async function getUserById(id) {"}]}]}

POST /git/readFiles
Body: ["/abs/path1","/abs/path2"]
Batch read multiple files. Accepts absolute or base-relative paths.
Returns: {"count":2,"files":{"/abs/path1":{"content":"..."},"/abs/path2":{"content":"..."}}}

GET /git/pull?repo=<folderName>
Pull latest changes from remote for current branch.
Returns: {"message":"Already up to date."}