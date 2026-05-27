import { stream } from "hono/streaming";
import type { Context, Hono } from "hono";
import { createPrismaClient } from "./prisma";
import { createAuth } from "./auth";
import {
	buildCanUseToolDecisionResponse,
	handleControlRequest,
	isCcrPermissionMode,
	type ToolPermissionDecision,
} from "./ccr-control";
import {
	CLAUDE_SESSION_STORE_PROJECT_KEY,
	CcrStore,
	ProjectNameConflictError,
	type ChatControlInput,
} from "./ccr-store";
import {
	destroyCcrSandbox,
	getCcrSandboxStatus,
	startCcrSandbox,
	stopCcrSessionRunner,
	stopCcrUserContainer,
	type NeoNoumiSandboxBindings,
} from "./ccr-sandbox";
import { getStringField, isJsonObject, readJsonObject, toJsonValue } from "./json";
import { isTerminalWorkerPayload, readWorkerEpoch } from "./ccr-protocol";
import { getSessionDetailResponse } from "./session-detail";
import { createSessionInternalEventsJsonlResponse } from "./session-internal-events-export";
import {
	createWorkspaceDirectory,
	createWorkspaceDownloadUrl,
	deleteWorkspacePath,
	listWorkspaceTree,
	moveWorkspacePath,
	normalizeWorkspacePath,
	signWorkspaceOperation,
	createWorkspaceUploadUrls,
	WORKSPACE_DOWNLOAD_URL_TTL_SECONDS,
	WORKSPACE_UPLOAD_MAX_FILE_SIZE,
	WORKSPACE_UPLOAD_MAX_FILES,
	writeWorkspaceFile,
	type ProjectWorkspaceBindings,
	type WorkspaceMoveSourceType,
	type WorkspaceUploadUrlInput,
} from "./project-workspace";
import type { ChatMessageInput, WorkerInternalEvent, WorkerVisibleEvent } from "./ccr-types";
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
export type CcrBindings = AuthBindings & NeoNoumiSandboxBindings & ProjectWorkspaceBindings;

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
	return new CcrStore(createRoutePrismaClient(env), {
		aiProxyCredentialSecret: env.AI_PROXY_CREDENTIAL_SECRET,
	});
}

/**
 * 创建 route 层直接使用的 Prisma Client。
 * @param env Worker 绑定
 * @returns 当前请求可用的 Prisma Client
 */
