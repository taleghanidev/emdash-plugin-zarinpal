import type { StorageCollection } from "emdash";
import type { PluginContext } from "emdash/plugin";

import {
	type Currency,
	type GatewayEnv,
	MAX_AMOUNT,
	requestPayment,
	startPayUrl,
	verifyPayment,
} from "./zarinpal.js";

/**
 * Payment lifecycle.
 *
 * - pending: created, waiting for the buyer or for the first verify.
 * - paid:    Zarinpal verify returned 100 or 101. Final.
 * - failed:  the last verify said "not paid". NOT final: a later verify can
 *            still find it paid, so reconciliation keeps checking it.
 * - expired: Zarinpal still said "not paid" after MAX_RECHECK_AGE_MS. A callback
 *            or a manual verify that later succeeds still moves it to paid.
 *            Unknown outcomes (outages) never expire.
 * - error:   Zarinpal refused to create the payment (no authority). Final.
 *
 * Only a successful verify writes `paid`, and every write is guarded by
 * `updateIf` on the current status, so a forged or repeated callback cannot
 * downgrade a paid record.
 */
export type PaymentStatus = "pending" | "paid" | "failed" | "expired" | "error";

export interface Payment {
	status: PaymentStatus;
	source: "link" | "checkout";
	env: GatewayEnv;
	/** Fingerprint of the merchant ID the payment was created with. */
	merchantRef: string | null;
	amount: number;
	currency: Currency;
	description: string;
	authority: string | null;
	orderId: string | null;
	linkId: string | null;
	email: string | null;
	mobile: string | null;
	idempotencyKey: string | null;
	payloadHash: string | null;
	receiptToken: string;
	createdAt: string;
	/** When the current authority was issued; restarts reset it. */
	attemptAt: string | null;
	updatedAt: string;
	callbackStatus: "OK" | "NOK" | null;
	callbackAt: string | null;
	refId: string | null;
	cardPan: string | null;
	fee: number | null;
	feeType: string | null;
	verifyCode: number | null;
	verifiedAt: string | null;
	checks: number;
	nextCheckAt: string | null;
	lastError: string | null;
	lastErrorCode: number | null;
}

export interface PaymentLink {
	title: string;
	amount: number;
	currency: Currency;
	description: string;
	active: boolean;
	createdAt: string;
}

export interface Config {
	merchantId: string;
	/** First 16 hex characters of SHA-256(merchantId); "" when unset. */
	merchantRef: string;
	env: GatewayEnv;
	currency: Currency;
	baseUrl: string;
	successPath: string;
	failurePath: string;
	apiKey: string;
	rateLimit: number;
}

export const UNSETTLED: PaymentStatus[] = ["pending", "failed", "expired"];

/** First reconciliation check, after the buyer has had time to pay. */
export const FIRST_CHECK_DELAY_MS = 20 * 60_000;
/** After this age a definite "not paid" answer marks the payment expired. */
export const MAX_RECHECK_AGE_MS = 6 * 60 * 60_000;
/**
 * Delay before the next check, by number of checks already made: checks land
 * about 20 minutes, 2 hours and 6 hours after the payment started, so each
 * abandoned payment costs three checks.
 */
const BACKOFF_MS = [100, 240, 180].map((m) => m * 60_000);
/**
 * Zarinpal answers that mean "this authority is not paid". Everything else
 * (rate limits, configuration errors, amount mismatches, unknown codes) says
 * nothing about the payment and keeps it scheduled.
 */
const NOT_PAID_CODES = new Set([-51, -54]);
/** Uncertain outcomes are re-checked at least this often, without end. */
export const MAX_BACKOFF_MS = 180 * 60_000;
/**
 * A reservation without an authority older than this is abandoned: a
 * sandboxed call is cut off after 30 seconds of wall time.
 */
export const STALE_RESERVATION_MS = 45_000;

export function payments(ctx: PluginContext): StorageCollection<Payment> {
	return ctx.storage.payments as StorageCollection<Payment>;
}

export function links(ctx: PluginContext): StorageCollection<PaymentLink> {
	return ctx.storage.links as StorageCollection<PaymentLink>;
}

// ── Settings ────────────────────────────────────────────────────────────────

