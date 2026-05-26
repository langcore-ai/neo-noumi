import "dotenv/config";
import { CcrStore } from "../src/worker/lib/ccr-store";
import { createPrismaClient } from "../src/worker/lib/prisma";
import { isJsonObject } from "../src/worker/lib/ccr-json";
import type { JsonObject } from "../src/worker/lib/ccr-types";

/** 默认测试工具名称，用于和真实业务工具区分。 */
const DEFAULT_TOOL_NAME = "AExternalToolTest";

/** 默认测试工具输入，保持 payload 足够小且可肉眼识别。 */
const DEFAULT_TOOL_INPUT: JsonObject = { message: "ccr remote tool ping" };

/** 测试 CLI 配置。 */
export type RemoteToolTestOptions = {
	/** CCR session ID。 */
	sessionId: string;
	/** Neo Noumi 服务 base URL。 */
	baseUrl: string;
	/** 测试工具名称。 */
	toolName: string;
	/** 测试工具输入。 */
	input: JsonObject;
	/** 是否保留 requires_action 状态，便于人工检查 UI。 */
	leavePending: boolean;
	/** 已知 worker token；为空时脚本会通过数据库轮换一个新 token。 */
	workerToken?: string;
};

/** requires_action 测试负载。 */
export type RequiresActionTestPayload = {
	/** 测试 request ID。 */
	requestId: string;
	/** 测试 tool_use ID。 */
	toolUseId: string;
	/** 写给 /worker 的状态 payload。 */
	workerState: JsonObject;
	/** 写给 /worker/events 的可见事件 payload。 */
	visibleEvent: JsonObject;
	/** 写给 /worker/internal-events 的内部事件 payload。 */
	internalEvent: JsonObject;
};

/**
 * 解析命令行参数。
 * @param argv process.argv.slice(2)
 * @returns 测试配置
 */
export function parseArgs(argv: string[]): RemoteToolTestOptions {
	const values = new Map<string, string>();
	const flags = new Set<string>();
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (!arg.startsWith("--")) {
			throw new Error(`Unexpected argument: ${arg}`);
		}
		if (arg === "--leave-pending") {
			flags.add(arg);
			continue;
		}
		const value = argv[index + 1];
		if (!value || value.startsWith("--")) {
			throw new Error(`${arg} requires a value`);
		}
		values.set(arg, value);
		index += 1;
	}

	const sessionId = values.get("--session-id") ?? process.env.CCR_TEST_SESSION_ID;
	if (!sessionId) {
		throw new Error("--session-id or CCR_TEST_SESSION_ID is required");
	}

	const inputText = values.get("--input-json") ?? JSON.stringify(DEFAULT_TOOL_INPUT);
	const input = JSON.parse(inputText) as unknown;
	if (!isJsonObject(input)) {
		throw new Error("--input-json must be a JSON object");
	}

	return {
		sessionId,
		baseUrl:
			values.get("--base-url") ??
			process.env.CCR_TEST_BASE_URL ??
			process.env.NEO_NOUMI_PUBLIC_BASE_URL ??
			process.env.CCR_PUBLIC_BASE_URL ??
			"http://localhost:5173",
		toolName: values.get("--tool-name") ?? DEFAULT_TOOL_NAME,
		input,
		leavePending: flags.has("--leave-pending"),
		workerToken: values.get("--worker-token") ?? process.env.CCR_TEST_WORKER_TOKEN,
	};
}

/**
 * 构造一次 A-side remote tool pending action。
 * @param options 测试配置
 * @param workerEpoch 当前 worker epoch
 * @returns 可提交给 CCR worker 协议的 payload
 */
export function buildRequiresActionTestPayload(
	options: Pick<RemoteToolTestOptions, "toolName" | "input">,
	workerEpoch: number,
): RequiresActionTestPayload {
	const requestId = crypto.randomUUID();
	const toolUseId = `toolu_${crypto.randomUUID().replaceAll("-", "")}`;
	const actionDescription = `Testing ${options.toolName}`;
	const pendingAction = {
		tool_name: options.toolName,
		action_description: actionDescription,
		request_id: requestId,
		tool_use_id: toolUseId,
		input: options.input,
	};

	return {
		requestId,
		toolUseId,
		workerState: {
			worker_epoch: workerEpoch,
			worker_status: "requires_action",
			requires_action_details: pendingAction,
			external_metadata: {
				pending_action: pendingAction,
			},
		},
		visibleEvent: {
			payload: {
				type: "assistant",
				uuid: crypto.randomUUID(),
				message: {
					role: "assistant",
					content: [
						{
							type: "tool_use",
							id: toolUseId,
							name: options.toolName,
							input: options.input,
						},
					],
				},
			},
		},
		internalEvent: {
			payload: {
				type: "assistant",
				uuid: crypto.randomUUID(),
				message: {
					role: "assistant",
					content: [
						{
							type: "tool_use",
							id: toolUseId,
							name: options.toolName,
							input: options.input,
						},
					],
				},
			},
			event_metadata: {
				request_id: requestId,
				tool_use_id: toolUseId,
				tool_name: options.toolName,
				source: "ccr-remote-tool-test",
			},
		},
	};
}

