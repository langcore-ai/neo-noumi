import { Sandbox } from "@cloudflare/sandbox";
import type { OutboundHandlerContext } from "@cloudflare/containers";
import { CLAUDE_SESSION_STORE_PROJECT_KEY, type CcrStore } from "./ccr-store";
import { isJsonObject, toJsonValue, type JsonObject } from "./json";
import { CCR_SDK_APPROVED_HOST } from "./ccr-protocol";
import { buildUserContainerId } from "./container-identity";
import {
	destroyUserContainerSandbox,
	getUserContainer,
} from "./container-sandbox";
import {
	ANTHROPIC_API_HOST,
	proxyAnthropicApiRequest,
	type AiProxyBindings,
} from "./ccr-ai-proxy";
import { createPrismaClient } from "./prisma";
import {
	buildProjectWorkspaceMountPrefix,
	buildProjectWorkspaceMountPath,
	shouldSkipWorkspaceMount,
} from "./project-workspace-mount";
import { buildClaudeProjectStateDir } from "./ccr-claude-state";

/** Sandbox 内 CCR runner 脚本路径 */
const RUNNER_PATH = "/tmp/neo-noumi/ccr-runner.sh";

/** Sandbox 内敏感环境变量文件路径 */
const ENV_PATH = "/tmp/neo-noumi/ccr-env.sh";

/** Sandbox 内 CCR runner 日志路径，避免写入用户 workspace。 */
const RUNNER_LOG_PATH = "/tmp/neo-noumi/ccr-runner.log";

/** Sandbox 内观测服务的虚拟上报 host，由 Worker outbound handler 接收。 */
const SANDBOX_OBSERVABILITY_HOST = "neo-noumi-observability.internal";

/** 旧版 /workspace cwd 对应的 Claude Code 项目状态目录。 */
const CLAUDE_LEGACY_PROJECT_STATE_DIR = "/root/.claude/projects/-workspace";

/** Claude Code 本地 transcript 文件路径。 */
const claudeTranscriptPath = (projectStateDir: string, sessionId: string) =>
	`${projectStateDir}/${sessionId}.jsonl`;

/** Claude Code sessionStore 文件在容器内的恢复路径。 */
const claudeSessionStorePath = (projectStateDir: string, subpath: string) =>
	`${projectStateDir}/${subpath}`;

/** 启动前恢复 internal events 的分页大小。 */
const TRANSCRIPT_RESTORE_PAGE_SIZE = 500;

/** Claude Code runner 启动默认模型；真实业务模型由前端 set_model control_request 决定。 */
const CLAUDE_RUNNER_BOOT_MODEL = "claude-sonnet-4-6";

/** Sandbox 观测事件类型白名单。 */
const SANDBOX_OBSERVATION_EVENT_TYPES = new Set([
	"startup",
	"heartbeat",
	"resource",
	"signal",
	"shutdown",
	"error",
]);

/** CCR sandbox 启动日志基础字段。 */
type CcrSandboxStartupLogContext = {
	/** 登录用户 ID。 */
	userId: string;
	/** CCR session ID。 */
	sessionId: string;
	/** 用户级 sandbox ID。 */
	sandboxId: string;
};

/** Project workspace 挂载信息。 */
type ProjectWorkspaceMount = {
	/** 容器内挂载路径 */
	mountPath: string;
	/** 当前启动是否执行了新的挂载 */
	mounted: boolean;
	/** Project ID，也是 R2 prefix 的第一段 */
	projectId: string;
	/** 用户可见 project 名称 */
	projectName: string;
};

/**
 * 将错误收敛成可安全打到日志里的对象。
 * @param error 捕获到的错误
 * @returns 日志可序列化错误
 */
function serializeLogError(error: unknown) {
	if (error instanceof Error) {
		return {
			name: error.name,
			message: error.message,
			stack: error.stack,
		};
	}
	return { message: String(error) };
}

/**
 * 输出 CCR sandbox 启动结构化日志。
 * @param level 日志级别
 * @param phase 启动阶段
 * @param context 启动上下文
 * @param details 额外字段
 */
function logCcrSandboxStartup(
	level: "info" | "warn" | "error",
	phase: string,
	context: CcrSandboxStartupLogContext,
	details: Record<string, unknown> = {},
) {
	console[level]({
		component: "ccr-sandbox",
		event: "ccr.sandbox.startup",
		phase,
		...context,
		...details,
	});
}

/**
 * 包装启动阶段并记录耗时与失败原因。
 * @param phase 阶段名称
 * @param context 启动上下文
 * @param task 阶段任务
 * @returns 阶段返回值
 */
async function runStartupStep<T>(
	phase: string,
	context: CcrSandboxStartupLogContext,
	task: () => Promise<T>,
): Promise<T> {
	const startedAt = Date.now();
	logCcrSandboxStartup("info", `${phase}.begin`, context);
	try {
		const result = await task();
		logCcrSandboxStartup("info", `${phase}.ok`, context, {
			durationMs: Date.now() - startedAt,
		});
		return result;
	} catch (error) {
		logCcrSandboxStartup("error", `${phase}.error`, context, {
			durationMs: Date.now() - startedAt,
			error: serializeLogError(error),
		});
		throw error;
	}
}