function safePath(value: unknown, fallback: string): string {
	if (typeof value !== "string") return fallback;
	const v = value.trim();
	// A same-site path only: no scheme, no protocol-relative "//host".
	if (!v.startsWith("/") || v.startsWith("//") || v.includes("\\")) return fallback;
	return v;
}

function normalizeOrigin(value: unknown): string {
	if (typeof value !== "string" || value.trim() === "") return "";
	try {
		const url = new URL(value.trim());
		if (url.protocol !== "https:" && url.protocol !== "http:") return "";
		return url.origin;
	} catch {
		return "";
	}
}

/** Reads every setting in one bridge call. */
export async function loadConfig(ctx: PluginContext): Promise<Config> {
	const entries = await ctx.settings.list();
	const s: Record<string, unknown> = {};
	for (const { key, value } of entries) s[key] = value;

	const rate = typeof s.rateLimit === "number" ? Math.floor(s.rateLimit) : 30;
	const merchantId = typeof s.merchantId === "string" ? s.merchantId.trim() : "";
	return {
		merchantId,
		merchantRef: merchantId ? (await sha256Hex(merchantId)).slice(0, 16) : "",
		env: s.sandbox === false ? "production" : "sandbox",
		currency: s.currency === "IRR" ? "IRR" : "IRT",
		baseUrl: normalizeOrigin(s.siteUrl) || normalizeOrigin(ctx.site?.url),
		successPath: safePath(s.successPath, "/payment/success"),
		failurePath: safePath(s.failurePath, "/payment/failed"),
		apiKey: typeof s.apiKey === "string" ? s.apiKey : "",
		rateLimit: Math.min(Math.max(rate, 1), 1000),
	};
}

export function callbackUrl(ctx: PluginContext, cfg: Config): string {
	return `${cfg.baseUrl}/_emdash/api/plugins/${ctx.plugin.id}/callback`;
}

/**
 * Return pages are site-relative paths. EmDash only lets a public route
 * redirect within the origin the request arrived on, and the callback always
 * arrives on the site, so a path is both sufficient and safe.
 */
export function successUrl(cfg: Config, id: string, p: Payment): string {
	const q = new URLSearchParams({ payment: id, token: p.receiptToken });
	return `${cfg.successPath}${cfg.successPath.includes("?") ? "&" : "?"}${q}`;
}

export function failureUrl(cfg: Config, reason: string, id?: string): string {
	const q = new URLSearchParams(id ? { payment: id, reason } : { reason });
	return `${cfg.failurePath}${cfg.failurePath.includes("?") ? "&" : "?"}${q}`;
}

// ── Small helpers ───────────────────────────────────────────────────────────

export function nowIso(): string {
	return new Date().toISOString();
}

