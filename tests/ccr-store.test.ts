import { describe, expect, test } from "bun:test";
import { Prisma } from "../src/generated/prisma/client";
import {
	CcrStore,
	normalizeAiProxyCredentialInput,
	normalizeProjectCreateInput,
	normalizeProjectUpdateInput,
	ProjectNameConflictError,
} from "../src/worker/lib/ccr-store";
import { mergeJsonObject } from "../src/worker/lib/ccr-json";

type CcrStorePrisma = ConstructorParameters<typeof CcrStore>[0];

/**
 * 用最小 fake Prisma client 构造 CcrStore。
 * @param fake 只包含当前测试会调用的方法
 * @returns CcrStore 实例
 */
function createStoreFromFakePrisma(fake: unknown): CcrStore {
	return new CcrStore(fake as CcrStorePrisma);
}

/**
 * 计算测试用 AI Proxy token 哈希，保持断言贴近数据库保存形态。
 * @param token token 原文
 * @returns 十六进制 SHA-256
 */
async function hashTestToken(token: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(token),
	);
	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

describe("normalizeProjectCreateInput", () => {
	test("uses the default name when the project name is empty", () => {
		expect(normalizeProjectCreateInput({ name: "   " })).toEqual({
			name: "Default Project",
			description: null,
		});
	});

	test("trims project name and description", () => {
		expect(
			normalizeProjectCreateInput({
				name: "  产品研发  ",
				description: "  需求和代码会话  ",
			}),
		).toEqual({
			name: "产品研发",
			description: "需求和代码会话",
		});
	});

	test("caps project fields to the API limits", () => {
		const normalized = normalizeProjectCreateInput({
			name: "a".repeat(100),
			description: "b".repeat(600),
		});

		expect(normalized.name).toHaveLength(80);
		expect(normalized.description).toHaveLength(500);
	});
});

describe("normalizeProjectUpdateInput", () => {
	test("does not update omitted fields", () => {
		expect(normalizeProjectUpdateInput({ description: "  只更新描述  " })).toEqual({
			description: "只更新描述",
		});
	});

	test("uses the default name only when name is explicitly empty", () => {
		expect(normalizeProjectUpdateInput({ name: "   " })).toEqual({
			name: "Default Project",
		});
	});
});

describe("mergeJsonObject", () => {
	test("treats null patch fields as clearing stale metadata", () => {
		expect(
			mergeJsonObject(
				{
					model: "sonnet",
					pending_action: { tool_name: "old-tool" },
					task_summary: "old summary",
				},
				{
					model: "haiku",
					pending_action: null,
				},
			),
		).toEqual({
			model: "haiku",
			task_summary: "old summary",
		});
	});
});

describe("CcrStore tool permission lookup", () => {
	test("finds can_use_tool request with targeted JSON path query", async () => {
		const calls: unknown[] = [];
		const store = createStoreFromFakePrisma({
			chatWorkerEvent: {
				findFirst: async (args: unknown) => {
					calls.push(args);
					return {
						payload: {
							type: "control_request",
							request_id: "request-1",
							request: {
								subtype: "can_use_tool",
								tool_name: "Bash",
								input: { command: "pwd" },
							},
						},
					};
				},
			},
		});

		await expect(
			store.findToolPermissionRequest("session-1", "request-1"),
		).resolves.toEqual({
			subtype: "can_use_tool",
			tool_name: "Bash",
			input: { command: "pwd" },
		});
		expect(calls).toEqual([
			{
				where: {
					sessionId: "session-1",
					eventType: "control_request",
					payload: { path: ["request_id"], equals: "request-1" },
				},
				orderBy: { id: "desc" },
				select: { payload: true },
			},
		]);
	});

	test("checks existing permission response with targeted JSON path query", async () => {
		const calls: unknown[] = [];
		const store = createStoreFromFakePrisma({
			chatClientEvent: {
				findFirst: async (args: unknown) => {
					calls.push(args);
					return { id: 1 };
				},
			},
		});

		await expect(
			store.hasToolPermissionResponse("session-1", "request-1"),
		).resolves.toBe(true);
		expect(calls).toEqual([
			{
				where: {
					sessionId: "session-1",
					eventType: "control_response",
					payload: { path: ["response", "request_id"], equals: "request-1" },
				},
				select: { id: true },
			},
		]);
	});
});