/** Neo Noumi sandbox Worker 绑定 */
export interface NeoNoumiSandboxBindings extends AiProxyBindings {
	/** Sandbox Durable Object binding */
	NEO_NOUMI_SANDBOX: DurableObjectNamespace<NeoNoumiSandbox>;
	/** 当前 Worker 对外 base URL */
	NEO_NOUMI_PUBLIC_BASE_URL?: string;
	/** 旧版公网地址变量；仅用于部署过渡兼容。 */
	CCR_PUBLIC_BASE_URL?: string;
	/** 是否启用真实 Claude Code CLI 执行；未开启时使用 fallback 验证链路 */
	NEO_NOUMI_ENABLE_REAL_CLAUDE?: string;
	/** 旧版真实执行开关；仅用于部署过渡兼容。 */
	CCR_ENABLE_REAL_CLAUDE?: string;
	/** Claude Code API Key；仅由 Worker AI Proxy 转发时读取，不会注入 sandbox。 */
	ANTHROPIC_API_KEY?: string;
	/** Anthropic 兼容 API base URL；仅由 Worker AI Proxy 转发时读取。 */
	ANTHROPIC_BASE_URL?: string;
	/** AI Proxy fallback credential 使用的鉴权头类型。 */
	AI_PROXY_AUTH_HEADER?: string;
	/** 用户级 AI Proxy credential 加密密钥。 */
	AI_PROXY_CREDENTIAL_SECRET?: string;
	/** Cloudflare 账号 ID，用于 Sandbox s3fs 挂载 R2。 */
	R2_ACCOUNT_ID?: string;
	/** R2 S3 API access key ID，用于 Sandbox s3fs 挂载。 */
	R2_ACCESS_KEY_ID?: string;
	/** R2 S3 API secret access key，用于 Sandbox s3fs 挂载。 */
	R2_SECRET_ACCESS_KEY?: string;
	/** Project workspace R2 bucket 名称，用于 Sandbox s3fs 挂载。 */
	PROJECT_WORKSPACE_BUCKET_NAME?: string;
	/** 本地开发禁用 R2/s3fs workspace 挂载，避免 Docker 缺少 /dev/fuse 阻断 chat 链路。 */
	NEO_NOUMI_DISABLE_WORKSPACE_MOUNT?: string;
}

/** Cloudflare Sandbox，用于运行 Neo Noumi chat worker。 */
export class NeoNoumiSandbox extends Sandbox {
	/** 容器空闲 3 分钟后进入休眠，降低旧 runner 和挂载资源占用。 */
	sleepAfter = "3m";
	/** 默认允许普通出站请求；只有 outboundByHost 命中的少数 host 会被 Worker 接管。 */
	enableInternet = true;
	interceptHttps = true;
}

/**
 * 读取 Worker 可用的 PostgreSQL 连接串。
 * @param env Worker 绑定
 * @returns PostgreSQL 连接串
 */
function getDatabaseUrl(env: NeoNoumiSandboxBindings): string {
	const databaseUrl = env.HYPERDRIVE?.connectionString ?? env.DATABASE_URL;
	if (!databaseUrl) {
		throw new Error("DATABASE_URL or HYPERDRIVE.connectionString is required");
	}
	return databaseUrl;
}

/**
 * 从观测事件 payload 中读取用户级 sandbox ID。
 * @param payload 观测事件 payload
 * @param fallback 无法读取时使用的容器运行时 ID
 * @returns sandbox ID
 */
function readObservedSandboxId(payload: JsonObject, fallback: string): string {
	const sandboxId = payload.sandbox_id;
	return typeof sandboxId === "string" && sandboxId.length > 0
		? sandboxId
		: fallback;
}

/**
 * 写入 sandbox 观测事件。
 * @param request 容器内观测进程发出的请求
 * @param env Worker 绑定
 * @param context outbound handler 上下文
 * @returns 写入结果响应
 */
async function recordSandboxObservation(
	request: Request,
	env: NeoNoumiSandboxBindings,
	context: OutboundHandlerContext,
): Promise<Response> {
	if (request.method !== "POST") {
		console.warn({
			component: "ccr-sandbox",
			event: "sandbox.observation.rejected",
			reason: "method_not_allowed",
			method: request.method,
			containerId: context.containerId,
			className: context.className,
		});
		return new Response("Method Not Allowed", { status: 405 });
	}
	const url = new URL(request.url);
	if (url.pathname !== "/events") {
		console.warn({
			component: "ccr-sandbox",
			event: "sandbox.observation.rejected",
			reason: "path_not_found",
			pathname: url.pathname,
			containerId: context.containerId,
			className: context.className,
		});
		return new Response("Not Found", { status: 404 });
	}
	const input = await request.json().catch(() => null);
	if (!isJsonObject(input)) {
		console.warn({
			component: "ccr-sandbox",
			event: "sandbox.observation.rejected",
			reason: "invalid_payload",
			containerId: context.containerId,
			className: context.className,
		});
		return Response.json({ error: "Invalid observation payload" }, { status: 400 });
	}
	const eventType = typeof input.eventType === "string" ? input.eventType : "";
	if (!SANDBOX_OBSERVATION_EVENT_TYPES.has(eventType)) {
		console.warn({
			component: "ccr-sandbox",
			event: "sandbox.observation.rejected",
			reason: "invalid_event_type",
			eventType,
			containerId: context.containerId,
			className: context.className,
		});
		return Response.json({ error: "Invalid observation event type" }, { status: 400 });
	}
	const payload = isJsonObject(input.payload) ? input.payload : {};
	const observedAt =
		typeof input.observedAt === "string" ? new Date(input.observedAt) : new Date();
	const sequence =
		typeof input.sequence === "number" && Number.isInteger(input.sequence)
			? input.sequence
			: null;
	const sandboxId = readObservedSandboxId(payload, context.containerId);
	const prisma = createPrismaClient(getDatabaseUrl(env));
	try {
		await prisma.sandboxObservationEvent.create({
			data: {
				sandboxId,
				containerId: context.containerId,
				eventType,
				sequence,
				observedAt: Number.isNaN(observedAt.getTime()) ? new Date() : observedAt,
				payload: toJsonValue(payload) ?? {},
			},
		});
	} catch (error) {
		console.error({
			component: "ccr-sandbox",
			event: "sandbox.observation.persist_failed",
			sandboxId,
			containerId: context.containerId,
			className: context.className,
			eventType,
			sequence,
			error: serializeLogError(error),
		});
		throw error;
	}
	console.info({
		component: "ccr-sandbox",
		event: "sandbox.observation.persisted",
		sandboxId,
		containerId: context.containerId,
		className: context.className,
		eventType,
		sequence,
	});
	return Response.json({ ok: true });
}

