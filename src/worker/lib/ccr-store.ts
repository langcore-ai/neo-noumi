import type { PrismaClient } from "../../generated/prisma/client";
import { isJsonObject, mergeJsonObject, toJsonValue } from "./ccr-json";
import type {
	ChatMessageInput,
	JsonObject,
	JsonValue,
	WorkerInternalEvent,
	WorkerVisibleEvent,
} from "./ccr-types";

/** 默认 CCR external metadata */
const DEFAULT_EXTERNAL_METADATA: JsonObject = {
	permission_mode: "default",
	model: "sonnet",
	pending_action: null,
	task_summary: null,
};

/** 默认分页大小 */
const DEFAULT_PAGE_SIZE = 100;

/** 并发写入 client event 发生序号冲突时的最大重试次数 */
const CLIENT_EVENT_SEQUENCE_RETRY_LIMIT = 3;

/** Client event 等待 worker 消费的状态。 */
const CLIENT_EVENT_STATUS_QUEUED = "queued";

/** 默认项目名称 */
const DEFAULT_PROJECT_NAME = "Default Project";

/** 用户级 sandbox ID 前缀，用于按用户复用同一个容器。 */
const USER_SANDBOX_ID_PREFIX = "neo-noumi-user";

/**
 * 生成随机事件 ID。
 * @returns UUID
 */
function newEventId(): string {
	return crypto.randomUUID();
}

/**
 * 从 payload 提取幂等 ID。
 * @param payload 事件 payload
 * @returns 事件 ID
 */
function eventIdFromPayload(payload: JsonObject): string {
	return typeof payload.uuid === "string" ? payload.uuid : newEventId();
}

/**
 * 将 Prisma JSON 值收敛为 JSON 对象。
 * @param value Prisma JSON 值
 * @returns JSON 对象
 */
function asJsonObject(value: unknown): JsonObject {
	return isJsonObject(value) ? value : {};
}

/**
 * 判断事件 payload 是否只是连接保活。
 * @param payload 事件 payload
 * @returns 是否应跳过持久化
 */
function isKeepAlivePayload(payload: JsonObject): boolean {
	return payload.type === "keep_alive";
}

/**
 * 判断事件是否为 runner 初始化元数据。
 * @param payload 事件 payload
 * @returns 是否为 system/init 事件
 */
function isSystemInitPayload(payload: JsonObject): boolean {
	return payload.type === "system" && payload.subtype === "init";
}

/**
 * 判断错误是否是 Prisma 唯一约束冲突。
 * @param error 原始错误
 * @returns 是否是 P2002
 */
function isUniqueConstraintError(error: unknown): boolean {
	return isJsonObject(error) && error.code === "P2002";
}

/** PostgreSQL backed chat session store */
export class CcrStore {
	constructor(private readonly prisma: PrismaClient) {}

	/**
	 * 确保用户默认 project 存在。
	 * @param userId 用户 ID
	 * @returns 默认 project
	 */
	async ensureDefaultProject(userId: string) {
		const existing = await this.prisma.project.findFirst({
			where: { userId, deletedAt: null },
			orderBy: { createdAt: "asc" },
		});
		if (existing) {
			return existing;
		}
		return this.createProject(userId, DEFAULT_PROJECT_NAME);
	}

	/**
	 * 创建 project。
	 * @param userId 用户 ID
	 * @param name project 名称
	 * @returns project
	 */
	async createProject(userId: string, name?: string) {
		return this.prisma.project.create({
			data: {
				id: crypto.randomUUID(),
				userId,
				name: name?.trim() || DEFAULT_PROJECT_NAME,
			},
		});
	}

	/**
	 * 查询用户 project 列表。
	 * @param userId 用户 ID
	 * @returns project 列表
	 */
	async listProjects(userId: string) {
		return this.prisma.project.findMany({
			where: { userId, deletedAt: null },
			orderBy: { updatedAt: "desc" },
			take: 50,
		});
	}

	/**
	 * 查询用户自己的 project。
	 * @param userId 用户 ID
	 * @param projectId project ID
	 * @returns project；不存在或不属于用户时返回 null
	 */
	async findUserProject(userId: string, projectId: string) {
		return this.prisma.project.findFirst({
			where: { id: projectId, userId, deletedAt: null },
		});
	}

