import type { PluginContext } from "emdash/plugin";

import {
	type Config,
	callbackUrl,
	links,
	loadConfig,
	nowIso,
	type Payment,
	type PaymentLink,
	type PaymentStatus,
	payments,
	randomToken,
	validAmount,
	verifyAndRecord,
} from "./payments.js";
import { reconcile } from "./reconcile.js";
import { buttonSnippet } from "./snippet.js";
import { type Currency, ERROR_TEXT } from "./zarinpal.js";

type Block = Record<string, unknown>;
interface BlockResponse {
	blocks: Block[];
	toast?: { type: "success" | "error" | "info"; message: string };
}

interface Interaction {
	type: string;
	page?: string;
	action_id?: string;
	value?: unknown;
	values?: Record<string, unknown>;
}

const FILTERS: Array<{ label: string; value: PaymentStatus | "all" }> = [
	{ label: "All", value: "all" },
	{ label: "Paid", value: "paid" },
	{ label: "Pending", value: "pending" },
	{ label: "Failed", value: "failed" },
	{ label: "Expired", value: "expired" },
	{ label: "Error", value: "error" },
];

function money(amount: number, currency: Currency): string {
	return `${amount.toLocaleString("en-US")} ${currency === "IRT" ? "Toman" : "Rial"}`;
}

function errorText(code: number | null, fallback: string | null): string {
	if (code === null) return fallback ?? "";
	return `${code}: ${ERROR_TEXT[String(code)] ?? fallback ?? "Zarinpal error"}`;
}

function configBlocks(ctx: PluginContext, cfg: Config): Block[] {
	const problems: string[] = [];
	if (!cfg.merchantId) problems.push("Merchant ID is not set.");
	if (!cfg.baseUrl) problems.push("No public site URL: set it in the plugin settings.");
	const blocks: Block[] = [];
	if (problems.length > 0) {
		blocks.push({
			type: "banner",
			variant: "error",
			title: "Zarinpal is not ready",
			description: `${problems.join(" ")} Open Plugins, then Zarinpal settings.`,
		});
	} else if (cfg.env === "sandbox") {
		blocks.push({
			type: "banner",
			variant: "alert",
			title: "Sandbox mode",
			description: "Payments go to sandbox.zarinpal.com and no real money moves. Turn off Sandbox mode in the settings to go live.",
		});
	}
	blocks.push({
		type: "fields",
		fields: [
			{ label: "Gateway", value: cfg.env === "sandbox" ? "Sandbox" : "Production" },
			{ label: "Default currency", value: cfg.currency === "IRT" ? "Toman (IRT)" : "Rial (IRR)" },
			{ label: "Callback URL", value: cfg.baseUrl ? callbackUrl(ctx, cfg) : "Not set" },
			{ label: "Checkout API", value: cfg.apiKey ? "Enabled" : "Disabled (no API key)" },
		],
	});
	return blocks;
}

async function statsBlock(ctx: PluginContext): Promise<Block> {
	const store = payments(ctx);
	const [paid, pending, failed] = await Promise.all([
		store.count({ status: "paid" }),
		store.count({ status: "pending" }),
		store.count({ status: "failed" }),
	]);
	return {
		type: "stats",
		items: [
			{ label: "Paid", value: paid.toLocaleString("en-US") },
			{ label: "Pending", value: pending.toLocaleString("en-US") },
			{ label: "Failed", value: failed.toLocaleString("en-US") },
		],
	};
}