NeoNoumiSandbox.outboundByHost = {
	[SANDBOX_OBSERVABILITY_HOST]: async (
		request: Request,
		env: Env,
		context: OutboundHandlerContext,
	) => {
		console.info({
			component: "ccr-sandbox",
			event: "sandbox.outbound.hit",
			host: SANDBOX_OBSERVABILITY_HOST,
			pathname: new URL(request.url).pathname,
			containerId: context.containerId,
			className: context.className,
		});
		return recordSandboxObservation(
			request,
			env as Env & NeoNoumiSandboxBindings,
			context,
		);
	},
	[CCR_SDK_APPROVED_HOST]: async (request: Request, env: Env) => {
		// Claude Code 请求 approved host，Worker 内部重写回本服务的 CCR routes
		const url = new URL(request.url);
		const neoNoumiEnv = env as Env & {
			NEO_NOUMI_PUBLIC_BASE_URL?: string;
			CCR_PUBLIC_BASE_URL?: string;
		};
		const baseUrl =
			typeof neoNoumiEnv.NEO_NOUMI_PUBLIC_BASE_URL === "string"
				? neoNoumiEnv.NEO_NOUMI_PUBLIC_BASE_URL
				: typeof neoNoumiEnv.CCR_PUBLIC_BASE_URL === "string"
					? neoNoumiEnv.CCR_PUBLIC_BASE_URL
				: url.origin;
		const target = new URL(url.pathname + url.search, baseUrl);
		console.info({
			component: "ccr-sandbox",
			event: "sandbox.outbound.hit",
			host: CCR_SDK_APPROVED_HOST,
			pathname: url.pathname,
			targetPathname: target.pathname,
		});
		const response = await fetch(new Request(target, request));
		console.info({
			component: "ccr-sandbox",
			event: "sandbox.outbound.response",
			host: CCR_SDK_APPROVED_HOST,
			pathname: url.pathname,
			status: response.status,
		});
		return response;
	},
	[ANTHROPIC_API_HOST]: async (request: Request, env: Env) => {
		const url = new URL(request.url);
		console.info({
			component: "ccr-sandbox",
			event: "sandbox.outbound.hit",
			host: ANTHROPIC_API_HOST,
			pathname: url.pathname,
		});
		const response = await proxyAnthropicApiRequest(request, env as Env & AiProxyBindings);
		console.info({
			component: "ccr-sandbox",
			event: "sandbox.outbound.response",
			host: ANTHROPIC_API_HOST,
			pathname: url.pathname,
			status: response.status,
		});
		return response;
	},
};

/**
 * 生成 sandbox runner 脚本。
 * @returns shell 脚本
 */
function buildRunnerScript(): string {
	return `#!/bin/sh
set -eu

SESSION_ID="$1"
WORKER_ACCESS_TOKEN="$2"
AI_PROXY_TOKEN="$3"
CLAUDE_SESSION_MODE="\${4:-new}"
WORKSPACE_DIR="\${5:-/workspace}"
SDK_URL="https://${CCR_SDK_APPROVED_HOST}/v1/code/sessions/$SESSION_ID"
AUTH_HEADER="Authorization: Bearer $WORKER_ACCESS_TOKEN"

REGISTER_JSON="$(curl -fsS -X POST "$SDK_URL/worker/register" -H "$AUTH_HEADER" -H 'content-type: application/json' --data '{}')"
WORKER_EPOCH="$(node -e "const input=process.argv[1]; console.log(JSON.parse(input).worker_epoch)" "$REGISTER_JSON")"

export CLAUDE_CODE_ENVIRONMENT_KIND=bridge
export CLAUDE_CODE_USE_CCR_V2=1
export CLAUDE_CODE_WORKER_EPOCH="$WORKER_EPOCH"
export CLAUDE_CODE_SESSION_ACCESS_TOKEN="$WORKER_ACCESS_TOKEN"
export CLAUDE_CODE_POST_FOR_SESSION_INGRESS_V2=1
export NODE_EXTRA_CA_CERTS=/etc/cloudflare/certs/cloudflare-containers-ca.crt
export CURL_CA_BUNDLE=/etc/cloudflare/certs/cloudflare-containers-ca.crt
export SSL_CERT_FILE=/etc/cloudflare/certs/cloudflare-containers-ca.crt
export ANTHROPIC_BASE_URL="https://${ANTHROPIC_API_HOST}"
export ANTHROPIC_API_KEY="$AI_PROXY_TOKEN"

cd "$WORKSPACE_DIR"

if [ "\${NEO_NOUMI_ENABLE_REAL_CLAUDE:-0}" = "1" ] && command -v claude >/dev/null 2>&1; then
  CLAUDE_SESSION_ARG="--session-id"
  if [ "$CLAUDE_SESSION_MODE" = "resume" ]; then
    CLAUDE_SESSION_ARG="--resume"
  fi
  exec claude --print \
    --sdk-url "https://${CCR_SDK_APPROVED_HOST}/v1/code/sessions/$SESSION_ID" \
    "$CLAUDE_SESSION_ARG" "$SESSION_ID" \
    --model "${CLAUDE_RUNNER_BOOT_MODEL}" \
    --input-format stream-json \
    --output-format stream-json \
    --replay-user-messages \
    --verbose
fi

curl -fsS -X PUT "$SDK_URL/worker" \
  -H "$AUTH_HEADER" \
  -H 'content-type: application/json' \
  --data '{"worker_epoch":'"$WORKER_EPOCH"',"worker_status":"running","external_metadata":{"runner":"sandbox-fallback"}}'

curl -fsS -X POST "$SDK_URL/worker/events" \
  -H "$AUTH_HEADER" \
  -H 'content-type: application/json' \
  --data '{"worker_epoch":'"$WORKER_EPOCH"',"events":[{"payload":{"type":"assistant","uuid":"'"$(cat /proc/sys/kernel/random/uuid)"'","message":{"role":"assistant","content":"Sandbox runner is ready. Set NEO_NOUMI_ENABLE_REAL_CLAUDE=1 and provide Claude credentials to enable real execution."}}},{"payload":{"type":"result","uuid":"'"$(cat /proc/sys/kernel/random/uuid)"'","subtype":"success","is_error":false,"result":"sandbox-fallback-ready"}}]}'

curl -fsS -X PUT "$SDK_URL/worker" \
  -H "$AUTH_HEADER" \
  -H 'content-type: application/json' \
  --data '{"worker_epoch":'"$WORKER_EPOCH"',"worker_status":"idle","external_metadata":{"runner":"sandbox-fallback"}}'
`;
}

