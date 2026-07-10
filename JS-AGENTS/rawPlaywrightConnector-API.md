# Raw Playwright Connector - Agent API Docs
"agentId": "playwright connector"
Base URL: http://localhost:3036

────────────────────────────────────────
HEALTH CHECK
────────────────────────────────────────
GET http://localhost:3036/health
Response: { "status": "UP" }

────────────────────────────────────────
EXECUTE PLAYWRIGHT CODE
────────────────────────────────────────
POST http://localhost:3036/execute

Content-Type: application/json
Body: { "code": "<your nodejs playwright code as a string>" }

⚠️  CRITICAL RULES:
1. The body MUST be a JSON object with a single key: "code"
2. The value of "code" is the entire Playwright script as a JSON string
3. Escape all double quotes inside the code as \"
4. Use \n for newlines inside the code string
5. The last statement MUST be: return results;
6. Always populate the `results` variable with the data you want returned
7. Always call await driver.quit() before returning
8. Use driver._currentPage to access the active Playwright page object
9. Use page.$$eval(), page.$eval(), page.locator() etc. for DOM interaction
10. Inside page.evaluate(), always use function() {} syntax - never arrow functions () =>
11. Inside page.evaluate(), always use explicit return statements - never shorthand object returns

────────────────────────────────────────
EXAMPLE PAYLOAD 1
────────────────────────────────────────
{
  "code": "const driver = await createDriver();\nawait driver.get(\"https://example.com\");\n\nconst page = driver._currentPage;\nconst title = await driver.getTitle();\nconst url = page.url();\n\nconst elements = await page.evaluate(function() {\n  var buttons = Array.from(document.querySelectorAll(\"button\"));\n  var anchors = Array.from(document.querySelectorAll(\"a\"));\n  return buttons.concat(anchors).map(function(el) {\n    return {\n      tag: el.tagName.toLowerCase(),\n      text: el.innerText ? el.innerText.trim() : \"\",\n      href: el.href || null\n    };\n  });\n});\n\nawait driver.quit();\n\nlet results = { title, url, elements };\nreturn results;"
}

────────────────────────────────────────
EXAMPLE PAYLOAD 2
────────────────────────────────────────
{
  "code": "const driver = await createDriver();\nawait driver.get(\"http://localhost:4200/homepage\");\n\nconst page = driver._currentPage;\n\nconst emailInput = page.locator('input[type=\"email\"][placeholder=\"Your email\"]');\nawait emailInput.waitFor({ timeout: 10000 });\nawait emailInput.clear();\nawait emailInput.fill(\"hello\");\n\nconst subscribeButton = page.locator(\"button\", { hasText: \"Subscribe\" });\nawait subscribeButton.waitFor({ timeout: 10000 });\nawait subscribeButton.click();\n\nconst dialog = await page.waitForEvent(\"dialog\", { timeout: 5000 });\nconst alertText = dialog.message();\nawait dialog.accept();\n\nconst url = page.url();\n\nawait driver.quit();\n\nlet results = { success: true, finalUrl: url, alertText };\n\nreturn results;"
}

────────────────────────────────────────
EXAMPLE PAYLOAD 3
────────────────────────────────────────
{
  "code": "const driver = await createDriver();\nawait driver.get(\"https://cloud-pc-templates.com\");\n\nconst page = driver._currentPage;\n\nconst regionSelectTrigger = page.locator(\"mat-select .mat-mdc-select-trigger, mat-select .mat-select-trigger\");\nawait regionSelectTrigger.waitFor({ timeout: 10000 });\nawait regionSelectTrigger.scrollIntoViewIfNeeded();\nawait regionSelectTrigger.click();\n\nconst mumbaiOption = page.locator(\"mat-option\", { hasText: \"Mumbai\" });\nawait mumbaiOption.waitFor({ timeout: 10000 });\nawait mumbaiOption.click();\n\nconst proceedBtn = page.locator(\"button\", { hasText: \"Proceed to Software\" });\nawait proceedBtn.waitFor({ timeout: 10000 });\nawait proceedBtn.waitFor({ state: \"enabled\", timeout: 5000 });\nawait proceedBtn.click();\n\nawait page.locator(\".software-name\").first().waitFor({ timeout: 15000 });\n\nconst softwareNames = await page.$$eval(\".software-name\", function(els) {\n  return els.map(function(el) { return el.textContent.trim(); });\n});\n\nawait driver.quit();\n\nconst results = { softwareNames };\nreturn results;"
}

────────────────────────────────────────
RESPONSE FORMAT
────────────────────────────────────────
Success:
{ "success": true, "result": { ...whatever you put in results... } }

Failure:
{ "success": false, "error": "error message here" }