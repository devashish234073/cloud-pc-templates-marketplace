FILE EXPLORER API (http://localhost:3030)

GET /health
Returns: {"status":"UP","baseDir":"/path"}

GET /findFile?type=js&excludeFolder=node_modules,dist
Search by extension. Returns: {"count":2,"files":["/path/file1.js","/path/file2.js"]}

GET /findFile?name=package.json&excludeFolder=node_modules
Search by exact filename. Returns: {"count":1,"files":["/path/package.json"]}

GET /readFile?path=/full/path/to/file
Returns: {"path":"/full/path","size":1234,"content":"..."}
Blocks binary files: pdf,doc,docx,ppt,pptx,xls,xlsx,png,jpg,jpeg,gif,bmp,webp,mp3,mp4,wav,avi,mkv,mov,exe,dll,bin,iso,zip,rar,7z