/**
 * 生成安全的 shell 单引号参数。
 * @param value 原始环境变量值
 * @returns 可直接拼入 shell 命令的字符串
 */
function shellQuote(value: string | undefined): string {
	if (!value) {
		return "''";
	}
	return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * 读取 POSIX 路径的父目录。
 * @param filePath 文件路径
 * @returns 父目录
 */
function dirname(filePath: string): string {
	const index = filePath.lastIndexOf("/");
	return index > 0 ? filePath.slice(0, index) : "/";
}

/**
 * 判断 sessionStore 相对路径是否允许写入 Claude 项目状态目录。
 * @param sessionId session ID
 * @param subpath sessionStore 相对路径
 * @returns 是否安全
 */
function isSafeSessionStoreSubpath(sessionId: string, subpath: string): boolean {
	return (
		(subpath === `${sessionId}.jsonl` ||
			subpath.startsWith(`${sessionId}/subagents/`)) &&
		!subpath.includes("..") &&
		!subpath.startsWith("/")
	);
}

/**
 * 判断 sessionStore 文件是否是 foreground transcript。
 * @param sessionId session ID
 * @param subpath sessionStore 相对路径
 * @returns 是否为 foreground transcript
 */
function isForegroundTranscriptSubpath(sessionId: string, subpath: string): boolean {
	return subpath === `${sessionId}.jsonl`;
}

/**
 * 从 sessionStore JSONL 内容中恢复 transcript payload。
 * @param content JSONL 内容
 * @returns 可用于恢复 memory 的 payload 列表
 */
function parseSessionStorePayloads(content: string): JsonObject[] {
	const payloads: JsonObject[] = [];
	for (const line of content.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) {
			continue;
		}
		try {
			const parsed = JSON.parse(trimmed) as unknown;
			if (isJsonObject(parsed)) {
				payloads.push(parsed);
			}
		} catch {
			// sessionStore 可能被外部适配器写入非 JSONL 内容，跳过坏行保留启动能力。
		}
	}
	return payloads;
}

/** Claude memory 写入意图。 */
type MemoryWriteIntent = {
	/** tool_use ID，用于和 tool_result 对齐 */
	toolUseId: string;
	/** memory 文件路径 */
	filePath: string;
	/** 待写入内容 */
	content: string;
};

/** Claude 本次启动应使用的会话模式。 */
type ClaudeSessionMode = "new" | "resume";

/** Claude 本地状态恢复结果。 */
type ClaudeLocalStateRestoreResult = {
	/** 启动 CLI 时应使用的会话模式 */
	sessionMode: ClaudeSessionMode;
	/** 本次恢复到本地的 transcript 事件数 */
	transcriptEvents: number;
};

/**
 * 从 assistant payload 中提取 Claude memory 写入意图。
 * @param payload internal event payload
 * @returns 待 tool_result 确认的 memory 写入
 */
function extractMemoryWriteIntents(
	payload: JsonObject,
	projectStateDir: string,
): MemoryWriteIntent[] {
	const message = isJsonObject(payload.message) ? payload.message : {};
	const content = Array.isArray(message.content) ? message.content : [];
	const writes: MemoryWriteIntent[] = [];
	for (const block of content) {
		if (!isJsonObject(block) || block.type !== "tool_use" || block.name !== "Write") {
			continue;
		}
		const toolUseId = typeof block.id === "string" ? block.id : "";
		const input = isJsonObject(block.input) ? block.input : {};
		const filePath = typeof input.file_path === "string" ? input.file_path : "";
		const fileContent = typeof input.content === "string" ? input.content : undefined;
		if (
			toolUseId &&
			fileContent !== undefined &&
			(filePath.startsWith(`${projectStateDir}/memory/`) ||
				filePath.startsWith(`${CLAUDE_LEGACY_PROJECT_STATE_DIR}/memory/`))
		) {
			const normalizedPath = filePath.startsWith(
				`${CLAUDE_LEGACY_PROJECT_STATE_DIR}/memory/`,
			)
				? `${projectStateDir}${filePath.slice(CLAUDE_LEGACY_PROJECT_STATE_DIR.length)}`
				: filePath;
			writes.push({ toolUseId, filePath: normalizedPath, content: fileContent });
		}
	}
	return writes;
}