	/**
	 * 确保 session 存在。
	 * @param sessionId session ID
	 * @param title 可选标题
	 * @param userId 用户 ID
	 * @param projectId project ID
	 */
	async ensureSession(
		sessionId: string,
		title: string | undefined,
		userId: string,
		projectId: string,
	) {
		return this.prisma.chatSession.upsert({
			where: { id: sessionId },
			create: {
				id: sessionId,
				title,
				userId,
				projectId,
				externalMetadata: DEFAULT_EXTERNAL_METADATA,
			},
			update: title ? { title } : {},
		});
	}

	/**
	 * 创建新的 CCR session。
	 * @param title 标题
	 * @returns session 摘要
	 */
	async createSession(userId: string, projectId: string, title?: string) {
		const project = await this.findUserProject(userId, projectId);
		if (!project) {
			return null;
		}
		// 使用裸 UUID 即可；Cloudflare sandbox 名称会在容器层单独加业务前缀。
		const sessionId = crypto.randomUUID();
		return this.ensureSession(sessionId, title, userId, project.id);
	}

	/**
	 * 查询 session 列表。
	 * @returns session 摘要列表
	 */
	async listSessions(userId: string, projectId?: string) {
		return this.prisma.chatSession.findMany({
			where: { userId, projectId, deletedAt: null },
			orderBy: { updatedAt: "desc" },
			take: 50,
		});
	}

	/**
	 * 删除 CCR session 及其级联数据。
	 * @param sessionId session ID
	 * @returns 是否删除了记录
	 */
	async deleteSession(sessionId: string): Promise<boolean> {
		// Prisma 关系设置了 onDelete: Cascade，会同步清理 events 与 sessionStore。
		const result = await this.prisma.chatSession.deleteMany({
			where: { id: sessionId },
		});
		return result.count > 0;
	}

	/**
	 * 标记 session 正在删除，避免列表继续展示等待后台清理的会话。
	 * @param sessionId session ID
	 * @returns 是否更新了记录
	 */
	async markSessionDeleting(sessionId: string): Promise<boolean> {
		const result = await this.prisma.chatSession.updateMany({
			where: { id: sessionId, deletedAt: null },
			data: { containerStatus: "deleting", deletedAt: new Date() },
		});
		return result.count > 0;
	}

	/**
	 * 查询 session 的容器生命周期信息。
	 * @param sessionId session ID
	 * @returns 容器状态；不存在时返回 null
	 */
	async getSessionLifecycle(sessionId: string) {
		return this.prisma.chatSession.findUnique({
			where: { id: sessionId },
			select: {
				sandboxId: true,
				runnerProcessId: true,
				containerStatus: true,
				deletedAt: true,
				userId: true,
				projectId: true,
			},
		});
	}

	/**
	 * 读取用户级容器生命周期。
	 * @param userId 用户 ID
	 * @returns 用户容器状态
	 */
	async getUserContainer(userId: string) {
		return this.prisma.userContainer.upsert({
			where: { userId },
			create: {
				id: crypto.randomUUID(),
				userId,
				sandboxId: `${USER_SANDBOX_ID_PREFIX}-${userId}`,
			},
			update: {},
		});
	}

	/**
	 * 更新用户级容器状态。
	 * @param userId 用户 ID
	 * @param data 状态字段
	 */
	async updateUserContainer(
		userId: string,
		data: { containerStatus?: string; sandboxId?: string | null },
	) {
		await this.prisma.userContainer.upsert({
			where: { userId },
			create: {
				id: crypto.randomUUID(),
				userId,
				sandboxId: data.sandboxId ?? `${USER_SANDBOX_ID_PREFIX}-${userId}`,
				containerStatus: data.containerStatus ?? "stopped",
			},
			update: data,
		});
	}

	/**
	 * 为 sandbox worker 准备会话级访问 token。
	 * @param sessionId session ID
	 * @returns worker 访问 token
	 */
	async rotateWorkerAccessToken(sessionId: string): Promise<string> {
		const token = crypto.randomUUID();
		const result = await this.prisma.chatSession.updateMany({
			where: { id: sessionId },
			data: { workerAccessToken: token },
		});
		if (result.count === 0) {
			throw new Error("Session not found");
		}
		return token;
	}

	/**
	 * 校验 sandbox worker 访问 token。
	 * @param sessionId session ID
	 * @param token 请求携带的 token
	 * @returns token 是否有效
	 */
	async verifyWorkerAccessToken(sessionId: string, token: string): Promise<boolean> {
		const session = await this.prisma.chatSession.findUnique({
			where: { id: sessionId },
			select: { workerAccessToken: true, deletedAt: true },
		});
		return Boolean(
			session?.workerAccessToken &&
				session.workerAccessToken === token &&
				!session.deletedAt,
		);
	}

