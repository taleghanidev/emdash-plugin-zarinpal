/**
 * Zarinpal payment gateway v4 client.
 *
 * Official reference: https://www.zarinpal.com/docs/paymentGateway/connectToGateway
 * Behaviour below was also checked against sandbox.zarinpal.com:
 * - verify must be sent in the same unit the payment was requested in
 *   (an IRT request verified with the Rial amount returns -50);
 * - verifying before the buyer pays returns -51, and the same authority
 *   verifies with 100 once the buyer pays, so -51 is never final;
 * - a second verify of a paid authority returns 101 with the same ref_id;
 * - errors come back with a non-2xx status and
 *   `{"data":{},"errors":{"message","code","validations"}}`.
 */

export type GatewayEnv = "sandbox" | "production";
export type Currency = "IRR" | "IRT";

export const GATEWAY_HOSTS: Record<GatewayEnv, string> = {
	production: "https://payment.zarinpal.com",
	sandbox: "https://sandbox.zarinpal.com",
};

/** Largest amount Zarinpal accepts: 100,000,000 Toman (error -41). */
export const MAX_AMOUNT: Record<Currency, number> = {
	IRT: 100_000_000,
	IRR: 1_000_000_000,
};

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export type GatewayResult =
	| { ok: true; code: number; data: Record<string, unknown> }
	| {
			ok: false;
			/** Zarinpal error code such as -51, or null when the call never got a gateway answer. */
			code: number | null;
			message: string;
			/** True when the outcome is unknown (network failure, 5xx, unreadable body). */
			uncertain: boolean;
	  };

export function startPayUrl(env: GatewayEnv, authority: string): string {
	return `${GATEWAY_HOSTS[env]}/pg/StartPay/${encodeURIComponent(authority)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toCode(value: unknown): number | null {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && /^-?\d+$/.test(value)) return Number(value);
	return null;
}

async function call(
	fetchFn: FetchFn,
	env: GatewayEnv,
	method: "request" | "verify",
	body: Record<string, unknown>,
): Promise<GatewayResult> {
	let response: Response;
	try {
		response = await fetchFn(`${GATEWAY_HOSTS[env]}/pg/v4/payment/${method}.json`, {
			method: "POST",
			headers: { "content-type": "application/json", accept: "application/json" },
			body: JSON.stringify(body),
		});
	} catch (error) {
		const detail = error instanceof Error ? `: ${error.message}` : "";
		return { ok: false, code: null, message: `Could not reach Zarinpal${detail}`.slice(0, 300), uncertain: true };
	}

	let json: unknown;
	try {
		json = await response.json();
	} catch {
		return {
			ok: false,
			code: null,
			message: `Zarinpal returned HTTP ${response.status} without JSON`,
			uncertain: true,
		};
	}

	const data = isRecord(json) && isRecord(json.data) ? json.data : {};
	const code = toCode(data.code);
	if (response.ok && (code === 100 || code === 101)) {
		return { ok: true, code, data };
	}

	const errors = isRecord(json) ? json.errors : undefined;
	let errorCode: number | null = null;
	let message = `Zarinpal returned HTTP ${response.status}`;
	if (isRecord(errors)) {
		errorCode = toCode(errors.code);
		if (typeof errors.message === "string") message = errors.message;
	}
	return {
		ok: false,
		code: errorCode ?? code,
		message: message.slice(0, 300),
		uncertain: response.status >= 500 || (errorCode === null && code === null),
	};
}

export interface RequestPaymentInput {
	merchantId: string;
	amount: number;
	currency: Currency;
	description: string;
	callbackUrl: string;
	orderId?: string | null;
	email?: string | null;
	mobile?: string | null;
}

export async function requestPayment(
	fetchFn: FetchFn,
	env: GatewayEnv,
	input: RequestPaymentInput,
): Promise<GatewayResult & { authority?: string }> {
	const metadata: Record<string, string> = {};
	if (input.orderId) metadata.order_id = input.orderId;
	if (input.email) metadata.email = input.email;
	if (input.mobile) metadata.mobile = input.mobile;

	const result = await call(fetchFn, env, "request", {
		merchant_id: input.merchantId,
		amount: input.amount,
		currency: input.currency,
		description: input.description,
		callback_url: input.callbackUrl,
		...(Object.keys(metadata).length > 0 ? { metadata } : {}),
	});
	if (!result.ok) return result;
	const authority = result.data.authority;
	if (typeof authority !== "string" || authority.length === 0) {
		return { ok: false, code: null, message: "Zarinpal returned no authority", uncertain: false };
	}
	return { ...result, authority };
}

export interface VerifiedPayment {
	code: number;
	refId: string | null;
	cardPan: string | null;
	cardHash: string | null;
	fee: number | null;
	feeType: string | null;
}

export async function verifyPayment(
	fetchFn: FetchFn,
	env: GatewayEnv,
	input: { merchantId: string; amount: number; authority: string },
): Promise<{ ok: true; payment: VerifiedPayment } | Extract<GatewayResult, { ok: false }>> {
	const result = await call(fetchFn, env, "verify", {
		merchant_id: input.merchantId,
		amount: input.amount,
		authority: input.authority,
	});
	if (!result.ok) return result;
	const d = result.data;
	return {
		ok: true,
		payment: {
			code: result.code,
			refId: d.ref_id === undefined || d.ref_id === null ? null : String(d.ref_id),
			cardPan: typeof d.card_pan === "string" ? d.card_pan : null,
			cardHash: typeof d.card_hash === "string" ? d.card_hash : null,
			fee: typeof d.fee === "number" ? d.fee : null,
			feeType: typeof d.fee_type === "string" ? d.fee_type : null,
		},
	};
}

/** Human-readable meaning of the Zarinpal codes a merchant is likely to see. */
export const ERROR_TEXT: Record<string, string> = {
	"-9": "Validation error (merchant, callback, description, amount or referrer)",
	"-10": "Invalid merchant ID or server IP",
	"-11": "Merchant terminal is not active",
	"-12": "Too many attempts, try again later",
	"-14": "Callback domain does not match the terminal's registered domain",
	"-15": "Terminal suspended",
	"-41": "Amount above the 100,000,000 Toman maximum",
	"-50": "Verified amount differs from the requested amount",
	"-51": "Not paid (yet)",
	"-52": "Unexpected gateway error",
	"-53": "Authority belongs to another merchant",
	"-54": "Invalid authority",
};