/**
 * 从 user payload 中提取已成功完成的 tool_use ID。
 * @param payload internal event payload
 * @returns 成功执行的 tool_use ID 列表
 */
function extractSuccessfulToolResultIds(payload: JsonObject): string[] {
	const message = isJsonObject(payload.message) ? payload.message : {};
	const content = Array.isArray(message.content) ? message.content : [];
	return content
		.filter((block) => {
			return (
				isJsonObject(block) &&
				block.type === "tool_result" &&
				typeof block.tool_use_id === "string" &&
				block.is_error !== true
			);
		})
		.map((block) => String((block as JsonObject).tool_use_id));
}

/**
 * 拉取 foreground internal events，并保持服务端入库顺序。
 * @param store CCR store
 * @param sessionId session ID
 * @returns internal event payload 列表
 */
async function listForegroundInternalPayloads(
	store: CcrStore,
	sessionId: string,
): Promise<JsonObject[]> {
	const payloads: JsonObject[] = [];
	let cursor: number | undefined;
	while (true) {
		const page = await store.listInternalEvents(sessionId, {
			subagents: false,
			cursor,
			limit: TRANSCRIPT_RESTORE_PAGE_SIZE,
		});
		payloads.push(...page.data.map((event) => event.payload));
		if (!page.next_cursor) {
			return payloads;
		}
		// next_cursor 是服务端稳定顺序字段，不是 internal event UUID。
		cursor = Number(page.next_cursor);
	}
}

/**
 * 恢复 Claude Code 依赖的容器本地状态。
 * @param sandbox sandbox client
 * @param store CCR store
 * @param sessionId session ID
 */
async function restoreClaudeLocalState(
	sandbox: ReturnType<typeof getCcrSandbox>,
	store: CcrStore,
	sessionId: string,
	workspacePath: string,
): Promise<ClaudeLocalStateRestoreResult> {
	const projectStateDir = buildClaudeProjectStateDir(workspacePath);
	let sessionStoreFiles = await store.listSessionStoreFiles(
		sessionId,
		CLAUDE_SESSION_STORE_PROJECT_KEY,
		sessionId,
	);
	if (sessionStoreFiles.length === 0) {
		// 旧会话没有 Claude sessionStore 镜像时，先从 internal events 回填一次。
		await store.ensureClaudeSessionStoreFromInternalEvents(sessionId);
		sessionStoreFiles = await store.listSessionStoreFiles(
			sessionId,
			CLAUDE_SESSION_STORE_PROJECT_KEY,
			sessionId,
		);
	}
	let transcriptPayloads: JsonObject[] = [];
	const memoryPayloads: JsonObject[] = [];
	let hasForegroundSessionStore = false;
	const pendingMemoryWrites = new Map<string, MemoryWriteIntent>();
	const memoryFiles = new Map<string, string>();
	let restoredSessionStoreFiles = 0;
	for (const file of sessionStoreFiles) {
		if (!isSafeSessionStoreSubpath(sessionId, file.subpath)) {
			continue;
		}
		const storedFile = await store.readSessionStoreFile(
			sessionId,
			CLAUDE_SESSION_STORE_PROJECT_KEY,
			file.subpath,
		);
		if (!storedFile) {
			continue;
		}
		const targetPath = claudeSessionStorePath(projectStateDir, file.subpath);
		// sessionStore 中保存的是 Claude Code 原生 JSONL，启动前要恢复为本地副本。
		await sandbox.exec(`mkdir -p ${shellQuote(dirname(targetPath))}`);
		await sandbox.writeFile(targetPath, storedFile.content);
		restoredSessionStoreFiles += 1;
		const parsedPayloads = parseSessionStorePayloads(storedFile.content);
		memoryPayloads.push(...parsedPayloads);
		if (isForegroundTranscriptSubpath(sessionId, file.subpath)) {
			// foreground sessionStore 是恢复主源，存在时不再用 internal events 覆盖。
			hasForegroundSessionStore = true;
			transcriptPayloads = parsedPayloads;
		}
	}
	if (!hasForegroundSessionStore) {
		transcriptPayloads = await listForegroundInternalPayloads(store, sessionId);
		// foreground 缺失时补 internal events；已恢复的 subagent sessionStore 仍参与 memory 推导。
		memoryPayloads.push(...transcriptPayloads);
	}
	for (const payload of memoryPayloads) {
		for (const memoryWrite of extractMemoryWriteIntents(payload, projectStateDir)) {
			pendingMemoryWrites.set(memoryWrite.toolUseId, memoryWrite);
		}
		for (const toolUseId of extractSuccessfulToolResultIds(payload)) {
			const memoryWrite = pendingMemoryWrites.get(toolUseId);
			if (!memoryWrite) {
				continue;
			}
			// 只有执行成功的 Write 才能恢复；同一路径以后写入为准。
			memoryFiles.set(memoryWrite.filePath, memoryWrite.content);
			pendingMemoryWrites.delete(toolUseId);
		}
	}

	await sandbox.exec(
		`mkdir -p ${shellQuote(projectStateDir)} ${shellQuote(
			`${projectStateDir}/memory`,
		)}`,
	);
	if (!hasForegroundSessionStore && transcriptPayloads.length > 0) {
		// 只有没有 foreground sessionStore 时，才用 internal events 兜底生成本地 transcript。
		await sandbox.writeFile(
			claudeTranscriptPath(projectStateDir, sessionId),
			`${transcriptPayloads.map((payload) => JSON.stringify(payload)).join("\n")}\n`,
		);
	}
	for (const [filePath, content] of memoryFiles) {
		await sandbox.exec(`mkdir -p ${shellQuote(dirname(filePath))}`);
		await sandbox.writeFile(filePath, content);
	}
	await store.recordOperation(sessionId, {
		direction: "route_internal",
		category: "sandbox_state_restored",
		payload: {
			transcript_events: transcriptPayloads.length,
			session_store_files: restoredSessionStoreFiles,
			memory_files: memoryFiles.size,
			project_state_dir: projectStateDir,
		},
	});
	return {
		// 有历史 transcript 才进入 Claude Code resume 分支；新会话首轮仍使用 --session-id。
		sessionMode: transcriptPayloads.length > 0 ? "resume" : "new",
		transcriptEvents: transcriptPayloads.length,
	};
}

