import { Prisma, type PrismaClient } from "../../generated/prisma/client";
import {
	getStringField,
	isJsonObject,
	mergeJsonObject,
	toJsonValue,
	type JsonObject,
	type JsonValue,
} from "./json";
import {
	buildRouteMcpInitializeRequest,
	buildSetMaxThinkingTokensRequest,
	buildSetModelRequest,
	buildSetPermissionModeRequest,
	type CcrPermissionMode,
} from "./ccr-control";
import {
	CLIENT_EVENT_STATUS_FAILED,
	CLIENT_EVENT_STATUS_QUEUED,
	asCcrPayload,
	eventIdFromPayload,
	isKeepAlivePayload,
	isSystemInitPayload,
	mergeClientEventDeliveryStatus,
	normalizeClaudeBaseUrl,
} from "./ccr-protocol";
import type {
	ChatMessageInput,
	WorkerInternalEvent,
	WorkerVisibleEvent,
} from "./ccr-types";
import { buildUserContainerId } from "./container-identity";

/** 默认 CCR external metadata */
const DEFAULT_EXTERNAL_METADATA: JsonObject = {
	permission_mode: "default",
	model: "sonnet",
	pending_action: null,
	task_summary: null,
};

/** 默认分页大小 */
const DEFAULT_PAGE_SIZE = 100;

/** 默认项目名称 */
const DEFAULT_PROJECT_NAME = "Default Project";

/** Project 名称最大长度，避免 UI 和数据库写入过长的非业务内容。 */
const PROJECT_NAME_MAX_LENGTH = 80;

/** Project 描述最大长度，用于管理页摘要展示。 */
const PROJECT_DESCRIPTION_MAX_LENGTH = 500;

/** Serializable 事务冲突的最大重试次数。 */
const SERIALIZABLE_TRANSACTION_RETRY_LIMIT = 3;

/** AI Proxy token 前缀，用于和真实上游 key 做肉眼区分。 */
const AI_PROXY_TOKEN_PREFIX = "nnaip_";

/** AI Proxy token 默认有效期，单位毫秒。 */
const AI_PROXY_TOKEN_TTL_MS = 6 * 60 * 60 * 1000;

/** 默认 AI Proxy credential 名称。 */
const DEFAULT_AI_PROXY_CREDENTIAL_NAME = "Default Anthropic Proxy";

/** AI Proxy credential 名称最大长度。 */
const AI_PROXY_CREDENTIAL_NAME_MAX_LENGTH = 80;

/** AI Proxy credential 密文版本前缀。 */
const AI_PROXY_CREDENTIAL_CIPHERTEXT_PREFIX = "v1:";

/** Claude Code Agent SDK transcript 在 sessionStore 中使用的 project key。 */
export const CLAUDE_SESSION_STORE_PROJECT_KEY = "claude-code";

/** sessionStore 中 foreground transcript 的相对路径。 */
const foregroundTranscriptSubpath = (sessionId: string) => `${sessionId}.jsonl`;

/** sessionStore 中 subagent transcript 的相对路径。 */
const subagentTranscriptSubpath = (sessionId: string, agentId: string) =>
	`${sessionId}/subagents/agent-${agentId}.jsonl`;

/** sessionStore 中 subagent transcript 的路径前缀。 */
const subagentTranscriptPrefix = (sessionId: string) => `${sessionId}/subagents/`;

/** internal events fallback 镜像单次最多恢复事件数，避免长会话压垮 Worker 内存。 */
const INTERNAL_EVENT_RESTORE_MAX_EVENTS = 1_000;

/** internal events fallback 镜像单次最多生成 JSONL 字节数。 */
const INTERNAL_EVENT_RESTORE_MAX_BYTES = 2 * 1024 * 1024;

/** internal events fallback 估算 JSONL 字节数时复用的编码器。 */
const internalEventRestoreTextEncoder = new TextEncoder();

/** Project 名称冲突错误。 */
export class ProjectNameConflictError extends Error {
	/**
	 * 创建 project 名称冲突错误。
	 * @param projectName 冲突的 project 名称
	 */
	constructor(projectName: string) {
		super(`Project name already exists: ${projectName}`);
		this.name = "ProjectNameConflictError";
	}
}

/** 下发给 Claude Code 的会话控制选项。 */
export type ChatControlInput = {
	/** 本轮使用的权限模式；plan 模式通过该字段下发。 */
	permissionMode?: CcrPermissionMode;
	/** 是否标记为 ultraplan；仅在 permissionMode=plan 时有意义。 */
	ultraplan?: boolean;
	/** 本轮目标模型；空字符串表示不下发模型切换。 */
	model?: string;
	/** thinking token 上限；null 表示恢复 Claude Code 默认配置。 */
	maxThinkingTokens?: number | null;
};

/** route 准备入队的 client event。 */
type ClientEventEnqueueInput = {
	/** client event payload。 */
	payload: JsonObject;
	/** 显式事件类型；缺省时使用 payload.type。 */
	eventType?: string;
	/** 事件来源。 */
	source?: string;
};

/** chat 控制事件和对应 metadata patch。 */
type ChatControlBuildResult = {
	/** 需要先于用户消息入队的控制事件。 */
	events: ClientEventEnqueueInput[];
	/** 可提前同步的 session metadata。 */
	metadata: JsonObject;
};

/**
 * 计算恢复窗口查询游标，保留最新 compact boundary 本身。
 * @param cursor 客户端分页游标
 * @param compactionId 最新 compact boundary 的数据库 ID
 * @returns Prisma gt 游标
 */
function restoreCursor(cursor: number, compactionId: number): number {
	return Math.max(cursor, compactionId > 0 ? compactionId - 1 : 0);
}

/**
 * 从 internal event 中读取 Claude Code subagent transcript 子目录。
 * @param event internal event DTO
 * @returns 子目录；不存在时返回 null
 */
function readAgentTranscriptSubdir(event: {
	payload: JsonObject;
	event_metadata: JsonObject | null;
}): string | null {
	const candidates = [
		event.event_metadata?.agent_transcript_subdir,
		event.event_metadata?.transcript_subdir,
		event.payload.agent_transcript_subdir,
		event.payload.transcript_subdir,
	];
	const subdir = candidates.find(
		(candidate) =>
			typeof candidate === "string" &&
			candidate.length > 0 &&
			!candidate.includes("..") &&
			!candidate.includes("/"),
	);
	return typeof subdir === "string" ? subdir : null;
}

/**
 * 生成随机事件 ID。
 * @returns UUID
 */
function newEventId(): string {
	return crypto.randomUUID();
}

/**
 * 生成 AI Proxy token 原文。
 * @returns 只会暴露给容器的短期 proxy token
 */
function newAiProxyToken(): string {
	return `${AI_PROXY_TOKEN_PREFIX}${crypto.randomUUID().replaceAll("-", "")}`;
}

/**
 * 判断权限模式切换是否适合在 route 侧提前同步 metadata。
 * @param mode 权限模式
 * @returns 可以提前同步时返回 true
 */
function canOptimisticallySyncPermissionMode(mode: CcrPermissionMode): boolean {
	// bypassPermissions 会被 Claude Code 按启动参数和设置二次拒绝，不能在成功前确认到 metadata。
	return mode !== "bypassPermissions";
}

/** internal event fallback 恢复用 DTO。 */
type InternalEventRestoreItem = {
	/** internal event UUID。 */
	event_id: string;
	/** internal event 类型。 */
	event_type: string;
	/** 原始 CCR payload。 */
	payload: JsonObject;
	/** event metadata。 */
	event_metadata: JsonObject | null;
	/** 是否为 compaction boundary。 */
	is_compaction: boolean;
	/** 创建时间。 */
	created_at: string;
	/** subagent ID；foreground 为空。 */
	agent_id: string | null;
};

/** internal event fallback 恢复窗口。 */
type InternalEventRestoreWindow = {
	/** 被纳入恢复窗口的事件。 */
	events: InternalEventRestoreItem[];
	/** 是否因为硬上限截断。 */
	truncated: boolean;
	/** 已生成 JSONL 的估算字节数。 */
	bytes: number;
};

/**
 * 判断数据库错误是否来自唯一约束冲突。
 * @param error 捕获到的错误
 * @returns 是否为唯一约束冲突
 */
function isUniqueConstraintError(error: unknown): boolean {
	return (
		error instanceof Prisma.PrismaClientKnownRequestError &&
		error.code === "P2002"
	);
}

/**
 * 计算 token 哈希，数据库只保存不可逆摘要。
 * @param token token 原文
 * @returns 十六进制 SHA-256
 */
