/**
 * The restart race, driven directly: an old checkout request is still waiting
 * for Zarinpal when a retry restarts its reservation. Whatever the old request
 * gets back later must not touch the restarted record. The plugin-test host
 * cannot hold a request open, so this uses an in-memory store and a fetch
 * whose answers the test releases by hand.
 */
import { describe, expect, it } from "vitest";

import { type Config, createPayment, type NewPayment, type Payment } from "../src/payments.js";

type Row = { value: Payment; revision: number };

function memoryStore() {
	const rows = new Map<string, Row>();
	const matches = (data: Record<string, unknown>, where: Record<string, unknown>) =>
		Object.entries(where).every(([k, cond]) => {
			const v = data[k] ?? null;
			if (cond && typeof cond === "object" && "in" in cond) return (cond as { in: unknown[] }).in.includes(v);
			return v === cond;
		});
	return {
		rows,
		async get(id: string) {
			return rows.get(id)?.value ?? null;
		},
		async getVersioned(id: string) {
			const r = rows.get(id);
			return r ? { value: structuredClone(r.value), revision: String(r.revision) } : null;
		},
		async compareAndSet(id: string, rev: string | null, value: Payment) {
			const r = rows.get(id);
			if ((rev === null && r) || (rev !== null && (!r || String(r.revision) !== rev))) return { applied: false as const };
			rows.set(id, { value: structuredClone(value), revision: (r?.revision ?? 0) + 1 });
			return { applied: true as const, revision: String((r?.revision ?? 0) + 1) };
		},
		async updateIf(id: string, args: { where: Record<string, unknown>; set?: Partial<Payment> }) {
			const r = rows.get(id);
			if (!r || !matches(r.value as unknown as Record<string, unknown>, args.where)) return { applied: false as const };
			r.value = { ...r.value, ...args.set };
			r.revision++;
			return { applied: true as const, data: structuredClone(r.value) };
		},
	};
}

function deferredFetch() {
	const pending: Array<(r: Response) => void> = [];
	const fetch = (_url: string) => new Promise<Response>((resolve) => pending.push(resolve));
	return { fetch, pending };
}

const ok = (authority: string) =>
	new Response(JSON.stringify({ data: { code: 100, authority }, errors: [] }), { status: 200 });
const fail = () =>
	new Response(JSON.stringify({ data: {}, errors: { code: -12, message: "Too many attempts" } }), { status: 429 });

const cfg: Config = {
	merchantId: "1344b5d4-0048-11e8-94db-005056a205be",
	merchantRef: "abc",
	env: "sandbox",
	currency: "IRT",
	baseUrl: "https://shop.example.ir",
	successPath: "/payment/success",
	failurePath: "/payment/failed",
	apiKey: "k",
	rateLimit: 30,
};

const input: NewPayment = {
	source: "checkout",
	amount: 10000,
	currency: "IRT",
	description: "Seat",
	orderId: "ord-1",
	linkId: null,
	email: null,
	mobile: null,
	idempotencyKey: "order-race-1",
};

function context(store: ReturnType<typeof memoryStore>, fetch: (url: string) => Promise<Response>) {
	return {
		plugin: { id: "zarinpal", version: "0.1.1" },
		storage: { payments: store },
		http: { fetch },
		log: { warn() {}, info() {}, error() {}, debug() {} },
		site: { url: "https://shop.example.ir" },
	} as never;
}

async function race(oldAnswer: () => Response, oldFirst = false) {
	const store = memoryStore();
	const net = deferredFetch();
	const ctx = context(store, net.fetch);

	// 1. The old request reserves the key and waits for Zarinpal.
	const oldCall = createPayment(ctx, cfg, input);
	await new Promise((r) => setTimeout(r, 0));
	expect(net.pending).toHaveLength(1);

	// 2. Time passes; the reservation looks abandoned and a retry restarts it.
	const [id, row] = [...store.rows.entries()][0]!;
	row.value.updatedAt = new Date(Date.now() - 60_000).toISOString();
	const retry = createPayment(ctx, cfg, input);
	await new Promise((r) => setTimeout(r, 0));
	expect(net.pending).toHaveLength(2);
	let late: Awaited<typeof oldCall>;
	if (oldFirst) {
		// 3a. The old answer lands between the restart and the retry's answer.
		net.pending[0]!(oldAnswer());
		late = await oldCall;
		net.pending[1]!(ok("S000000000000000000000000000000new1"));
	} else {
		net.pending[1]!(ok("S000000000000000000000000000000new1"));
	}
	const retried = await retry;
	expect(retried).toMatchObject({ ok: true, paymentUrl: "https://sandbox.zarinpal.com/pg/StartPay/S000000000000000000000000000000new1" });
	if (!oldFirst) {
		// 3b. The old answer arrives after everything else.
		net.pending[0]!(oldAnswer());
		late = await oldCall;
	}
	return { late: late!, record: store.rows.get(id)!.value };
}

describe("reservation fence", () => {
	it("an old success landing between restart and retry cannot claim the record", async () => {
		const { late, record } = await race(() => ok("S000000000000000000000000000000old1"), true);
		expect(late).toMatchObject({ ok: false, error: "IN_PROGRESS" });
		expect(record).toMatchObject({ status: "pending", authority: "S000000000000000000000000000000new1" });
	});

	it("an old failure landing between restart and retry cannot mark it an error", async () => {
		const { late, record } = await race(fail, true);
		expect(late).toMatchObject({ ok: false, error: "GATEWAY_REJECTED" });
		expect(record).toMatchObject({ status: "pending", authority: "S000000000000000000000000000000new1" });
	});

	it("a late success from the old request does not replace the new authority", async () => {
		const { late, record } = await race(() => ok("S000000000000000000000000000000old1"));
		expect(late).toMatchObject({ ok: false, error: "IN_PROGRESS" });
		expect(record).toMatchObject({ status: "pending", authority: "S000000000000000000000000000000new1" });
	});

	it("a late failure from the old request does not mark the new attempt as an error", async () => {
		const { late, record } = await race(fail);
		expect(late).toMatchObject({ ok: false, error: "GATEWAY_REJECTED" });
		expect(record).toMatchObject({ status: "pending", authority: "S000000000000000000000000000000new1" });
	});
});