/**
 * 生成 sandbox 进程环境变量脚本。
 * @param env Worker 绑定
 * @returns shell export 脚本
 */
function buildEnvScript(env: NeoNoumiSandboxBindings): string {
	return [
		`export NEO_NOUMI_ENABLE_REAL_CLAUDE=${shellQuote(
			env.NEO_NOUMI_ENABLE_REAL_CLAUDE ?? env.CCR_ENABLE_REAL_CLAUDE,
		)}`,
		"",
	].join("\n");
}

/**
 * 对容器状态中的敏感字段做兜底脱敏。
 * @param value 待返回值
 * @returns 脱敏后的值
 */
function redactSecrets(value: unknown): unknown {
	if (typeof value === "string") {
		return value
			.replaceAll(/sk-[A-Za-z0-9_-]+/g, "[REDACTED]")
			.replaceAll(/nnaip_[A-Za-z0-9_-]+/g, "[REDACTED]")
			.replaceAll(/ANTHROPIC_API_KEY='[^']*'/g, "ANTHROPIC_API_KEY='[REDACTED]'")
			.replaceAll(/AI_PROXY_TOKEN='[^']*'/g, "AI_PROXY_TOKEN='[REDACTED]'");
	}
	if (Array.isArray(value)) {
		return value.map(redactSecrets);
	}
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value).map(([key, item]) => [key, redactSecrets(item)]),
		);
	}
	return value;
}

/**
 * 获取指定 session 的 sandbox。
 * @param env Worker 绑定
 * @param userId 用户 ID
 * @returns sandbox client
 */
function getCcrSandbox(env: NeoNoumiSandboxBindings, userId: string) {
	return getUserContainer(env.NEO_NOUMI_SANDBOX, userId);
}

/**
 * 读取 Sandbox 挂载 R2 所需配置。
 * @param env Worker 绑定
 * @returns Sandbox SDK mountBucket 配置
 */
function readWorkspaceMountConfig(env: NeoNoumiSandboxBindings) {
	if (!env.PROJECT_WORKSPACE_BUCKET_NAME) {
		throw new Error("PROJECT_WORKSPACE_BUCKET_NAME is required");
	}
	if (!env.R2_ACCOUNT_ID) {
		throw new Error("R2_ACCOUNT_ID is required");
	}
	if (!env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY) {
		throw new Error("R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY are required");
	}
	return {
		bucketName: env.PROJECT_WORKSPACE_BUCKET_NAME,
		credentials: {
			accessKeyId: env.R2_ACCESS_KEY_ID,
			secretAccessKey: env.R2_SECRET_ACCESS_KEY,
		},
		endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
	};
}

/**
 * 判断容器路径是否已经是挂载点。
 * @param sandbox sandbox client
 * @param mountPath 容器内挂载路径
 * @returns 是否已经挂载
 */
async function isMountedPath(
	sandbox: ReturnType<typeof getCcrSandbox>,
	mountPath: string,
): Promise<boolean> {
	const result = await sandbox.exec(`mountpoint -q ${shellQuote(mountPath)}`, {
		origin: "internal",
	});
	return result.success;
}

/**
 * 确保当前 session 所属 project workspace 已挂载到容器。
 * @param sandbox sandbox client
 * @param store CCR store
 * @param sessionId session ID
 * @returns workspace 挂载信息
 */
async function ensureProjectWorkspaceMounted(
	sandbox: ReturnType<typeof getCcrSandbox>,
	env: NeoNoumiSandboxBindings,
	store: CcrStore,
	sessionId: string,
): Promise<ProjectWorkspaceMount> {
	const context = await store.getSessionWorkspaceContext(sessionId);
	if (!context || context.deletedAt || context.project.deletedAt) {
		throw new Error("Session workspace not found");
	}

	const mountPath = buildProjectWorkspaceMountPath(
		context.project.name,
		context.projectId,
	);
	if (await isMountedPath(sandbox, mountPath)) {
		await store.recordOperation(sessionId, {
			direction: "route_internal",
			category: "sandbox_workspace_mount_checked",
			payload: {
				mount_path: mountPath,
				project_id: context.projectId,
				project_name: context.project.name,
				mounted: false,
				reason: "already_mounted",
			},
		});
		return {
			mountPath,
			mounted: false,
			projectId: context.projectId,
			projectName: context.project.name,
		};
	}

	// 挂载点必须预先存在，且路径段已收敛为 s3fs 友好的 POSIX 名称。
	await sandbox.exec(`mkdir -p ${shellQuote(mountPath)}`, {
		origin: "internal",
	});
	if (shouldSkipWorkspaceMount(env.NEO_NOUMI_DISABLE_WORKSPACE_MOUNT)) {
		await store.recordOperation(sessionId, {
			direction: "route_internal",
			category: "sandbox_workspace_mount_checked",
			payload: {
				mount_path: mountPath,
				project_id: context.projectId,
				project_name: context.project.name,
				mounted: false,
				reason: "workspace_mount_disabled",
			},
		});
		return {
			mountPath,
			mounted: false,
			projectId: context.projectId,
			projectName: context.project.name,
		};
	}
	const mountConfig = readWorkspaceMountConfig(env);
	await sandbox.mountBucket(mountConfig.bucketName, mountPath, {
		credentials: mountConfig.credentials,
		endpoint: mountConfig.endpoint,
		// Sandbox SDK 的 s3fs prefix 必须同时以 `/` 开头和结尾。
		prefix: buildProjectWorkspaceMountPrefix(context.projectId),
		// workspace 挂载只用于观察，写入统一走 route-side MCP 工具。
		readOnly: true,
	});
	await store.recordOperation(sessionId, {
		direction: "route_internal",
		category: "sandbox_workspace_mount_checked",
		payload: {
			mount_path: mountPath,
			project_id: context.projectId,
			project_name: context.project.name,
			mounted: true,
		},
	});
	return {
		mountPath,
		mounted: true,
		projectId: context.projectId,
		projectName: context.project.name,
	};
}

