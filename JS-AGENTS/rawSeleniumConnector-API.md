Raw Selenium Connector - Agent API Docs
"agentId": "selenium connector"
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
8. Inside executeScript(), always use function() {} syntax - never arrow functions () =>
9. Inside executeScript(), always use explicit return statements - never shorthand object returns

────────────────────────────────────────
EXAMPLE PAYLOAD 1
────────────────────────────────────────
{
  "code": "const driver = await createDriver();\nawait driver.get(\"https://example.com\");\n\nconst title = await driver.getTitle();\nconst url = await driver.getCurrentUrl();\n\nconst elements = await driver.executeScript(function() {\n  var buttons = Array.from(document.querySelectorAll(\"button\"));\n  var anchors = Array.from(document.querySelectorAll(\"a\"));\n  return buttons.concat(anchors).map(function(el) {\n    return {\n      tag: el.tagName.toLowerCase(),\n      text: el.innerText ? el.innerText.trim() : \"\",\n      href: el.href || null\n    };\n  });\n});\n\nawait driver.quit();\n\nlet results = { title, url, elements };\nreturn results;"
}

────────────────────────────────────────
EXAMPLE PAYLOAD 2
────────────────────────────────────────
{
  "code": "const driver = await createDriver();\nawait driver.get(\"http://localhost:4200/homepage\");\n\nconst { until, By } = require(\"selenium-webdriver\");\n\nconst emailInput = await driver.wait(\n  until.elementLocated(By.css('input[type=\"email\"][placeholder=\"Your email\"]')),\n  10000\n);\nawait emailInput.clear();\nawait emailInput.sendKeys(\"hello\");\n\nconst subscribeButton = await driver.wait(\n  until.elementLocated(By.xpath(\"//button[normalize-space(text())='Subscribe']\"))\n  , 10000\n);\nawait subscribeButton.click();\n\nawait driver.wait(until.alertIsPresent(), 5000);\nconst alert = await driver.switchTo().alert();\nconst alertText = await alert.getText();\nawait alert.accept();\n\nconst url = await driver.getCurrentUrl();\n\nawait driver.quit();\n\nlet results = { success: true, finalUrl: url, alertText };\n\nreturn results;"
}

────────────────────────────────────────
EXAMPLE PAYLOAD 2
────────────────────────────────────────
{
  "code": "const { until, By } = require(\"selenium-webdriver\");\nconst driver = await createDriver();\n\nawait driver.get(\"https://cloud-pc-templates.com\");\n\nconst regionSelectTrigger = await driver.wait(\n  until.elementLocated(By.css(\"mat-select .mat-mdc-select-trigger, mat-select .mat-select-trigger\")),\n  10000\n);\nawait driver.executeScript(\"arguments[0].scrollIntoView(true);\", regionSelectTrigger);\nawait regionSelectTrigger.click();\n\nconst mumbaiOption = await driver.wait(\n  until.elementLocated(By.xpath(\"//mat-option[.//span[contains(text(), 'Mumbai')]]\"))\n  , 10000\n);\nawait mumbaiOption.click();\n\nconst proceedBtn = await driver.wait(\n  until.elementLocated(By.xpath(\"//button[contains(., 'Proceed to Software')]\"))\n  , 10000\n);\nawait driver.wait(until.elementIsEnabled(proceedBtn), 5000);\nawait proceedBtn.click();\n\nawait driver.wait(until.elementsLocated(By.css(\".software-name\")), 15000);\n\nconst softwareNameElements = await driver.findElements(By.css(\".software-name\"));\nconst softwareNames = await Promise.all(softwareNameElements.map(el => el.getText()));\n\nawait driver.quit();\n\nconst results = { softwareNames };\nreturn results;"
}

────────────────────────────────────────
RESPONSE FORMAT
────────────────────────────────────────
Success:
{ "success": true, "result": { ...whatever you put in results... } }

Failure:
{ "success": false, "error": "error message here" }