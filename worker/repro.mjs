import { chromium } from "playwright";

const URL = process.argv[2] || "https://browserquest.carluve.workers.dev";
const browser = await chromium.launch();
const page = await browser.newPage();

page.on("console", (msg) => console.log("CONSOLE", msg.type(), msg.text()));
page.on("pageerror", (err) => console.log("PAGEERROR", err.message, "\n", err.stack));
page.on("websocket", (ws) => {
  console.log("WS OPEN", ws.url());
  ws.on("framereceived", (f) => console.log("WS RECV", String(f.payload).slice(0, 120)));
  ws.on("framesent", (f) => console.log("WS SENT", String(f.payload).slice(0, 120)));
  ws.on("close", () => console.log("WS CLOSE"));
  ws.on("socketerror", (e) => console.log("WS ERROR", e));
});

console.log("navigating", URL);
await page.goto(URL, { waitUntil: "load", timeout: 30000 });
await page.waitForTimeout(3000);

await page.click("#nameinput");
await page.locator("#nameinput").pressSequentially("PlayBot", { delay: 30 });
await page.locator(".createcharacter .play div").first().click({ timeout: 8000, force: true }).catch((e) => console.log("click err", e.message));

await page.waitForTimeout(9000);

const started = await page.evaluate(() => document.body.classList.contains("started")).catch(() => null);
console.log("body.started =", started);

await browser.close();