async function paymentsPage(
	ctx: PluginContext,
	cursor?: string,
	toast?: BlockResponse["toast"],
	options: { cfg?: Config; stats?: boolean } = {},
): Promise<BlockResponse> {
	const cfg = options.cfg ?? (await loadConfig(ctx));
	const filter = ((await ctx.kv.get<string>("ui:filter")) ?? "all") as PaymentStatus | "all";
	const store = payments(ctx);
	const result = await store.query({
		...(filter === "all" ? {} : { where: { status: filter } }),
		orderBy: { createdAt: "desc" },
		limit: 25,
		...(cursor ? { cursor } : {}),
	});

	const rows = result.items.map(({ id, data: p }) => ({
		created: p.createdAt,
		description: p.description,
		amount: money(p.amount, p.currency),
		status: p.status,
		ref: p.refId ?? "",
		order: p.orderId ?? "",
		env: p.env === "sandbox" ? "sandbox" : "live",
		action: {
			type: "menu",
			action_id: "payment_menu",
			label: "Actions",
			items: [
				{ label: "Details", value: `details:${id}` },
				...(p.status === "paid" || p.status === "error" || !p.authority
					? []
					: [{ label: "Verify now", value: `verify:${id}` }]),
			],
		},
	}));

	return {
		blocks: [
			{ type: "header", text: "Zarinpal payments" },
			...configBlocks(ctx, cfg),
			...(options.stats === false ? [] : [await statsBlock(ctx)]),
			{
				type: "actions",
				elements: [
					...FILTERS.map((f) => ({
						type: "button",
						label: f.label,
						action_id: `filter:${f.value}`,
						value: f.value,
						...(f.value === filter ? { style: "primary" } : {}),
					})),
					{ type: "button", label: "Reconcile now", action_id: "reconcile" },
				],
			},
			{
				type: "table",
				columns: [
					{ key: "created", label: "Created", format: "relative_time" },
					{ key: "description", label: "Description" },
					{ key: "amount", label: "Amount" },
					{ key: "status", label: "Status", format: "badge" },
					{ key: "ref", label: "Ref ID", format: "code" },
					{ key: "order", label: "Order" },
					{ key: "env", label: "Gateway", format: "badge" },
					{ key: "action", label: "", format: "element" },
				],
				rows,
				page_action_id: "payments_page",
				...(result.hasMore && result.cursor ? { next_cursor: result.cursor } : {}),
				empty_text:
					filter === "all"
						? "No payments yet. Create a payment link or call the checkout API."
						: `No ${filter} payments.`,
			},
			{
				type: "context",
				text: "Unsettled payments are re-verified automatically (first after 20 minutes, then with backoff). A definite \"not paid\" answer expires after 6 hours; an outage never expires a payment. A payment only becomes Paid when Zarinpal's verify call confirms it.",
			},
		],
		...(toast ? { toast } : {}),
	};
}

async function detailsPage(ctx: PluginContext, id: string): Promise<BlockResponse> {
	const p = await payments(ctx).get(id);
	if (!p) return paymentsPage(ctx, undefined, { type: "error", message: "Payment not found" });
	const field = (label: string, value: unknown) => ({
		label,
		value: value === null || value === undefined || value === "" ? "—" : String(value),
	});
	return {
		blocks: [
			{ type: "header", text: p.description },
			{
				type: "actions",
				elements: [
					{ type: "button", label: "Back to payments", action_id: "back" },
					...(p.status === "paid" || p.status === "error" || !p.authority
						? []
						: [{ type: "button", label: "Verify now", action_id: "verify", value: id, style: "primary" }]),
				],
			},
			{
				type: "fields",
				fields: [
					field("Status", p.status),
					field("Amount", money(p.amount, p.currency)),
					field("Gateway", p.env),
					field("Source", p.source === "link" ? "Payment link" : "Checkout API"),
					field("Payment ID", id),
					field("Order ID", p.orderId),
					field("Authority", p.authority),
					field("Ref ID", p.refId),
					field("Card", p.cardPan),
					field("Fee", p.fee === null ? null : `${p.fee.toLocaleString("en-US")} (${p.feeType ?? ""})`),
					field("Email", p.email),
					field("Mobile", p.mobile),
					field("Created", p.createdAt),
					field("Verified", p.verifiedAt),
					field("Callback", p.callbackStatus ? `${p.callbackStatus} at ${p.callbackAt}` : null),
					field("Verify attempts", p.checks),
					field("Next check", p.nextCheckAt),
					field("Last gateway answer", errorText(p.lastErrorCode, p.lastError)),
				],
			},
		],
	};
}