async function hashToken(token: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(token),
	);
	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

/**
 * 从 secret 派生 AES-GCM key。
 * @param secret Worker secret
 * @returns WebCrypto key
 */
async function importAiProxyCredentialKey(secret: string): Promise<CryptoKey> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(secret),
	);
	return crypto.subtle.importKey("raw", digest, "AES-GCM", false, [
		"encrypt",
		"decrypt",
	]);
}

/**
 * 编码 base64url。
 * @param bytes 原始字节
 * @returns base64url 字符串
 */
function encodeBase64Url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary)
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replaceAll("=", "");
}

/**
 * 解码 base64url。
 * @param value base64url 字符串
 * @returns 原始字节
 */
function decodeBase64Url(value: string): Uint8Array {
	const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
	const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
	const binary = atob(padded);
	return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

/**
 * 清洗 AI Proxy credential 输入。
 * @param input 原始输入
 * @returns 可持久化 credential 字段
 */
export function normalizeAiProxyCredentialInput(input: {
	name?: string | null;
	baseUrl?: string | null;
	apiKey?: string | null;
	provider?: string | null;
}) {
	const baseUrl = normalizeClaudeBaseUrl(input.baseUrl?.trim() || undefined);
	return {
		name: (input.name?.trim() || DEFAULT_AI_PROXY_CREDENTIAL_NAME).slice(
			0,
			AI_PROXY_CREDENTIAL_NAME_MAX_LENGTH,
		),
		provider: input.provider?.trim() || "anthropic",
		baseUrl: baseUrl || "https://api.anthropic.com",
		apiKey: input.apiKey?.trim() ?? "",
	};
}

/** AI Proxy 请求审计创建输入。 */
export type AiProxyRequestLogCreateInput = {
	/** 用户 ID。 */
	userId: string;
	/** Chat session ID。 */
	sessionId: string;
	/** AI Proxy token 表 ID。 */
	tokenId: string;
	/** 使用用户 credential 时记录 credential ID；平台 fallback 为空。 */
	credentialId?: string | null;
	/** 上游 provider。 */
	provider: string;
	/** 容器原始请求 method。 */
	requestMethod: string;
	/** 容器原始请求 URL。 */
	requestUrl: string;
	/** 容器原始请求 path。 */
	requestPath: string;
	/** 实际转发的上游 URL。 */
	upstreamUrl: string;
	/** 实际转发的上游 base URL。 */
	upstreamBaseUrl: string;
	/** 请求体 UTF-8 字节数。 */
	requestBytes: number;
};

/** AI Proxy 请求审计完成输入。 */
export type AiProxyRequestLogCompleteInput = {
	/** 轻表日志 ID。 */
	logId: string;
	/** HTTP 响应状态码；网络错误时为空。 */
	statusCode?: number | null;
	/** 请求总耗时，单位毫秒。 */
	durationMs: number;
	/** 响应体 UTF-8 字节数。 */
	responseBytes?: number | null;
	/** 网络或落库前捕获到的错误信息。 */
	errorMessage?: string | null;
	/** 容器原始请求头。 */
	requestHeaders?: Prisma.InputJsonValue;
	/** 容器原始请求体。 */
	requestBody?: string | null;
	/** 实际转发上游请求头。 */
	upstreamRequestHeaders?: Prisma.InputJsonValue;
	/** 上游响应头。 */
	responseHeaders?: Prisma.InputJsonValue | null;
	/** 上游响应体。 */
	responseBody?: string | null;
};

/**
 * 将 Prisma JSON 值收敛为 JSON 对象。
 * @param value Prisma JSON 值
 * @returns JSON 对象
 */
function asJsonObject(value: unknown): JsonObject {
	return isJsonObject(value) ? value : {};
}

/**
 * 判断错误是否是可重试的事务冲突。
 * @param error 原始错误
 * @returns 是否可重试
 */
function isRetryableTransactionError(error: unknown): boolean {
	if (!isJsonObject(error)) {
		return false;
	}
	return error.code === "P2034" || error.code === "40001";
}

/**
 * 执行带重试的 Serializable 事务。
 * @param prisma Prisma client
 * @param fn 事务体
 * @returns 事务结果
 */
async function runSerializableTransaction<T>(
	prisma: PrismaClient,
	fn: Parameters<PrismaClient["$transaction"]>[0] extends (tx: infer Tx) => unknown
		? (tx: Tx) => Promise<T>
		: never,
): Promise<T> {
	let lastError: unknown = new Error("Serializable transaction failed");
	for (let attempt = 0; attempt < SERIALIZABLE_TRANSACTION_RETRY_LIMIT; attempt += 1) {
		try {
			return await prisma.$transaction(fn, {
				isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
			});
		} catch (error) {
			lastError = error;
			if (!isRetryableTransactionError(error)) {
				throw error;
			}
			if (attempt === SERIALIZABLE_TRANSACTION_RETRY_LIMIT - 1) {
				throw error;
			}
			// 序列化冲突通常来自并发写同一 project/session，短暂退避后再重试。
			await sleep(10 * 2 ** attempt + Math.floor(Math.random() * 5));
		}
	}
	throw lastError;
}

/**
 * 暂停一小段时间。
 * @param ms 毫秒数
 */
function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 清洗创建 project 的表单输入。
 * @param input 原始输入
 * @returns 可写入数据库的 project 字段
 */
export function normalizeProjectCreateInput(input: {
	name?: string | null;
	description?: string | null;
}) {
	const trimmedName = input.name?.trim() ?? "";
	const trimmedDescription = input.description?.trim() ?? "";

	return {
		// 空名称回落到默认名称，保持历史创建接口的兼容行为。
		name: (trimmedName || DEFAULT_PROJECT_NAME).slice(0, PROJECT_NAME_MAX_LENGTH),
		description: trimmedDescription
			? trimmedDescription.slice(0, PROJECT_DESCRIPTION_MAX_LENGTH)
			: null,
	};
}

/**
 * 清洗更新 project 的表单输入。
 * @param input 原始输入，字段为 undefined 时表示调用方没有要求更新
 * @returns 可写入数据库的 project 字段
 */
export function normalizeProjectUpdateInput(input: {
	name?: string | null;
	description?: string | null;
}) {
	const data: { name?: string; description?: string | null } = {};

	if (input.name !== undefined) {
		const trimmedName = input.name?.trim() ?? "";
		// 显式提交空名称时沿用创建逻辑的默认名称；未提交 name 时不修改原名称。
		data.name = (trimmedName || DEFAULT_PROJECT_NAME).slice(0, PROJECT_NAME_MAX_LENGTH);
	}
	if (input.description !== undefined) {
		const trimmedDescription = input.description?.trim() ?? "";
		data.description = trimmedDescription
			? trimmedDescription.slice(0, PROJECT_DESCRIPTION_MAX_LENGTH)
			: null;
	}

	return data;
}

/** 面向 UI/API 的安全会话字段，避免把 worker token 返回给浏览器。 */
const chatSessionSummarySelect = {
	id: true,
	title: true,
	userId: true,
	projectId: true,
	workerEpoch: true,
	workerStatus: true,
	containerStatus: true,
	sandboxId: true,
	externalMetadata: true,
	requiresActionDetails: true,
	createdAt: true,
	updatedAt: true,
	deletedAt: true,
	lastHeartbeatAt: true,
} as const;

/** Project 删除前需要用于后台清理 runner 的 session 生命周期字段。 */
const projectSessionLifecycleSelect = {
	id: true,
	sandboxId: true,
	runnerProcessId: true,
	containerStatus: true,
	deletedAt: true,
	userId: true,
	projectId: true,
} as const;

/** PostgreSQL backed chat session store */
export class CcrStore {
	constructor(
		private readonly prisma: PrismaClient,
		private readonly options: { aiProxyCredentialSecret?: string } = {},
	) {}

	/**
	 * 加密 AI Proxy API key。
	 * @param apiKey API key 明文
	 * @returns 可持久化密文
	 */
	private async encryptAiProxyApiKey(apiKey: string): Promise<string> {
		const secret = this.options.aiProxyCredentialSecret;
		if (!secret) {
			throw new Error("AI_PROXY_CREDENTIAL_SECRET is required");
		}
		const iv = crypto.getRandomValues(new Uint8Array(12));
		const key = await importAiProxyCredentialKey(secret);
		const ciphertext = new Uint8Array(
			await crypto.subtle.encrypt(
				{ name: "AES-GCM", iv },
				key,
				new TextEncoder().encode(apiKey),
			),
		);
		return `${AI_PROXY_CREDENTIAL_CIPHERTEXT_PREFIX}${encodeBase64Url(
			iv,
		)}.${encodeBase64Url(ciphertext)}`;
	}

	/**
	 * 解密 AI Proxy API key。
	 * @param ciphertext 密文
	 * @returns API key 明文
	 */
	private async decryptAiProxyApiKey(ciphertext: string): Promise<string> {
		const secret = this.options.aiProxyCredentialSecret;
		if (!secret) {
			throw new Error("AI_PROXY_CREDENTIAL_SECRET is required");
		}
		if (!ciphertext.startsWith(AI_PROXY_CREDENTIAL_CIPHERTEXT_PREFIX)) {
			throw new Error("Unsupported AI proxy credential format");
		}
		const [encodedIv, encodedCiphertext] = ciphertext
			.slice(AI_PROXY_CREDENTIAL_CIPHERTEXT_PREFIX.length)
			.split(".");
		if (!encodedIv || !encodedCiphertext) {
			throw new Error("Invalid AI proxy credential ciphertext");
		}
		const key = await importAiProxyCredentialKey(secret);
		const plaintext = await crypto.subtle.decrypt(
			{ name: "AES-GCM", iv: decodeBase64Url(encodedIv) },
			key,
			decodeBase64Url(encodedCiphertext),
		);
		return new TextDecoder().decode(plaintext);
	}

	/**
	 * 在 worker 写入前锁定当前活跃 session。
	 * @param tx Prisma 事务 client
	 * @param sessionId session ID
	 * @returns session 仍然活跃时返回 true
	 */
	private async claimActiveSession(
		tx: Prisma.TransactionClient,
		sessionId: string,
	): Promise<boolean> {
		const result = await tx.chatSession.updateMany({
			where: { id: sessionId, deletedAt: null },
			// sessionStore 写入来自 worker 侧，锁定 session 行可避免删除态继续被写入。
			data: { lastHeartbeatAt: new Date() },
		});
		return result.count > 0;
	}

	/**
	 * 在 worker epoch 写入前锁定当前活跃 session。
	 * @param tx Prisma 事务 client
	 * @param sessionId session ID
	 * @param epoch worker epoch
	 * @returns session 仍然活跃且 epoch 匹配时返回 true
	 */
	private async claimActiveWorkerEpoch(
		tx: Prisma.TransactionClient,
		sessionId: string,
		epoch: number,
	): Promise<boolean> {
		const result = await tx.chatSession.updateMany({
			where: { id: sessionId, workerEpoch: epoch, deletedAt: null },
			// 写入 heartbeat 时间可锁定 session 行，避免删除和 worker 上报并发穿透。
			data: { lastHeartbeatAt: new Date() },
		});
		return result.count > 0;
	}

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
		try {
			return await this.createProject(userId, DEFAULT_PROJECT_NAME);
		} catch (error) {
			if (!(error instanceof ProjectNameConflictError)) {
				throw error;
			}
			// 并发初始化默认项目时，另一个请求可能已完成创建，回读即可。
			const latest = await this.prisma.project.findFirst({
				where: { userId, name: DEFAULT_PROJECT_NAME, deletedAt: null },
				orderBy: { createdAt: "asc" },
			});
			if (!latest) {
				throw error;
			}
			return latest;
		}
	}

	/**
	 * 创建 project。
	 * @param userId 用户 ID
	 * @param name project 名称
	 * @param description project 描述
	 * @returns project
	 */
	async createProject(userId: string, name?: string, description?: string) {
		const input = normalizeProjectCreateInput({ name, description });
		const existing = await this.prisma.project.findFirst({
			where: { userId, name: input.name, deletedAt: null },
			select: { id: true },
		});
		if (existing) {
			throw new ProjectNameConflictError(input.name);
		}

		try {
			return await this.prisma.project.create({
				data: {
					id: crypto.randomUUID(),
					userId,
					name: input.name,
					description: input.description,
				},
			});
		} catch (error) {
			if (isUniqueConstraintError(error)) {
				throw new ProjectNameConflictError(input.name);
			}
			throw error;
		}
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
			include: {
				sessions: {
					where: { deletedAt: null },
					orderBy: { updatedAt: "desc" },
					take: 10,
					select: chatSessionSummarySelect,
				},
				_count: {
					select: {
						// 管理页只统计未软删除会话，避免已删除会话影响当前项目概览。
						sessions: { where: { deletedAt: null } },
					},
				},
			},
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
	 * 更新用户自己的 project。
	 * @param userId 用户 ID
	 * @param projectId project ID
	 * @param input project 表单输入
	 * @returns 更新后的 project；不存在或不属于用户时返回 null
	 */
	async updateProject(
		userId: string,
		projectId: string,
		input: { name?: string | null; description?: string | null },
	) {
		const normalized = normalizeProjectUpdateInput(input);
		if (Object.keys(normalized).length === 0) {
			return this.findUserProject(userId, projectId);
		}
		if (normalized.name) {
			const existing = await this.prisma.project.findFirst({
				where: {
					id: { not: projectId },
					userId,
					name: normalized.name,
					deletedAt: null,
				},
				select: { id: true },
			});
			if (existing) {
				throw new ProjectNameConflictError(normalized.name);
			}
		}
		let result;
		try {
			result = await this.prisma.project.updateMany({
				where: { id: projectId, userId, deletedAt: null },
				data: normalized,
			});
		} catch (error) {
			if (normalized.name && isUniqueConstraintError(error)) {
				throw new ProjectNameConflictError(normalized.name);
			}
			throw error;
		}
		if (result.count === 0) {
			return null;
		}
		return this.findUserProject(userId, projectId);
	}

	/**
	 * 软删除用户自己的 project，并同步隐藏其下会话。
	 * @param userId 用户 ID
	 * @param projectId project ID
	 * @returns 删除结果和本次删除影响到的 session 生命周期
	 */
	async deleteProject(userId: string, projectId: string) {
		const now = new Date();
		return runSerializableTransaction(this.prisma, async (tx) => {
			const project = await tx.project.updateMany({
				where: { id: projectId, userId, deletedAt: null },
				data: { deletedAt: now },
			});
			if (project.count === 0) {
				return { deleted: false, sessions: [] };
			}
			const sessions = await tx.chatSession.findMany({
				where: { projectId, userId, deletedAt: null },
				select: projectSessionLifecycleSelect,
			});
			// 项目从管理页删除后，其下会话也不应继续出现在聊天历史里。
			await tx.chatSession.updateMany({
				where: { projectId, userId, deletedAt: null },
				data: { containerStatus: "deleting", deletedAt: now },
			});
			return { deleted: true, sessions };
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
		// 使用裸 UUID 即可；Cloudflare sandbox 名称会在容器层单独加业务前缀。
		const sessionId = crypto.randomUUID();
		return runSerializableTransaction(this.prisma, async (tx) => {
			const project = await tx.project.findFirst({
				where: { id: projectId, userId, deletedAt: null },
				select: { id: true },
			});
			if (!project) {
				return null;
			}
			return tx.chatSession.create({
				data: {
					id: sessionId,
					title,
					userId,
					projectId: project.id,
					externalMetadata: DEFAULT_EXTERNAL_METADATA,
				},
				select: chatSessionSummarySelect,
			});
		});
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
			select: chatSessionSummarySelect,
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
	 * 查询 session 启动 Claude Code 前所需的 workspace 上下文。
	 * @param sessionId session ID
	 * @returns workspace 所属 project；不存在时返回 null
	 */
	async getSessionWorkspaceContext(sessionId: string) {
		return this.prisma.chatSession.findUnique({
			where: { id: sessionId },
			select: {
				deletedAt: true,
				projectId: true,
				project: {
					select: {
						id: true,
						name: true,
						deletedAt: true,
					},
				},
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
				sandboxId: buildUserContainerId(userId),
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
				sandboxId: data.sandboxId ?? buildUserContainerId(userId),
				containerStatus: data.containerStatus ?? "stopped",
			},
			update: data,
		});
	}

	/**
	 * 读取用户 Claude Code 配置，不存在时返回空配置。
	 * @param userId 用户 ID
	 * @returns 用户级 Claude Code 配置
	 */
	async getUserClaudeCodeConfig(userId: string) {
		const config = await this.prisma.userClaudeCodeConfig.findUnique({
			where: { userId },
		});
		return {
			claudeConfigJson: config ? asJsonObject(config.claudeConfigJson) : {},
			claudeJson: config ? asJsonObject(config.claudeJson) : {},
		};
	}

	/**
	 * 写入用户 Claude Code 配置。
	 * @param userId 用户 ID
	 * @param input Claude Code 配置内容
	 * @returns 写入后的配置
	 */
	async upsertUserClaudeCodeConfig(
		userId: string,
		input: { claudeConfigJson: JsonObject; claudeJson: JsonObject },
	) {
		return this.prisma.userClaudeCodeConfig.upsert({
			where: { userId },
			create: {
				id: crypto.randomUUID(),
				userId,
				claudeConfigJson: input.claudeConfigJson,
				claudeJson: input.claudeJson,
			},
			update: {
				claudeConfigJson: input.claudeConfigJson,
				claudeJson: input.claudeJson,
			},
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
			where: { id: sessionId, deletedAt: null },
			data: { workerAccessToken: token },
		});
		if (result.count === 0) {
			throw new Error("Session not found");
		}
		return token;
	}

	/**
	 * 为当前 session 签发短期 AI Proxy token。
	 * @param userId 用户 ID
	 * @param sessionId session ID
	 * @param sandboxId 用户级 sandbox ID
	 * @returns 只注入容器的短期 token 原文
	 */
	async rotateAiProxyToken(
		userId: string,
		sessionId: string,
		sandboxId: string,
	): Promise<string> {
		const token = newAiProxyToken();
		const tokenHash = await hashToken(token);
		const expiresAt = new Date(Date.now() + AI_PROXY_TOKEN_TTL_MS);
		await runSerializableTransaction(this.prisma, async (tx) => {
			const session = await tx.chatSession.findFirst({
				where: { id: sessionId, userId, deletedAt: null },
				select: { id: true },
			});
			if (!session) {
				throw new Error("Session not found");
			}
			// 新 runner 启动时吊销同 session 的旧 token，避免旧容器继续打模型请求。
			await tx.aiProxyToken.updateMany({
				where: { sessionId, revokedAt: null },
				data: { revokedAt: new Date() },
			});
			await tx.aiProxyToken.create({
				data: {
					id: crypto.randomUUID(),
					tokenHash,
					userId,
					sessionId,
					sandboxId,
					expiresAt,
				},
			});
		});
		return token;
	}

	/**
	 * 吊销 session 的 AI Proxy token。
	 * @param sessionId session ID
	 */
	async revokeAiProxyTokensForSession(sessionId: string) {
		await this.prisma.aiProxyToken.updateMany({
			where: { sessionId, revokedAt: null },
			data: { revokedAt: new Date() },
		});
	}

	/**
	 * 校验 AI Proxy token 并恢复所属 session。
	 * @param token 容器提交的 proxy token
	 * @returns token 绑定上下文；无效时返回 null
	 */
	async authenticateAiProxyToken(token: string): Promise<{
		tokenId: string;
		userId: string;
		sessionId: string;
		sandboxId: string;
	} | null> {
		if (!token.startsWith(AI_PROXY_TOKEN_PREFIX)) {
			return null;
		}
		const tokenHash = await hashToken(token);
		const row = await this.prisma.aiProxyToken.findUnique({
			where: { tokenHash },
			select: {
				id: true,
				userId: true,
				sessionId: true,
				sandboxId: true,
				expiresAt: true,
				revokedAt: true,
				session: {
					select: {
						deletedAt: true,
						sandboxId: true,
					},
				},
			},
		});
		if (
			!row ||
			row.revokedAt ||
			row.expiresAt.getTime() <= Date.now() ||
			row.session.deletedAt ||
			row.session.sandboxId !== row.sandboxId
		) {
			return null;
		}
		return {
			tokenId: row.id,
			userId: row.userId,
			sessionId: row.sessionId,
			sandboxId: row.sandboxId,
		};
	}

	/**
	 * 创建或替换用户默认 AI Proxy credential。
	 * @param userId 用户 ID
	 * @param input credential 输入
	 * @returns credential 摘要
	 */
	async upsertDefaultAiProxyCredential(
		userId: string,
		input: { name?: string | null; baseUrl?: string | null; apiKey?: string | null; provider?: string | null },
	) {
		const normalized = normalizeAiProxyCredentialInput(input);
		if (!normalized.apiKey) {
			throw new Error("API key is required");
		}
		const encryptedApiKey = await this.encryptAiProxyApiKey(normalized.apiKey);
		return runSerializableTransaction(this.prisma, async (tx) => {
			await tx.aiProxyCredential.updateMany({
				where: { userId, deletedAt: null, isDefault: true },
				data: { isDefault: false },
			});
			return tx.aiProxyCredential.create({
				data: {
					id: crypto.randomUUID(),
					userId,
					name: normalized.name,
					provider: normalized.provider,
					baseUrl: normalized.baseUrl,
					apiKeyCiphertext: encryptedApiKey,
					isDefault: true,
				},
				select: {
					id: true,
					name: true,
					provider: true,
					baseUrl: true,
					isDefault: true,
					createdAt: true,
					updatedAt: true,
				},
			});
		});
	}

	/**
	 * 读取用户 AI Proxy credentials 摘要。
	 * @param userId 用户 ID
	 * @returns 不包含 API key 的 credential 列表
	 */
	async listAiProxyCredentials(userId: string) {
		return this.prisma.aiProxyCredential.findMany({
			where: { userId, deletedAt: null },
			orderBy: [{ isDefault: "desc" }, { updatedAt: "desc" }],
			select: {
				id: true,
				name: true,
				provider: true,
				baseUrl: true,
				isDefault: true,
				createdAt: true,
				updatedAt: true,
			},
		});
	}

	/**
	 * 读取用户默认 AI Proxy credential，包含转发所需 API key。
	 * @param userId 用户 ID
	 * @returns credential；不存在时返回 null
	 */
	async getDefaultAiProxyCredential(userId: string) {
		const credential = await this.prisma.aiProxyCredential.findFirst({
			where: { userId, deletedAt: null, isDefault: true },
			orderBy: { updatedAt: "desc" },
			select: {
				id: true,
				provider: true,
				baseUrl: true,
				apiKeyCiphertext: true,
			},
		});
		return credential
			? {
					id: credential.id,
					provider: credential.provider,
					baseUrl: credential.baseUrl,
					apiKey: await this.decryptAiProxyApiKey(credential.apiKeyCiphertext),
				}
			: null;
	}

	/**
	 * 创建 AI Proxy 请求审计记录。
	 * @param input 请求与转发上下文
	 * @returns 轻表日志 ID
	 */
	async createAiProxyRequestLog(input: AiProxyRequestLogCreateInput): Promise<string> {
		const logId = crypto.randomUUID();
		await this.prisma.aiProxyRequestLog.create({
			data: {
				id: logId,
				userId: input.userId,
				sessionId: input.sessionId,
				tokenId: input.tokenId,
				credentialId: input.credentialId ?? null,
				provider: input.provider,
				requestMethod: input.requestMethod,
				requestUrl: input.requestUrl,
				requestPath: input.requestPath,
				upstreamUrl: input.upstreamUrl,
				upstreamBaseUrl: input.upstreamBaseUrl,
				requestBytes: input.requestBytes,
			},
		});
		return logId;
	}

	/**
	 * 补全 AI Proxy 请求审计记录的响应信息。
	 * @param input 响应与错误信息
	 */
	async completeAiProxyRequestLog(input: AiProxyRequestLogCompleteInput): Promise<void> {
		const completedAt = new Date();
		await this.prisma.aiProxyRequestLog.update({
			where: { id: input.logId },
			data: {
				statusCode: input.statusCode ?? null,
				durationMs: input.durationMs,
				responseBytes: input.responseBytes ?? null,
				errorMessage: input.errorMessage ?? null,
				completedAt,
				payload: input.requestHeaders && input.upstreamRequestHeaders
					? {
							create: {
								id: crypto.randomUUID(),
								requestHeaders: input.requestHeaders,
								requestBody: input.requestBody ?? null,
								upstreamRequestHeaders: input.upstreamRequestHeaders,
								responseHeaders: input.responseHeaders ?? undefined,
								responseBody: input.responseBody ?? null,
							},
						}
					: undefined,
			},
		});
	}

	/**
	 * 校验 sandbox worker 访问 token，并返回所属用户。
	 * @param sessionId session ID
	 * @param token 请求携带的 token
	 * @returns 通过鉴权的 session owner；失败返回 null
	 */
	async authenticateWorkerAccessToken(
		sessionId: string,
		token: string,
	): Promise<{ userId: string } | null> {
		const session = await this.prisma.chatSession.findUnique({
			where: { id: sessionId },
			select: { workerAccessToken: true, deletedAt: true, userId: true },
		});
		if (
			!session?.workerAccessToken ||
			session.workerAccessToken !== token ||
			session.deletedAt
		) {
			return null;
		}
		return { userId: session.userId };
	}

	/**
	 * 注册 worker 并推进 epoch。
	 * @param sessionId session ID
	 * @returns 新 epoch
	 */
	async registerWorker(sessionId: string): Promise<number> {
		const [session] = await this.prisma.chatSession.updateManyAndReturn({
			where: { id: sessionId, deletedAt: null },
			data: {
				// epoch 必须在数据库内原子递增，避免两个 runner 同时注册拿到同一代际。
				workerEpoch: { increment: 1 },
				workerStatus: "idle",
				containerStatus: "running",
			},
			select: { workerEpoch: true },
		});
		if (!session) {
			throw new Error("Session not found or deleting");
		}
		await this.recordOperation(sessionId, {
			direction: "route_internal",
			category: "worker_registered",
			payload: { worker_epoch: session.workerEpoch },
		});
		return session.workerEpoch;
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
	 * @param epoch worker epoch
	 * @param body 请求体
	 * @returns 是否接受本次 worker 上报
	 */
	async updateWorker(sessionId: string, epoch: number, body: JsonObject): Promise<boolean> {
		return this.prisma.$transaction(async (tx) => {
			if (!(await this.claimActiveWorkerEpoch(tx, sessionId, epoch))) {
				return false;
			}
			const session = await tx.chatSession.findFirst({
				where: { id: sessionId, workerEpoch: epoch, deletedAt: null },
				select: { externalMetadata: true },
			});
			if (!session) {
				return false;
			}
			const externalMetadata = isJsonObject(body.external_metadata)
				? body.external_metadata
				: undefined;
			const workerStatus =
				typeof body.worker_status === "string" ? body.worker_status : undefined;
			const hasRequiresActionDetails = Object.hasOwn(
				body,
				"requires_action_details",
			);
			const requiresActionDetailsPayload = isJsonObject(body.requires_action_details)
				? body.requires_action_details
				: null;
			const requiresActionDetails = requiresActionDetailsPayload
				? requiresActionDetailsPayload
				: hasRequiresActionDetails && body.requires_action_details === null
					? Prisma.DbNull
					: workerStatus && workerStatus !== "requires_action"
						? Prisma.DbNull
						: undefined;

			const result = await tx.chatSession.updateMany({
				where: { id: sessionId, workerEpoch: epoch, deletedAt: null },
				data: {
					workerStatus,
					externalMetadata: mergeJsonObject(
						asJsonObject(session.externalMetadata),
						externalMetadata,
					),
					requiresActionDetails,
				},
			});
			if (result.count === 0) {
				return false;
			}
			await tx.chatOperationLog.create({
				data: {
					sessionId,
					direction: "worker_to_route",
					category:
						workerStatus === "requires_action" ? "requires_action" : "worker_state",
					requestId:
						requiresActionDetailsPayload &&
						typeof requiresActionDetailsPayload.request_id === "string"
							? requiresActionDetailsPayload.request_id
							: undefined,
					payload: toJsonValue(body) ?? {},
				},
			});
			return true;
		});
	}

	/**
	 * 合并写入 route 主动下发的会话 metadata。
	 * @param sessionId session ID
	 * @param metadata metadata patch；null 字段按 merge patch 语义删除
	 * @returns 是否写入成功
	 */
	async updateSessionExternalMetadata(
		sessionId: string,
		metadata: JsonObject,
	): Promise<boolean> {
		return this.prisma.$transaction(async (tx) => {
			const session = await tx.chatSession.findFirst({
				where: { id: sessionId, deletedAt: null },
				select: { externalMetadata: true },
			});
			if (!session) {
				return false;
			}
			const result = await tx.chatSession.updateMany({
				where: { id: sessionId, deletedAt: null },
				data: {
					externalMetadata: mergeJsonObject(
						asJsonObject(session.externalMetadata),
						metadata,
					),
				},
			});
			if (result.count === 0) {
				return false;
			}
			await tx.chatOperationLog.create({
				data: {
					sessionId,
					direction: "route_to_worker",
					category: "session_metadata",
					payload: metadata,
				},
			});
			return true;
		});
	}

	/**
	 * 构造并入队本轮需要先于用户消息执行的控制事件。
	 * @param sessionId session ID
	 * @param control 控制选项
	 * @returns 已入队的 client events
	 */
	async enqueueChatControls(sessionId: string, control: ChatControlInput = {}) {
		const built = this.buildChatControlEvents(control);
		return this.enqueueClientEvents(sessionId, built.events, built.metadata);
	}

	/**
	 * 构造本轮 chat 控制事件和可提前同步的 metadata。
	 * @param control 控制选项
	 * @returns 控制事件与 metadata patch
	 */
	private buildChatControlEvents(control: ChatControlInput = {}): ChatControlBuildResult {
		const events: ClientEventEnqueueInput[] = [];
		const metadata: JsonObject = {};
		if (control.permissionMode) {
			events.push(
				{
					payload: buildSetPermissionModeRequest(control.permissionMode, {
						ultraplan:
							control.permissionMode === "plan" ? control.ultraplan === true : undefined,
					}),
					eventType: "control_request",
					source: "chat-api",
				},
			);
			if (canOptimisticallySyncPermissionMode(control.permissionMode)) {
				// route 只能提前同步不会被当前 CLI 二次拒绝的模式，避免 UI 进入假状态。
				metadata.permission_mode = control.permissionMode;
				metadata.is_ultraplan_mode =
					control.permissionMode === "plan" && control.ultraplan === true ? true : null;
			}
		}

		if (control.model) {
			events.push(
				{
					payload: buildSetModelRequest(control.model),
					eventType: "control_request",
					source: "chat-api",
				},
			);
			if (control.model !== "default") {
				// default 会由 Claude Code 解析成真实模型名，route 侧不能提前猜测。
				metadata.model = control.model;
			}
		}

		if (Object.hasOwn(control, "maxThinkingTokens")) {
			const tokens = control.maxThinkingTokens ?? null;
			events.push(
				{
					payload: buildSetMaxThinkingTokensRequest(tokens),
					eventType: "control_request",
					source: "chat-api",
				},
			);
			metadata.max_thinking_tokens = tokens;
		}

		return { events, metadata };
	}

	/**
	 * 写入用户消息并启动用 client event。
	 * @param sessionId session ID
	 * @param messages 用户消息列表
	 * @param control 需要在用户消息前下发的控制选项
	 */
	async enqueueChatInput(
		sessionId: string,
		messages: ChatMessageInput[],
		control: ChatControlInput = {},
	) {
		const builtControls = this.buildChatControlEvents(control);
		const events: ClientEventEnqueueInput[] = [
			{
				payload: buildRouteMcpInitializeRequest(),
				eventType: "control_request",
				source: "chat-api",
			},
			...builtControls.events,
		];
		for (const message of messages) {
			events.push(
				{
					payload: {
						type: "user",
						message: {
							role: message.role,
							content: message.content,
						},
						session_id: sessionId,
						parent_tool_use_id: null,
					},
					eventType: "user",
					source: "chat-api",
				},
			);
		}
		return this.enqueueClientEvents(sessionId, events, builtControls.metadata);
	}

	/**
	 * 标记已入库的 client events 启动失败。
	 * @param sessionId session ID
	 * @param eventIds client event IDs
	 */
	async markClientEventsFailed(sessionId: string, eventIds: string[]) {
		if (eventIds.length === 0) {
			return;
		}
		await this.prisma.chatClientEvent.updateMany({
			where: {
				sessionId,
				eventId: { in: eventIds },
				status: CLIENT_EVENT_STATUS_QUEUED,
			},
			data: { status: CLIENT_EVENT_STATUS_FAILED },
		});
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
		const [created] = await this.enqueueClientEvents(sessionId, [
			{ payload, eventType: options.eventType, source: options.source },
		]);
		if (!created) {
			throw new Error("Failed to enqueue client event");
		}
		return created;
	}

	/**
	 * 批量下发 client events，并为同一轮 chat 分配连续 sequence。
	 * @param sessionId session ID
	 * @param inputs 待入队事件
	 * @param metadata 可随本批事件一起写入的 metadata patch
	 * @returns 事件记录
	 */
	private async enqueueClientEvents(
		sessionId: string,
		inputs: ClientEventEnqueueInput[],
		metadata: JsonObject = {},
	) {
		if (inputs.length === 0) {
			return [];
		}
		const created = await runSerializableTransaction(this.prisma, async (tx) => {
			const [session] = await tx.chatSession.updateManyAndReturn({
				where: { id: sessionId, deletedAt: null },
				// 同一批 chat 输入必须一次性分配连续 sequence，避免并发发送把控制事件串到别的 prompt。
				data: { nextClientSequence: { increment: inputs.length } },
				select: { nextClientSequence: true, externalMetadata: true },
			});
			if (!session) {
				throw new Error("Session not found or deleting");
			}
			const firstSequenceNum = session.nextClientSequence - inputs.length;
			const rows = [];
			for (const [index, input] of inputs.entries()) {
				const eventType = input.eventType ?? String(input.payload.type ?? "message");
				const source = input.source ?? "route";
				const row = await tx.chatClientEvent.create({
					data: {
						sessionId,
						eventId: newEventId(),
						sequenceNum: firstSequenceNum + index,
						eventType,
						source,
						payload: input.payload,
					},
				});
				await tx.chatOperationLog.create({
					data: {
						sessionId,
						direction: "route_to_worker",
						category: eventType,
						eventId: row.eventId,
						payload: input.payload,
					},
				});
				rows.push(row);
			}
			if (Object.keys(metadata).length > 0) {
				await tx.chatSession.updateMany({
					where: { id: sessionId, deletedAt: null },
					data: {
						externalMetadata: mergeJsonObject(
							asJsonObject(session.externalMetadata),
							metadata,
						),
					},
				});
				await tx.chatOperationLog.create({
					data: {
						sessionId,
						direction: "route_to_worker",
						category: "session_metadata",
						payload: metadata,
					},
				});
			}
			return rows;
		});
		return created.map((row) => this.toClientEventDto(row));
	}

	/**
	 * 查询 client events。
	 * @param sessionId session ID
	 * @param fromSequence 起始序号
	 * @param limit 数量
	 * @returns events
	 */
	async listClientEvents(sessionId: string, fromSequence: number, limit = DEFAULT_PAGE_SIZE) {
		const rows = await this.prisma.chatClientEvent.findMany({
			where: { sessionId, sequenceNum: { gt: fromSequence } },
			orderBy: { sequenceNum: "asc" },
			take: Math.min(Math.max(limit, 1), 500),
		});
		return rows.map((row) => this.toClientEventDto(row));
	}

	/**
	 * 查询最新 client events，并保持返回顺序为从旧到新。
	 * @param sessionId session ID
	 * @param limit 数量
	 * @returns events
	 */
	async listRecentClientEvents(sessionId: string, limit = DEFAULT_PAGE_SIZE) {
		const rows = await this.prisma.chatClientEvent.findMany({
			where: { sessionId },
			orderBy: { sequenceNum: "desc" },
			take: Math.min(Math.max(limit, 1), 500),
		});
		return rows.reverse().map((row) => this.toClientEventDto(row));
	}

	/**
	 * 查询指定 sequence 之前的 client events，并保持返回顺序为从旧到新。
	 * @param sessionId session ID
	 * @param beforeSequence 当前已加载的最小 sequence
	 * @param limit 数量
	 * @returns events
	 */
	async listClientEventsBefore(
		sessionId: string,
		beforeSequence: number,
		limit = DEFAULT_PAGE_SIZE,
	) {
		const rows = await this.prisma.chatClientEvent.findMany({
			where: { sessionId, sequenceNum: { lt: beforeSequence } },
			orderBy: { sequenceNum: "desc" },
			take: Math.min(Math.max(limit, 1), 500),
		});
		return rows.reverse().map((row) => this.toClientEventDto(row));
	}

	/**
	 * 查找指定的工具权限申请。
	 * @param sessionId session ID
	 * @param requestId control request ID
	 * @returns can_use_tool 内层 request；不存在时返回 null
	 */
	async findToolPermissionRequest(sessionId: string, requestId: string): Promise<JsonObject | null> {
		const row = await this.prisma.chatWorkerEvent.findFirst({
			where: {
				sessionId,
				eventType: "control_request",
				// 只按 request_id 定位候选事件，避免边缘 Worker 全量拉取长会话 timeline。
				payload: { path: ["request_id"], equals: requestId },
			},
			orderBy: { id: "desc" },
			select: { payload: true },
		});
		const payload = row ? asJsonObject(row.payload) : {};
		const request = isJsonObject(payload.request) ? payload.request : {};
		if (
			payload.type === "control_request" &&
			getStringField(payload, "request_id") === requestId &&
			getStringField(request, "subtype") === "can_use_tool"
		) {
			return request;
		}
		return null;
	}

	/**
	 * 判断指定工具权限申请是否已经响应过。
	 * @param sessionId session ID
	 * @param requestId control request ID
	 * @returns 是否已有 control_response client event
	 */
	async hasToolPermissionResponse(sessionId: string, requestId: string): Promise<boolean> {
		const row = await this.prisma.chatClientEvent.findFirst({
			where: {
				sessionId,
				eventType: "control_response",
				// response.request_id 是 CCR control_response 和原 request 关联的稳定键。
				payload: { path: ["response", "request_id"], equals: requestId },
			},
			select: { id: true },
		});
		return Boolean(row);
	}

	/**
	 * 查询等待下发给 worker 的 client events。
	 * @param sessionId session ID
	 * @param fromSequence 起始序号
	 * @returns 尚未交付的 events；session 已删除时返回 null
	 */
	async listQueuedClientEvents(sessionId: string, fromSequence: number) {
		const rows = await this.prisma.chatClientEvent.findMany({
			where: {
				sessionId,
				session: { deletedAt: null },
				sequenceNum: { gt: fromSequence },
				// 新 worker 从 0 建立 SSE 时不能重放已交付输入，否则旧消息会被再次执行并入库。
				status: CLIENT_EVENT_STATUS_QUEUED,
			},
			orderBy: { sequenceNum: "asc" },
			take: DEFAULT_PAGE_SIZE,
		});
		if (rows.length === 0) {
			const session = await this.prisma.chatSession.findFirst({
				where: { id: sessionId, deletedAt: null },
				select: { id: true },
			});
			// SSE 长连接必须在 session 删除后主动结束，避免 worker 继续空轮询或收到旧事件。
			if (!session) {
				return null;
			}
		}
		return rows.map((row) => this.toClientEventDto(row));
	}

	/**
	 * 写入 worker visible events。
	 * @param sessionId session ID
	 * @param epoch worker epoch
	 * @param events worker events
	 * @returns 是否接受本次 worker 上报
	 */
	async insertWorkerEvents(
		sessionId: string,
		epoch: number,
		events: WorkerVisibleEvent[],
	): Promise<boolean> {
		return this.prisma.$transaction(async (tx) => {
			if (!(await this.claimActiveWorkerEpoch(tx, sessionId, epoch))) {
				return false;
			}
			for (const event of events) {
				const payload = asCcrPayload(event.payload);
				// keep_alive 只用于维持 worker 长连接，不进入业务事件表。
				if (isKeepAlivePayload(payload)) {
					continue;
				}
				const eventId = eventIdFromPayload(payload, newEventId);
				const eventType = String(payload.type ?? "unknown");
				if (isSystemInitPayload(payload)) {
					const existingSystemEvents = await tx.chatWorkerEvent.findMany({
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
				const created = await tx.chatWorkerEvent.createMany({
					data: {
						sessionId,
						eventId,
						workerEpoch: epoch,
						eventType,
						payload,
						ephemeral: Boolean(event.ephemeral),
					},
					// eventId 是 worker visible event 的幂等键；重复上报不应继续写 operation log。
					skipDuplicates: true,
				});
				if (created.count === 0) {
					continue;
				}
				await tx.chatOperationLog.create({
					data: {
						sessionId,
						direction: "worker_to_route",
						category: eventType,
						eventId,
						payload: toJsonValue(payload) ?? {},
					},
				});
			}
			return true;
		});
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
	 * @returns 是否接受本次 worker 上报
	 */
	async insertInternalEvents(
		sessionId: string,
		epoch: number,
		events: WorkerInternalEvent[],
	): Promise<boolean> {
		const accepted = await this.prisma.$transaction(async (tx) => {
			if (!(await this.claimActiveWorkerEpoch(tx, sessionId, epoch))) {
				return false;
			}
			for (const event of events) {
				const payload = asCcrPayload(event.payload);
				// keep_alive 没有审计价值，避免污染 internal event 历史。
				if (isKeepAlivePayload(payload)) {
					continue;
				}
				const eventId = eventIdFromPayload(payload, newEventId);
				const eventType = String(payload.type ?? "unknown");
				await tx.chatInternalEvent.createMany({
					data: {
						sessionId,
						eventId,
						workerEpoch: epoch,
						eventType,
						payload,
						eventMetadata: event.event_metadata ?? undefined,
						isCompaction: Boolean(event.is_compaction),
						agentId: event.agent_id ?? null,
					},
					// internal event 也以 eventId 做幂等，重复恢复不应触发无意义镜像重建。
					skipDuplicates: true,
				});
			}
			return true;
		});
		return accepted;
	}

	/**
	 * 查询指定范围内最后一次 compact 边界的数据库顺序 ID。
	 * @param sessionId session ID
	 * @param agentId 子 agent ID；null 表示 foreground
	 * @returns compact 边界之后才需要恢复的起始 ID
	 */
	private async findLastCompactionId(sessionId: string, agentId: string | null) {
		const row = await this.prisma.chatInternalEvent.findFirst({
			where: { sessionId, agentId, isCompaction: true },
			orderBy: { id: "desc" },
			select: { id: true },
		});
		return row?.id ?? 0;
	}

	/**
	 * 查询所有存在 internal events 的 subagent ID。
	 * @param sessionId session ID
	 * @returns subagent ID 列表
	 */
	private async listInternalEventAgentIds(sessionId: string) {
		const rows = await this.prisma.chatInternalEvent.findMany({
			where: { sessionId, agentId: { not: null } },
			select: { agentId: true },
			distinct: ["agentId"],
		});
		return rows
			.map((row) => row.agentId)
			.filter((agentId): agentId is string => typeof agentId === "string");
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
		const cursor = options.cursor ?? 0;
		const rows = options.subagents
			? await this.listSubagentInternalEventRows(sessionId, cursor, limit + 1)
			: await this.prisma.chatInternalEvent.findMany({
					where: {
						sessionId,
						id: {
							gt: restoreCursor(
								cursor,
								await this.findLastCompactionId(sessionId, null),
							),
						},
						agentId: null,
					},
					orderBy: { id: "asc" },
					take: limit + 1,
				});
		const pageRows = rows.slice(0, limit);
		return {
			data: pageRows.map((row) => ({
				event_id: row.eventId,
				event_type: row.eventType,
				payload: asJsonObject(row.payload),
				event_metadata: row.eventMetadata ? asJsonObject(row.eventMetadata) : null,
				is_compaction: row.isCompaction,
				created_at: row.createdAt.toISOString(),
				agent_id: row.agentId,
			})),
			next_cursor:
				rows.length > limit ? String(pageRows[pageRows.length - 1]?.id) : null,
		};
	}

	/**
	 * 查询 subagent internal events，并对每个 agent 单独应用 compact 边界。
	 * @param sessionId session ID
	 * @param cursor 全局分页游标
	 * @param take 查询数量
	 * @returns 已按服务端稳定顺序排序的事件行
	 */
	private async listSubagentInternalEventRows(
		sessionId: string,
		cursor: number,
		take: number,
	) {
		const agentIds = await this.listInternalEventAgentIds(sessionId);
		const rows = (
			await Promise.all(
				agentIds.map(async (agentId) => {
					const compactionId = await this.findLastCompactionId(sessionId, agentId);
					return this.prisma.chatInternalEvent.findMany({
						where: {
							sessionId,
							agentId,
							id: { gt: restoreCursor(cursor, compactionId) },
						},
						orderBy: { id: "asc" },
						take,
					});
				}),
			)
		)
			.flat()
			.sort((a, b) => a.id - b.id);
		return rows.slice(0, take);
	}

	/**
	 * 拉取有硬上限的 internal event 恢复窗口。
	 * @param sessionId session ID
	 * @param subagents 是否读取子 agent
	 * @returns 当前恢复窗口内的 internal events
	 */
	private async listBoundedInternalEventsForRestore(
		sessionId: string,
		subagents: boolean,
	): Promise<InternalEventRestoreWindow> {
		const events: InternalEventRestoreItem[] = [];
		let bytes = 0;
		let cursor: number | undefined;
		while (true) {
			const page = await this.listInternalEvents(sessionId, {
				subagents,
				cursor,
				limit: 500,
			});
			for (const event of page.data) {
				const eventBytes =
					internalEventRestoreTextEncoder.encode(JSON.stringify(event.payload)).byteLength + 1;
				if (
					events.length >= INTERNAL_EVENT_RESTORE_MAX_EVENTS ||
					bytes + eventBytes > INTERNAL_EVENT_RESTORE_MAX_BYTES
				) {
					return { events, truncated: true, bytes };
				}
				bytes += eventBytes;
				events.push(event);
			}
			if (!page.next_cursor) {
				return { events, truncated: false, bytes };
			}
			// next_cursor 是数据库顺序 ID，和 event_id 的幂等 UUID 语义不同。
			cursor = Number(page.next_cursor);
		}
	}

	/**
	 * 写入由 internal events 生成的 Claude sessionStore 镜像。
	 * @param sessionId session ID
	 * @param subpath sessionStore 相对路径
	 * @param content JSONL 内容
	 * @param metadata 镜像元数据
	 */
	private async writeClaudeSessionStoreMirrorFile(
		sessionId: string,
		subpath: string,
		content: string,
		metadata: JsonObject,
	) {
		const existing = await this.readSessionStoreFile(
			sessionId,
			CLAUDE_SESSION_STORE_PROJECT_KEY,
			subpath,
		);
		if (existing && existing.metadata?.source !== "ccr_internal_events") {
			// 直接 sessionStore 写入是恢复主源；internal events 镜像不能覆盖它。
			return;
		}
		await this.writeSessionStoreFile(
			sessionId,
			CLAUDE_SESSION_STORE_PROJECT_KEY,
			subpath,
			content,
			metadata,
		);
	}

	/**
	 * 将 internal events 镜像到 Claude Code Agent SDK sessionStore。
	 * @param sessionId session ID
	 */
	private async syncClaudeSessionStoreFromInternalEvents(sessionId: string) {
		const activeSession = await this.prisma.chatSession.findFirst({
			where: { id: sessionId, deletedAt: null },
			select: { id: true },
		});
		if (!activeSession) {
			return;
		}
		const foregroundWindow = await this.listBoundedInternalEventsForRestore(sessionId, false);
		const foregroundEvents = foregroundWindow.events;
		await this.writeClaudeSessionStoreMirrorFile(
			sessionId,
			foregroundTranscriptSubpath(sessionId),
			foregroundEvents.map((event) => JSON.stringify(event.payload)).join("\n") +
				(foregroundEvents.length > 0 ? "\n" : ""),
			{
				source: "ccr_internal_events",
				transcript_kind: "foreground",
				event_count: foregroundEvents.length,
				truncated: foregroundWindow.truncated,
				restore_bytes: foregroundWindow.bytes,
				restore_max_events: INTERNAL_EVENT_RESTORE_MAX_EVENTS,
				restore_max_bytes: INTERNAL_EVENT_RESTORE_MAX_BYTES,
			},
		);

		const subagentWindow = await this.listBoundedInternalEventsForRestore(sessionId, true);
		const subagentEvents = subagentWindow.events;
		const subpaths = new Set<string>();
		const eventsBySubpath = new Map<string, JsonObject[]>();
		for (const event of subagentEvents) {
			if (!event.agent_id) {
				continue;
			}
			const transcriptSubdir = readAgentTranscriptSubdir(event);
			const subpath = transcriptSubdir
				? `${sessionId}/subagents/${transcriptSubdir}/agent-${event.agent_id}.jsonl`
				: subagentTranscriptSubpath(sessionId, event.agent_id);
			const entries = eventsBySubpath.get(subpath) ?? [];
			entries.push(event.payload);
			eventsBySubpath.set(subpath, entries);
		}
		for (const [subpath, payloads] of eventsBySubpath) {
			subpaths.add(subpath);
			await this.writeClaudeSessionStoreMirrorFile(
				sessionId,
				subpath,
				payloads.map((payload) => JSON.stringify(payload)).join("\n") + "\n",
				{
					source: "ccr_internal_events",
					transcript_kind: "subagent",
					event_count: payloads.length,
					truncated: subagentWindow.truncated,
					restore_bytes: subagentWindow.bytes,
					restore_max_events: INTERNAL_EVENT_RESTORE_MAX_EVENTS,
					restore_max_bytes: INTERNAL_EVENT_RESTORE_MAX_BYTES,
				},
			);
		}
		for (const file of await this.listSessionStoreFiles(
			sessionId,
			CLAUDE_SESSION_STORE_PROJECT_KEY,
			subagentTranscriptPrefix(sessionId),
		)) {
			if (subpaths.has(file.subpath)) {
				continue;
			}
			const existing = await this.readSessionStoreFile(
				sessionId,
				CLAUDE_SESSION_STORE_PROJECT_KEY,
				file.subpath,
			);
			if (existing?.metadata?.source === "ccr_internal_events") {
				await this.deleteSessionStoreFile(
					sessionId,
					CLAUDE_SESSION_STORE_PROJECT_KEY,
					file.subpath,
				);
			}
		}
	}

	/**
	 * 旧会话缺少 Claude Code sessionStore 镜像时，从 internal events 回填一次。
	 * @param sessionId session ID
	 * @returns 是否发生了回填
	 */
	async ensureClaudeSessionStoreFromInternalEvents(sessionId: string): Promise<boolean> {
		const existingFiles = await this.listSessionStoreFiles(
			sessionId,
			CLAUDE_SESSION_STORE_PROJECT_KEY,
			sessionId,
		);
		if (existingFiles.length > 0) {
			return false;
		}
		const existingEvent = await this.prisma.chatInternalEvent.findFirst({
			where: { sessionId },
			select: { id: true },
		});
		if (!existingEvent) {
			return false;
		}
		await this.syncClaudeSessionStoreFromInternalEvents(sessionId);
		return true;
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
	 * 查询最新 chat timeline，并保持返回顺序为从旧到新。
	 * @param sessionId session ID
	 * @param limit 数量
	 * @returns timeline events
	 */
	async listRecentChatTimeline(sessionId: string, limit = 200) {
		const rows = await this.prisma.chatWorkerEvent.findMany({
			where: { sessionId },
			orderBy: { id: "desc" },
			take: Math.min(Math.max(limit, 1), 500),
		});
		return rows.reverse().map((row) => ({
			id: row.id,
			event_id: row.eventId,
			event_type: row.eventType,
			payload: asJsonObject(row.payload),
			ephemeral: row.ephemeral,
			created_at: row.createdAt.toISOString(),
		}));
	}

	/**
	 * 查询指定 timeline ID 之前的 chat timeline，并保持返回顺序为从旧到新。
	 * @param sessionId session ID
	 * @param beforeId 当前已加载的最小 timeline ID
	 * @param limit 数量
	 * @returns timeline events
	 */
	async listChatTimelineBefore(sessionId: string, beforeId: number, limit = 200) {
		const rows = await this.prisma.chatWorkerEvent.findMany({
			where: { sessionId, id: { lt: beforeId } },
			orderBy: { id: "desc" },
			take: Math.min(Math.max(limit, 1), 500),
		});
		return rows.reverse().map((row) => ({
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
	 * @returns 是否接受本次 worker 上报
	 */
	async insertDeliveryUpdates(
		sessionId: string,
		epoch: number,
		updates: Array<{ event_id: string; status: string }>,
	): Promise<boolean> {
		return this.prisma.$transaction(async (tx) => {
			if (!(await this.claimActiveWorkerEpoch(tx, sessionId, epoch))) {
				return false;
			}
			for (const update of updates) {
				if (!update.event_id) {
					continue;
				}
				const event = await tx.chatClientEvent.findFirst({
					where: { sessionId, eventId: update.event_id },
					select: { status: true },
				});
				// delivery 是 client event 的状态转移；找不到原事件时不写孤儿审计行。
				if (!event) {
					continue;
				}
				const nextStatus = mergeClientEventDeliveryStatus(event.status, update.status);
				if (!nextStatus) {
					continue;
				}
				if (nextStatus !== event.status) {
					await tx.chatClientEvent.updateMany({
						where: { sessionId, eventId: update.event_id },
						data: { status: nextStatus },
					});
				}
				await tx.chatDeliveryUpdate.create({
					data: {
						sessionId,
						eventId: update.event_id,
						status: nextStatus,
						workerEpoch: epoch,
					},
				});
			}
			return true;
		});
	}

	/**
	 * 记录 heartbeat。
	 * @param sessionId session ID
	 * @param epoch worker epoch
	 * @returns 是否接受本次 heartbeat
	 */
	async recordHeartbeat(sessionId: string, epoch: number): Promise<boolean> {
		const result = await this.prisma.chatSession.updateMany({
			where: { id: sessionId, workerEpoch: epoch, deletedAt: null },
			data: { lastHeartbeatAt: new Date() },
		});
		return result.count > 0;
	}

	/**
	 * 仅更新活跃 session 的容器状态。
	 * @param sessionId session ID
	 * @param data 状态字段
	 */
	async updateActiveContainer(
		sessionId: string,
		data: {
			workerStatus?: string;
			containerStatus?: string;
			sandboxId?: string | null;
			runnerProcessId?: string | null;
		},
	) {
		const result = await this.prisma.chatSession.updateMany({
			where: { id: sessionId, deletedAt: null },
			data,
		});
		if (result.count === 0) {
			throw new Error("Session not found or deleting");
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
		const result = await this.prisma.chatSession.updateMany({
			where: { id: sessionId, deletedAt: null },
			data: {
				containerStatus: "running",
				sandboxId,
				runnerProcessId,
			},
		});
		if (result.count === 0) {
			throw new Error("Session not found or deleting");
		}
	}

	/**
	 * 清理 session runner 进程记录。
	 * @param sessionId session ID
	 */
	async clearSessionRunner(sessionId: string) {
		await this.updateActiveContainer(sessionId, {
			workerStatus: "idle",
			containerStatus: "stopped",
			runnerProcessId: null,
		});
	}

	/**
	 * 清理已删除 session 的 runner 进程记录。
	 * @param sessionId session ID
	 */
	async clearDeletedSessionRunner(sessionId: string) {
		await this.prisma.chatSession.updateMany({
			where: { id: sessionId, deletedAt: { not: null } },
			// 删除态保持 deleting 语义，只清掉已不存在的进程 ID。
			data: { runnerProcessId: null },
		});
	}

	/**
	 * 清理用户级容器销毁后遗留的 session runner 状态。
	 * @param userId 用户 ID
	 * @param sandboxId 被停止的 sandbox ID
	 * @returns 被清理的 session 数量
	 */
	async clearUserContainerSessionRunners(userId: string, sandboxId: string) {
		const result = await this.prisma.chatSession.updateMany({
			where: {
				userId,
				deletedAt: null,
				sandboxId,
				OR: [
					{ runnerProcessId: { not: null } },
					{ containerStatus: { in: ["starting", "running"] } },
				],
			},
			data: {
				workerStatus: "idle",
				containerStatus: "stopped",
				sandboxId: null,
				runnerProcessId: null,
			},
		});
		return result.count;
	}

	/**
	 * 读取已存在的 session 摘要，不创建新 session。
	 * @param sessionId session ID
	 * @returns session；不存在时返回 null
	 */
	async findSessionSummary(sessionId: string) {
		return this.prisma.chatSession.findUnique({
			where: { id: sessionId },
			select: chatSessionSummarySelect,
		});
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
			select: chatSessionSummarySelect,
		});
	}

	/**
	 * 写入 sessionStore 文件。
	 * @param sessionId session ID
	 * @param projectKey sessionStore project key
	 * @param subpath 文件相对路径
	 * @param content 文件内容
	 * @param metadata 附加元数据
	 * @returns 写入后的文件；session 非活跃时返回 null
	 */
	async writeSessionStoreFile(
		sessionId: string,
		projectKey: string,
		subpath: string,
		content: string,
		metadata?: JsonObject,
	) {
		return this.prisma.$transaction(async (tx) => {
			if (!(await this.claimActiveSession(tx, sessionId))) {
				return null;
			}
			return tx.chatSessionStoreFile.upsert({
				where: { sessionId_projectKey_subpath: { sessionId, projectKey, subpath } },
				create: { sessionId, projectKey, subpath, content, metadata },
				update: { content, metadata },
			});
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
	 * @param sessionId session ID
	 * @param projectKey sessionStore project key
	 * @param subpath 文件相对路径
	 * @returns 是否删除了文件；session 非活跃时返回 false
	 */
	async deleteSessionStoreFile(
		sessionId: string,
		projectKey: string,
		subpath: string,
	) {
		return this.prisma.$transaction(async (tx) => {
			if (!(await this.claimActiveSession(tx, sessionId))) {
				return false;
			}
			const result = await tx.chatSessionStoreFile.deleteMany({
				where: { sessionId, projectKey, subpath },
			});
			return result.count > 0;
		});
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
