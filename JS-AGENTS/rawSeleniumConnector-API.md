Raw Selenium Connector — Agent API Docs

Base URL: http://localhost:3035

────────────────────────────────────────
HEALTH CHECK
────────────────────────────────────────
GET http://localhost:3035/health
Response: { "status": "UP" }

────────────────────────────────────────
EXECUTE SELENIUM CODE
────────────────────────────────────────
POST http://localhost:3035/execute

Content-Type: application/json
Body: { "code": "<your nodejs selenium code as a string>" }

⚠️  CRITICAL RULES:
1. The body MUST be a JSON object with a single key: "code"
2. The value of "code" is the entire Selenium script as a JSON string
3. Escape all double quotes inside the code as \"
4. Use \n for newlines inside the code string
5. The last statement MUST be: return results;
6. Always populate the `results` variable with the data you want returned
7. Always call await driver.quit() before returning
8. Inside executeScript(), always use function() {} syntax — never arrow functions () =>
9. Inside executeScript(), always use explicit return statements — never shorthand object returns

────────────────────────────────────────
EXAMPLE PAYLOAD
────────────────────────────────────────
{
  "code": "const driver = await createDriver();\nawait driver.get(\"https://example.com\");\n\nconst title = await driver.getTitle();\nconst url = await driver.getCurrentUrl();\n\nconst elements = await driver.executeScript(function() {\n  var buttons = Array.from(document.querySelectorAll(\"button\"));\n  var anchors = Array.from(document.querySelectorAll(\"a\"));\n  return buttons.concat(anchors).map(function(el) {\n    return {\n      tag: el.tagName.toLowerCase(),\n      text: el.innerText ? el.innerText.trim() : \"\",\n      href: el.href || null\n    };\n  });\n});\n\nawait driver.quit();\n\nlet results = { title, url, elements };\nreturn results;"
}

────────────────────────────────────────
RESPONSE FORMAT
────────────────────────────────────────
Success:
{ "success": true, "result": { ...whatever you put in results... } }

Failure:
{ "success": false, "error": "error message here" }