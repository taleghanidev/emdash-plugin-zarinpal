import type { PluginContext, SandboxedPlugin } from "emdash/plugin";
import { pluginResponse, pluginRoute } from "emdash/plugin";

import { handleAdmin } from "./admin.js";
import {
	type Config,
	cleanEmail,
	cleanMobile,
	cleanOrderId,
	createPayment,
	failureUrl,
	links,
	loadConfig,
	nowIso,
	type Payment,
	payments,
	receiptView,
	secretsMatch,
	serverView,
	successUrl,
	takeRateToken,
	UNSETTLED,
	validAmount,
	verifyAndRecord,
} from "./payments.js";
import { RECONCILE_TASK, reconcile } from "./reconcile.js";
import type { Currency } from "./zarinpal.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function redirect(location: string) {
	return pluginResponse({ status: 303, headers: { location, "cache-control": "no-store" } });
}

function fail(cfg: Config, reason: string, id?: string) {
	return redirect(failureUrl(cfg, reason, id));
}

function queryValue(input: unknown, key: string): string {
	if (!isRecord(input)) return "";
	const v = input[key];
	if (typeof v === "string") return v;
	if (Array.isArray(v) && typeof v[0] === "string") return v[0];
	return "";
}

function attemptView(a: { id: string; data: Payment }) {
	return { id: a.id, status: a.data.status, amount: a.data.amount, currency: a.data.currency, createdAt: a.data.createdAt };
}

function ready(cfg: Config): string | null {
	if (!cfg.merchantId) return "not_configured";
	if (!cfg.baseUrl) return "no_site_url";
	return null;
}

// ── Plugin ──────────────────────────────────────────────────────────────────

