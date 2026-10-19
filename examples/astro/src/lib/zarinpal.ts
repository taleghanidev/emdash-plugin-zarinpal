/**
 * Calls a public route of the Zarinpal plugin in-process, from Astro server
 * code. No HTTP round trip, so it also works on Cloudflare Workers, where a
 * Worker fetching its own hostname is not reliable.
 */
type Locals = App.Locals;

export interface ZarinpalResult<T = Record<string, any>> {
	ok: boolean;
	data: T & { ok?: boolean; error?: string; message?: string };
}

export async function zarinpal<T = Record<string, any>>(
	locals: Locals,
	baseUrl: URL,
	route: "checkout" | "payment" | "receipt" | "pay",
	init: { method?: "GET" | "POST"; body?: unknown; query?: Record<string, string> } = {},
): Promise<ZarinpalResult<T>> {
	const emdash = (locals as any).emdash;
	if (!emdash?.handlePublicPluginApiRoute) throw new Error("EmDash runtime is not available");
	const method = init.method ?? "POST";
	const url = new URL(`/_emdash/api/plugins/zarinpal/${route}`, baseUrl);
	for (const [k, v] of Object.entries(init.query ?? {})) url.searchParams.set(k, v);
	const request = new Request(url, {
		method,
		...(method === "POST"
			? { headers: { "content-type": "application/json" }, body: JSON.stringify(init.body ?? {}) }
			: {}),
	});
	const result = await emdash.handlePublicPluginApiRoute("zarinpal", method, `/${route}`, request);
	const data = (result?.data ?? { ok: false, error: result?.error?.code ?? "PLUGIN_ERROR" }) as ZarinpalResult<T>["data"];
	return { ok: Boolean(result?.success && data.ok), data };
}

/** Text for the failure reasons the plugin sends. Translate as needed. */
export const FAILURE_TEXT: Record<string, string> = {
	cancelled: "پرداخت لغو شد یا بانک آن را نپذیرفت.",
	verify_pending: "پاسخ بانک هنوز نرسیده است؛ پرداخت چند دقیقهٔ دیگر خودکار بررسی می‌شود.",
	unknown_payment: "این پرداخت پیدا نشد.",
	invalid_callback: "پاسخ درگاه نامعتبر بود.",
	"zarinpal_-51": "پرداخت انجام نشد.",
	"zarinpal_-50": "مبلغ پرداخت با سفارش یکسان نیست.",
	RATE_LIMITED: "درخواست‌ها زیاد است؛ چند لحظهٔ دیگر دوباره تلاش کنید.",
};