/**
 * 从 sandbox process 列表中提取进程 ID。
 * @param process sandbox process
 * @returns 进程 ID
 */
function getProcessId(process: unknown): string {
	return typeof process === "object" && process && "id" in process
		? String(process.id)
		: "";
}

/**
 * 启动 CCR sandbox runner。
 */
export async function startCcrSandbox(
	_request: Request,
	env: NeoNoumiSandboxBindings,
	store: CcrStore,
	userId: string,
	sessionId: string,
) {
	const sandboxId = buildUserContainerId(userId);
	const logContext = { userId, sessionId, sandboxId };
	const sandbox = getCcrSandbox(env, userId);
	logCcrSandboxStartup("info", "begin", logContext);
	const lifecycle = await runStartupStep("lifecycle.read", logContext, () =>
		store.getSessionLifecycle(sessionId),
	);
	if (lifecycle?.deletedAt) {
		logCcrSandboxStartup("warn", "session.deleted", logContext);
		throw new Error("Session is deleting");
	}
	if (lifecycle?.containerStatus === "running" && lifecycle.runnerProcessId) {
		const processes = await runStartupStep("processes.list_existing", logContext, () =>
			sandbox.listProcesses().catch((error) => {
				logCcrSandboxStartup("warn", "processes.list_existing.failed_ignored", logContext, {
					error: serializeLogError(error),
				});
				return [];
			}),
		);
		const process = Array.isArray(processes)
			? processes.find((item) => getProcessId(item) === lifecycle.runnerProcessId)
			: undefined;
		if (process) {
			logCcrSandboxStartup("info", "reuse_existing_process", logContext, {
				processId: lifecycle.runnerProcessId,
			});
			return {
				sandbox_id: sandboxId,
				process,
				session_lifecycle: lifecycle,
			};
		}
		// 记录中的进程已不存在，清理后重新拉起当前 session runner。
		await runStartupStep("runner.clear_stale", logContext, () =>
			store.clearSessionRunner(sessionId),
		);
	}
	await runStartupStep("user_container.ensure", logContext, () =>
		store.getUserContainer(userId),
	);
	const workerAccessToken = await runStartupStep("worker_token.rotate", logContext, () =>
		store.rotateWorkerAccessToken(sessionId),
	);
	const aiProxyToken = await runStartupStep("ai_proxy_token.rotate", logContext, () =>
		store.rotateAiProxyToken(userId, sessionId, sandboxId),
	);
	await runStartupStep("user_container.mark_starting", logContext, () =>
		store.updateUserContainer(userId, {
			containerStatus: "starting",
			sandboxId,
		}),
	);
	await runStartupStep("session_container.mark_starting", logContext, () =>
		store.updateActiveContainer(sessionId, {
			containerStatus: "starting",
			sandboxId,
		}),
	);
	await runStartupStep("sandbox.env.set", logContext, () =>
		sandbox.setEnvVars({
			// 非敏感标识注入容器，供观测主进程上报时标记用户级 sandbox。
			NEO_NOUMI_SANDBOX_ID: sandboxId,
			NEO_NOUMI_OBSERVABILITY_ENDPOINT: `http://${SANDBOX_OBSERVABILITY_HOST}/events`,
		}),
	);
	const workspaceMount = await runStartupStep("workspace.mount", logContext, () =>
		ensureProjectWorkspaceMounted(
			sandbox,
			env,
			store,
			sessionId,
		),
	);
	logCcrSandboxStartup("info", "workspace.mount.ok", logContext, {
		mountPath: workspaceMount.mountPath,
		mounted: workspaceMount.mounted,
		projectId: workspaceMount.projectId,
		projectName: workspaceMount.projectName,
	});
	const restoredState = await runStartupStep("claude_state.restore", logContext, () =>
		restoreClaudeLocalState(
			sandbox,
			store,
			sessionId,
			workspaceMount.mountPath,
		),
	);
	logCcrSandboxStartup("info", "claude_state.restore.ok", logContext, {
		sessionMode: restoredState.sessionMode,
		transcriptEvents: restoredState.transcriptEvents,
	});
	await runStartupStep("runner.dir.ensure", logContext, () =>
		sandbox.exec(`mkdir -p ${shellQuote(dirname(RUNNER_PATH))}`, {
			origin: "internal",
		}),
	);
	await runStartupStep("runner.env.write", logContext, () =>
		sandbox.writeFile(ENV_PATH, buildEnvScript(env)),
	);
	await runStartupStep("runner.script.write", logContext, () =>
		sandbox.writeFile(RUNNER_PATH, buildRunnerScript()),
	);
	await runStartupStep("runner.env.chmod", logContext, () =>
		sandbox.exec(`chmod 600 ${ENV_PATH}`),
	);
	await runStartupStep("runner.script.chmod", logContext, () =>
		sandbox.exec(`chmod +x ${RUNNER_PATH}`),
	);
	const process = await runStartupStep("runner.process.start", logContext, () =>
		sandbox.startProcess(
			[
				"sh -lc",
				shellQuote(
					[
						`. ${ENV_PATH};`,
						"exec",
						RUNNER_PATH,
						shellQuote(sessionId),
						shellQuote(workerAccessToken),
						shellQuote(aiProxyToken),
						shellQuote(restoredState.sessionMode),
						shellQuote(workspaceMount.mountPath),
						`> ${shellQuote(RUNNER_LOG_PATH)} 2>&1`,
					].join(" "),
				),
			].join(" "),
			{ cwd: workspaceMount.mountPath },
		),
	);
	try {
		await runStartupStep("runner.db.bind", logContext, () =>
			store.setSessionRunner(sessionId, sandboxId, process.id),
		);
	} catch (error) {
		// 如果 project/session 在启动进程期间被删除，必须立刻杀掉刚创建的 runner。
		logCcrSandboxStartup("warn", "runner.db.bind.cleanup", logContext, {
			processId: process.id,
			error: serializeLogError(error),
		});
		await sandbox.killProcess(process.id).catch((killError) => {
			logCcrSandboxStartup("warn", "runner.cleanup.kill_failed", logContext, {
				processId: process.id,
				error: serializeLogError(killError),
			});
			return undefined;
		});
		const remainingProcesses = await sandbox.listProcesses().catch((listError) => {
			logCcrSandboxStartup("warn", "runner.cleanup.list_failed", logContext, {
				error: serializeLogError(listError),
			});
			return null;
		});
		if (Array.isArray(remainingProcesses)) {
			await store.updateUserContainer(userId, {
				containerStatus: remainingProcesses.length > 0 ? "running" : "stopped",
				sandboxId,
			});
		}
		throw error;
	}
	await runStartupStep("user_container.mark_running", logContext, () =>
		store.updateUserContainer(userId, {
			containerStatus: "running",
			sandboxId,
		}),
	);
	await runStartupStep("operation.record_started", logContext, () =>
		store.recordOperation(sessionId, {
			direction: "route_internal",
			category: "sandbox_started",
			payload: {
				sandbox_id: sandboxId,
				process_id: process.id,
				claude_session_mode: restoredState.sessionMode,
				transcript_events: restoredState.transcriptEvents,
				workspace_mount_path: workspaceMount.mountPath,
				workspace_project_id: workspaceMount.projectId,
				workspace_project_name: workspaceMount.projectName,
				workspace_mounted: workspaceMount.mounted,
			},
		}),
	);
	logCcrSandboxStartup("info", "complete", logContext, {
		processId: process.id,
		sessionMode: restoredState.sessionMode,
	});
	return {
		sandbox_id: sandboxId,
		process,
		session_lifecycle: await store.getSessionLifecycle(sessionId),
	};
}

