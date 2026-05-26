import { describe, expect, test } from "bun:test";
import { getSessionDetailResponse } from "../src/worker/lib/session-detail";

/** 构造测试用 session 摘要。 */
function createSession() {
	return {
		id: "session-1",
		title: "测试会话",
		userId: "user-1",
		projectId: "project-1",
		workerEpoch: 1,
		workerStatus: "idle",
		containerStatus: "stopped",
		sandboxId: null,
		externalMetadata: {},
		requiresActionDetails: null,
		createdAt: new Date("2026-05-26T00:00:00.000Z"),
		updatedAt: new Date("2026-05-26T00:00:00.000Z"),
		deletedAt: null,
		lastHeartbeatAt: null,
	};
}

/** 构造测试用 client event。 */
function createClientEvent(sequenceNum: number) {
	return {
		eventId: `client-${sequenceNum}`,
		sequenceNum,
		eventType: "user",
		source: "user",
		payload: { type: "user", index: sequenceNum },
		createdAt: new Date("2026-05-26T00:00:00.000Z"),
	};
}

/** 构造测试用 timeline event。 */
function createTimelineEvent(id: number) {
	return {
		id,
		eventId: `worker-${id}`,
		eventType: "assistant",
		payload: { type: "assistant", index: id },
		ephemeral: false,
		createdAt: new Date("2026-05-26T00:00:00.000Z"),
	};
}

describe("getSessionDetailResponse", () => {
	test("reads recent session content without CCR store", async () => {
		const calls: unknown[] = [];
		const prisma = {
			chatSession: {
				findFirst: async (args: unknown) => {
					calls.push(args);
					return createSession();
				},
			},
			chatClientEvent: {
				findMany: async (args: { take: number }) => {
					calls.push(args);
					return [3, 2, 1].map(createClientEvent).slice(0, args.take);
				},
			},
			chatWorkerEvent: {
				findMany: async (args: { take: number }) => {
					calls.push(args);
					return [13, 12, 11].map(createTimelineEvent).slice(0, args.take);
				},
			},
		};

		const detail = await getSessionDetailResponse(prisma, {
			userId: "user-1",
			sessionId: "session-1",
			limit: 2,
			older: false,
			beforeClientSequence: null,
			beforeTimelineId: null,
		});

		expect(detail?.clientEvents.map((event) => event.sequence_num)).toEqual([2, 3]);
		expect(detail?.timeline.map((event) => event.id)).toEqual([12, 13]);
		expect(detail?.history).toEqual({
			hasMoreClientEvents: true,
			hasMoreTimeline: true,
			beforeClientSequence: 2,
			beforeTimelineId: 12,
		});
		expect(calls).toEqual([
			expect.objectContaining({
				where: { id: "session-1", userId: "user-1", deletedAt: null },
			}),
			expect.objectContaining({
				where: { sessionId: "session-1" },
				orderBy: { sequenceNum: "desc" },
				take: 3,
			}),
			expect.objectContaining({
				where: { sessionId: "session-1" },
				orderBy: { id: "desc" },
				take: 3,
			}),
		]);
	});

	test("reads older session content before current cursors", async () => {
		const calls: unknown[] = [];
		const prisma = {
			chatSession: {
				findFirst: async () => createSession(),
			},
			chatClientEvent: {
				findMany: async (args: unknown) => {
					calls.push(args);
					return [4, 3].map(createClientEvent);
				},
			},
			chatWorkerEvent: {
				findMany: async (args: unknown) => {
					calls.push(args);
					return [14, 13].map(createTimelineEvent);
				},
			},
		};

		const detail = await getSessionDetailResponse(prisma, {
			userId: "user-1",
			sessionId: "session-1",
			limit: 2,
			older: true,
			beforeClientSequence: 5,
			beforeTimelineId: 15,
		});

		expect(detail?.clientEvents.map((event) => event.sequence_num)).toEqual([3, 4]);
		expect(detail?.timeline.map((event) => event.id)).toEqual([13, 14]);
		expect(calls).toEqual([
			expect.objectContaining({
				where: { sessionId: "session-1", sequenceNum: { lt: 5 } },
				orderBy: { sequenceNum: "desc" },
			}),
			expect.objectContaining({
				where: { sessionId: "session-1", id: { lt: 15 } },
				orderBy: { id: "desc" },
			}),
		]);
	});

	test("returns null for missing or unauthorized session", async () => {
		const prisma = {
			chatSession: {
				findFirst: async () => null,
			},
			chatClientEvent: {
				findMany: async () => {
					throw new Error("should not query client events");
				},
			},
			chatWorkerEvent: {
				findMany: async () => {
					throw new Error("should not query timeline events");
				},
			},
		};

		await expect(
			getSessionDetailResponse(prisma, {
				userId: "user-1",
				sessionId: "missing-session",
				limit: 10,
				older: false,
				beforeClientSequence: null,
				beforeTimelineId: null,
			}),
		).resolves.toBeNull();
	});
});
