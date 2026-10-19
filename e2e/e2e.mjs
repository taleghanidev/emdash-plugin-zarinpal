import { chromium } from "playwright";
import { readFileSync } from "node:fs";
const SITE = "http://localhost:4321";
const S = process.argv[2];
const API_KEY = readFileSync(process.argv[3], "utf8").match(/ZARINPAL_API_KEY=(.*)/)[1].trim();
const MERCHANT = "1344b5d4-0048-11e8-94db-005056a205be";
const log = (...a) => console.log("•", ...a);

const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 2, locale: "en-US" });
const page = await ctx.newPage();
page.on("dialog", (d) => { log("dialog:", d.message()); d.dismiss(); });
// Zarinpal's sandbox payment page intermittently answers 500; reload it.
const settleGateway = async () => {
	for (let i = 0; i < 4 && !(await page.locator("button.buttons-submit").count()); i++) {
		await page.waitForTimeout(2000); await page.reload(); await page.waitForLoadState("networkidle");
	}
};
const shot = async (name, opts = {}) => { await page.waitForTimeout(600); if (await welcome.isVisible().catch(() => false)) { await welcome.click(); await page.waitForTimeout(400); } await page.screenshot({ path: `${S}/${name}.png`, ...opts }); log("shot", name); };
const welcome = page.getByRole("button", { name: "Get Started" });
await page.addLocatorHandler(welcome, async (btn) => { await btn.click(); });
const dismissWelcome = async () => { try { await welcome.waitFor({ timeout: 2500 }); await welcome.click(); await page.waitForTimeout(500); } catch {} };
const admin = async (path) => { await page.goto(SITE + path); await page.waitForLoadState("networkidle"); await dismissWelcome(); await page.waitForTimeout(800); };

// 1. sign in (dev bypass)
await page.goto(`${SITE}/_emdash/api/setup/dev-bypass?redirect=/_emdash/admin`);
await page.waitForLoadState("networkidle"); await dismissWelcome();

// 2. plugin list
await admin("/_emdash/admin/plugins-manager");
await shot("01-plugins-list");

// 3. settings
await admin("/_emdash/admin/plugins-manager/zarinpal/settings");
const inputs = page.locator("main input:not([type=checkbox]):not([type=hidden]):not([id$=-hidden-input])");
log("inputs:", await inputs.count());
await inputs.nth(0).fill(MERCHANT);           // merchant id (secret)
await inputs.nth(1).fill(SITE);               // site url
await inputs.nth(4).fill(API_KEY);            // api key (secret)
await shot("02-settings", { fullPage: true });
await page.getByRole("button", { name: "Save Settings" }).first().click();
await page.waitForTimeout(1500);
await shot("03-settings-saved");

// 4. payments page before any payment
await admin("/_emdash/admin/plugins/zarinpal/payments");
await shot("04-payments-empty", { fullPage: true });

// 5. create a payment link
await admin("/_emdash/admin/plugins/zarinpal/links");
const linkInputs = page.locator("main form input:not([type=hidden])");
await linkInputs.nth(0).fill("Workshop ticket");
await page.locator("main form input[type=number], main form input[inputmode=numeric], main form input[inputmode=decimal]").first().fill("250000");
await page.getByRole("button", { name: "Create link" }).click();
await page.waitForTimeout(1500);
const linkId = (await page.locator("main").innerText()).match(/lnk_[A-Za-z0-9_-]+/)?.[0];
log("link id:", linkId);
const acc = page.getByText("Button code: Workshop ticket"); if (await acc.count()) await acc.first().click();
await shot("05-payment-links", { fullPage: true });

// 6. shop page and payment-link flow -> sandbox -> pay
await page.goto(`${SITE}/shop?link=${linkId}`); await page.waitForLoadState("networkidle");
await shot("06-shop");
await page.locator("form.zarinpal-pay input[name=mobile]").fill("09121234567");
await Promise.all([page.waitForURL(/sandbox\.zarinpal\.com\/pg\/StartPay/, { timeout: 60000 }), page.locator("form.zarinpal-pay button").click()]);
await page.waitForLoadState("networkidle");
await settleGateway();
await shot("07-zarinpal-sandbox-gateway");
await Promise.all([page.waitForURL(/\/payment\/(success|failed)/, { timeout: 60000 }), page.locator("button.buttons-submit").click()]);
await page.waitForLoadState("networkidle");
log("after pay:", page.url());
await shot("08-success-receipt");
const successUrl = new URL(page.url());
const paidId = successUrl.searchParams.get("payment");

// 7. server checkout flow -> sandbox -> cancel
await page.goto(`${SITE}/shop`); await page.waitForLoadState("networkidle");
await page.locator("input[value=docker-workshop]").check();
await Promise.all([page.waitForURL(/sandbox\.zarinpal\.com\/pg\/StartPay/, { timeout: 60000 }), page.locator("form.checkout button").click()]);
await page.waitForLoadState("networkidle");
await settleGateway();
await Promise.all([page.waitForURL(/\/payment\/(success|failed)/, { timeout: 60000 }), page.getByText("انصراف").first().click()]);
await page.waitForLoadState("networkidle");
log("after cancel:", page.url());
await shot("09-failed-cancelled");

// 8. admin ledger, details, widget
await admin("/_emdash/admin/plugins/zarinpal/payments");
await shot("10-payments-ledger", { fullPage: true });
const menus = page.getByRole("button", { name: "Actions" });
log("row menus:", await menus.count());
await menus.last().click(); await page.waitForTimeout(400);
await shot("11-row-menu");
await page.getByRole("menuitem", { name: "Details" }).click(); await page.waitForTimeout(1500);
await shot("12-payment-details", { fullPage: true });
await admin("/_emdash/admin");
await shot("13-dashboard-widget");

// 9. server-side status for fulfilment
const res = await page.request.post(`${SITE}/_emdash/api/plugins/zarinpal/payment`, { data: { apiKey: API_KEY, paymentId: paidId } });
log("payment route:", JSON.stringify(await res.json()));
const bad = await page.request.post(`${SITE}/_emdash/api/plugins/zarinpal/payment`, { data: { apiKey: "wrong", paymentId: paidId } });
log("wrong key:", JSON.stringify(await bad.json()));
const forged = await page.request.get(`${SITE}/_emdash/api/plugins/zarinpal/receipt?payment=${paidId}&token=forged`);
log("forged receipt:", JSON.stringify(await forged.json()));
const getPay = await page.request.get(`${SITE}/_emdash/api/plugins/zarinpal/pay?link=${linkId}`);
log("GET pay:", getPay.status());
await b.close();