function createRoutePrismaClient(env: CcrBindings) {
	const databaseUrl = env.HYPERDRIVE?.connectionString ?? env.DATABASE_URL;
	if (!databaseUrl) {
		throw new Error("DATABASE_URL or HYPERDRIVE.connectionString is required");
	}
	return createPrismaClient(databaseUrl);
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
 * 读取历史消息分页大小。
 * @param limitQuery limit query
 * @returns 限制在安全范围内的分页大小
 */
function readHistoryLimit(limitQuery: string | undefined): number {
	const limit = Number(limitQuery ?? 10);
	return Math.min(Math.max(Number.isFinite(limit) ? Math.trunc(limit) : 10, 1), 50);
}

/**
 * 读取正整数 query。
 * @param value query 值
 * @returns 正整数；非法时返回 null
 */
function readPositiveIntegerQuery(value: string | undefined): number | null {
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * 读取 chat 请求携带的 Claude Code 控制选项。
 * @param body 请求 JSON
 * @returns 已校验的控制选项
 */
function readChatControlInput(body: Record<string, unknown>): ChatControlInput {
	const permissionMode = body.permissionMode ?? body.permission_mode;
	const model = getStringField(body, "model")?.trim();
	const rawMaxThinkingTokens = body.maxThinkingTokens ?? body.max_thinking_tokens;
	const control: ChatControlInput = {};
	if (isCcrPermissionMode(permissionMode)) {
		// plan 模式是明确产品需求；ultraplan 只作为额外标记，不影响普通 plan。
		control.permissionMode = permissionMode;
		control.ultraplan = body.ultraplan === true;
	}
	if (model) {
		control.model = model;
	}
	if (rawMaxThinkingTokens === null) {
		control.maxThinkingTokens = null;
	} else if (
		typeof rawMaxThinkingTokens === "number" &&
		Number.isSafeInteger(rawMaxThinkingTokens) &&
		rawMaxThinkingTokens >= 0
	) {
		control.maxThinkingTokens = rawMaxThinkingTokens;
	}
	return control;
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
	return isTerminalWorkerPayload(payload);
}

/**
 * 读取并校验当前用户自己的 project。
 * @param store CCR store
 * @param userId 用户 ID
 * @param projectId project ID
 * @returns project；不存在时返回 null
 */
async function findOwnedProject(store: CcrStore, userId: string, projectId: string) {
	return store.findUserProject(userId, projectId);
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
 * 校验登录用户并写入 route 变量。
 * @param c Hono context
 * @param next 后续中间件
 */
async function authenticateApiUser(
	c: Context<{ Bindings: Env & CcrBindings; Variables: CcrVariables }>,
	next: () => Promise<void>,
) {
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
}

/**
 * 将 workspace path 校验错误转换为 route 可控的 400 响应。
 * @param path 原始 workspace path
 * @param options path 规范化选项
 * @returns 规范化后的 path 或错误信息
 */
function readWorkspaceRoutePath(path: string | undefined, options: { allowEmpty?: boolean } = {}) {
	try {
		return { path: normalizeWorkspacePath(path, options) };
	} catch (error) {
		return { error: error instanceof Error ? error.message : "Invalid workspace path" };
	}
}

/**
 * 读取 workspace tree 请求参数。
 * @param body 可选 JSON body，POST 用于承载较长路径
 * @returns 文件树查询参数
 */
async function readWorkspaceTreeRequest(
	body?: Record<string, unknown>,
) {
	const prefix = getStringField(body ?? {}, "prefix") ?? "";
	const cursor = getStringField(body ?? {}, "cursor");
	return {
		prefix,
		cursor,
	};
}

/**
 * 返回指定 project 的 workspace 文件树。
 * @param c Hono context
 * @param body 可选 JSON body，避免长 prefix 突破 URL 长度限制
 * @returns 文件树响应
 */
async function handleWorkspaceTreeRequest(
	c: Context<{ Bindings: Env & CcrBindings; Variables: CcrVariables }>,
	body?: Record<string, unknown>,
) {
	const store = createStore(c.env);
	const userId = c.get("userId");
	const projectId = c.req.param("projectId");
	const project = await findOwnedProject(store, userId, projectId);
	if (!project) {
		return c.json({ error: "Project not found" }, 404);
	}
	const { prefix, cursor } = await readWorkspaceTreeRequest(body);
	const prefixResult = readWorkspaceRoutePath(prefix, {
		allowEmpty: true,
	});
	if ("error" in prefixResult) {
		return c.json({ error: prefixResult.error }, 400);
	}
	const workspace = await listWorkspaceTree(
		c.env.PROJECT_WORKSPACE_BUCKET,
		projectId,
		prefixResult.path,
		cursor,
	);
	return c.json({
		workspace,
		signature: await signWorkspaceOperation(c.env, {
			operation: "list",
			projectId,
			path: prefixResult.path,
		}),
	});
}

/**
 * 挂载 CCR route 和一等业务 route。
 * @param app Hono app
 */
export function mountCcrRoutes(app: Hono<{ Bindings: Env & CcrBindings; Variables: CcrVariables }>) {
	app.use("/api/ccr/*", authenticateApiUser);
	app.use("/api/sessions/*", authenticateApiUser);
	app.use("/api/projects", authenticateApiUser);
	app.use("/api/projects/*", authenticateApiUser);

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

	app.get("/api/projects", async (c) => {
		const store = createStore(c.env);
		return c.json({ projects: await store.listProjects(c.get("userId")) });
	});

	app.get("/api/ccr/ai-proxy/credentials", async (c) => {
		const store = createStore(c.env);
		return c.json({
			credentials: await store.listAiProxyCredentials(c.get("userId")),
		});
	});

	app.post("/api/ccr/ai-proxy/credentials/default", async (c) => {
		const body = await readJsonObject(c.req.raw);
		const store = createStore(c.env);
		let credential;
		try {
			credential = await store.upsertDefaultAiProxyCredential(c.get("userId"), {
				name: getStringField(body, "name"),
				provider: getStringField(body, "provider"),
				baseUrl: getStringField(body, "baseUrl"),
				apiKey: getStringField(body, "apiKey"),
			});
		} catch (error) {
			return c.json(
				{ error: error instanceof Error ? error.message : "Invalid credential" },
				400,
			);
		}
		return c.json({ credential });
	});

	app.post("/api/projects", async (c) => {
		const body = await readJsonObject(c.req.raw);
		const store = createStore(c.env);
		let project;
		try {
			project = await store.createProject(
				c.get("userId"),
				getStringField(body, "name"),
				getStringField(body, "description"),
			);
		} catch (error) {
			if (error instanceof ProjectNameConflictError) {
				return c.json({ error: "Project name already exists" }, 409);
			}
			throw error;
		}
		return c.json({ project });
	});

	app.patch("/api/projects/:projectId", async (c) => {
		const body = await readJsonObject(c.req.raw);
		const store = createStore(c.env);
		const hasName = Object.hasOwn(body, "name");
		const hasDescription = Object.hasOwn(body, "description");
		if (!hasName && !hasDescription) {
			return c.json({ error: "No project fields to update" }, 400);
		}
		const input = {
			// PATCH 必须区分“字段缺失”和“字段为空”，避免局部更新误覆盖名称。
			name: hasName ? getStringField(body, "name") : undefined,
			description: hasDescription ? getStringField(body, "description") : undefined,
		};
		let project;
		try {
			project = await store.updateProject(c.get("userId"), c.req.param("projectId"), {
				name: input.name,
				description: input.description,
			});
		} catch (error) {
			if (error instanceof ProjectNameConflictError) {
				return c.json({ error: "Project name already exists" }, 409);
			}
			throw error;
		}
		if (!project) {
			return c.json({ error: "Project not found" }, 404);
		}
		return c.json({ project });
	});

	app.delete("/api/projects/:projectId", async (c) => {
		const store = createStore(c.env);
		const userId = c.get("userId");
		const projectId = c.req.param("projectId");
		const result = await store.deleteProject(userId, projectId);
		const activeSessionIds = result.sessions
			.filter((lifecycle) => shouldStopSandboxBeforeDelete(lifecycle))
			.map((lifecycle) => lifecycle.id);
		if (!result.deleted) {
			return c.json({ error: "Project not found" }, 404);
		}
		if (activeSessionIds.length > 0) {
			c.executionCtx.waitUntil(
				Promise.all(
					activeSessionIds.map((sessionId) =>
						stopCcrSessionRunner(c.env, store, userId, sessionId).catch((error) =>
							store.recordOperation(sessionId, {
								direction: "route_internal",
								category: "project_delete_runner_cleanup_failed",
								payload: {
									project_id: projectId,
									error: error instanceof Error ? error.message : String(error),
								},
							}).catch(() => undefined),
						),
					),
				).then(() => undefined),
			);
		}
		return c.json({
			ok: true,
			pendingCleanup: activeSessionIds.length > 0,
			stoppingSessions: activeSessionIds.length,
		});
	});

	app.post("/api/projects/:projectId/sessions", async (c) => {
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

	app.get("/api/projects/:projectId/sessions", async (c) => {
		const store = createStore(c.env);
		return c.json({
			sessions: await store.listSessions(c.get("userId"), c.req.param("projectId")),
		});
	});

	app.post("/api/projects/:projectId/workspace/tree", async (c) => {
		const body = await readJsonObject(c.req.raw);
		return handleWorkspaceTreeRequest(c, body);
	});

	app.get("/api/projects/:projectId/workspace/file", async (c) => {
		const store = createStore(c.env);
		const userId = c.get("userId");
		const projectId = c.req.param("projectId");
		const project = await findOwnedProject(store, userId, projectId);
		if (!project) {
			return c.json({ error: "Project not found" }, 404);
		}
		const path = c.req.query("path");
		if (!path) {
			return c.json({ error: "path is required" }, 400);
		}
		const pathResult = readWorkspaceRoutePath(path);
		if ("error" in pathResult) {
			return c.json({ error: pathResult.error }, 400);
		}
		const etag = c.req.query("etag");
		let download;
		try {
			download = await createWorkspaceDownloadUrl(
				c.env,
				c.env.PROJECT_WORKSPACE_BUCKET,
				projectId,
				pathResult.path,
				{ ifMatch: etag },
			);
		} catch (error) {
			if (error instanceof Error && error.message === "Workspace file etag does not match") {
				return c.json({ error: error.message }, 412);
			}
			throw error;
		}
		if (!download) {
			return c.json({ error: "Workspace file not found" }, 404);
		}
		c.header("Cache-Control", `private, max-age=${WORKSPACE_DOWNLOAD_URL_TTL_SECONDS}`);
		c.header("X-Workspace-ETag", download.etag);
		c.header("Vary", "Cookie, Authorization");
		return c.redirect(download.downloadUrl, 302);
	});

	app.put("/api/projects/:projectId/workspace/file", async (c) => {
		const body = await readJsonObject(c.req.raw);
		const store = createStore(c.env);
		const userId = c.get("userId");
		const projectId = c.req.param("projectId");
		const project = await findOwnedProject(store, userId, projectId);
		if (!project) {
			return c.json({ error: "Project not found" }, 404);
		}
		const path = getStringField(body, "path");
		const content = getStringField(body, "content");
		if (!path || content === undefined) {
			return c.json({ error: "path and content are required" }, 400);
		}
		const pathResult = readWorkspaceRoutePath(path);
		if ("error" in pathResult) {
			return c.json({ error: pathResult.error }, 400);
		}
		const contentType = getStringField(body, "contentType");
		const signature = await signWorkspaceOperation(c.env, {
			operation: "write",
			projectId,
			path: pathResult.path,
			body: content,
		});
		const file = await writeWorkspaceFile(
			c.env.PROJECT_WORKSPACE_BUCKET,
			projectId,
			pathResult.path,
			content,
			contentType,
		);
		return c.json({
			file,
			signature,
		});
	});

	app.post("/api/projects/:projectId/workspace/upload-urls", async (c) => {
		const body = await readJsonObject(c.req.raw);
		const store = createStore(c.env);
		const userId = c.get("userId");
		const projectId = c.req.param("projectId");
		const project = await findOwnedProject(store, userId, projectId);
		if (!project) {
			return c.json({ error: "Project not found" }, 404);
		}
		const basePathResult = readWorkspaceRoutePath(getStringField(body, "basePath") ?? "", {
			allowEmpty: true,
		});
		if ("error" in basePathResult) {
			return c.json({ error: basePathResult.error }, 400);
		}
		const rawFiles = body.files;
		if (!Array.isArray(rawFiles) || rawFiles.length === 0) {
			return c.json({ error: "files are required" }, 400);
		}
		if (rawFiles.length > WORKSPACE_UPLOAD_MAX_FILES) {
			return c.json({ error: `files cannot exceed ${WORKSPACE_UPLOAD_MAX_FILES}` }, 400);
		}
		const files: WorkspaceUploadUrlInput[] = [];
		for (const rawFile of rawFiles) {
			if (!isJsonObject(rawFile) || typeof rawFile.relativePath !== "string") {
				return c.json({ error: "files[].relativePath is required" }, 400);
			}
			const pathResult = readWorkspaceRoutePath(rawFile.relativePath);
			if ("error" in pathResult) {
				return c.json({ error: pathResult.error }, 400);
			}
			if (
				typeof rawFile.size !== "number" ||
				!Number.isSafeInteger(rawFile.size) ||
				rawFile.size < 0
			) {
				return c.json({ error: "files[].size is required" }, 400);
			}
			if (rawFile.size > WORKSPACE_UPLOAD_MAX_FILE_SIZE) {
				return c.json({ error: "Workspace upload file exceeds the maximum size" }, 400);
			}
			const contentType =
				typeof rawFile.contentType === "string" ? rawFile.contentType : undefined;
			if (contentType && /[\r\n]/.test(contentType)) {
				return c.json({ error: "files[].contentType is invalid" }, 400);
			}
			files.push({
				relativePath: pathResult.path,
				size: rawFile.size,
				contentType,
			});
		}
		const signature = await signWorkspaceOperation(c.env, {
			operation: "upload",
			projectId,
			path: basePathResult.path,
			body: JSON.stringify(files.map((file) => file.relativePath)),
		});
		const upload = await createWorkspaceUploadUrls(
			c.env,
			projectId,
			basePathResult.path,
			files,
		);
		return c.json({
			upload,
			signature,
		});
	});

	app.delete("/api/projects/:projectId/workspace/file", async (c) => {
		const body = await readJsonObject(c.req.raw);
		const store = createStore(c.env);
		const userId = c.get("userId");
		const projectId = c.req.param("projectId");
		const project = await findOwnedProject(store, userId, projectId);
		if (!project) {
			return c.json({ error: "Project not found" }, 404);
		}
		const path = getStringField(body, "path") ?? c.req.query("path");
		if (!path) {
			return c.json({ error: "path is required" }, 400);
		}
		const pathResult = readWorkspaceRoutePath(path);
		if ("error" in pathResult) {
			return c.json({ error: pathResult.error }, 400);
		}
		const signature = await signWorkspaceOperation(c.env, {
			operation: "delete",
			projectId,
			path: pathResult.path,
		});
		const deleted = await deleteWorkspacePath(
			c.env.PROJECT_WORKSPACE_BUCKET,
			projectId,
			pathResult.path,
			{ recursive: true },
		);
		return c.json({
			ok: true,
			deleted,
			signature,
		});
	});

	app.post("/api/projects/:projectId/workspace/directory", async (c) => {
		const body = await readJsonObject(c.req.raw);
		const store = createStore(c.env);
		const userId = c.get("userId");
		const projectId = c.req.param("projectId");
		const project = await findOwnedProject(store, userId, projectId);
		if (!project) {
			return c.json({ error: "Project not found" }, 404);
		}
		const path = getStringField(body, "path");
		if (!path) {
			return c.json({ error: "path is required" }, 400);
		}
		const pathResult = readWorkspaceRoutePath(path);
		if ("error" in pathResult) {
			return c.json({ error: pathResult.error }, 400);
		}
		const signature = await signWorkspaceOperation(c.env, {
			operation: "mkdir",
			projectId,
			path: pathResult.path,
		});
		const directory = await createWorkspaceDirectory(
			c.env.PROJECT_WORKSPACE_BUCKET,
			projectId,
			pathResult.path,
			{ recursive: body.recursive === true },
		);
		return c.json({
			directory,
			signature,
		});
	});

	app.post("/api/projects/:projectId/workspace/move", async (c) => {
		const body = await readJsonObject(c.req.raw);
		const store = createStore(c.env);
		const userId = c.get("userId");
		const projectId = c.req.param("projectId");
		const project = await findOwnedProject(store, userId, projectId);
		if (!project) {
			return c.json({ error: "Project not found" }, 404);
		}
		const fromPath = getStringField(body, "fromPath");
		const toPath = getStringField(body, "toPath");
		const sourceType = getStringField(body, "sourceType");
		if (!fromPath || !toPath) {
			return c.json({ error: "fromPath and toPath are required" }, 400);
		}
		if (sourceType && sourceType !== "file" && sourceType !== "directory") {
			return c.json({ error: "sourceType must be file or directory" }, 400);
		}
		const moveSourceType = sourceType as WorkspaceMoveSourceType | undefined;
		const fromPathResult = readWorkspaceRoutePath(fromPath);
		if ("error" in fromPathResult) {
			return c.json({ error: fromPathResult.error }, 400);
		}
		const toPathResult = readWorkspaceRoutePath(toPath);
		if ("error" in toPathResult) {
			return c.json({ error: toPathResult.error }, 400);
		}
		const signature = await signWorkspaceOperation(c.env, {
			operation: "move",
			projectId,
			path: fromPathResult.path,
			body: JSON.stringify({ toPath: toPathResult.path }),
		});
		const item = await moveWorkspacePath(
			c.env.PROJECT_WORKSPACE_BUCKET,
			projectId,
			fromPathResult.path,
			toPathResult.path,
			moveSourceType,
			{ overwrite: true },
		);
		if (!item) {
			return c.json({ error: "Workspace path not found" }, 404);
		}
		return c.json({
			item,
			signature,
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
		const sessionId = c.req.param("sessionId");
		const detail = await getSessionDetailResponse(createRoutePrismaClient(c.env), {
			userId: c.get("userId"),
			sessionId,
			limit: readHistoryLimit(c.req.query("limit")),
			older: c.req.query("older") === "1",
			beforeClientSequence: readPositiveIntegerQuery(
				c.req.query("beforeClientSequence"),
			),
			beforeTimelineId: readPositiveIntegerQuery(c.req.query("beforeTimelineId")),
		});
		if (!detail) {
			return c.json({ error: "Session not found" }, 404);
		}
		return c.json(detail);
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

	app.post("/api/ccr/sessions/:sessionId/tool-permission", async (c) => {
		const body = await readJsonObject(c.req.raw);
		const store = createStore(c.env);
		const sessionId = c.req.param("sessionId");
		const session = await store.findUserSessionSummary(c.get("userId"), sessionId);
		if (!session || session.deletedAt) {
			return c.json({ error: "Session not found" }, 404);
		}
		const requestId = getStringField(body, "requestId");
		const rawDecision = getStringField(body, "decision");
		if (!requestId || (rawDecision !== "allow" && rawDecision !== "deny")) {
			return c.json({ error: "requestId and decision are required" }, 400);
		}
		const decision: ToolPermissionDecision = rawDecision;
		const request = await store.findToolPermissionRequest(sessionId, requestId);
		if (!request) {
			return c.json({ error: "Tool permission request not found" }, 404);
		}
		if (await store.hasToolPermissionResponse(sessionId, requestId)) {
			return c.json({ error: "Tool permission request already answered" }, 409);
		}
		const response = buildCanUseToolDecisionResponse(
			requestId,
			request,
			decision,
		);
		const event = await store.enqueueClientEvent(sessionId, response, {
			eventType: "control_response",
			source: "user-permission",
		});
		return c.json({ ok: true, event });
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
		const control = readChatControlInput(body);
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
					acceptedEvents = await store.enqueueChatInput(sessionId, messages, control);
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
		const acceptedEvents = await store.enqueueChatInput(sessionId, messages, control);
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

	app.get("/api/sessions/:sessionId/internal-events.jsonl", async (c) => {
		const response = await createSessionInternalEventsJsonlResponse(
			createRoutePrismaClient(c.env),
			{
				userId: c.get("userId"),
				sessionId: c.req.param("sessionId"),
				signal: c.req.raw.signal,
			},
		);
		if (!response) {
			return c.json({ error: "Session not found" }, 404);
		}
		return response;
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
					if (!events) {
						await output.write(
							formatSseControlFrame("done", { reason: "session_deleted" }),
						);
						return;
					}
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
		const events = Array.isArray(body.events)
			? (body.events.filter(isJsonObject) as unknown as WorkerVisibleEvent[])
			: [];
		const accepted = await store.insertWorkerEvents(sessionId, workerEpoch, events);
		if (!accepted) {
			return c.json({ error: "worker_epoch mismatch" }, 409);
		}
		for (const event of events) {
			const payload = isJsonObject(event.payload) ? event.payload : {};
			if (payload.type !== "control_request") {
				continue;
			}
			const response = await handleControlRequest(payload, {
				env: c.env,
				sessionId,
				store,
				userId: c.get("userId"),
			});
			if (response) {
				await store.enqueueClientEvent(sessionId, response, {
					eventType: "control_response",
					source: "route-control",
				});
			}
		}
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
		const events = Array.isArray(body.events)
			? (body.events.filter(isJsonObject) as unknown as WorkerInternalEvent[])
			: [];
		if (!(await store.insertInternalEvents(sessionId, workerEpoch, events))) {
			return c.json({ error: "worker_epoch mismatch" }, 409);
		}
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
		const updates = Array.isArray(body.updates)
			? body.updates.filter(isJsonObject).map((update) => ({
					event_id: getStringField(update, "event_id") ?? "",
					status: getStringField(update, "status") ?? "unknown",
				}))
			: [];
		if (!(await store.insertDeliveryUpdates(sessionId, workerEpoch, updates))) {
			return c.json({ error: "worker_epoch mismatch" }, 409);
		}
		return c.json({ ok: true });
	});

	app.put("/v1/code/sessions/:sessionId/worker", async (c) => {
		const store = createStore(c.env);
		const sessionId = c.req.param("sessionId");
		const body = await readJsonObject(c.req.raw);
		const workerEpoch = readWorkerEpoch(body);
		if (!(await store.updateWorker(sessionId, workerEpoch, body))) {
			return c.json({ error: "worker_epoch mismatch" }, 409);
		}
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
		if (!(await store.recordHeartbeat(sessionId, workerEpoch))) {
			return c.json({ error: "worker_epoch mismatch" }, 409);
		}
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
		const file = await store.writeSessionStoreFile(
			c.req.param("sessionId"),
			projectKey,
			subpath,
			body.content,
			isJsonObject(body.metadata) ? body.metadata : undefined,
		);
		if (!file) {
			return c.json({ error: "session not active" }, 409);
		}
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