async function linksPage(ctx: PluginContext, toast?: BlockResponse["toast"]): Promise<BlockResponse> {
	const cfg = await loadConfig(ctx);
	const result = await links(ctx).query({ orderBy: { createdAt: "desc" }, limit: 50 });
	const rows = result.items.map(({ id, data: l }) => ({
		title: l.title,
		amount: money(l.amount, l.currency),
		id,
		state: l.active ? "active" : "disabled",
		created: l.createdAt,
		action: {
			type: "menu",
			action_id: "link_menu",
			label: "Actions",
			items: [
				{ label: l.active ? "Disable" : "Enable", value: `${l.active ? "disable" : "enable"}:${id}` },
				{ label: "Delete", value: `delete:${id}` },
			],
		},
	}));
	const snippets = result.items.slice(0, 10).map(({ id, data }) => ({
		type: "accordion",
		label: `Button code: ${data.title}`,
		default_open: false,
		blocks: [
			{ type: "code", language: "tsx", code: buttonSnippet(ctx.plugin.id, id, `Pay ${money(data.amount, data.currency)}`) },
		],
	}));
	return {
		blocks: [
			{ type: "header", text: "Payment links" },
			{
				type: "context",
				text: "A payment link is a fixed price. Paste its button code into any page, template or HTML block: the button asks the plugin to create the payment, then sends the buyer to Zarinpal.",
			},
			{
				type: "form",
				block_id: "new_link",
				fields: [
					{ type: "text_input", action_id: "title", label: "Title", placeholder: "Workshop ticket" },
					{ type: "number_input", action_id: "amount", label: "Amount", min: 1 },
					{
						type: "select",
						action_id: "currency",
						label: "Currency",
						initial_value: cfg.currency,
						options: [
							{ label: "Toman (IRT)", value: "IRT" },
							{ label: "Rial (IRR)", value: "IRR" },
						],
					},
					{
						type: "text_input",
						action_id: "description",
						label: "Description shown by Zarinpal",
						placeholder: "Leave empty to use the title",
					},
				],
				submit: { label: "Create link", action_id: "create_link" },
			},
			{
				type: "table",
				columns: [
					{ key: "title", label: "Title" },
					{ key: "amount", label: "Amount" },
					{ key: "id", label: "Link ID", format: "code" },
					{ key: "state", label: "State", format: "badge" },
					{ key: "created", label: "Created", format: "relative_time" },
					{ key: "action", label: "", format: "element" },
				],
				rows,
				page_action_id: "links_page",
				empty_text: "No payment links yet.",
			},
			...snippets,
		],
		...(toast ? { toast } : {}),
	};
}

async function createLink(ctx: PluginContext, values: Record<string, unknown>): Promise<BlockResponse> {
	const title = typeof values.title === "string" ? values.title.trim().slice(0, 120) : "";
	const currency: Currency = values.currency === "IRR" ? "IRR" : "IRT";
	const amount = typeof values.amount === "string" ? Number(values.amount) : values.amount;
	const description =
		typeof values.description === "string" && values.description.trim()
			? values.description.trim().slice(0, 500)
			: title;
	if (!title) return linksPage(ctx, { type: "error", message: "Give the link a title." });
	if (!validAmount(amount, currency)) {
		return linksPage(ctx, { type: "error", message: "Enter a whole amount within Zarinpal's limit." });
	}
	const id = `lnk_${randomToken(9)}`;
	await links(ctx).put(id, { title, amount, currency, description, active: true, createdAt: nowIso() });
	return linksPage(ctx, { type: "success", message: `Link "${title}" created.` });
}

