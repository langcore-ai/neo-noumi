import { describe, expect, test } from "bun:test";
import { createSessionInternalEventsJsonlResponse } from "../src/worker/lib/session-internal-events-export";

/** 构造测试用 internal event 行。 */
function createInternalEventRow(id: number) {
	return {
		id,
		eventId: `event-${id}`,
		workerEpoch: 1,
		eventType: "assistant",
		payload: { type: "assistant", index: id },
		eventMetadata: null,
		isCompaction: false,
		agentId: null,
		createdAt: new Date("2026-05-26T00:00:00.000Z"),
	};
}

describe("createSessionInternalEventsJsonlResponse", () => {
	test("streams full session internal events in 50-row pages", async () => {
		const rows = Array.from({ length: 125 }, (_, index) => createInternalEventRow(index + 1));
		const findManyCalls: unknown[] = [];
		const prisma = {
			chatSession: {
				findFirst: async () => ({ id: "session-1" }),
			},
			chatInternalEvent: {
				findMany: async (args: { where: { id: { gt: number } }; take: number }) => {
					findManyCalls.push(args);
					return rows.filter((row) => row.id > args.where.id.gt).slice(0, args.take);
				},
			},
		};

		const response = await createSessionInternalEventsJsonlResponse(prisma, {
			userId: "user-1",
			sessionId: "session-1",
			signal: new AbortController().signal,
		});

		expect(response?.status).toBe(200);
		expect(response?.headers.get("Content-Type")).toContain("application/x-ndjson");
		const text = await response?.text();
		const lines = text?.trim().split("\n") ?? [];
		expect(lines).toHaveLength(125);
		expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
			id: 1,
			event_id: "event-1",
			worker_epoch: 1,
			payload: { type: "assistant", index: 1 },
		});
		expect(findManyCalls).toEqual([
			expect.objectContaining({ take: 50, where: { sessionId: "session-1", id: { gt: 0 } } }),
			expect.objectContaining({ take: 50, where: { sessionId: "session-1", id: { gt: 50 } } }),
			expect.objectContaining({ take: 50, where: { sessionId: "session-1", id: { gt: 100 } } }),
		]);
	});

	test("returns null when the session is not owned by current user", async () => {
		const prisma = {
			chatSession: {
				findFirst: async () => null,
			},
			chatInternalEvent: {
				findMany: async () => {
					throw new Error("should not query internal events");
				},
			},
		};

		await expect(
			createSessionInternalEventsJsonlResponse(prisma, {
				userId: "user-1",
				sessionId: "missing-session",
				signal: new AbortController().signal,
			}),
		).resolves.toBeNull();
	});
});