	/**
	 * 注册 worker 并推进 epoch。
	 * @param sessionId session ID
	 * @returns 新 epoch
	 */
	async registerWorker(sessionId: string): Promise<number> {
		const session = await this.prisma.chatSession.findUniqueOrThrow({
			where: { id: sessionId },
			select: { workerEpoch: true },
		});
		const nextEpoch = session.workerEpoch + 1;
		await this.prisma.chatSession.updateMany({
			where: { id: sessionId },
			data: {
				workerEpoch: nextEpoch,
				workerStatus: "idle",
				containerStatus: "running",
			},
		});
		await this.recordOperation(sessionId, {
			direction: "route_internal",
			category: "worker_registered",
			payload: { worker_epoch: nextEpoch },
		});
		return nextEpoch;
	}

	/**
	 * 判断 worker epoch 是否仍为当前有效值。
	 * @param sessionId session ID
	 * @param epoch worker epoch
	 * @returns 是否有效
	 */
	async isCurrentEpoch(sessionId: string, epoch: number): Promise<boolean> {
		const session = await this.prisma.chatSession.findUnique({
			where: { id: sessionId },
			select: { workerEpoch: true },
		});
		return session?.workerEpoch === epoch;
	}

	/**
	 * 获取 worker 恢复快照。
	 * @param sessionId session ID
	 * @returns worker snapshot
	 */
	async getWorkerSnapshot(sessionId: string) {
		const session = await this.prisma.chatSession.findUniqueOrThrow({
			where: { id: sessionId },
			select: { externalMetadata: true },
		});
		return {
			external_metadata: {
				...DEFAULT_EXTERNAL_METADATA,
				...asJsonObject(session.externalMetadata),
			},
		};
	}

	/**
	 * 更新 worker 状态。
	 * @param sessionId session ID
	 * @param body 请求体
	 */
	async updateWorker(sessionId: string, body: JsonObject) {
		const session = await this.prisma.chatSession.findUniqueOrThrow({
			where: { id: sessionId },
			select: { externalMetadata: true },
		});
		const externalMetadata = isJsonObject(body.external_metadata)
			? body.external_metadata
			: undefined;
		const requiresActionDetails = isJsonObject(body.requires_action_details)
			? body.requires_action_details
			: undefined;
		const workerStatus =
			typeof body.worker_status === "string" ? body.worker_status : undefined;

		await this.prisma.chatSession.updateMany({
			where: { id: sessionId },
			data: {
				workerStatus,
				externalMetadata: mergeJsonObject(
					asJsonObject(session.externalMetadata),
					externalMetadata,
				),
				requiresActionDetails,
			},
		});
		await this.recordOperation(sessionId, {
			direction: "worker_to_route",
			category: workerStatus === "requires_action" ? "requires_action" : "worker_state",
			payload: body,
			requestId:
				requiresActionDetails &&
				typeof requiresActionDetails.request_id === "string"
					? requiresActionDetails.request_id
					: undefined,
		});
	}

	/**
	 * 写入用户消息并启动用 client event。
	 * @param sessionId session ID
	 * @param messages 用户消息列表
	 */
	async enqueueChatInput(sessionId: string, messages: ChatMessageInput[]) {
		for (const message of messages) {
			await this.enqueueClientEvent(
				sessionId,
				{
					type: "user",
					message: {
						role: message.role,
						content: message.content,
					},
					session_id: sessionId,
					parent_tool_use_id: null,
				},
				{ eventType: "user", source: "chat-api" },
			);
		}
	}