const plugin: SandboxedPlugin = {
	hooks: {
		"plugin:activate": async (_event, ctx) => {
			await ctx.cron?.schedule(RECONCILE_TASK, { schedule: "* * * * *" });
		},
		cron: {
			errorPolicy: "continue",
			handler: async (event, ctx) => {
				if (event.name !== RECONCILE_TASK) return;
				const result = await reconcile(ctx, 3);
				if (result.paid > 0) ctx.log.info("Zarinpal reconciliation found paid payments", result);
			},
		},
	},

	routes: {
		/**
		 * Payment-link button. The button's script posts { link } here and
		 * sends the browser to the returned paymentUrl. EmDash does not let a
		 * public route redirect to another origin, so this answers JSON.
		 * POST only, so crawlers and link previews never create payments.
		 */
		pay: pluginRoute({
			public: true,
			methods: ["POST"],
			request: { body: "json", maxBytes: 4096 },
			handler: async (routeCtx, ctx) => {
				const cfg = await loadConfig(ctx);
				const notReady = ready(cfg);
				if (notReady) return { ok: false, error: notReady.toUpperCase() };

				const body = isRecord(routeCtx.input) ? routeCtx.input : {};
				const linkId = typeof body.link === "string" ? body.link.trim() : "";
				const link = /^lnk_[A-Za-z0-9_-]{6,40}$/.test(linkId) ? await links(ctx).get(linkId) : null;
				if (!link || !link.active) return { ok: false, error: "UNKNOWN_LINK" };

				if (!(await takeRateToken(ctx, cfg.rateLimit))) return { ok: false, error: "RATE_LIMITED" };

				const created = await createPayment(ctx, cfg, {
					source: "link",
					amount: link.amount,
					currency: link.currency,
					description: link.description || link.title,
					orderId: null,
					linkId,
					email: cleanEmail(body.email),
					mobile: cleanMobile(body.mobile),
					idempotencyKey: null,
				});
				if (!created.ok) return { ok: false, error: created.error };
				return { ok: true, paymentId: created.id, paymentUrl: created.paymentUrl };
			},
		}),

		/**
		 * Server-side checkout for site code (an Astro endpoint, a form handler).
		 * Never call it from the browser: the body carries the API key.
		 */
		checkout: pluginRoute({
			public: true,
			methods: ["POST"],
			request: { body: "json", maxBytes: 8192 },
			handler: async (routeCtx, ctx) => {
				const cfg = await loadConfig(ctx);
				const body = isRecord(routeCtx.input) ? routeCtx.input : {};
				if (!cfg.apiKey) return { ok: false, error: "CHECKOUT_DISABLED" };
				if (typeof body.apiKey !== "string" || !(await secretsMatch(body.apiKey, cfg.apiKey))) {
					return { ok: false, error: "UNAUTHORIZED" };
				}
				const notReady = ready(cfg);
				if (notReady) return { ok: false, error: notReady.toUpperCase() };

				if (body.currency !== undefined && body.currency !== "IRR" && body.currency !== "IRT") {
					return { ok: false, error: "INVALID_CURRENCY", message: 'currency must be "IRR" or "IRT"' };
				}
				const currency: Currency = body.currency ?? cfg.currency;
				if (!validAmount(body.amount, currency)) {
					return { ok: false, error: "INVALID_AMOUNT", message: "amount must be a positive whole number within Zarinpal's limit" };
				}
				const description = typeof body.description === "string" ? body.description.trim() : "";
				if (!description || description.length > 500) {
					return { ok: false, error: "INVALID_DESCRIPTION", message: "description is required, at most 500 characters" };
				}
				const orderId = cleanOrderId(body.orderId);
				if (orderId === false) {
					return { ok: false, error: "INVALID_ORDER_ID", message: "orderId: 1-64 of A-Z a-z 0-9 . _ : -" };
				}
				const key = body.idempotencyKey;
				if (key !== undefined && (typeof key !== "string" || key.length < 8 || key.length > 128)) {
					return { ok: false, error: "INVALID_IDEMPOTENCY_KEY", message: "idempotencyKey: 8-128 characters" };
				}

				if (!(await takeRateToken(ctx, cfg.rateLimit))) return { ok: false, error: "RATE_LIMITED" };

				const created = await createPayment(ctx, cfg, {
					source: "checkout",
					amount: body.amount,
					currency,
					description,
					orderId,
					linkId: null,
					email: cleanEmail(body.email),
					mobile: cleanMobile(body.mobile),
					idempotencyKey: typeof key === "string" ? key : null,
				});
				if (!created.ok) {
					return { ok: false, error: created.error, message: created.message, paymentId: created.id ?? null };
				}
				return {
					ok: true,
					paymentId: created.id,
					authority: created.payment.authority,
					paymentUrl: created.paymentUrl,
					reused: created.reused,
					environment: created.payment.env,
				};
			},
		}),

		/**
		 * Zarinpal sends the buyer back here with ?Authority=...&Status=OK|NOK.
		 * Status is never trusted: only a successful verify marks a payment paid.
		 */
		callback: pluginRoute({
			public: true,
			methods: ["GET"],
			request: { body: "none" },
			response: "raw",
			handler: async (routeCtx, ctx) => {
				const cfg = await loadConfig(ctx);
				const authority = queryValue(routeCtx.input, "Authority").trim();
				const status = queryValue(routeCtx.input, "Status").trim().toUpperCase();
				if (!/^[A-Za-z0-9]{10,64}$/.test(authority)) return fail(cfg, "invalid_callback");

				const found = await payments(ctx).query({ where: { authority }, limit: 1 });
				const hit = found.items[0];
				if (!hit) return fail(cfg, "unknown_payment");
				const { id, data: payment } = hit;

				if (payment.status === "paid") return redirect(successUrl(cfg, id, payment));

				const observed = { callbackStatus: status === "OK" ? "OK" : "NOK", callbackAt: nowIso() } as const;
				if (status !== "OK") {
					// The buyer cancelled or the bank declined. Leave the payment
					// unsettled: reconciliation verifies it later in case it was paid.
					await payments(ctx).updateIf(id, {
						where: { status: { in: UNSETTLED } },
						set: { ...observed, updatedAt: nowIso() },
					});
					return redirect(failureUrl(cfg, "cancelled", id));
				}

				const after = await verifyAndRecord(ctx, cfg, id, payment, observed);
				if (after.status === "paid") return redirect(successUrl(cfg, id, after));
				return redirect(
					failureUrl(cfg, after.lastErrorCode === null ? "verify_pending" : `zarinpal_${after.lastErrorCode}`, id),
				);
			},
		}),

		/** Receipt data for the buyer's success page: needs the token from the redirect. */
		receipt: pluginRoute({
			public: true,
			methods: ["GET"],
			request: { body: "none" },
			handler: async (routeCtx, ctx) => {
				const id = queryValue(routeCtx.input, "payment");
				const token = queryValue(routeCtx.input, "token");
				if (!/^(pay|ik)_[A-Za-z0-9_-]{8,64}$/.test(id) || !token) return { ok: false, error: "NOT_FOUND" };
				const p = await payments(ctx).get(id);
				if (!p || !(await secretsMatch(token, p.receiptToken))) return { ok: false, error: "NOT_FOUND" };
				return { ok: true, payment: receiptView(id, p) };
			},
		}),

		/**
		 * Authoritative status for the site's server code, for fulfilment.
		 * Body: { apiKey, paymentId } or { apiKey, orderId }. Pass verify: true
		 * to re-verify an unsettled payment with Zarinpal before answering.
		 */
		payment: pluginRoute({
			public: true,
			methods: ["POST"],
			request: { body: "json", maxBytes: 4096 },
			handler: async (routeCtx, ctx) => {
				const cfg = await loadConfig(ctx);
				const body = isRecord(routeCtx.input) ? routeCtx.input : {};
				if (!cfg.apiKey) return { ok: false, error: "CHECKOUT_DISABLED" };
				if (typeof body.apiKey !== "string" || !(await secretsMatch(body.apiKey, cfg.apiKey))) {
					return { ok: false, error: "UNAUTHORIZED" };
				}
				const store = payments(ctx);
				let attempts: Array<{ id: string; data: Payment }> = [];
				if (typeof body.paymentId === "string" && /^(pay|ik)_[A-Za-z0-9_-]{8,64}$/.test(body.paymentId)) {
					const p = await store.get(body.paymentId);
					if (p) attempts = [{ id: body.paymentId, data: p }];
				} else if (typeof body.orderId === "string" && cleanOrderId(body.orderId)) {
					const orderId = body.orderId;
					// An order can have several attempts. A paid one always wins,
					// however many newer unpaid attempts exist.
					const [paid, recent] = await Promise.all([
						store.query({ where: { orderId, status: "paid" }, limit: 1 }),
						store.query({ where: { orderId }, orderBy: { createdAt: "desc" }, limit: 20 }),
					]);
					attempts = recent.items;
					if (paid.items[0]) {
						return {
							ok: true,
							payment: serverView(paid.items[0].id, paid.items[0].data),
							attempts: attempts.map(attemptView),
						};
					}
					if (body.verify === true && cfg.merchantId) {
						// Verify the two attempts touched longest ago. Every verify
						// updates updatedAt, so repeated calls rotate through all
						// unsettled attempts, expired ones included.
						const due = await store.query({
							where: { orderId, status: { in: UNSETTLED } },
							orderBy: { updatedAt: "asc" },
							limit: 6,
						});
						for (const a of due.items.filter((x) => x.data.authority).slice(0, 2)) {
							const after = await verifyAndRecord(ctx, cfg, a.id, a.data, {}, { reread: false });
							if (after.status === "paid") {
								return { ok: true, payment: serverView(a.id, after), attempts: attempts.map(attemptView) };
							}
						}
					}
				}
				if (attempts.length === 0) return { ok: false, error: "NOT_FOUND" };

				let chosen = attempts.find((a) => a.data.status === "paid");
				if (!chosen && body.verify === true && cfg.merchantId && typeof body.paymentId === "string") {
					const only = attempts[0]!;
					only.data = await verifyAndRecord(ctx, cfg, only.id, only.data, {}, { reread: false });
				}
				chosen ??= attempts[0]!;
				return {
					ok: true,
					payment: serverView(chosen.id, chosen.data),
					attempts: attempts.map(attemptView),
				};
			},
		}),

		admin: {
			handler: async (routeCtx, ctx: PluginContext) => handleAdmin(ctx, routeCtx.input),
		},
	},
};

export default plugin;