export function randomToken(bytes = 18): string {
	const buf = crypto.getRandomValues(new Uint8Array(bytes));
	let s = "";
	for (const b of buf) s += String.fromCharCode(b);
	return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function sha256Hex(value: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Compares two secrets through their SHA-256 digests, so the loop always runs
 * over 32 bytes whatever the input lengths.
 */
export async function secretsMatch(given: string, expected: string): Promise<boolean> {
	if (!expected) return false;
	const enc = new TextEncoder();
	const [a, b] = await Promise.all([
		crypto.subtle.digest("SHA-256", enc.encode(given)),
		crypto.subtle.digest("SHA-256", enc.encode(expected)),
	]);
	const x = new Uint8Array(a);
	const y = new Uint8Array(b);
	let diff = 0;
	for (let i = 0; i < x.length; i++) diff |= x[i]! ^ y[i]!;
	return diff === 0;
}

const EMAIL_RE = /^[^\s@<>()",;]{1,64}@[^\s@<>()",;]{1,190}\.[A-Za-z]{2,}$/;
const MOBILE_RE = /^09\d{9}$/;
const ORDER_RE = /^[A-Za-z0-9._:-]{1,64}$/;

export function cleanEmail(value: unknown): string | null {
	return typeof value === "string" && EMAIL_RE.test(value.trim()) ? value.trim() : null;
}

/** Zarinpal expects an Iranian mobile like 09121234567; Persian digits are normalized. */
export function cleanMobile(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const v = value
		.trim()
		.replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
		.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
		.replace(/^\+98/, "0")
		.replace(/^0098/, "0")
		.replace(/[\s-]/g, "");
	return MOBILE_RE.test(v) ? v : null;
}

export function cleanOrderId(value: unknown): string | null | false {
	if (value === undefined || value === null || value === "") return null;
	return typeof value === "string" && ORDER_RE.test(value) ? value : false;
}

export function validAmount(amount: unknown, currency: Currency): amount is number {
	return (
		typeof amount === "number" &&
		Number.isSafeInteger(amount) &&
		amount > 0 &&
		amount <= MAX_AMOUNT[currency]
	);
}

export function backoffFor(checks: number): number {
	return BACKOFF_MS[Math.min(checks, BACKOFF_MS.length - 1)]!;
}

// ── Rate limit ──────────────────────────────────────────────────────────────

/**
 * Fixed-window counter in a ring of ten KV keys (one per minute slot), so the
 * KV never grows. The write is a compare-and-set: of two concurrent requests
 * on the same count only one passes, and the other is refused rather than
 * retried, which keeps the call within two subrequests.
 */
export async function takeRateToken(ctx: PluginContext, limit: number): Promise<boolean> {
	const minute = Math.floor(Date.now() / 60_000);
	const key = `rate:${minute % 10}`;
	const current = await ctx.kv.getVersioned<{ minute: number; count: number }>(key);
	const count = current && current.value.minute === minute ? current.value.count : 0;
	if (count >= limit) return false;
	const result = await ctx.kv.compareAndSet(key, current?.revision ?? null, { minute, count: count + 1 });
	return result.applied;
}

// ── Create ──────────────────────────────────────────────────────────────────

export interface NewPayment {
	source: Payment["source"];
	amount: number;
	currency: Currency;
	description: string;
	orderId: string | null;
	linkId: string | null;
	email: string | null;
	mobile: string | null;
	idempotencyKey: string | null;
}

export type CreateResult =
	| { ok: true; id: string; payment: Payment; paymentUrl: string; reused: boolean }
	| { ok: false; error: string; message: string; id?: string };

async function payloadHashOf(input: NewPayment): Promise<string> {
	return sha256Hex(
		JSON.stringify([
			input.source,
			input.amount,
			input.currency,
			input.description,
			input.orderId,
			input.linkId,
			input.email,
			input.mobile,
		]),
	);
}

/**
 * Reserves the payment record first (compare-and-set on a fresh id, or on the
 * id derived from the idempotency key), then asks Zarinpal for an authority.
 * Two concurrent requests with one idempotency key cannot both reach Zarinpal.
 *
 * A reservation that never got an authority (Zarinpal refused it, or the
 * worker died before saving it) can be restarted with the same key: an
 * authority the buyer never received can never be paid, so asking again is
 * safe. The restart is claimed with compare-and-set, and only the request
 * that stores its authority first hands a payment URL to the buyer.
 */
export async function createPayment(
	ctx: PluginContext,
	cfg: Config,
	input: NewPayment,
): Promise<CreateResult> {
	const store = payments(ctx);
	const now = nowIso();
	const payloadHash = input.idempotencyKey ? await payloadHashOf(input) : null;
	const id = input.idempotencyKey
		? `ik_${(await sha256Hex(input.idempotencyKey)).slice(0, 40)}`
		: `pay_${randomToken(15)}`;

	let record: Payment = {
		status: "pending",
		source: input.source,
		env: cfg.env,
		merchantRef: cfg.merchantRef,
		amount: input.amount,
		currency: input.currency,
		description: input.description,
		authority: null,
		orderId: input.orderId,
		linkId: input.linkId,
		email: input.email,
		mobile: input.mobile,
		idempotencyKey: input.idempotencyKey,
		payloadHash,
		receiptToken: randomToken(),
		createdAt: now,
		attemptAt: null,
		updatedAt: now,
		callbackStatus: null,
		callbackAt: null,
		refId: null,
		cardPan: null,
		fee: null,
		feeType: null,
		verifyCode: null,
		verifiedAt: null,
		checks: 0,
		nextCheckAt: null,
		lastError: null,
		lastErrorCode: null,
	};

	const reserved = await store.compareAndSet(id, null, record);
	if (!reserved.applied) {
		const current = await store.getVersioned(id);
		const existing = current?.value;
		if (!current || !existing || existing.payloadHash !== payloadHash) {
			return {
				ok: false,
				error: "IDEMPOTENCY_CONFLICT",
				message: "This idempotency key was already used with a different payment.",
			};
		}
		if (existing.status === "pending" && existing.authority) {
			return {
				ok: true,
				id,
				payment: existing,
				paymentUrl: startPayUrl(existing.env, existing.authority),
				reused: true,
			};
		}
		const stale =
			existing.status === "pending" &&
			!existing.authority &&
			Date.now() - Date.parse(existing.updatedAt) > STALE_RESERVATION_MS;
		if (existing.status !== "error" && !stale) {
			return {
				ok: false,
				error: existing.status === "paid" ? "ALREADY_PAID" : existing.status === "pending" ? "IN_PROGRESS" : "PAYMENT_NOT_PAYABLE",
				message: `The payment for this idempotency key is ${existing.status}.`,
				id,
			};
		}
		// Restart the reservation. Only one concurrent retry wins the claim.
		record = {
			...existing,
			status: "pending",
			env: cfg.env,
			merchantRef: cfg.merchantRef,
			authority: null,
			updatedAt: now,
			lastError: null,
			lastErrorCode: null,
		};
		const claimed = await store.compareAndSet(id, current.revision, record);
		if (!claimed.applied) {
			return { ok: false, error: "IN_PROGRESS", message: "Another request is starting this payment.", id };
		}
	}

	const http = ctx.http;
	if (!http) throw new Error("network:request capability is missing");
	const result = await requestPayment(http.fetch.bind(http), cfg.env, {
		merchantId: cfg.merchantId,
		amount: input.amount,
		currency: input.currency,
		description: input.description,
		callbackUrl: callbackUrl(ctx, cfg),
		orderId: input.orderId ?? id,
		email: input.email,
		mobile: input.mobile,
	});

	if (!result.ok || !result.authority) {
		const failed = !result.ok ? result : { code: null, message: "No authority", uncertain: false };
		await store.updateIf(id, {
			where: { status: "pending", authority: null },
			set: {
				status: "error",
				lastError: failed.message,
				lastErrorCode: failed.code,
				updatedAt: nowIso(),
			},
		});
		ctx.log.warn("Zarinpal payment request failed", { id, code: failed.code });
		return {
			ok: false,
			error: "GATEWAY_REJECTED",
			message: failed.code !== null ? `Zarinpal error ${failed.code}: ${failed.message}` : failed.message,
			id,
		};
	}

	const authority = result.authority;
	const nextCheckAt = new Date(Date.now() + FIRST_CHECK_DELAY_MS).toISOString();
	const saved = await store.updateIf(id, {
		where: { status: "pending", authority: null },
		set: { authority, nextCheckAt, attemptAt: nowIso(), checks: 0, updatedAt: nowIso() },
	});
	if (!saved.applied) {
		// Another request stored its authority first. Never hand out an
		// authority the record does not hold: a payment on it could not be verified.
		return { ok: false, error: "IN_PROGRESS", message: "Another request started this payment.", id };
	}
	return { ok: true, id, payment: saved.data, paymentUrl: startPayUrl(cfg.env, authority), reused: false };
}

// ── Verify ──────────────────────────────────────────────────────────────────

/**
 * Verifies one payment with Zarinpal and records the outcome.
 * Safe to run concurrently from the callback, the cron job and the admin:
 * Zarinpal answers 100 then 101 for a paid authority, and every write is
 * guarded by the current status.
 *
 * Outcomes:
 * - 100/101: paid (final).
 * - a Zarinpal "not paid" answer (-51, -54): failed, re-checked with backoff
 *   until MAX_RECHECK_AGE_MS after the authority was issued, then expired.
 * - anything else (network error, 5xx, rate limit, merchant ID changed,
 *   unknown code): the status is kept and the payment stays scheduled
 *   forever, so a paid payment is never given up because of an outage.
 *
 * `reread` re-reads the record when a concurrent writer won, which costs one
 * more subrequest; the cron job skips it to stay within Cloudflare's budget.
 */
export async function verifyAndRecord(
	ctx: PluginContext,
	cfg: Config,
	id: string,
	payment: Payment,
	extra: Partial<Payment> = {},
	options: { reread?: boolean } = {},
): Promise<Payment> {
	if (payment.status === "paid" || payment.status === "error" || !payment.authority) {
		return payment;
	}
	const store = payments(ctx);
	const now = nowIso();
	const reread = options.reread ?? true;

	// A payment belongs to the merchant that created it. If the merchant ID has
	// changed since, Zarinpal would answer -53; keep the payment open instead.
	if (payment.merchantRef && cfg.merchantRef && payment.merchantRef !== cfg.merchantRef) {
		const saved = await store.updateIf(id, {
			where: { status: { in: UNSETTLED } },
			set: {
				...extra,
				lastError: "The merchant ID changed after this payment was created. Restore it, or check the payment in the Zarinpal panel.",
				lastErrorCode: null,
				updatedAt: now,
				nextCheckAt: new Date(Date.now() + MAX_BACKOFF_MS).toISOString(),
			},
			delta: { checks: { inc: 1 } },
		});
		return saved.applied ? saved.data : payment;
	}

	const http = ctx.http;
	if (!http) throw new Error("network:request capability is missing");
	const result = await verifyPayment(http.fetch.bind(http), payment.env, {
		merchantId: cfg.merchantId,
		amount: payment.amount,
		authority: payment.authority,
	});

	if (result.ok) {
		const v = result.payment;
		const paid: Partial<Payment> = {
			...extra,
			status: "paid",
			refId: v.refId,
			cardPan: v.cardPan,
			fee: v.fee,
			feeType: v.feeType,
			verifyCode: v.code,
			verifiedAt: now,
			updatedAt: now,
			nextCheckAt: null,
			lastError: null,
			lastErrorCode: null,
		};
		const saved = await store.updateIf(id, { where: { status: { in: UNSETTLED } }, set: paid });
		if (saved.applied) return saved.data;
		// Not applied: another writer already settled it (as paid, since an
		// authority exists). Zarinpal just confirmed the payment either way.
		return reread ? ((await store.get(id)) ?? { ...payment, ...paid }) : { ...payment, ...paid };
	}

	const age = Date.now() - Date.parse(payment.attemptAt ?? payment.createdAt);
	const notPaid = !result.uncertain && result.code !== null && NOT_PAID_CODES.has(result.code);
	let status: PaymentStatus;
	let nextCheckAt: string | null;
	if (!notPaid) {
		status = payment.status;
		nextCheckAt = new Date(Date.now() + Math.min(backoffFor(payment.checks), MAX_BACKOFF_MS)).toISOString();
	} else if (age >= MAX_RECHECK_AGE_MS) {
		status = "expired";
		nextCheckAt = null;
	} else {
		status = "failed";
		nextCheckAt = new Date(Date.now() + backoffFor(payment.checks)).toISOString();
	}
	const saved = await store.updateIf(id, {
		where: { status: { in: UNSETTLED } },
		set: { ...extra, status, lastError: result.message, lastErrorCode: result.code, updatedAt: now, nextCheckAt },
		delta: { checks: { inc: 1 } },
	});
	if (saved.applied) return saved.data;
	return reread ? ((await store.get(id)) ?? payment) : payment;
}

/** Fields safe to hand to the site's server code. */
export function serverView(id: string, p: Payment) {
	return {
		id,
		status: p.status,
		paid: p.status === "paid",
		environment: p.env,
		amount: p.amount,
		currency: p.currency,
		description: p.description,
		orderId: p.orderId,
		linkId: p.linkId,
		email: p.email,
		mobile: p.mobile,
		authority: p.authority,
		refId: p.refId,
		cardPan: p.cardPan,
		fee: p.fee,
		createdAt: p.createdAt,
		verifiedAt: p.verifiedAt,
		lastErrorCode: p.lastErrorCode,
	};
}

/** Fields safe to show the buyer on a receipt page. */
export function receiptView(id: string, p: Payment) {
	return {
		id,
		status: p.status,
		paid: p.status === "paid",
		amount: p.amount,
		currency: p.currency,
		description: p.description,
		refId: p.status === "paid" ? p.refId : null,
		verifiedAt: p.verifiedAt,
		environment: p.env,
	};
}