	/**
	 * 下发 client event。
	 * @param sessionId session ID
	 * @param payload payload
	 * @param options 事件选项
	 * @returns 事件记录
	 */
	async enqueueClientEvent(
		sessionId: string,
		payload: JsonObject,
		options: { eventType?: string; source?: string } = {},
	) {
		const eventType = options.eventType ?? String(payload.type ?? "message");
		const source = options.source ?? "route";
		let created;
		for (let attempt = 0; attempt < CLIENT_EVENT_SEQUENCE_RETRY_LIMIT; attempt += 1) {
			const last = await this.prisma.chatClientEvent.findFirst({
				where: { sessionId },
				orderBy: { sequenceNum: "desc" },
				select: { sequenceNum: true },
			});
			const sequenceNum = (last?.sequenceNum ?? 0) + 1;
			try {
				created = await this.prisma.chatClientEvent.create({
					data: {
						sessionId,
						eventId: newEventId(),
						sequenceNum,
						eventType,
						source,
						payload,
					},
				});
				break;
			} catch (error) {
				// 并发写入可能抢到相同 sequenceNum，重试后重新读取最新序号。
				if (attempt === CLIENT_EVENT_SEQUENCE_RETRY_LIMIT - 1) {
					throw error;
				}
			}
		}
		if (!created) {
			throw new Error("Failed to create CCR client event");
		}
		await this.recordOperation(sessionId, {
			direction: "route_to_worker",
			category: eventType,
			eventId: created.eventId,
			payload,
		});
		return this.toClientEventDto(created);
	}

	/**
	 * 查询 client events。
	 * @param sessionId session ID
	 * @param fromSequence 起始序号
	 * @returns events
	 */
	async listClientEvents(sessionId: string, fromSequence: number) {
		const rows = await this.prisma.chatClientEvent.findMany({
			where: { sessionId, sequenceNum: { gt: fromSequence } },
			orderBy: { sequenceNum: "asc" },
			take: DEFAULT_PAGE_SIZE,
		});
		return rows.map((row) => this.toClientEventDto(row));
	}

	/**
	 * 查询等待下发给 worker 的 client events。
	 * @param sessionId session ID
	 * @param fromSequence 起始序号
	 * @returns 尚未交付的 events
	 */
	async listQueuedClientEvents(sessionId: string, fromSequence: number) {
		const rows = await this.prisma.chatClientEvent.findMany({
			where: {
				sessionId,
				sequenceNum: { gt: fromSequence },
				// 新 worker 从 0 建立 SSE 时不能重放已交付输入，否则旧消息会被再次执行并入库。
				status: CLIENT_EVENT_STATUS_QUEUED,
			},
			orderBy: { sequenceNum: "asc" },
			take: DEFAULT_PAGE_SIZE,
		});
		return rows.map((row) => this.toClientEventDto(row));
	}

	/**
	 * 写入 worker visible events。
	 * @param sessionId session ID
	 * @param epoch worker epoch
	 * @param events worker events
	 */
	async insertWorkerEvents(
		sessionId: string,
		epoch: number,
		events: WorkerVisibleEvent[],
	) {
		for (const event of events) {
			const payload = isJsonObject(event.payload) ? event.payload : {};
			// keep_alive 只用于维持 worker 长连接，不进入业务事件表。
			if (isKeepAlivePayload(payload)) {
				continue;
			}
			const eventId = eventIdFromPayload(payload);
			const eventType = String(payload.type ?? "unknown");
			if (isSystemInitPayload(payload)) {
				const existingSystemEvents = await this.prisma.chatWorkerEvent.findMany({
					where: { sessionId, workerEpoch: epoch, eventType },
					select: { payload: true },
				});
				// 同一 worker epoch 的 init 只表示同一次 runner 元数据，重复上报不应污染时间线。
				if (
					existingSystemEvents.some((item) =>
						isSystemInitPayload(asJsonObject(item.payload)),
					)
				) {
					continue;
				}
			}
			try {
				await this.prisma.chatWorkerEvent.create({
					data: {
						sessionId,
						eventId,
						workerEpoch: epoch,
						eventType,
						payload,
						ephemeral: Boolean(event.ephemeral),
					},
				});
			} catch (error) {
				// eventId 是 worker visible event 的幂等键；重复上报不应继续写 operation log。
				if (isUniqueConstraintError(error)) {
					continue;
				}
				throw error;
			}
			await this.recordOperation(sessionId, {
				direction: "worker_to_route",
				category: eventType,
				eventId,
				payload,
			});
		}
	}

	/**
	 * 将 client event 数据库行转换成 CCR 协议 DTO。
	 * @param row client event 数据库行
	 * @returns 协议 DTO
	 */
	private toClientEventDto(row: {
		eventId: string;
		sequenceNum: number;
		eventType: string;
		source: string;
		payload: unknown;
		createdAt: Date;
	}) {
		return {
			event_id: row.eventId,
			sequence_num: row.sequenceNum,
			event_type: row.eventType,
			source: row.source,
			payload: asJsonObject(row.payload),
			created_at: row.createdAt.toISOString(),
		};
	}