/**
 * 获取 CCR sandbox 状态。
 */
export async function getCcrSandboxStatus(
	env: NeoNoumiSandboxBindings,
	userId: string,
) {
	const sandbox = getCcrSandbox(env, userId);
	const processes = await sandbox.listProcesses().catch((error) => ({
		error: error instanceof Error ? error.message : String(error),
	}));
	const runnerLog = await sandbox
		.readFile(RUNNER_LOG_PATH)
		.then((file) => file.content.slice(-8_000))
		.catch(() => "");
	return {
		sandbox_id: buildUserContainerId(userId),
		processes: redactSecrets(processes),
		runner_log: redactSecrets(runnerLog),
	};
}

/**
 * 停止指定 session 的 sandbox runner。
 */
export async function stopCcrSessionRunner(
	env: NeoNoumiSandboxBindings,
	store: CcrStore,
	userId: string,
	sessionId: string,
) {
	const sandbox = getCcrSandbox(env, userId);
	const lifecycle = await store.getSessionLifecycle(sessionId);
	if (lifecycle?.runnerProcessId) {
		await sandbox.killProcess(lifecycle.runnerProcessId).catch(() => undefined);
	}
	if (lifecycle?.deletedAt) {
		await store.clearDeletedSessionRunner(sessionId);
	} else {
		try {
			await store.clearSessionRunner(sessionId);
		} catch (error) {
			const latestLifecycle = await store.getSessionLifecycle(sessionId);
			if (!latestLifecycle?.deletedAt) {
				throw error;
			}
			// 清理前刚好进入删除态时，只移除 runnerProcessId，不回写 live 状态。
			await store.clearDeletedSessionRunner(sessionId);
		}
	}
	await store.revokeAiProxyTokensForSession(sessionId);
	const remainingProcesses = await sandbox.listProcesses().catch(() => []);
	if (Array.isArray(remainingProcesses) && remainingProcesses.length === 0) {
		// 用户级容器没有其它会话 runner 时，才把用户容器标为 stopped。
		await store.updateUserContainer(userId, { containerStatus: "stopped" });
	}
	return { ok: true };
}

/**
 * 销毁 CCR sandbox。
 */
export async function stopCcrUserContainer(
	env: NeoNoumiSandboxBindings,
	store: CcrStore,
	userId: string,
) {
	const sandboxId = await destroyUserContainerSandbox(env.NEO_NOUMI_SANDBOX, userId);
	const clearedSessions = await store.clearUserContainerSessionRunners(userId, sandboxId);
	await store.updateUserContainer(userId, {
		containerStatus: "stopped",
		sandboxId: null,
	});
	return { ok: true, sandbox_id: sandboxId, cleared_sessions: clearedSessions };
}

/** @deprecated 使用 stopCcrUserContainer 表达用户级容器停止语义。 */
export const destroyCcrSandbox = stopCcrUserContainer;