async function linkAction(ctx: PluginContext, value: string): Promise<BlockResponse> {
	const [action, id] = value.split(":", 2);
	if (!id) return linksPage(ctx);
	const store = links(ctx);
	if (action === "delete") {
		await store.delete(id);
		return linksPage(ctx, { type: "success", message: "Link deleted. Its past payments stay in the ledger." });
	}
	const link = await store.get(id);
	if (!link) return linksPage(ctx, { type: "error", message: "Link not found" });
	await store.put(id, { ...link, active: action === "enable" });
	return linksPage(ctx, { type: "success", message: action === "enable" ? "Link enabled." : "Link disabled." });
}

async function verifyNow(ctx: PluginContext, id: string): Promise<BlockResponse> {
	const p = await payments(ctx).get(id);
	if (!p) return paymentsPage(ctx, undefined, { type: "error", message: "Payment not found" });
	const cfg = await loadConfig(ctx);
	const after = await verifyAndRecord(ctx, cfg, id, p);
	const page = await detailsPage(ctx, id);
	page.toast =
		after.status === "paid"
			? { type: "success", message: `Paid. Ref ID ${after.refId ?? ""}` }
			: { type: "info", message: `Not paid: ${errorText(after.lastErrorCode, after.lastError)}` };
	return page;
}

async function summaryWidget(ctx: PluginContext): Promise<BlockResponse> {
	const cfg = await loadConfig(ctx);
	const blocks: Block[] = [await statsBlock(ctx)];
	if (!cfg.merchantId) blocks.unshift({ type: "banner", variant: "error", description: "Merchant ID not set" });
	else if (cfg.env === "sandbox") blocks.push({ type: "context", text: "Sandbox mode: no real money moves." });
	return { blocks };
}

function cursorOf(value: unknown): string | undefined {
	if (typeof value === "string") return value || undefined;
	if (value && typeof value === "object" && "cursor" in value) {
		const c = (value as { cursor?: unknown }).cursor;
		return typeof c === "string" && c ? c : undefined;
	}
	return undefined;
}

export async function handleAdmin(ctx: PluginContext, input: unknown): Promise<BlockResponse> {
	const i = (input && typeof input === "object" ? input : {}) as Interaction;
	const value = typeof i.value === "string" ? i.value : "";

	if (i.type === "page_load") {
		if (i.page === "widget:summary") return summaryWidget(ctx);
		if (i.page === "/links") return linksPage(ctx);
		return paymentsPage(ctx);
	}
	if (i.type === "form_submit" && i.action_id === "create_link") {
		return createLink(ctx, i.values ?? {});
	}
	if (i.type === "block_action") {
		switch (i.action_id) {
			case "filter:all":
			case "filter:paid":
			case "filter:pending":
			case "filter:failed":
			case "filter:expired":
			case "filter:error":
				await ctx.kv.set("ui:filter", i.action_id.slice("filter:".length));
				return paymentsPage(ctx);
			case "payments_page":
				return paymentsPage(ctx, cursorOf(i.value));
			case "back":
				return paymentsPage(ctx);
			case "reconcile": {
				// Stay under the 10-subrequest budget of a Cloudflare sandboxed call:
				// settings + query + 2 x (verify + write) + filter + list.
				const cfg = await loadConfig(ctx);
				const r = await reconcile(ctx, 2, cfg);
				return paymentsPage(
					ctx,
					undefined,
					{ type: "success", message: `Checked ${r.checked} due payment(s); ${r.paid} newly paid.` },
					{ cfg, stats: false },
				);
			}
			case "verify":
				return verifyNow(ctx, value);
			case "payment_menu": {
				const [action, id] = value.split(":", 2);
				if (id && action === "verify") return verifyNow(ctx, id);
				if (id && action === "details") return detailsPage(ctx, id);
				return paymentsPage(ctx);
			}
			case "link_menu":
				return linkAction(ctx, value);
			case "links_page":
				return linksPage(ctx);
		}
	}
	return { blocks: [] };
}

export type { Payment };