	/**
	 * 写入 internal events。
	 * @param sessionId session ID
	 * @param epoch worker epoch
	 * @param events internal events
	 */
	async insertInternalEvents(
		sessionId: string,
		epoch: number,
		events: WorkerInternalEvent[],
	) {
		for (const event of events) {
			const payload = isJsonObject(event.payload) ? event.payload : {};
			// keep_alive 没有审计价值，避免污染 internal event 历史。
			if (isKeepAlivePayload(payload)) {
				continue;
			}
			const eventId = eventIdFromPayload(payload);
			const eventType = String(payload.type ?? "unknown");
			await this.prisma.chatInternalEvent.upsert({
				where: { eventId },
				create: {
					sessionId,
					eventId,
					workerEpoch: epoch,
					eventType,
					payload,
					eventMetadata: event.event_metadata ?? undefined,
					isCompaction: Boolean(event.is_compaction),
					agentId: event.agent_id,
				},
				update: {},
			});
		}
	}

	/**
	 * 查询 internal events。
	 * @param sessionId session ID
	 * @param options 查询参数
	 * @returns 分页结果
	 */
	async listInternalEvents(
		sessionId: string,
		options: { subagents: boolean; cursor?: number; limit?: number },
	) {
		const limit = Math.min(Math.max(options.limit ?? DEFAULT_PAGE_SIZE, 1), 500);
		const rows = await this.prisma.chatInternalEvent.findMany({
			where: {
				sessionId,
				id: { gt: options.cursor ?? 0 },
				agentId: options.subagents ? { not: null } : null,
			},
			orderBy: { id: "asc" },
			take: limit + 1,
		});
		const pageRows = rows.slice(0, limit);
		return {
			data: pageRows.map((row) => ({
				event_id: String(row.id),
				event_type: row.eventType,
				payload: asJsonObject(row.payload),
				event_metadata: row.eventMetadata ? asJsonObject(row.eventMetadata) : null,
				is_compaction: row.isCompaction,
				created_at: row.createdAt.toISOString(),
				agent_id: row.agentId ?? undefined,
			})),
			next_cursor:
				rows.length > limit ? String(pageRows[pageRows.length - 1]?.id) : null,
		};
	}

	/**
	 * 查询 chat timeline。
	 * @param sessionId session ID
	 * @param cursor 游标
	 * @param limit 数量
	 * @returns timeline events
	 */
	async listChatTimeline(sessionId: string, cursor = 0, limit = 200) {
		const rows = await this.prisma.chatWorkerEvent.findMany({
			where: { sessionId, id: { gt: cursor } },
			orderBy: { id: "asc" },
			take: Math.min(Math.max(limit, 1), 500),
		});
		return rows.map((row) => ({
			id: row.id,
			event_id: row.eventId,
			event_type: row.eventType,
			payload: asJsonObject(row.payload),
			ephemeral: row.ephemeral,
			created_at: row.createdAt.toISOString(),
		}));
	}

	/**
	 * 记录 delivery 状态。
	 * @param sessionId session ID
	 * @param epoch worker epoch
	 * @param updates 更新列表
	 */
	async insertDeliveryUpdates(
		sessionId: string,
		epoch: number,
		updates: Array<{ event_id: string; status: string }>,
	) {
		for (const update of updates) {
			if (!update.event_id) {
				continue;
			}
			const updated = await this.prisma.chatClientEvent.updateMany({
				where: { sessionId, eventId: update.event_id },
				data: { status: update.status },
			});
			// delivery 是 client event 的状态转移；找不到原事件时不写孤儿审计行。
			if (updated.count === 0) {
				continue;
			}
			await this.prisma.chatDeliveryUpdate.create({
				data: {
					sessionId,
					eventId: update.event_id,
					status: update.status,
					workerEpoch: epoch,
				},
			});
		}
	}

	/**
	 * 记录 heartbeat。
	 * @param sessionId session ID
	 * @param epoch worker epoch
	 */
	async recordHeartbeat(sessionId: string, epoch: number) {
		await this.prisma.chatSession.updateMany({
			where: { id: sessionId, workerEpoch: epoch },
			data: { lastHeartbeatAt: new Date() },
		});
	}

