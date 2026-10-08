FILE EXPLORER API (http://localhost:3030)
"agentId": "file-explorer"
This agent does global file search, use this only when you need to search globally

GET /findFileByName?name=<exactFileName>&excludeFolder=<folder1,folder2>
Find files by exact name. Excludes hidden dirs by default.
Returns: {"count":2,"files":["/abs/path/file.js"]}

GET /findFileByExtension?type=<ext>&excludeFolder=<folder1,folder2>
Find files by extension. Excludes hidden dirs by default.
Returns: {"count":2,"files":["/abs/path/file.js"]}

GET /searchText?text=hello&excludeFolder=node_modules
Searches for text inside all readable (non-binary) files recursively. This does Case-insensitive search , to search text with space pass %20 instead of space and this api returns response like: {
  "search": "hello",
  "count": 2,
  "results": [
    {
      "file": "/path/app.js",
      "matches": [
        {
          "lineNumber": 12,
          "line": "console.log('hello world');"
        },
        {
          "lineNumber": 45,
          "line": "// hello comment"
        }
      ]
    },
    {
      "file": "/path/README.md",
      "matches": [
        {
          "lineNumber": 3,
          "line": "hello from documentation"
        }
      ]
    }
  ]
}

GET /readFile?path=/full/path/to/file
Returns response like: {"path":"/full/path","size":1234,"content":"..."}
Blocks binary files: pdf,doc,docx,ppt,pptx,xls,xlsx,png,jpg,jpeg,gif,bmp,webp,mp3,mp4,wav,avi,mkv,mov,exe,dll,bin,iso,zip,rar,7z
