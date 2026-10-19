/**
 * Server-side checkout: the price comes from your own code, never from the
 * browser. The form on /shop posts here; we create the payment through the
 * plugin and redirect the buyer to Zarinpal.
 *
 * Needs the plugin's "Checkout API key" setting and the same value in the
 * ZARINPAL_API_KEY secret: `wrangler secret put ZARINPAL_API_KEY` on
 * Cloudflare (with nodejs_compat, Workers expose secrets on process.env),
 * .dev.vars locally, or the process environment on Node.js.
 */
import type { APIRoute } from "astro";

import { zarinpal } from "../../lib/zarinpal";

export const prerender = false;

// Your catalogue. Amounts in Toman.
const PRODUCTS: Record<string, { title: string; amount: number }> = {
	"linux-basics": { title: "Linux Basics course", amount: 1_500_000 },
	"docker-workshop": { title: "Docker workshop", amount: 2_900_000 },
};

export const POST: APIRoute = async ({ request, locals, url, redirect }) => {
	const form = await request.formData();
	const product = PRODUCTS[String(form.get("product"))];
	if (!product) return new Response("Unknown product", { status: 400 });

	// Your own order id: use it later to fulfil exactly once.
	const orderId = `ord-${crypto.randomUUID()}`;
	const result = await zarinpal(locals, url, "checkout", {
		body: {
			apiKey: process.env.ZARINPAL_API_KEY,
			amount: product.amount,
			currency: "IRT",
			description: product.title,
			orderId,
			idempotencyKey: orderId,
			mobile: String(form.get("mobile") ?? "") || undefined,
		},
	});
	if (!result.ok) {
		return redirect(`/payment/failed?reason=${encodeURIComponent(result.data.error ?? "checkout_failed")}`, 303);
	}
	return redirect(result.data.paymentUrl as string, 303);
};