/**
 * 拼接 CCR worker 协议 URL。
 * @param baseUrl 服务 base URL
 * @param sessionId CCR session ID
 * @param path worker 子路径
 * @returns 完整 URL
 */
function buildWorkerUrl(baseUrl: string, sessionId: string, path: string): string {
	const url = new URL(`/v1/code/sessions/${sessionId}${path}`, baseUrl);
	return url.toString();
}

/**
 * 提交 JSON 请求并校验 2xx 响应。
 * @param url 请求 URL
 * @param token worker bearer token
 * @param method HTTP method
 * @param body JSON body
 * @returns JSON 响应
 */
async function fetchJson(
	url: string,
	token: string,
	method: "GET" | "POST" | "PUT",
	body?: JsonObject,
): Promise<JsonObject> {
	const response = await fetch(url, {
		method,
		headers: {
			authorization: `Bearer ${token}`,
			"content-type": "application/json",
		},
		body: body ? JSON.stringify(body) : undefined,
	});
	const text = await response.text();
	const json = text ? (JSON.parse(text) as unknown) : {};
	if (!response.ok) {
		throw new Error(`${method} ${url} failed: ${response.status} ${text}`);
	}
	if (!isJsonObject(json)) {
		throw new Error(`${method} ${url} returned non-object JSON`);
	}
	return json;
}

/**
 * 获取 worker token；未显式传入时通过数据库轮换。
 * @param options 测试配置
 * @returns worker token
 */
async function resolveWorkerToken(options: RemoteToolTestOptions): Promise<string> {
	if (options.workerToken) {
		return options.workerToken;
	}
	const databaseUrl = process.env.DATABASE_URL;
	if (!databaseUrl) {
		throw new Error("DATABASE_URL is required when --worker-token is not provided");
	}
	const prisma = createPrismaClient(databaseUrl);
	try {
		const store = new CcrStore(prisma);
		const lifecycle = await store.getSessionLifecycle(options.sessionId);
		if (!lifecycle || lifecycle.deletedAt) {
			throw new Error(`Session not found or deleted: ${options.sessionId}`);
		}
		return store.rotateWorkerAccessToken(options.sessionId);
	} finally {
		// CLI 进程要主动释放 pg 连接，避免测试结束后短暂挂住。
		await prisma.$disconnect();
	}
}

/**
 * 执行一次 CCR remote tool pending action 测试。
 * @param options 测试配置
 * @returns 测试结果
 */
export async function runRemoteToolTest(options: RemoteToolTestOptions) {
	const workerToken = await resolveWorkerToken(options);
	const register = await fetchJson(
		buildWorkerUrl(options.baseUrl, options.sessionId, "/worker/register"),
		workerToken,
		"POST",
		{},
	);
	const workerEpoch = Number(register.worker_epoch);
	if (!Number.isSafeInteger(workerEpoch) || workerEpoch <= 0) {
		throw new Error(`Invalid worker_epoch: ${JSON.stringify(register)}`);
	}

	const payload = buildRequiresActionTestPayload(options, workerEpoch);
	await fetchJson(
		buildWorkerUrl(options.baseUrl, options.sessionId, "/worker/events"),
		workerToken,
		"POST",
		{ worker_epoch: workerEpoch, events: [payload.visibleEvent] },
	);
	await fetchJson(
		buildWorkerUrl(options.baseUrl, options.sessionId, "/worker/internal-events"),
		workerToken,
		"POST",
		{ worker_epoch: workerEpoch, events: [payload.internalEvent] },
	);
	await fetchJson(
		buildWorkerUrl(options.baseUrl, options.sessionId, "/worker"),
		workerToken,
		"PUT",
		payload.workerState,
	);

	const snapshot = await fetchJson(
		buildWorkerUrl(options.baseUrl, options.sessionId, "/worker"),
		workerToken,
		"GET",
	);
	const metadata = isJsonObject(snapshot.worker) ? snapshot.worker.external_metadata : null;
	if (!isJsonObject(metadata) || !isJsonObject(metadata.pending_action)) {
		throw new Error("Remote tool pending_action was not persisted");
	}

	if (!options.leavePending) {
		await fetchJson(
			buildWorkerUrl(options.baseUrl, options.sessionId, "/worker"),
			workerToken,
			"PUT",
			{
				worker_epoch: workerEpoch,
				worker_status: "idle",
				requires_action_details: null,
				external_metadata: { pending_action: null },
			},
		);
	}

	return {
		ok: true,
		sessionId: options.sessionId,
		baseUrl: options.baseUrl,
		workerEpoch,
		requestId: payload.requestId,
		toolUseId: payload.toolUseId,
		toolName: options.toolName,
		leftPending: options.leavePending,
	};
}

if (import.meta.main) {
	runRemoteToolTest(parseArgs(process.argv.slice(2)))
		.then((result) => {
			console.log(JSON.stringify(result, null, 2));
		})
		.catch((error) => {
			console.error(error instanceof Error ? error.message : String(error));
			process.exit(1);
		});
}
