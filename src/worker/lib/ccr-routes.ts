import { stream } from "hono/streaming";
import type { Context, Hono } from "hono";
import { createPrismaClient } from "./prisma";
import { createAuth } from "./auth";
import { CLAUDE_SESSION_STORE_PROJECT_KEY, CcrStore } from "./ccr-store";
import {
	destroyCcrSandbox,
	getCcrSandboxStatus,
	startCcrSandbox,
	stopCcrSessionRunner,
	stopCcrUserContainer,
	type NeoNoumiSandboxBindings,
} from "./ccr-sandbox";
import { getStringField, isJsonObject, readJsonObject, toJsonValue } from "./ccr-json";
import type { ChatMessageInput, JsonObject, WorkerInternalEvent, WorkerVisibleEvent } from "./ccr-types";
import type { AuthBindings } from "./auth";

/** SSE 心跳间隔，单位毫秒 */
const SSE_HEARTBEAT_INTERVAL_MS = 5_000;

/** SSE 轮询间隔，单位毫秒 */
const SSE_POLL_INTERVAL_MS = 500;

/** Chat SSE 无新增事件时的最大保持时间，单位毫秒 */
const CHAT_STREAM_IDLE_TIMEOUT_MS = 120_000;

/** 删除会话前需要主动停止 sandbox 的容器状态 */
const ACTIVE_CONTAINER_STATUSES = new Set(["starting", "running"]);

/** Hono SSE 输出对象的最小能力集合 */
type SseOutput = {
	/** 写入一段 SSE 文本 */
	write: (chunk: string) => Promise<unknown>;
	/** 暂停一段时间，避免忙轮询 */
	sleep: (ms: number) => Promise<unknown>;
};

/** 可设置响应头的 Hono 上下文最小接口。 */
type HeaderContext = {
	/** 设置响应头 */
	header: (name: string, value: string) => void;
};

/** CCR route 需要的 Worker 绑定 */
export type CcrBindings = AuthBindings & NeoNoumiSandboxBindings;

/** CCR route 上下文变量 */
type CcrVariables = {
	userId: string;
};

/**
 * 创建 CCR store。
 * @param env Worker 绑定
 * @returns CCR store
 */
function createStore(env: CcrBindings): CcrStore {
	const databaseUrl = env.HYPERDRIVE?.connectionString ?? env.DATABASE_URL;
	if (!databaseUrl) {
		throw new Error("DATABASE_URL or HYPERDRIVE.connectionString is required");
	}
	return new CcrStore(createPrismaClient(databaseUrl));
}

/**
 * 读取 worker_epoch。
 * @param body 请求 JSON
 * @returns epoch
 */
function readWorkerEpoch(body: JsonObject): number {
	return typeof body.worker_epoch === "number"
		? body.worker_epoch
		: Number(body.worker_epoch);
}

/**
 * 格式化带游标的 SSE 数据 frame。
 * @param id SSE 事件 ID
 * @param eventName SSE 事件名
 * @param data JSON 负载
 * @returns 可直接写入 response stream 的 SSE 文本
 */