describe("normalizeAiProxyCredentialInput", () => {
	test("normalizes AI proxy credential defaults and /v1 base URL", () => {
		expect(
			normalizeAiProxyCredentialInput({
				name: "  Mandao  ",
				baseUrl: "https://ai-api.example.com/v1",
				apiKey: "  sk-test  ",
			}),
		).toEqual({
			name: "Mandao",
			provider: "anthropic",
			baseUrl: "https://ai-api.example.com",
			apiKey: "sk-test",
		});
	});
});

describe("CcrStore project name uniqueness", () => {
	test("rejects creating a duplicate active project name for the same user", async () => {
		let createCalled = false;
		const store = createStoreFromFakePrisma({
			project: {
				findFirst: async () => ({ id: "existing-project" }),
				create: async () => {
					createCalled = true;
					return {};
				},
			},
		});

		await expect(store.createProject("user-1", "A")).rejects.toBeInstanceOf(
			ProjectNameConflictError,
		);
		expect(createCalled).toBe(false);
	});

	test("rejects renaming a project to another active project name", async () => {
		let updateCalled = false;
		const store = createStoreFromFakePrisma({
			project: {
				findFirst: async () => ({ id: "other-project" }),
				updateMany: async () => {
					updateCalled = true;
					return { count: 1 };
				},
			},
		});

		await expect(
			store.updateProject("user-1", "project-1", { name: "A" }),
		).rejects.toBeInstanceOf(ProjectNameConflictError);
		expect(updateCalled).toBe(false);
	});
});

