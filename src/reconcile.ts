import type { PluginContext } from "emdash/plugin";

import { type Config, loadConfig, nowIso, payments, verifyAndRecord } from "./payments.js";

export const RECONCILE_TASK = "zarinpal-reconcile";

/**
 * Re-verifies payments whose next check is due, oldest first.
 *
 * Covers buyers who paid but never came back to the callback (closed tab,
 * lost connection) and callbacks that hit a network error. The batch is small
 * because a Cloudflare sandboxed plugin gets 10 subrequests per invocation:
 * one settings read, one query, then one verify and one write per payment,
 * so 3 payments cost 8 calls with room for one log line. The job runs every
 * minute, which gives about 180 checks an hour.
 */
export async function reconcile(
	ctx: PluginContext,
	batch = 3,
	config?: Config,
): Promise<{ checked: number; paid: number }> {
	const cfg = config ?? (await loadConfig(ctx));
	if (!cfg.merchantId) return { checked: 0, paid: 0 };
	const due = await payments(ctx).query({
		where: { nextCheckAt: { lte: nowIso() } },
		orderBy: { nextCheckAt: "asc" },
		limit: batch,
	});
	let paid = 0;
	for (const { id, data } of due.items) {
		const after = await verifyAndRecord(ctx, cfg, id, data, {}, { reread: false });
		if (after.status === "paid" && data.status !== "paid") paid++;
	}
	return { checked: due.items.length, paid };
}