	/**
	 * 更新容器状态。
	 * @param sessionId session ID
	 * @param data 状态字段
	 */
	async updateContainer(
		sessionId: string,
		data: {
			workerStatus?: string;
			containerStatus?: string;
			sandboxId?: string | null;
			runnerProcessId?: string | null;
		},
	) {
		// 状态更新按主键执行，避免 deletedAt 空值过滤导致运行态静默丢失。
		const result = await this.prisma.chatSession.updateMany({
			where: { id: sessionId },
			data,
		});
		if (result.count === 0) {
			throw new Error("Session not found");
		}
	}

	/**
	 * 记录 session 对应的 sandbox runner 进程。
	 * @param sessionId session ID
	 * @param sandboxId 用户级 sandbox ID
	 * @param runnerProcessId runner 进程 ID
	 */
	async setSessionRunner(
		sessionId: string,
		sandboxId: string,
		runnerProcessId: string,
	) {
		await this.updateContainer(sessionId, {
			containerStatus: "running",
			sandboxId,
			runnerProcessId,
		});
	}

	/**
	 * 清理 session runner 进程记录。
	 * @param sessionId session ID
	 */
	async clearSessionRunner(sessionId: string) {
		await this.updateContainer(sessionId, {
			workerStatus: "idle",
			containerStatus: "stopped",
			runnerProcessId: null,
		});
	}

	/**
	 * 读取已存在的 session 摘要，不创建新 session。
	 * @param sessionId session ID
	 * @returns session；不存在时返回 null
	 */
	async findSessionSummary(sessionId: string) {
		return this.prisma.chatSession.findUnique({ where: { id: sessionId } });
	}

	/**
	 * 按用户读取 session 摘要。
	 * @param userId 用户 ID
	 * @param sessionId session ID
	 * @returns session；不存在或不属于用户时返回 null
	 */
	async findUserSessionSummary(userId: string, sessionId: string) {
		return this.prisma.chatSession.findFirst({
			where: { id: sessionId, userId, deletedAt: null },
		});
	}

	/**
	 * 写入 sessionStore 文件。
	 */
	async writeSessionStoreFile(
		sessionId: string,
		projectKey: string,
		subpath: string,
		content: string,
		metadata?: JsonObject,
	) {
		return this.prisma.chatSessionStoreFile.upsert({
			where: { sessionId_projectKey_subpath: { sessionId, projectKey, subpath } },
			create: { sessionId, projectKey, subpath, content, metadata },
			update: { content, metadata },
		});
	}

	/**
	 * 读取 sessionStore 文件。
	 */
	async readSessionStoreFile(
		sessionId: string,
		projectKey: string,
		subpath: string,
	) {
		const file = await this.prisma.chatSessionStoreFile.findUnique({
			where: { sessionId_projectKey_subpath: { sessionId, projectKey, subpath } },
		});
		return file
			? {
					content: file.content,
					metadata: file.metadata ? asJsonObject(file.metadata) : null,
					updated_at: file.updatedAt.toISOString(),
				}
			: null;
	}

	/**
	 * 列出 sessionStore 文件。
	 */
	async listSessionStoreFiles(sessionId: string, projectKey: string, prefix = "") {
		const rows = await this.prisma.chatSessionStoreFile.findMany({
			where: { sessionId, projectKey, subpath: { startsWith: prefix } },
			orderBy: { subpath: "asc" },
		});
		return rows.map((row) => ({
			subpath: row.subpath,
			updated_at: row.updatedAt.toISOString(),
		}));
	}

	/**
	 * 删除 sessionStore 文件。
	 */
	async deleteSessionStoreFile(
		sessionId: string,
		projectKey: string,
		subpath: string,
	) {
		const result = await this.prisma.chatSessionStoreFile.deleteMany({
			where: { sessionId, projectKey, subpath },
		});
		return result.count > 0;
	}

	/**
	 * 记录 operation log。
	 */
	async recordOperation(
		sessionId: string,
		input: {
			direction: string;
			category: string;
			payload: JsonObject | JsonValue;
			eventId?: string;
			agentId?: string;
			toolName?: string;
			toolUseId?: string;
			requestId?: string;
		},
	) {
		await this.prisma.chatOperationLog.create({
			data: {
				sessionId,
				direction: input.direction,
				category: input.category,
				eventId: input.eventId,
				agentId: input.agentId,
				toolName: input.toolName,
				toolUseId: input.toolUseId,
				requestId: input.requestId,
				payload: toJsonValue(input.payload) ?? {},
			},
		});
	}
}
