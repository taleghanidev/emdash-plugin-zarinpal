import { chromium } from "playwright";
import { readFileSync } from "node:fs";
const SITE = "http://localhost:4321", S = process.argv[2];
const API_KEY = readFileSync(process.argv[3], "utf8").match(/ZARINPAL_API_KEY=(.*)/)[1].trim();
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
const welcome = page.getByRole("button", { name: "Get Started" });
await page.addLocatorHandler(welcome, async (x) => { await x.click(); });
// 1. server checkout via the plugin route directly (as site code would)
const r = await page.request.post(`${SITE}/_emdash/api/plugins/zarinpal/checkout`, { data: { apiKey: API_KEY, amount: 990000, description: "Abandoned-tab test", orderId: "ord-abandon-1", idempotencyKey: "ord-abandon-1" } });
const out = (await r.json()).data; console.log("checkout:", JSON.stringify(out));
// 2. buyer pays, but the redirect back to our site never arrives (tab closed / network drop)
await page.goto(out.paymentUrl);
const payHref = await page.locator('a:has(button.buttons-submit)').getAttribute("href");
const hop = await page.request.get(payHref.replace(/^http:/, "https:"), { maxRedirects: 0 });
console.log("sandbox marked paid; it would redirect to:", hop.status(), hop.headers()["location"]);
let st = (await (await page.request.post(`${SITE}/_emdash/api/plugins/zarinpal/payment`, { data: { apiKey: API_KEY, orderId: "ord-abandon-1" } })).json()).data.payment;
console.log("before recovery:", st.status, st.refId);
// 3. admin recovers it
await page.goto(`${SITE}/_emdash/api/setup/dev-bypass?redirect=/_emdash/admin/plugins/zarinpal/payments`);
await page.waitForLoadState("networkidle"); await page.waitForTimeout(1500);
const row = page.getByRole("row").filter({ hasText: "Abandoned-tab test" });
await row.first().getByRole("button", { name: "Actions" }).click();
await page.getByRole("menuitem", { name: "Verify now" }).click();
await page.waitForTimeout(2500);
await page.screenshot({ path: `${S}/14-verify-now-recovered.png` });
st = (await (await page.request.post(`${SITE}/_emdash/api/plugins/zarinpal/payment`, { data: { apiKey: API_KEY, orderId: "ord-abandon-1" } })).json()).data.payment;
console.log("after recovery:", st.status, st.refId);
await b.close();
