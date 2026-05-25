import { Sandbox, getSandbox } from "@cloudflare/sandbox";
import { CLAUDE_SESSION_STORE_PROJECT_KEY, type CcrStore } from "./ccr-store";
import { isJsonObject } from "./ccr-json";
import { CCR_SDK_APPROVED_HOST } from "./ccr-protocol";
import {
	ANTHROPIC_API_HOST,
	proxyAnthropicApiRequest,
	type AiProxyBindings,
} from "./ccr-ai-proxy";
import type { JsonObject } from "./ccr-types";
import {
	buildClaudeProjectStateDir,
	buildProjectWorkspaceMountPath,
	PROJECT_WORKSPACE_BUCKET_BINDING,
	PROJECT_WORKSPACE_ROOT,
} from "./ccr-workspace-mount";

/** Sandbox 内 CCR runner 脚本路径 */
const RUNNER_PATH = "/tmp/neo-noumi/ccr-runner.sh";

/** Sandbox 内敏感环境变量文件路径 */
const ENV_PATH = "/tmp/neo-noumi/ccr-env.sh";

/** Sandbox 内 CCR runner 日志路径，避免写入用户 workspace。 */
const RUNNER_LOG_PATH = "/tmp/neo-noumi/ccr-runner.log";

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

/** Claude Code 默认模型；固定到网关可识别的 Sonnet 模型，避免 CLI 选择 Opus 后缀模型。 */
const CLAUDE_MODEL = "claude-sonnet-4-6";

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
	/** Claude Code 模型名；默认固定使用 claude-sonnet-4-6 */
	CLAUDE_MODEL?: string;
	/** AI Proxy fallback credential 使用的鉴权头类型。 */
	AI_PROXY_AUTH_HEADER?: string;
	/** 用户级 AI Proxy credential 加密密钥。 */
	AI_PROXY_CREDENTIAL_SECRET?: string;
}

/** Cloudflare Sandbox，用于运行 Neo Noumi chat worker。 */
export class NeoNoumiSandbox extends Sandbox {
	enableInternet = false;
	interceptHttps = true;
	allowedHosts = [
		CCR_SDK_APPROVED_HOST,
		ANTHROPIC_API_HOST,
	];
}

NeoNoumiSandbox.outboundByHost = {
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
		return fetch(new Request(target, request));
	},
	[ANTHROPIC_API_HOST]: async (request: Request, env: Env) => {
		return proxyAnthropicApiRequest(request, env as Env & AiProxyBindings);
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
    --model "\${CLAUDE_MODEL:-${CLAUDE_MODEL}}" \
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
		`export CLAUDE_MODEL=${shellQuote(env.CLAUDE_MODEL ?? CLAUDE_MODEL)}`,
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
	return getSandbox(env.NEO_NOUMI_SANDBOX, `neo-noumi-user-${userId}`);
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

	// 只创建挂载根目录，具体 project 目录交给 mountBucket 绑定到 R2 prefix。
	await sandbox.exec(`mkdir -p ${shellQuote(PROJECT_WORKSPACE_ROOT)}`, {
		origin: "internal",
	});
	await sandbox.mountBucket(PROJECT_WORKSPACE_BUCKET_BINDING, mountPath, {
		prefix: `/${context.projectId}`,
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
	const sandboxId = `neo-noumi-user-${userId}`;
	const sandbox = getCcrSandbox(env, userId);
	const lifecycle = await store.getSessionLifecycle(sessionId);
	if (lifecycle?.deletedAt) {
		throw new Error("Session is deleting");
	}
	if (lifecycle?.containerStatus === "running" && lifecycle.runnerProcessId) {
		const processes = await sandbox.listProcesses().catch(() => []);
		const process = Array.isArray(processes)
			? processes.find((item) => getProcessId(item) === lifecycle.runnerProcessId)
			: undefined;
		if (process) {
			return {
				sandbox_id: sandboxId,
				process,
				session_lifecycle: lifecycle,
			};
		}
		// 记录中的进程已不存在，清理后重新拉起当前 session runner。
		await store.clearSessionRunner(sessionId);
	}
	await store.getUserContainer(userId);
	const workerAccessToken = await store.rotateWorkerAccessToken(sessionId);
	const aiProxyToken = await store.rotateAiProxyToken(userId, sessionId, sandboxId);
	await store.updateUserContainer(userId, {
		containerStatus: "starting",
		sandboxId,
	});
	await store.updateActiveContainer(sessionId, {
		containerStatus: "starting",
		sandboxId,
	});
	const workspaceMount = await ensureProjectWorkspaceMounted(
		sandbox,
		store,
		sessionId,
	);
	const restoredState = await restoreClaudeLocalState(
		sandbox,
		store,
		sessionId,
		workspaceMount.mountPath,
	);
	await sandbox.exec(`mkdir -p ${shellQuote(dirname(RUNNER_PATH))}`, {
		origin: "internal",
	});
	await sandbox.writeFile(ENV_PATH, buildEnvScript(env));
	await sandbox.writeFile(RUNNER_PATH, buildRunnerScript());
	await sandbox.exec(`chmod 600 ${ENV_PATH}`);
	await sandbox.exec(`chmod +x ${RUNNER_PATH}`);
	const process = await sandbox.startProcess(
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
	);
	try {
		await store.setSessionRunner(sessionId, sandboxId, process.id);
	} catch (error) {
		// 如果 project/session 在启动进程期间被删除，必须立刻杀掉刚创建的 runner。
		await sandbox.killProcess(process.id).catch(() => undefined);
		const remainingProcesses = await sandbox.listProcesses().catch(() => null);
		if (Array.isArray(remainingProcesses)) {
			await store.updateUserContainer(userId, {
				containerStatus: remainingProcesses.length > 0 ? "running" : "stopped",
				sandboxId,
			});
		}
		throw error;
	}
	await store.updateUserContainer(userId, {
		containerStatus: "running",
		sandboxId,
	});
	await store.recordOperation(sessionId, {
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
		sandbox_id: `neo-noumi-user-${userId}`,
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
	const sandbox = getCcrSandbox(env, userId);
	const sandboxId = `neo-noumi-user-${userId}`;
	await sandbox.destroy();
	const clearedSessions = await store.clearUserContainerSessionRunners(userId, sandboxId);
	await store.updateUserContainer(userId, {
		containerStatus: "stopped",
		sandboxId: null,
	});
	return { ok: true, sandbox_id: sandboxId, cleared_sessions: clearedSessions };
}

/** @deprecated 使用 stopCcrUserContainer 表达用户级容器停止语义。 */
export const destroyCcrSandbox = stopCcrUserContainer;
