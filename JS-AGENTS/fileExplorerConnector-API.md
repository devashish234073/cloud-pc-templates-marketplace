FILE EXPLORER API (http://localhost:3030)

GET /health
Returns: {"status":"UP","baseDir":"/path"}

GET /findFile?type=js&excludeFolder=node_modules,dist
Search by extension. Returns response like: {"count":2,"files":["/path/file1.js","/path/file2.js"]}

GET /findFile?name=package.json&excludeFolder=node_modules
Search by exact filename. Returns response like: {"count":1,"files":["/path/package.json"]}

GET /searchText?text=hello&excludeFolder=node_modules
Searches for text inside all readable (non-binary) files recursively. This does Case-insensitive search and returns response like: {
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
