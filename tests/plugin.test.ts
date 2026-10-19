import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createPluginRuntimeTestHost, type PluginRuntimeTestHost } from "@emdash-cms/plugin-test";

const SANDBOX = "https://sandbox.zarinpal.com/pg/v4/payment";
const LIVE = "https://payment.zarinpal.com/pg/v4/payment";
const API_KEY = "test-api-key-0123456789";
const MERCHANT = "1344b5d4-0048-11e8-94db-005056a205be";
const BASE = "https://shop.example.ir";

let host: PluginRuntimeTestHost;

function json(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

const requestOk = (authority: string) =>
	json({ data: { code: 100, message: "Success", authority, fee_type: "Merchant", fee: 3000 }, errors: [] });
const verifyOk = (code = 100, refId = 535296301) =>
	json({
		data: { code, message: code === 100 ? "Paid" : "Verified", card_hash: "AB", card_pan: "999999******9999", ref_id: refId, fee_type: "Merchant", fee: 3000 },
		errors: [],
	});
const gatewayError = (code: number, message: string) =>
	json({ data: {}, errors: { message, code, validations: [] } }, 401);

async function configure(values: Record<string, unknown> = {}) {
	const settings = { merchantId: MERCHANT, sandbox: true, currency: "IRT", siteUrl: BASE, apiKey: API_KEY, ...values };
	for (const [key, value] of Object.entries(settings)) await host.fixtures.plugin.setting(key, value);
}

async function route(name: string, init: { method?: string; body?: unknown; rawBody?: BodyInit; query?: string; headers?: Record<string, string> } = {}) {
	return host.actions.routes.request(name, {
		url: `${BASE}/_emdash/api/plugins/zarinpal/${name}${init.query ? `?${init.query}` : ""}`,
		method: init.method ?? "POST",
		...(init.body !== undefined ? { body: init.body } : {}),
		...(init.rawBody !== undefined ? { rawBody: init.rawBody } : {}),
		...(init.headers ? { headers: init.headers } : {}),
	});
}

async function data(res: Response) {
	const body = (await res.json()) as { data?: Record<string, any> };
	return body.data as Record<string, any>;
}

async function checkout(body: Record<string, unknown> = {}) {
	return data(await route("checkout", { body: { apiKey: API_KEY, amount: 10000, description: "Course seat", ...body } }));
}

function requestsTo(suffix: string) {
	return host.http.requests().filter((r) => r.url.endsWith(suffix));
}

function bodyOf(r: { body: Uint8Array }) {
	return JSON.parse(new TextDecoder().decode(r.body));
}

beforeEach(async () => {
	host = await createPluginRuntimeTestHost({ site: { url: BASE, name: "Shop" } });
});

afterEach(async () => {
	await host.dispose();
});

describe("checkout", () => {
	it("creates a sandbox payment and returns the StartPay URL", async () => {
		await configure();
		await host.http.respond(`${SANDBOX}/request.json`, requestOk("S0000000000000000000000000000000abc1"));

		const out = await checkout({ orderId: "order-1", email: "a@b.ir", mobile: "۰۹۱۲۱۲۳۴۵۶۷" });
		expect(out.ok).toBe(true);
		expect(out.paymentUrl).toBe("https://sandbox.zarinpal.com/pg/StartPay/S0000000000000000000000000000000abc1");
		expect(out.environment).toBe("sandbox");

		const [req] = requestsTo("/request.json");
		expect(bodyOf(req!)).toEqual({
			merchant_id: MERCHANT,
			amount: 10000,
			currency: "IRT",
			description: "Course seat",
			callback_url: `${BASE}/_emdash/api/plugins/zarinpal/callback`,
			metadata: { order_id: "order-1", email: "a@b.ir", mobile: "09121234567" },
		});

		const stored = await host.inspect.storage.get<any>("payments", out.paymentId);
		expect(stored.status).toBe("pending");
		expect(stored.authority).toBe("S0000000000000000000000000000000abc1");
		expect(stored.nextCheckAt).toBeTruthy();
	});

	it("uses the live gateway when sandbox mode is off", async () => {
		await configure({ sandbox: false });
		await host.http.respond(`${LIVE}/request.json`, requestOk("A0000000000000000000000000000000abc2"));
		const out = await checkout();
		expect(out.paymentUrl).toBe("https://payment.zarinpal.com/pg/StartPay/A0000000000000000000000000000000abc2");
	});

	it("rejects a wrong API key without calling Zarinpal", async () => {
		await configure();
		const out = await checkout({ apiKey: "nope" });
		expect(out).toEqual({ ok: false, error: "UNAUTHORIZED" });
		expect(host.http.requests()).toHaveLength(0);
	});

	it("is disabled when no API key is configured", async () => {
		await configure({ apiKey: "" });
		expect((await checkout()).error).toBe("CHECKOUT_DISABLED");
	});

	it("validates amount, description and order id", async () => {
		await configure();
		expect((await checkout({ amount: 10.5 })).error).toBe("INVALID_AMOUNT");
		expect((await checkout({ amount: 100_000_001 })).error).toBe("INVALID_AMOUNT");
		expect((await checkout({ amount: 1_000_000_001, currency: "IRR" })).error).toBe("INVALID_AMOUNT");
		expect((await checkout({ description: "" })).error).toBe("INVALID_DESCRIPTION");
		expect((await checkout({ orderId: "has space" })).error).toBe("INVALID_ORDER_ID");
		expect(host.http.requests()).toHaveLength(0);
	});

	it("reuses one payment for a repeated idempotency key and refuses a changed payload", async () => {
		await configure();
		await host.http.respond(`${SANDBOX}/request.json`, requestOk("S0000000000000000000000000000000idem"));
		const first = await checkout({ idempotencyKey: "order-42-attempt-1" });
		const second = await checkout({ idempotencyKey: "order-42-attempt-1" });
		expect(second.paymentId).toBe(first.paymentId);
		expect(second.reused).toBe(true);
		expect(requestsTo("/request.json")).toHaveLength(1);

		const changed = await checkout({ idempotencyKey: "order-42-attempt-1", amount: 20000 });
		expect(changed.error).toBe("IDEMPOTENCY_CONFLICT");
	});

	it("records a gateway refusal as an error payment", async () => {
		await configure();
		await host.http.respond(`${SANDBOX}/request.json`, gatewayError(-9, "The input params invalid, validation error."));
		const out = await checkout();
		expect(out.ok).toBe(false);
		expect(out.error).toBe("GATEWAY_REJECTED");
		const stored = await host.inspect.storage.get<any>("payments", out.paymentId);
		expect(stored.status).toBe("error");
		expect(stored.lastErrorCode).toBe(-9);
	});

	it("rate-limits new payments per minute", async () => {
		await configure({ rateLimit: 1 });
		await host.http.respond(`${SANDBOX}/request.json`, requestOk("S0000000000000000000000000000000rate"));
		expect((await checkout()).ok).toBe(true);
		expect((await checkout()).error).toBe("RATE_LIMITED");
	});
});

describe("callback", () => {
	async function pendingPayment(authority = "S0000000000000000000000000000000cb01") {
		await host.http.respond(`${SANDBOX}/request.json`, requestOk(authority));
		const out = await checkout();
		return { id: out.paymentId as string, authority };
	}

	it("verifies with the stored amount and currency, then redirects to the success page", async () => {
		await configure();
		const { id, authority } = await pendingPayment();
		await host.http.respond(`${SANDBOX}/verify.json`, verifyOk());

		const res = await route("callback", { method: "GET", query: `Authority=${authority}&Status=OK` });
		expect(res.status).toBe(303);
		const location = new URL(res.headers.get("location")!, BASE);
		expect(location.pathname).toBe("/payment/success");
		expect(location.searchParams.get("payment")).toBe(id);

		const [verify] = requestsTo("/verify.json");
		expect(bodyOf(verify!)).toEqual({ merchant_id: MERCHANT, amount: 10000, authority });

		const stored = await host.inspect.storage.get<any>("payments", id);
		expect(stored).toMatchObject({ status: "paid", refId: "535296301", cardPan: "999999******9999", callbackStatus: "OK", nextCheckAt: null });

		const receipt = await data(await route("receipt", { method: "GET", query: `payment=${id}&token=${location.searchParams.get("token")}` }));
		expect(receipt.ok).toBe(true);
		expect(receipt.payment).toMatchObject({ paid: true, amount: 10000, currency: "IRT", refId: "535296301" });
		const wrong = await data(await route("receipt", { method: "GET", query: `payment=${id}&token=forged` }));
		expect(wrong).toEqual({ ok: false, error: "NOT_FOUND" });
	});

	it("treats Status=NOK as an observation, not a verdict", async () => {
		await configure();
		const { id, authority } = await pendingPayment();

		const res = await route("callback", { method: "GET", query: `Authority=${authority}&Status=NOK` });
		expect(res.status).toBe(303);
		expect(res.headers.get("location")).toContain("/payment/failed?payment=");
		expect(res.headers.get("location")).toContain("reason=cancelled");
		expect(requestsTo("/verify.json")).toHaveLength(0);
		expect((await host.inspect.storage.get<any>("payments", id)).status).toBe("pending");

		// The buyer actually paid (or the NOK was forged): a later OK still verifies.
		await host.http.respond(`${SANDBOX}/verify.json`, verifyOk());
		const ok = await route("callback", { method: "GET", query: `Authority=${authority}&Status=OK` });
		expect(ok.headers.get("location")).toContain("/payment/success");
		expect((await host.inspect.storage.get<any>("payments", id)).status).toBe("paid");
	});

	it("never downgrades a paid payment", async () => {
		await configure();
		const { id, authority } = await pendingPayment();
		await host.http.respond(`${SANDBOX}/verify.json`, verifyOk());
		await route("callback", { method: "GET", query: `Authority=${authority}&Status=OK` });

		const again = await route("callback", { method: "GET", query: `Authority=${authority}&Status=NOK` });
		expect(again.headers.get("location")).toContain("/payment/success");
		expect((await host.inspect.storage.get<any>("payments", id)).status).toBe("paid");
		expect(requestsTo("/verify.json")).toHaveLength(1);
	});

	it("keeps a -51 answer re-checkable, and reconciliation later finds it paid", async () => {
		await configure();
		const { id, authority } = await pendingPayment();
		await host.http.respond(`${SANDBOX}/verify.json`, gatewayError(-51, "Session is not valid, session is not active paid try."));

		const res = await route("callback", { method: "GET", query: `Authority=${authority}&Status=OK` });
		expect(res.headers.get("location")).toContain("reason=zarinpal_-51");
		const failed = await host.inspect.storage.get<any>("payments", id);
		expect(failed).toMatchObject({ status: "failed", lastErrorCode: -51, checks: 1 });
		expect(failed.nextCheckAt).toBeTruthy();

		// Make the check due, then run the cron job.
		await host.fixtures.plugin.storage("payments", id, { ...failed, nextCheckAt: "2000-01-01T00:00:00.000Z" });
		await host.http.respond(`${SANDBOX}/verify.json`, verifyOk(101));
		await host.transport.invokeHook("cron", { name: "zarinpal-reconcile", scheduledAt: new Date().toISOString() });

		expect(await host.inspect.storage.get<any>("payments", id)).toMatchObject({ status: "paid", verifyCode: 101, nextCheckAt: null });
	});

	it("leaves the payment unchanged when Zarinpal cannot be reached", async () => {
		await configure();
		const { id, authority } = await pendingPayment();
		await host.http.respond(`${SANDBOX}/verify.json`, new Response("bad gateway", { status: 502 }));
		const res = await route("callback", { method: "GET", query: `Authority=${authority}&Status=OK` });
		expect(res.headers.get("location")).toContain("reason=verify_pending");
		expect((await host.inspect.storage.get<any>("payments", id)).status).toBe("pending");
	});

	it("rejects unknown and malformed authorities", async () => {
		await configure();
		const unknown = await route("callback", { method: "GET", query: "Authority=S0000000000000000000000000000000none&Status=OK" });
		expect(unknown.headers.get("location")).toBe("/payment/failed?reason=unknown_payment");
		const bad = await route("callback", { method: "GET", query: "Authority=<script>&Status=OK" });
		expect(bad.headers.get("location")).toBe("/payment/failed?reason=invalid_callback");
		expect(host.http.requests()).toHaveLength(0);
	});
});

describe("payment links", () => {
	it("creates a link in the admin and starts a payment from the button route", async () => {
		await configure();
		const page = await host.admin.submit("/links", "create_link", { title: "Workshop", amount: 250000, currency: "IRT", description: "" });
		expect(JSON.stringify(page)).toContain("Workshop");
		const [link] = await host.inspect.storage.list<any>("links");
		expect(link!.data).toMatchObject({ title: "Workshop", amount: 250000, currency: "IRT", active: true });
		expect(JSON.stringify(page)).toContain(`data-link=\\"${link!.id}\\"`);

		await host.http.respond(`${SANDBOX}/request.json`, requestOk("S0000000000000000000000000000000link"));
		const out = await data(await route("pay", { body: { link: link!.id, mobile: "09121234567" } }));
		expect(out).toMatchObject({ ok: true, paymentUrl: "https://sandbox.zarinpal.com/pg/StartPay/S0000000000000000000000000000000link" });
		const [req] = requestsTo("/request.json");
		expect(bodyOf(req!)).toMatchObject({ amount: 250000, currency: "IRT", description: "Workshop" });
		const [payment] = await host.inspect.storage.list<any>("payments");
		expect(payment!.data).toMatchObject({ source: "link", linkId: link!.id, mobile: "09121234567" });
	});

	it("refuses GET, unknown links and disabled links", async () => {
		await configure();
		const get = await route("pay", { method: "GET", query: "link=lnk_whatever" });
		expect(get.status).toBe(405);

		expect((await data(await route("pay", { body: { link: "lnk_doesnotexist" } }))).error).toBe("UNKNOWN_LINK");

		await host.fixtures.plugin.storage("links", "lnk_disabled01", { title: "Old", amount: 1000, currency: "IRT", description: "Old", active: false, createdAt: new Date().toISOString() });
		expect((await data(await route("pay", { body: { link: "lnk_disabled01" } }))).error).toBe("UNKNOWN_LINK");
		expect(host.http.requests()).toHaveLength(0);
	});

	it("refuses to start when the merchant ID is missing", async () => {
		expect((await data(await route("pay", { body: { link: "lnk_whatever1" } }))).error).toBe("NOT_CONFIGURED");
	});
});

describe("server status route", () => {
	it("returns the payment by id or order id, and can re-verify", async () => {
		await configure();
		await host.http.respond(`${SANDBOX}/request.json`, requestOk("S0000000000000000000000000000000stat"));
		const out = await checkout({ orderId: "ord-7" });

		const byOrder = await data(await route("payment", { body: { apiKey: API_KEY, orderId: "ord-7" } }));
		expect(byOrder.payment).toMatchObject({ id: out.paymentId, status: "pending", orderId: "ord-7" });
		expect(byOrder.payment.receiptToken).toBeUndefined();

		await host.http.respond(`${SANDBOX}/verify.json`, verifyOk());
		const verified = await data(await route("payment", { body: { apiKey: API_KEY, paymentId: out.paymentId, verify: true } }));
		expect(verified.payment).toMatchObject({ paid: true, refId: "535296301" });

		const denied = await data(await route("payment", { body: { apiKey: "x", paymentId: out.paymentId } }));
		expect(denied.error).toBe("UNAUTHORIZED");
	});
});

describe("admin", () => {
	it("renders the payments page, details, filters and the widget", async () => {
		await configure();
		await host.http.respond(`${SANDBOX}/request.json`, requestOk("S0000000000000000000000000000000adm1"));
		const out = await checkout({ description: "Admin test" });

		const page = await host.admin.loadPage("/payments");
		const text = JSON.stringify(page);
		expect(text).toContain("Admin test");
		expect(text).toContain("Sandbox mode");

		const details = await host.admin.act("/payments", "payment_menu", { value: `details:${out.paymentId}` });
		expect(JSON.stringify(details)).toContain("S0000000000000000000000000000000adm1");

		const paidOnly = await host.admin.act("/payments", "filter:paid", { value: "paid" });
		expect(JSON.stringify(paidOnly)).toContain("No paid payments");

		const widget = await host.admin.loadWidget("summary");
		expect(JSON.stringify(widget)).toContain("Pending");
	});

	it("verifies a payment from the admin", async () => {
		await configure();
		await host.http.respond(`${SANDBOX}/request.json`, requestOk("S0000000000000000000000000000000adm2"));
		const out = await checkout();
		await host.http.respond(`${SANDBOX}/verify.json`, verifyOk());
		const res = await host.admin.act("/payments", "payment_menu", { value: `verify:${out.paymentId}` });
		expect(JSON.stringify(res)).toContain("Paid. Ref ID 535296301");
	});

	it("warns when the merchant ID is missing", async () => {
		const page = await host.admin.loadPage("/payments");
		expect(JSON.stringify(page)).toContain("Zarinpal is not ready");
	});
});

describe("review fixes", () => {
	it("rejects an explicit but invalid currency instead of using the default", async () => {
		await configure();
		expect((await checkout({ currency: "irr" })).error).toBe("INVALID_CURRENCY");
		expect(host.http.requests()).toHaveLength(0);
	});

	it("restarts an idempotency key whose first attempt Zarinpal refused", async () => {
		await configure();
		await host.http.respond(`${SANDBOX}/request.json`, gatewayError(-12, "Too many attempts"));
		const first = await checkout({ idempotencyKey: "order-restart-1" });
		expect(first.error).toBe("GATEWAY_REJECTED");
		await host.http.respond(`${SANDBOX}/request.json`, requestOk("S0000000000000000000000000000000rst1"));
		const second = await checkout({ idempotencyKey: "order-restart-1" });
		expect(second).toMatchObject({ ok: true, paymentId: first.paymentId, reused: false });
		expect((await host.inspect.storage.get<any>("payments", first.paymentId)).authority).toBe("S0000000000000000000000000000000rst1");
	});

	it("restarts a reservation abandoned before it got an authority", async () => {
		await configure();
		await host.http.respond(`${SANDBOX}/request.json`, requestOk("S0000000000000000000000000000000stl1"));
		const first = await checkout({ idempotencyKey: "order-stale-1" });
		const rec = await host.inspect.storage.get<any>("payments", first.paymentId);
		const old = new Date(Date.now() - 60_000).toISOString();
		await host.fixtures.plugin.storage("payments", first.paymentId, { ...rec, authority: null, nextCheckAt: null, updatedAt: old });

		const fresh = { ...rec, authority: null, nextCheckAt: null, updatedAt: new Date().toISOString() };
		await host.fixtures.plugin.storage("payments", first.paymentId, fresh);
		expect((await checkout({ idempotencyKey: "order-stale-1" })).error).toBe("IN_PROGRESS");

		await host.fixtures.plugin.storage("payments", first.paymentId, { ...fresh, updatedAt: old });
		await host.http.respond(`${SANDBOX}/request.json`, requestOk("S0000000000000000000000000000000stl2"));
		const retried = await checkout({ idempotencyKey: "order-stale-1" });
		expect(retried).toMatchObject({ ok: true, paymentUrl: "https://sandbox.zarinpal.com/pg/StartPay/S0000000000000000000000000000000stl2" });
	});

	it("never expires a payment because of an outage, but expires a definite not-paid answer", async () => {
		await configure();
		await host.http.respond(`${SANDBOX}/request.json`, requestOk("S0000000000000000000000000000000old1"));
		const out = await checkout();
		const rec = await host.inspect.storage.get<any>("payments", out.paymentId);
		const sevenHoursAgo = new Date(Date.now() - 7 * 3600_000).toISOString();
		const aged = { ...rec, createdAt: sevenHoursAgo, attemptAt: sevenHoursAgo, nextCheckAt: "2000-01-01T00:00:00.000Z" };
		await host.fixtures.plugin.storage("payments", out.paymentId, aged);

		await host.http.respond(`${SANDBOX}/verify.json`, new Response("bad gateway", { status: 502 }));
		await host.transport.invokeHook("cron", { name: "zarinpal-reconcile", scheduledAt: new Date().toISOString() });
		const afterOutage = await host.inspect.storage.get<any>("payments", out.paymentId);
		expect(afterOutage.status).toBe("pending");
		expect(afterOutage.nextCheckAt).toBeTruthy();

		await host.fixtures.plugin.storage("payments", out.paymentId, { ...afterOutage, nextCheckAt: "2000-01-01T00:00:00.000Z" });
		await host.http.respond(`${SANDBOX}/verify.json`, gatewayError(-51, "Session is not valid, session is not active paid try."));
		await host.transport.invokeHook("cron", { name: "zarinpal-reconcile", scheduledAt: new Date().toISOString() });
		expect(await host.inspect.storage.get<any>("payments", out.paymentId)).toMatchObject({ status: "expired", nextCheckAt: null });
	});

	it("does not expire a payment on a rate-limit answer, however old", async () => {
		await configure();
		await host.http.respond(`${SANDBOX}/request.json`, requestOk("S0000000000000000000000000000000r12x"));
		const out = await checkout();
		const rec = await host.inspect.storage.get<any>("payments", out.paymentId);
		const old = new Date(Date.now() - 7 * 3600_000).toISOString();
		await host.fixtures.plugin.storage("payments", out.paymentId, { ...rec, createdAt: old, attemptAt: old, nextCheckAt: "2000-01-01T00:00:00.000Z" });
		await host.http.respond(`${SANDBOX}/verify.json`, gatewayError(-12, "Too many attempts, please try again later."));
		await host.transport.invokeHook("cron", { name: "zarinpal-reconcile", scheduledAt: new Date().toISOString() });
		const after = await host.inspect.storage.get<any>("payments", out.paymentId);
		expect(after).toMatchObject({ status: "pending", lastErrorCode: -12 });
		expect(after.nextCheckAt).toBeTruthy();
	});

	it("finds a paid attempt behind more than 20 newer unpaid attempts", async () => {
		await configure();
		await host.http.respond(`${SANDBOX}/request.json`, requestOk("S0000000000000000000000000000000old0"));
		const first = await checkout({ orderId: "ord-many" });
		await host.http.respond(`${SANDBOX}/verify.json`, verifyOk());
		await route("callback", { method: "GET", query: "Authority=S0000000000000000000000000000000old0&Status=OK" });
		const paid = await host.inspect.storage.get<any>("payments", first.paymentId);
		for (let i = 0; i < 22; i++) {
			await host.fixtures.plugin.storage("payments", `pay_unpaid${String(i).padStart(4, "0")}`, {
				...paid, status: "failed", authority: `S00000000000000000000000000000000u${String(i).padStart(2, "0")}`,
				refId: null, createdAt: new Date(Date.now() + (i + 1) * 1000).toISOString(),
			});
		}
		const res = await data(await route("payment", { body: { apiKey: API_KEY, orderId: "ord-many" } }));
		expect(res.payment).toMatchObject({ id: first.paymentId, paid: true });
	});

	it("rotates order re-verification through expired attempts", async () => {
		await configure();
		await host.http.respond(`${SANDBOX}/request.json`, requestOk("S0000000000000000000000000000000rot0"));
		const base = await host.inspect.storage.get<any>("payments", (await checkout({ orderId: "ord-rot" })).paymentId);
		const t = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
		for (const [id, auth, updated] of [["pay_expired001", "S000000000000000000000000000000exp1", t(30)], ["pay_expired002", "S000000000000000000000000000000exp2", t(20)], ["pay_paidlater1", "S000000000000000000000000000000pdl1", t(10)]] as const) {
			await host.fixtures.plugin.storage("payments", id, { ...base, status: "expired", authority: auth, nextCheckAt: null, updatedAt: updated });
		}
		const notPaid = () => gatewayError(-51, "Session is not valid, session is not active paid try.");
		await host.http.respond(`${SANDBOX}/verify.json`, notPaid());
		await host.http.respond(`${SANDBOX}/verify.json`, notPaid());
		const first = await data(await route("payment", { body: { apiKey: API_KEY, orderId: "ord-rot", verify: true } }));
		expect(first.payment.paid).toBe(false);
		// The two oldest were just touched, so the next call reaches the third.
		await host.http.respond(`${SANDBOX}/verify.json`, verifyOk());
		const second = await data(await route("payment", { body: { apiKey: API_KEY, orderId: "ord-rot", verify: true } }));
		expect(second.payment).toMatchObject({ id: "pay_paidlater1", paid: true });
	});

	it("keeps a payment open instead of verifying it with a different merchant ID", async () => {
		await configure();
		await host.http.respond(`${SANDBOX}/request.json`, requestOk("S0000000000000000000000000000000mch1"));
		const out = await checkout();
		await host.fixtures.plugin.setting("merchantId", "00000000-1111-2222-3333-444444444444");
		host.http.clear();
		const res = await route("callback", { method: "GET", query: "Authority=S0000000000000000000000000000000mch1&Status=OK" });
		expect(res.headers.get("location")).toContain("reason=verify_pending");
		expect(host.http.requests()).toHaveLength(0);
		const rec = await host.inspect.storage.get<any>("payments", out.paymentId);
		expect(rec.status).toBe("pending");
		expect(rec.lastError).toContain("merchant ID changed");
	});

	it("reports a paid attempt for an order even when a newer attempt is unpaid", async () => {
		await configure();
		await host.http.respond(`${SANDBOX}/request.json`, requestOk("S0000000000000000000000000000000ord1"));
		const a = await checkout({ orderId: "ord-multi" });
		await host.http.respond(`${SANDBOX}/verify.json`, verifyOk());
		await route("callback", { method: "GET", query: "Authority=S0000000000000000000000000000000ord1&Status=OK" });
		await host.http.respond(`${SANDBOX}/request.json`, requestOk("S0000000000000000000000000000000ord2"));
		await checkout({ orderId: "ord-multi" });

		const res = await data(await route("payment", { body: { apiKey: API_KEY, orderId: "ord-multi", verify: true } }));
		expect(res.payment).toMatchObject({ id: a.paymentId, paid: true });
		expect(res.attempts).toHaveLength(2);
	});
});

describe("lifecycle", () => {
	it("schedules reconciliation on activation", async () => {
		await host.actions.plugin.activate();
		const tasks = await host.inspect.scheduledTasks();
		expect(JSON.stringify(tasks)).toContain("zarinpal-reconcile");
	});
});
