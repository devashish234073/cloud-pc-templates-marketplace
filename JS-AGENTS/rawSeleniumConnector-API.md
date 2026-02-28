Raw selenium Connector: This agent let's you run arbitrary selenium code in nodejs.

All APIs run on:
http://localhost:3035

To Check Health of the git explorer agent call

GET http://localhost:3035/health

Response will look like:
{"status":"UP"}

To Run Selenium Code

POST http://localhost:3035/execute with the arbitrary code with the last line must contain "return results;" where you will populate the results with the data you want you see in the response.

Below text is the exampe payload, it's plain text and syntactically should be a correct ndoejs selenium code.

const driver = await createDriver();
const fs = require("fs");
await driver.get("https://cloud-pc-templates.com");

const title = await driver.getTitle();
const url = await driver.getCurrentUrl();
const html = await driver.getPageSource();

// Collect all buttons and anchor tags
const buttons_and_a_s = await driver.executeScript(() => {
  const buttons = Array.from(document.querySelectorAll("button"));
  const anchors = Array.from(document.querySelectorAll("a"));
  
  const elements = [...buttons, ...anchors].map((el) => ({
    tag: el.tagName.toLowerCase(),
    text: el.innerText?.trim() || "",
    href: el.href || null,
    id: el.id || null,
    className: el.className || null,
    onclick: el.onclick?.toString() || null
  }));
  
  return elements;
});

await driver.quit();

let results = {
  title,
  url,
  htmlLength: html.length,
  buttons_and_a_s
};
return results;