describe("CcrStore worker lifecycle guards", () => {
	test("lists recent client events without loading the whole session history", async () => {
		const calls: unknown[] = [];
		const createdAt = new Date("2026-05-26T00:00:00.000Z");
		const rows = [3, 2, 1].map((sequenceNum) => ({
			eventId: `event-${sequenceNum}`,
			sequenceNum,
			eventType: "user",
			source: "chat-api",
			payload: { type: "user" },
			createdAt,
		}));
		const store = createStoreFromFakePrisma({
			chatClientEvent: {
				findMany: async (args: unknown) => {
					calls.push(args);
					return rows;
				},
			},
		});

		const events = await store.listRecentClientEvents("session-1", 3);

		expect(calls).toEqual([
			{
				where: { sessionId: "session-1" },
				orderBy: { sequenceNum: "desc" },
				take: 3,
			},
		]);
		expect(events.map((event) => event.sequence_num)).toEqual([1, 2, 3]);
	});

	test("lists older timeline events before the current first id", async () => {
		const calls: unknown[] = [];
		const createdAt = new Date("2026-05-26T00:00:00.000Z");
		const rows = [12, 11, 10].map((id) => ({
			id,
			eventId: `timeline-${id}`,
			eventType: "assistant",
			payload: { type: "assistant" },
			ephemeral: false,
			createdAt,
		}));
		const store = createStoreFromFakePrisma({
			chatWorkerEvent: {
				findMany: async (args: unknown) => {
					calls.push(args);
					return rows;
				},
			},
		});

		const events = await store.listChatTimelineBefore("session-1", 13, 3);

		expect(calls).toEqual([
			{
				where: { sessionId: "session-1", id: { lt: 13 } },
				orderBy: { id: "desc" },
				take: 3,
			},
		]);
		expect(events.map((event) => event.id)).toEqual([10, 11, 12]);
	});

	test("returns empty Claude Code config when the user has no stored config", async () => {
		const store = createStoreFromFakePrisma({
			userClaudeCodeConfig: {
				findUnique: async (args: { where: unknown }) => {
					expect(args.where).toEqual({ userId: "user-1" });
					return null;
				},
			},
		});

		await expect(store.getUserClaudeCodeConfig("user-1")).resolves.toEqual({
			claudeConfigJson: {},
			claudeJson: {},
		});
	});

	test("upserts user Claude Code config into the user-scoped record", async () => {
		let upsertArgs: unknown;
		const store = createStoreFromFakePrisma({
			userClaudeCodeConfig: {
				upsert: async (args: unknown) => {
					upsertArgs = args;
					return {};
				},
			},
		});

		await store.upsertUserClaudeCodeConfig("user-1", {
			claudeConfigJson: { permissions: { allow: ["Bash(ls)"] } },
			claudeJson: { hasCompletedOnboarding: true },
		});

		expect(upsertArgs).toMatchObject({
			where: { userId: "user-1" },
			create: {
				userId: "user-1",
				claudeConfigJson: { permissions: { allow: ["Bash(ls)"] } },
				claudeJson: { hasCompletedOnboarding: true },
			},
			update: {
				claudeConfigJson: { permissions: { allow: ["Bash(ls)"] } },
				claudeJson: { hasCompletedOnboarding: true },
			},
		});
	});

	test("stops queued event polling after the session is deleted", async () => {
		const whereClauses: unknown[] = [];
		const store = createStoreFromFakePrisma({
			chatClientEvent: {
				findMany: async (args: { where: unknown }) => {
					whereClauses.push(args.where);
					return [];
				},
			},
			chatSession: {
				findFirst: async (args: { where: unknown }) => {
					whereClauses.push(args.where);
					return null;
				},
			},
		});

		await expect(store.listQueuedClientEvents("session-1", 0)).resolves.toBeNull();
		expect(whereClauses).toEqual([
			{
				sessionId: "session-1",
				session: { deletedAt: null },
				sequenceNum: { gt: 0 },
				status: "queued",
			},
			{ id: "session-1", deletedAt: null },
		]);
	});

	test("rejects worker events before writing when the epoch is no longer active", async () => {
		const calls: string[] = [];
		const tx = {
			chatSession: {
				updateMany: async (args: { where: unknown }) => {
					calls.push("claim");
					expect(args.where).toEqual({
						id: "session-1",
						workerEpoch: 2,
						deletedAt: null,
					});
					return { count: 0 };
				},
			},
			chatWorkerEvent: {
				createMany: async () => {
					calls.push("event");
					return { count: 1 };
				},
			},
			chatOperationLog: {
				create: async () => {
					calls.push("operation");
					return {};
				},
			},
		};
		const store = createStoreFromFakePrisma({
			$transaction: async (fn: (transaction: unknown) => Promise<boolean>) => fn(tx),
		});

		await expect(
			store.insertWorkerEvents("session-1", 2, [{ payload: { type: "assistant" } }]),
		).resolves.toBe(false);
		expect(calls).toEqual(["claim"]);
	});

	test("encrypts user default AI proxy credential before storing", async () => {
		let storedApiKeyCiphertext = "";
		const tx = {
			aiProxyCredential: {
				updateMany: async () => ({ count: 1 }),
				create: async (args: { data: { apiKeyCiphertext: string } }) => {
					storedApiKeyCiphertext = args.data.apiKeyCiphertext;
					return {
						id: "credential-1",
						name: "Default Anthropic Proxy",
						provider: "anthropic",
						baseUrl: "https://api.anthropic.com",
						isDefault: true,
						createdAt: new Date(),
						updatedAt: new Date(),
					};
				},
			},
		};
		const store = new CcrStore(
			{
				$transaction: async (fn: (transaction: unknown) => Promise<unknown>) => fn(tx),
			} as CcrStorePrisma,
			{ aiProxyCredentialSecret: "unit-test-secret" },
		);

		await store.upsertDefaultAiProxyCredential("user-1", {
			apiKey: "sk-real-secret",
		});

		expect(storedApiKeyCiphertext).toStartWith("v1:");
		expect(storedApiKeyCiphertext).not.toContain("sk-real-secret");
	});

	test("rejects AI proxy token when session moved to another sandbox", async () => {
		const token = "nnaip_unit_test_token";
		const expectedTokenHash = await hashTestToken(token);
		let currentSessionSandboxId = "sandbox-current";
		const store = createStoreFromFakePrisma({
			aiProxyToken: {
				findUnique: async (args: { where: { tokenHash: string } }) => {
					expect(args.where.tokenHash).toBe(expectedTokenHash);
					return {
						id: "token-1",
						userId: "user-1",
						sessionId: "session-1",
						sandboxId: "sandbox-old",
						expiresAt: new Date(Date.now() + 60_000),
						revokedAt: null,
						session: {
							deletedAt: null,
							sandboxId: currentSessionSandboxId,
						},
					};
				},
			},
		});

		await expect(store.authenticateAiProxyToken(token)).resolves.toBeNull();

		currentSessionSandboxId = "sandbox-old";
		await expect(store.authenticateAiProxyToken(token)).resolves.toEqual({
			tokenId: "token-1",
			userId: "user-1",
			sessionId: "session-1",
			sandboxId: "sandbox-old",
		});
	});

	test("creates and completes AI proxy request logs with light and payload records", async () => {
		const calls: unknown[] = [];
		const store = createStoreFromFakePrisma({
			aiProxyRequestLog: {
				create: async (args: unknown) => {
					calls.push({ kind: "create", args });
					return {};
				},
				update: async (args: unknown) => {
					calls.push({ kind: "update", args });
					return {};
				},
			},
		});

		const logId = await store.createAiProxyRequestLog({
			userId: "user-1",
			sessionId: "session-1",
			tokenId: "token-1",
			credentialId: "credential-1",
			provider: "anthropic",
			requestMethod: "POST",
			requestUrl: "https://api.anthropic.com/v1/messages",
			requestPath: "/v1/messages",
			upstreamUrl: "https://gateway.example.com/v1/messages",
			upstreamBaseUrl: "https://gateway.example.com",
			requestBytes: 13,
		});
		await store.completeAiProxyRequestLog({
			logId,
			statusCode: 200,
			durationMs: 123,
			responseBytes: 15,
			requestHeaders: [["x-api-key", "nnaip_token"]],
			requestBody: "{\"ok\":true}",
			upstreamRequestHeaders: [["x-api-key", "real-key"]],
			responseHeaders: [["content-type", "application/json"]],
			responseBody: "{\"done\":true}",
		});

		expect(calls).toHaveLength(2);
		expect(calls[0]).toMatchObject({
			kind: "create",
			args: {
				data: {
					userId: "user-1",
					sessionId: "session-1",
					tokenId: "token-1",
					credentialId: "credential-1",
					provider: "anthropic",
					requestBytes: 13,
				},
			},
		});
		expect(calls[1]).toMatchObject({
			kind: "update",
			args: {
				where: { id: logId },
				data: {
					statusCode: 200,
					durationMs: 123,
					responseBytes: 15,
					errorMessage: null,
					payload: {
						create: {
							requestBody: "{\"ok\":true}",
							requestHeaders: [["x-api-key", "nnaip_token"]],
							upstreamRequestHeaders: [["x-api-key", "real-key"]],
							responseHeaders: [["content-type", "application/json"]],
							responseBody: "{\"done\":true}",
						},
					},
				},
			},
		});
	});

	test("clears stale requires_action details when worker returns to idle", async () => {
		const updates: Array<{ where: unknown; data: Record<string, unknown> }> = [];
		const operationPayloads: unknown[] = [];
		const tx = {
			chatSession: {
				updateMany: async (args: { where: unknown; data: Record<string, unknown> }) => {
					updates.push(args);
					return { count: 1 };
				},
				findFirst: async () => ({
					externalMetadata: {
						model: "sonnet",
						pending_action: { tool_name: "old-tool" },
						keep: "value",
					},
				}),
			},
			chatOperationLog: {
				create: async (args: { data: { payload: unknown } }) => {
					operationPayloads.push(args.data.payload);
					return {};
				},
			},
		};
		const store = createStoreFromFakePrisma({
			$transaction: async (fn: (transaction: unknown) => Promise<boolean>) => fn(tx),
		});

		await expect(
			store.updateWorker("session-1", 2, {
				worker_epoch: 2,
				worker_status: "idle",
				requires_action_details: null,
				external_metadata: {
					model: "haiku",
					pending_action: null,
				},
			}),
		).resolves.toBe(true);

		expect(updates[0]?.where).toEqual({
			id: "session-1",
			workerEpoch: 2,
			deletedAt: null,
		});
		expect(updates[1]?.data).toMatchObject({
			workerStatus: "idle",
			externalMetadata: {
				model: "haiku",
				keep: "value",
			},
		});
		expect(updates[1]?.data.requiresActionDetails).toBe(Prisma.DbNull);
		expect(operationPayloads).toHaveLength(1);
	});

	test("guards heartbeat updates by active session and current epoch", async () => {
		const updates: unknown[] = [];
		const store = createStoreFromFakePrisma({
			chatSession: {
				updateMany: async (args: { where: unknown; data: unknown }) => {
					updates.push({ where: args.where, data: Object.keys(args.data as object) });
					return { count: 0 };
				},
			},
		});

		await expect(store.recordHeartbeat("session-1", 3)).resolves.toBe(false);
		expect(updates).toEqual([
			{
				where: { id: "session-1", workerEpoch: 3, deletedAt: null },
				data: ["lastHeartbeatAt"],
			},
		]);
	});

	test("rejects sessionStore writes when the session is no longer active", async () => {
		const calls: string[] = [];
		const tx = {
			chatSession: {
				updateMany: async (args: { where: unknown }) => {
					calls.push("claim");
					expect(args.where).toEqual({ id: "session-1", deletedAt: null });
					return { count: 0 };
				},
			},
			chatSessionStoreFile: {
				upsert: async () => {
					calls.push("upsert");
					return {};
				},
			},
		};
		const store = createStoreFromFakePrisma({
			$transaction: async (fn: (transaction: unknown) => Promise<unknown>) => fn(tx),
		});

		await expect(
			store.writeSessionStoreFile("session-1", "claude-code", "session.jsonl", "{}"),
		).resolves.toBeNull();
		expect(calls).toEqual(["claim"]);
	});

	test("does not rebuild sessionStore when inserting internal events", async () => {
		const calls: string[] = [];
		const tx = {
			chatSession: {
				updateMany: async (args: { where: unknown }) => {
					calls.push("claim");
					expect(args.where).toEqual({
						id: "session-1",
						workerEpoch: 2,
						deletedAt: null,
					});
					return { count: 1 };
				},
			},
			chatInternalEvent: {
				createMany: async (args: { data: { eventType: string }; skipDuplicates: boolean }) => {
					calls.push(`create:${args.data.eventType}`);
					expect(args.skipDuplicates).toBe(true);
					return { count: 1 };
				},
			},
		};
		const store = createStoreFromFakePrisma({
			$transaction: async (fn: (transaction: unknown) => Promise<unknown>) => fn(tx),
			chatSession: {
				findFirst: async () => {
					throw new Error("insertInternalEvents should not rebuild sessionStore");
				},
			},
			chatSessionStoreFile: {
				findMany: async () => {
					throw new Error("insertInternalEvents should not read sessionStore");
				},
				upsert: async () => {
					throw new Error("insertInternalEvents should not write sessionStore");
				},
			},
		});

		await expect(
			store.insertInternalEvents("session-1", 2, [
				{
					payload: {
						type: "assistant",
						uuid: "event-1",
					},
				},
			]),
		).resolves.toBe(true);
		expect(calls).toEqual(["claim", "create:assistant"]);
	});

	test("caps internal event fallback sessionStore mirror size", async () => {
		const totalEvents = 1_200;
		const upserts: Array<{ create: { content: string; metadata?: Record<string, unknown> } }> = [];
		const rows = Array.from({ length: totalEvents }, (_, index) => {
			const id = index + 1;
			return {
				id,
				eventId: `internal-${id}`,
				eventType: "assistant",
				payload: { type: "assistant", index: id },
				eventMetadata: null,
				isCompaction: false,
				agentId: null,
				createdAt: new Date("2026-05-26T00:00:00.000Z"),
			};
		});
		const store = createStoreFromFakePrisma({
			$transaction: async (fn: (transaction: unknown) => Promise<unknown>) =>
				fn({
					chatSession: {
						updateMany: async () => ({ count: 1 }),
					},
					chatSessionStoreFile: {
						upsert: async (args: { create: { content: string; metadata?: Record<string, unknown> } }) => {
							upserts.push(args);
							return {};
						},
					},
				}),
			chatSession: {
				findFirst: async () => ({ id: "session-1" }),
			},
			chatSessionStoreFile: {
				findMany: async () => [],
				findUnique: async () => null,
			},
			chatInternalEvent: {
				findFirst: async (args: { where?: { isCompaction?: boolean } }) =>
					args.where?.isCompaction ? null : { id: 1 },
				findMany: async (args: {
					distinct?: string[];
					take?: number;
					where?: { id?: { gt?: number } };
				}) => {
					if (args.distinct?.includes("agentId")) {
						return [];
					}
					const afterId = args.where?.id?.gt ?? 0;
					return rows.filter((row) => row.id > afterId).slice(0, args.take ?? 100);
				},
			},
		});

		await expect(store.ensureClaudeSessionStoreFromInternalEvents("session-1")).resolves.toBe(true);

		const foregroundMirror = upserts[0]?.create;
		expect(foregroundMirror?.content.trim().split("\n")).toHaveLength(1_000);
		expect(foregroundMirror?.metadata).toMatchObject({
			source: "ccr_internal_events",
			transcript_kind: "foreground",
			event_count: 1_000,
			truncated: true,
			restore_max_events: 1_000,
		});
	});

	test("rejects new client events when the session is already deleting", async () => {
		const calls: string[] = [];
		const tx = {
			chatSession: {
				updateManyAndReturn: async (args: { where: unknown }) => {
					calls.push("allocate");
					expect(args.where).toEqual({ id: "session-1", deletedAt: null });
					return [];
				},
			},
			chatClientEvent: {
				create: async () => {
					calls.push("create");
					return {};
				},
			},
		};
		const store = createStoreFromFakePrisma({
			$transaction: async (fn: (transaction: unknown) => Promise<unknown>) => fn(tx),
		});

		await expect(
			store.enqueueClientEvent("session-1", {
				type: "user",
				message: { role: "user", content: "hello" },
			}),
		).rejects.toThrow("Session not found or deleting");
		expect(calls).toEqual(["allocate"]);
	});

	test("clears deleted session runner without rewriting live lifecycle fields", async () => {
		const updates: unknown[] = [];
		const store = createStoreFromFakePrisma({
			chatSession: {
				updateMany: async (args: { where: unknown; data: unknown }) => {
					updates.push(args);
					return { count: 1 };
				},
			},
		});

		await store.clearDeletedSessionRunner("session-1");
		expect(updates).toEqual([
			{
				where: { id: "session-1", deletedAt: { not: null } },
				data: { runnerProcessId: null },
			},
		]);
	});
});