function formatSseDataFrame(id: number, eventName: string, data: unknown): string {
	return `id: ${id}\nevent: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * 格式化不带游标的 SSE 控制 frame。
 * @param eventName SSE 事件名
 * @param data JSON 负载
 * @returns 可直接写入 response stream 的 SSE 文本
 */
function formatSseControlFrame(eventName: string, data: unknown): string {
	return `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * 创建 SSE 响应，统一设置协议头后再交给 Hono 写流。
 * @param c Hono 上下文
 * @param cb 流式写入回调
 * @returns SSE response
 */
function streamSse(
	c: HeaderContext,
	cb: Parameters<typeof stream>[1],
) {
	// `hono/streaming` 只提供流式 body，不会自动声明 SSE 协议语义。
	c.header("Content-Type", "text/event-stream; charset=utf-8");
	c.header("Cache-Control", "no-cache, no-transform");
	c.header("X-Content-Type-Options", "nosniff");
	return stream(c as Context, cb);
}

/**
 * 读取 SSE 游标，兼容浏览器 Last-Event-ID 自动重连和手动 cursor 查询参数。
 * @param lastEventId Last-Event-ID header
 * @param cursorQuery cursor query
 * @returns 有效游标；非法值按 0 处理
 */
function readSseCursor(lastEventId: string | null | undefined, cursorQuery: string | undefined) {
	const headerCursor = Number(lastEventId ?? 0);
	const queryCursor = Number(cursorQuery ?? 0);
	return Math.max(
		Number.isFinite(headerCursor) ? headerCursor : 0,
		Number.isFinite(queryCursor) ? queryCursor : 0,
	);
}

/**
 * 判断 timeline event 是否表示本轮对话结束。
 * @param event timeline event
 * @returns 是否结束
 */
function isTerminalTimelineEvent(event: Awaited<ReturnType<CcrStore["listChatTimeline"]>>[number]) {
	return event.event_type === "result" || event.payload.type === "result";
}

/**
 * 判断 worker visible event 是否表示本轮对话结束。
 * @param event worker visible event
 * @returns 是否结束
 */
function isTerminalWorkerEvent(event: WorkerVisibleEvent): boolean {
	const payload = isJsonObject(event.payload) ? event.payload : {};
	return payload.type === "result";
}

/**
 * 拉取 session 详情所需的全部 client events。
 * @param store CCR store
 * @param sessionId session ID
 * @returns 完整 client events
 */
async function listAllClientEvents(store: CcrStore, sessionId: string) {
	const events: Awaited<ReturnType<CcrStore["listClientEvents"]>> = [];
	let fromSequence = 0;
	while (true) {
		const page = await store.listClientEvents(sessionId, fromSequence);
		if (page.length === 0) {
			return events;
		}
		events.push(...page);
		// sequence_num 单调递增，用最后一条作为下一页游标。
		fromSequence = page[page.length - 1]?.sequence_num ?? fromSequence;
	}
}

/**
 * 拉取 session 详情所需的全部 timeline events。
 * @param store CCR store
 * @param sessionId session ID
 * @returns 完整 timeline events
 */
async function listAllChatTimeline(store: CcrStore, sessionId: string) {
	const events: Awaited<ReturnType<CcrStore["listChatTimeline"]>> = [];
	let cursor = 0;
	while (true) {
		const page = await store.listChatTimeline(sessionId, cursor, 500);
		if (page.length === 0) {
			return events;
		}
		events.push(...page);
		// id 单调递增，用最后一条作为下一页游标。
		cursor = page[page.length - 1]?.id ?? cursor;
	}
}

/**
 * 拉取 session 详情所需的全部 foreground internal events。
 * @param store CCR store
 * @param sessionId session ID
 * @returns 完整 internal events
 */
async function listAllForegroundInternalEvents(store: CcrStore, sessionId: string) {
	const events: Awaited<ReturnType<CcrStore["listInternalEvents"]>>["data"] = [];
	let cursor: number | undefined;
	while (true) {
		const page = await store.listInternalEvents(sessionId, {
			subagents: false,
			cursor,
			limit: 500,
		});
		events.push(...page.data);
		if (!page.next_cursor) {
			return events;
		}
		cursor = Number(page.next_cursor);
	}
}

/**
 * 流式输出 chat timeline。
 * @param output SSE 输出流
 * @param store CCR store
 * @param sessionId session ID
 * @param cursor 起始游标
 * @param signal 请求 abort signal
 * @param options 输出选项
 */
async function streamChatTimeline(
	output: SseOutput,
	store: CcrStore,
	sessionId: string,
	cursor: number,
	signal: AbortSignal,
	options: { closeOnTerminal: boolean },
) {
	let closed = false;
	let lastHeartbeatAt = Date.now();
	let lastEventAt = Date.now();
	const close = () => {
		closed = true;
	};
	signal.addEventListener("abort", close, { once: true });
	try {
		while (!closed) {
			const lifecycle = await store.getSessionLifecycle(sessionId);
			if (!lifecycle || lifecycle.deletedAt) {
				await output.write(
					formatSseControlFrame("done", {
						reason: "deleted",
					}),
				);
				return;
			}
			const events = await store.listChatTimeline(sessionId, cursor);
			for (const event of events) {
				cursor = Math.max(cursor, event.id);
				lastEventAt = Date.now();
				await output.write(
					formatSseDataFrame(event.id, "timeline", {
						session_id: sessionId,
						event,
					}),
				);
				if (options.closeOnTerminal && isTerminalTimelineEvent(event)) {
					await output.write(
						formatSseControlFrame("done", {
							reason: "terminal",
						}),
					);
					return;
				}
			}
			if (
				options.closeOnTerminal &&
				Date.now() - lastEventAt >= CHAT_STREAM_IDLE_TIMEOUT_MS
			) {
				await output.write(
					formatSseControlFrame("done", {
						reason: "idle_timeout",
					}),
				);
				return;
			}
			if (Date.now() - lastHeartbeatAt >= SSE_HEARTBEAT_INTERVAL_MS) {
				await output.write(": heartbeat\n\n");
				lastHeartbeatAt = Date.now();
			}
			await output.sleep(SSE_POLL_INTERVAL_MS);
		}
	} finally {
		signal.removeEventListener("abort", close);
	}
}

/**
 * 提取 Bearer token。
 * @param header Authorization header
 * @returns token
 */
function readBearerToken(header: string | null): string | undefined {
	const prefix = "Bearer ";
	return header?.startsWith(prefix) ? header.slice(prefix.length) : undefined;
}

/**
 * 判断删除 session 前是否需要停止 sandbox。
 * @param lifecycle session 容器生命周期信息
 * @returns 是否需要调用 sandbox stop
 */
function shouldStopSandboxBeforeDelete(
	lifecycle: Awaited<ReturnType<CcrStore["getSessionLifecycle"]>>,
): boolean {
	return Boolean(
		lifecycle?.sandboxId &&
			ACTIVE_CONTAINER_STATUSES.has(lifecycle.containerStatus),
	);
}

/**
 * 挂载 CCR route。
 * @param app Hono app
 */
export function mountCcrRoutes(app: Hono<{ Bindings: Env & CcrBindings; Variables: CcrVariables }>) {
	app.use("/api/ccr/*", async (c, next) => {
		const session = await createAuth(c.env).api.getSession({
			headers: c.req.raw.headers,
			query: { disableRefresh: true },
		});
		const userId = session?.user.id;
		if (!userId) {
			return c.json({ error: "Unauthorized" }, 401);
		}
		c.set("userId", userId);
		await next();
	});

	app.use("/v1/code/*", async (c, next) => {
		const sessionId = new URL(c.req.url).pathname.match(
			/^\/v1\/code\/sessions\/([^/]+)/,
		)?.[1];
		if (!sessionId) {
			return c.json({ error: "Invalid CCR worker path" }, 400);
		}
		const store = createStore(c.env);
		const token = readBearerToken(c.req.header("authorization") ?? null);
		const workerAuth = token
			? await store.authenticateWorkerAccessToken(sessionId, token)
			: null;
		if (!workerAuth) {
			return c.json({ error: "Unauthorized worker" }, 401);
		}
		// Worker 协议没有登录态；后续容器操作必须使用 token 绑定的 session owner。
		c.set("userId", workerAuth.userId);
		await next();
	});

	app.get("/api/ccr/projects", async (c) => {
		const store = createStore(c.env);
		return c.json({ projects: await store.listProjects(c.get("userId")) });
	});

	app.post("/api/ccr/projects", async (c) => {
		const body = await readJsonObject(c.req.raw);
		const store = createStore(c.env);
		const project = await store.createProject(c.get("userId"), getStringField(body, "name"));
		return c.json({ project });
	});

	app.post("/api/ccr/projects/:projectId/sessions", async (c) => {
		const body = await readJsonObject(c.req.raw);
		const store = createStore(c.env);
		const session = await store.createSession(
			c.get("userId"),
			c.req.param("projectId"),
			getStringField(body, "title"),
		);
		if (!session) {
			return c.json({ error: "Project not found" }, 404);
		}
		return c.json({ session });
	});

	app.get("/api/ccr/projects/:projectId/sessions", async (c) => {
		const store = createStore(c.env);
		return c.json({
			sessions: await store.listSessions(c.get("userId"), c.req.param("projectId")),
		});
	});

	app.post("/api/ccr/sessions", async (c) => {
		const body = await readJsonObject(c.req.raw);
		const store = createStore(c.env);
		const project = await store.ensureDefaultProject(c.get("userId"));
		const session = await store.createSession(
			c.get("userId"),
			project.id,
			getStringField(body, "title"),
		);
		if (!session) {
			return c.json({ error: "Project not found" }, 404);
		}
		return c.json({ session, project });
	});

	app.get("/api/ccr/sessions", async (c) => {
		const store = createStore(c.env);
		const projectId = c.req.query("projectId");
		return c.json({ sessions: await store.listSessions(c.get("userId"), projectId) });
	});

	app.get("/api/ccr/sessions/:sessionId", async (c) => {
		const store = createStore(c.env);
		const sessionId = c.req.param("sessionId");
		const session = await store.findUserSessionSummary(c.get("userId"), sessionId);
		if (!session) {
			return c.json({ error: "Session not found" }, 404);
		}
		const [clientEvents, timeline, internal] = await Promise.all([
			listAllClientEvents(store, sessionId),
			listAllChatTimeline(store, sessionId),
			listAllForegroundInternalEvents(store, sessionId),
		]);
		return c.json({
			session,
			clientEvents,
			timeline,
			internal,
		});
	});

	app.delete("/api/ccr/sessions/:sessionId", async (c) => {
		const store = createStore(c.env);
		const sessionId = c.req.param("sessionId");
		const lifecycle = await store.getSessionLifecycle(sessionId);
		if (!lifecycle || lifecycle.userId !== c.get("userId")) {
			// 删除接口保持幂等，前端可安全移除已不存在的历史会话。
			return c.json({ ok: true, deleted: false });
		}
		// 活跃 sandbox 后台停止，避免删除按钮被容器网络操作阻塞。
		if (shouldStopSandboxBeforeDelete(lifecycle)) {
			await store.markSessionDeleting(sessionId);
			c.executionCtx.waitUntil(
				stopCcrSessionRunner(c.env, store, c.get("userId"), sessionId)
					.catch(() => undefined)
					.then(() => store.deleteSession(sessionId)),
			);
			return c.json({ ok: true, deleted: true, pendingCleanup: true });
		}
		await store.deleteSession(sessionId);
		return c.json({ ok: true, deleted: true });
	});

	app.post("/api/ccr/sessions/:sessionId/messages", async (c) => {
		const body = await readJsonObject(c.req.raw);
		const store = createStore(c.env);
		const sessionId = c.req.param("sessionId");
		const session = await store.findUserSessionSummary(c.get("userId"), sessionId);
		if (!session || session.deletedAt) {
			return c.json({ error: "Session not found" }, 404);
		}
		const messages: ChatMessageInput[] = Array.isArray(body.messages)
			? body.messages.filter(isJsonObject).map((message) => ({
					role: getStringField(message, "role") ?? "user",
					content: toJsonValue(message.content),
				}))
			: [
					{
						role: "user",
						content: toJsonValue(body.message ?? body.content),
					},
				];
		if (c.req.header("accept")?.includes("text/event-stream")) {
			const cursor = readSseCursor(
				c.req.header("Last-Event-ID"),
				c.req.query("cursor"),
			);
			return streamSse(c, async (output) => {
				let acceptedEvents: Awaited<ReturnType<CcrStore["enqueueChatInput"]>> = [];
				try {
					// 先写入 session frame，让浏览器在 sandbox 启动前就建立长连接。
					await output.write(
						formatSseControlFrame("session", {
							session,
						}),
					);
					acceptedEvents = await store.enqueueChatInput(sessionId, messages);
					try {
						await startCcrSandbox(
							c.req.raw,
							c.env,
							store,
							c.get("userId"),
							sessionId,
						);
					} catch (error) {
						// 输入已入库但 runner 未启动时，不能继续保留 queued，避免下次启动误执行旧输入。
						await store.markClientEventsFailed(
							sessionId,
							acceptedEvents.map((event) => event.event_id),
						);
						throw error;
					}
					await output.write(
						formatSseControlFrame("session", {
							session: await store.findUserSessionSummary(c.get("userId"), sessionId),
						}),
					);
					await streamChatTimeline(
						output,
						store,
						sessionId,
						cursor,
						c.req.raw.signal,
						{
							closeOnTerminal: true,
						},
					);
				} catch (error) {
					await output.write(
						formatSseControlFrame("error", {
							error: error instanceof Error ? error.message : String(error),
						}),
					);
					await output.write(
						formatSseControlFrame("done", {
							reason: "error",
						}),
					);
				}
			});
		}
		const acceptedEvents = await store.enqueueChatInput(sessionId, messages);
		try {
			await startCcrSandbox(c.req.raw, c.env, store, c.get("userId"), sessionId);
		} catch (error) {
			// 非 SSE 调用同样要收敛输入状态，确保 worker 队列只包含可继续执行的事件。
			await store.markClientEventsFailed(
				sessionId,
				acceptedEvents.map((event) => event.event_id),
			);
			throw error;
		}
		return c.json({
			session: await store.findUserSessionSummary(c.get("userId"), sessionId),
			timeline: await store.listChatTimeline(sessionId),
		});
	});

	app.post("/api/ccr/sessions/:sessionId/container/start", async (c) => {
		const store = createStore(c.env);
		const sessionId = c.req.param("sessionId");
		const session = await store.findUserSessionSummary(c.get("userId"), sessionId);
		if (!session || session.deletedAt) {
			return c.json({ error: "Session not found" }, 404);
		}
		return c.json(await startCcrSandbox(c.req.raw, c.env, store, c.get("userId"), sessionId));
	});

	app.get("/api/ccr/sessions/:sessionId/container/status", async (c) => {
		const store = createStore(c.env);
		const sessionId = c.req.param("sessionId");
		const session = await store.findUserSessionSummary(c.get("userId"), sessionId);
		if (!session || session.deletedAt) {
			return c.json({ error: "Session not found" }, 404);
		}
		return c.json(await getCcrSandboxStatus(c.env, c.get("userId")));
	});

	app.post("/api/ccr/sessions/:sessionId/container/stop", async (c) => {
		const store = createStore(c.env);
		const sessionId = c.req.param("sessionId");
		const session = await store.findUserSessionSummary(c.get("userId"), sessionId);
		if (!session || session.deletedAt) {
			return c.json({ error: "Session not found" }, 404);
		}
		// 容器粒度是用户级；stop 必须销毁 sandbox，才能验证冷启动恢复链路。
		return c.json(await stopCcrUserContainer(c.env, store, c.get("userId")));
	});

	app.post("/api/ccr/sessions/:sessionId/runner/stop", async (c) => {
		const store = createStore(c.env);
		const sessionId = c.req.param("sessionId");
		const session = await store.findUserSessionSummary(c.get("userId"), sessionId);
		if (!session || session.deletedAt) {
			return c.json({ error: "Session not found" }, 404);
		}
		return c.json(await stopCcrSessionRunner(c.env, store, c.get("userId"), sessionId));
	});

	app.post("/api/ccr/sessions/:sessionId/container/destroy", async (c) => {
		const store = createStore(c.env);
		const sessionId = c.req.param("sessionId");
		const session = await store.findUserSessionSummary(c.get("userId"), sessionId);
		if (!session || session.deletedAt) {
			return c.json({ error: "Session not found" }, 404);
		}
		return c.json(await destroyCcrSandbox(c.env, store, c.get("userId")));
	});

	app.get("/api/ccr/sessions/:sessionId/events", async (c) => {
		const store = createStore(c.env);
		const sessionId = c.req.param("sessionId");
		const session = await store.findUserSessionSummary(c.get("userId"), sessionId);
		if (!session) {
			return c.json({ error: "Session not found" }, 404);
		}
		const cursor = readSseCursor(
			c.req.header("Last-Event-ID"),
			c.req.query("cursor"),
		);
		return streamSse(c, async (output) => {
			await streamChatTimeline(output, store, sessionId, cursor, c.req.raw.signal, {
				closeOnTerminal: false,
			});
		});
	});

	app.post("/v1/code/sessions/:sessionId/worker/register", async (c) => {
		const store = createStore(c.env);
		const workerEpoch = await store.registerWorker(c.req.param("sessionId"));
		return c.json({ worker_epoch: workerEpoch });
	});

	app.get("/v1/code/sessions/:sessionId/worker/events/stream", async (c) => {
		const store = createStore(c.env);
		const sessionId = c.req.param("sessionId");
		let fromSequence = readSseCursor(
			c.req.header("Last-Event-ID"),
			c.req.query("from_sequence_num"),
		);
		return streamSse(c, async (output) => {
			let closed = false;
			let lastHeartbeatAt = Date.now();
			await output.write(": ccr pg stream ready\n\n");
			const close = () => {
				closed = true;
			};
			c.req.raw.signal.addEventListener("abort", close, { once: true });
			try {
				while (!closed) {
					const events = await store.listQueuedClientEvents(sessionId, fromSequence);
					for (const event of events) {
						await output.write(
							formatSseDataFrame(event.sequence_num, "client_event", event),
						);
						fromSequence = Math.max(fromSequence, event.sequence_num);
					}
					if (Date.now() - lastHeartbeatAt >= SSE_HEARTBEAT_INTERVAL_MS) {
						await output.write(": heartbeat\n\n");
						lastHeartbeatAt = Date.now();
					}
					await output.sleep(SSE_POLL_INTERVAL_MS);
				}
			} finally {
				c.req.raw.signal.removeEventListener("abort", close);
			}
		});
	});

	app.post("/v1/code/sessions/:sessionId/worker/events", async (c) => {
		const store = createStore(c.env);
		const sessionId = c.req.param("sessionId");
		const body = await readJsonObject(c.req.raw);
		const workerEpoch = readWorkerEpoch(body);
		if (!(await store.isCurrentEpoch(sessionId, workerEpoch))) {
			return c.json({ error: "worker_epoch mismatch" }, 409);
		}
		const events = Array.isArray(body.events)
			? (body.events.filter(isJsonObject) as unknown as WorkerVisibleEvent[])
			: [];
		await store.insertWorkerEvents(sessionId, workerEpoch, events);
		if (events.some(isTerminalWorkerEvent)) {
			// result 是 Claude Code 本轮终止信号；销毁 runner 必须由后端兜底，不能依赖前端 SSE 是否在线。
			c.executionCtx.waitUntil(
				stopCcrSessionRunner(c.env, store, c.get("userId"), sessionId),
			);
		}
		return c.json({ ok: true });
	});

	app.post("/v1/code/sessions/:sessionId/worker/internal-events", async (c) => {
		const store = createStore(c.env);
		const sessionId = c.req.param("sessionId");
		const body = await readJsonObject(c.req.raw);
		const workerEpoch = readWorkerEpoch(body);
		if (!(await store.isCurrentEpoch(sessionId, workerEpoch))) {
			return c.json({ error: "worker_epoch mismatch" }, 409);
		}
		const events = Array.isArray(body.events)
			? (body.events.filter(isJsonObject) as unknown as WorkerInternalEvent[])
			: [];
		await store.insertInternalEvents(sessionId, workerEpoch, events);
		return c.json({ ok: true });
	});

	app.get("/v1/code/sessions/:sessionId/worker/internal-events", async (c) => {
		const store = createStore(c.env);
		const limit = Number(c.req.query("limit") ?? 0);
		return c.json(
			await store.listInternalEvents(c.req.param("sessionId"), {
				subagents: c.req.query("subagents") === "true",
				cursor: Number(c.req.query("cursor") ?? 0),
				limit: Number.isFinite(limit) && limit > 0 ? limit : undefined,
			}),
		);
	});

	app.post("/v1/code/sessions/:sessionId/worker/events/delivery", async (c) => {
		const store = createStore(c.env);
		const sessionId = c.req.param("sessionId");
		const body = await readJsonObject(c.req.raw);
		const workerEpoch = readWorkerEpoch(body);
		if (!(await store.isCurrentEpoch(sessionId, workerEpoch))) {
			return c.json({ error: "worker_epoch mismatch" }, 409);
		}
		const updates = Array.isArray(body.updates)
			? body.updates.filter(isJsonObject).map((update) => ({
					event_id: getStringField(update, "event_id") ?? "",
					status: getStringField(update, "status") ?? "unknown",
				}))
			: [];
		await store.insertDeliveryUpdates(sessionId, workerEpoch, updates);
		return c.json({ ok: true });
	});

	app.put("/v1/code/sessions/:sessionId/worker", async (c) => {
		const store = createStore(c.env);
		const sessionId = c.req.param("sessionId");
		const body = await readJsonObject(c.req.raw);
		const workerEpoch = readWorkerEpoch(body);
		if (!(await store.isCurrentEpoch(sessionId, workerEpoch))) {
			return c.json({ error: "worker_epoch mismatch" }, 409);
		}
		await store.updateWorker(sessionId, body);
		return c.json({ ok: true });
	});

	app.get("/v1/code/sessions/:sessionId/worker", async (c) => {
		const store = createStore(c.env);
		return c.json({
			worker: await store.getWorkerSnapshot(c.req.param("sessionId")),
		});
	});

	app.post("/v1/code/sessions/:sessionId/worker/heartbeat", async (c) => {
		const store = createStore(c.env);
		const sessionId = c.req.param("sessionId");
		const body = await readJsonObject(c.req.raw);
		const workerEpoch = readWorkerEpoch(body);
		if (!(await store.isCurrentEpoch(sessionId, workerEpoch))) {
			return c.json({ error: "worker_epoch mismatch" }, 409);
		}
		await store.recordHeartbeat(sessionId, workerEpoch);
		return c.json({ ok: true });
	});

	app.post("/v1/code/sessions/:sessionId/session-store/write", async (c) => {
		const store = createStore(c.env);
		const body = await readJsonObject(c.req.raw);
		const projectKey = getStringField(body, "project_key");
		const subpath = getStringField(body, "subpath");
		if (!projectKey || !subpath || typeof body.content !== "string") {
			return c.json({ error: "project_key, subpath and content are required" }, 400);
		}
		await store.writeSessionStoreFile(
			c.req.param("sessionId"),
			projectKey,
			subpath,
			body.content,
			isJsonObject(body.metadata) ? body.metadata : undefined,
		);
		return c.json({ ok: true });
	});

	app.post("/v1/code/sessions/:sessionId/session-store/read", async (c) => {
		const store = createStore(c.env);
		const sessionId = c.req.param("sessionId");
		const body = await readJsonObject(c.req.raw);
		const projectKey = getStringField(body, "project_key");
		const subpath = getStringField(body, "subpath");
		if (!projectKey || !subpath) {
			return c.json({ error: "project_key and subpath are required" }, 400);
		}
		let file = await store.readSessionStoreFile(sessionId, projectKey, subpath);
		if (!file && projectKey === CLAUDE_SESSION_STORE_PROJECT_KEY) {
			// 旧会话可能先有 internal events，Agent SDK 首次读取时再补齐 sessionStore。
			await store.ensureClaudeSessionStoreFromInternalEvents(sessionId);
			file = await store.readSessionStoreFile(sessionId, projectKey, subpath);
		}
		return file ? c.json({ file }) : c.json({ error: "not found" }, 404);
	});

	app.get("/v1/code/sessions/:sessionId/session-store/list", async (c) => {
		const store = createStore(c.env);
		const sessionId = c.req.param("sessionId");
		const projectKey = c.req.query("project_key");
		if (!projectKey) {
			return c.json({ error: "project_key is required" }, 400);
		}
		const prefix = c.req.query("prefix") ?? "";
		let files = await store.listSessionStoreFiles(sessionId, projectKey, prefix);
		if (files.length === 0 && projectKey === CLAUDE_SESSION_STORE_PROJECT_KEY) {
			// list 为空时触发一次回填，让旧会话也能被 sessionStore 枚举到。
			await store.ensureClaudeSessionStoreFromInternalEvents(sessionId);
			files = await store.listSessionStoreFiles(sessionId, projectKey, prefix);
		}
		return c.json({
			files,
		});
	});

	app.post("/v1/code/sessions/:sessionId/session-store/delete", async (c) => {
		const store = createStore(c.env);
		const body = await readJsonObject(c.req.raw);
		const projectKey = getStringField(body, "project_key");
		const subpath = getStringField(body, "subpath");
		if (!projectKey || !subpath) {
			return c.json({ error: "project_key and subpath are required" }, 400);
		}
		return c.json({
			ok: await store.deleteSessionStoreFile(
				c.req.param("sessionId"),
				projectKey,
				subpath,
			),
		});
	});
}
