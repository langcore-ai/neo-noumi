import { Sandbox, getSandbox } from "@cloudflare/sandbox";
import type { CcrStore } from "./ccr-store";

/** Claude Code 允许的官方域名，用于 outbound HTTPS interception。 */
const CLAUDE_APPROVED_HOST = "api.anthropic.com";

/** 当前验证过的 Anthropic 兼容网关域名；匹配 allowedHosts 后由容器直连公网。 */
const ANTHROPIC_COMPAT_HOSTS = ["ai-api.mandao.com", "maas.geneasy.ai"];

/** Sandbox 内 CCR runner 脚本路径 */
const RUNNER_PATH = "/workspace/ccr-runner.sh";

/** Sandbox 内敏感环境变量文件路径 */
const ENV_PATH = "/workspace/ccr-env.sh";

/** Claude Code 默认模型；固定到网关可识别的 Sonnet 模型，避免 CLI 选择 Opus 后缀模型。 */
const CLAUDE_MODEL = "claude-sonnet-4-6";

/** Neo Noumi sandbox Worker 绑定 */
export interface NeoNoumiSandboxBindings {
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
	/** Claude Code API Key；作为 Worker secret 注入后传给 sandbox 进程 */
	ANTHROPIC_API_KEY?: string;
	/** Anthropic 兼容 API base URL；可用于接入代理网关 */
	ANTHROPIC_BASE_URL?: string;
	/** Claude Code 模型名；默认固定使用 claude-sonnet-4-6 */
	CLAUDE_MODEL?: string;
	/** Claude Code OAuth token；按部署环境需要作为 secret 注入 */
	CLAUDE_CODE_OAUTH_TOKEN?: string;
}

/** Cloudflare Sandbox，用于运行 Neo Noumi chat worker。 */
export class NeoNoumiSandbox extends Sandbox {
	enableInternet = false;
	interceptHttps = true;
	allowedHosts = [CLAUDE_APPROVED_HOST, ...ANTHROPIC_COMPAT_HOSTS];
}

NeoNoumiSandbox.outboundByHost = {
	[CLAUDE_APPROVED_HOST]: async (request: Request, env: Env) => {
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
SDK_URL="https://${CLAUDE_APPROVED_HOST}/v1/code/sessions/$SESSION_ID"
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

if [ "\${NEO_NOUMI_ENABLE_REAL_CLAUDE:-0}" = "1" ] && command -v claude >/dev/null 2>&1; then
  exec claude --print \
    --sdk-url "https://${CLAUDE_APPROVED_HOST}/v1/code/sessions/$SESSION_ID" \
    --session-id "$SESSION_ID" \
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
 * 规范化 Claude Code 使用的 Anthropic base URL。
 * @param value 原始 base URL
 * @returns Claude Code 可接受的 origin；非法或空值保持原样
 */
function normalizeClaudeBaseUrl(value: string | undefined): string | undefined {
	if (!value) {
		return value;
	}
	try {
		const url = new URL(value);
		// Claude Code 会自行拼接 /v1/messages，传入 /v1 会导致 /v1/v1/messages。
		return url.pathname === "/v1" || url.pathname === "/v1/"
			? url.origin
			: value.replace(/\/+$/, "");
	} catch {
		return value;
	}
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
		`export ANTHROPIC_API_KEY=${shellQuote(env.ANTHROPIC_API_KEY)}`,
		`export ANTHROPIC_BASE_URL=${shellQuote(
			normalizeClaudeBaseUrl(env.ANTHROPIC_BASE_URL),
		)}`,
		`export CLAUDE_MODEL=${shellQuote(env.CLAUDE_MODEL ?? CLAUDE_MODEL)}`,
		`export CLAUDE_CODE_OAUTH_TOKEN=${shellQuote(env.CLAUDE_CODE_OAUTH_TOKEN)}`,
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
			.replaceAll(/ANTHROPIC_API_KEY='[^']*'/g, "ANTHROPIC_API_KEY='[REDACTED]'")
			.replaceAll(
				/CLAUDE_CODE_OAUTH_TOKEN='[^']*'/g,
				"CLAUDE_CODE_OAUTH_TOKEN='[REDACTED]'",
			);
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
	await store.updateUserContainer(userId, {
		containerStatus: "starting",
		sandboxId,
	});
	await store.updateContainer(sessionId, {
		containerStatus: "starting",
		sandboxId,
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
					"> /workspace/ccr-runner.log 2>&1",
				].join(" "),
			),
		].join(" "),
	);
	await store.setSessionRunner(sessionId, sandboxId, process.id);
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
		.readFile("/workspace/ccr-runner.log")
		.then((file) => file.content.slice(-8_000))
		.catch(() => "");
	return {
		sandbox_id: `neo-noumi-user-${userId}`,
		processes: redactSecrets(processes),
		runner_log: redactSecrets(runnerLog),
	};
}

/**
 * 停止 CCR sandbox 内进程。
 */
export async function stopCcrSandbox(
	env: NeoNoumiSandboxBindings,
	store: CcrStore,
	userId: string,
	options: { updateStore?: boolean } = {},
) {
	const sandbox = getCcrSandbox(env, userId);
	const processes = await sandbox.listProcesses().catch(() => []);
	if (Array.isArray(processes)) {
		for (const process of processes) {
			const id = getProcessId(process);
			if (id) {
				await sandbox.killProcess(id).catch(() => undefined);
			}
		}
	}
	if (options.updateStore !== false) {
		await store.updateUserContainer(userId, { containerStatus: "stopped" });
	}
	return { ok: true };
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
	await store.clearSessionRunner(sessionId);
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
export async function destroyCcrSandbox(
	env: NeoNoumiSandboxBindings,
	store: CcrStore,
	userId: string,
) {
	const sandbox = getCcrSandbox(env, userId);
	await sandbox.destroy();
	await store.updateUserContainer(userId, {
		containerStatus: "destroyed",
		sandboxId: null,
	});
	return { ok: true };
}
