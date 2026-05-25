import { createPrismaClient } from "./prisma";
import { CcrStore } from "./ccr-store";
import { normalizeClaudeBaseUrl } from "./ccr-protocol";
import { deleteKvCache, readKvJsonCache, writeKvJsonCache } from "./kv-cache";

/** 官方 Anthropic API host，由 Cloudflare outbound interception 劫持。 */
export const ANTHROPIC_API_HOST = "api.anthropic.com";

/** AI Proxy 允许转发的 Anthropic API 路径。 */
const ALLOWED_ANTHROPIC_API_PATHS = new Set([
	"/v1/messages",
	"/v1/messages/count_tokens",
]);

/** AI Proxy 运行所需 Worker 绑定。 */
export interface AiProxyBindings {
	/** PostgreSQL 连接串，未启用 Hyperdrive 时使用。 */
	DATABASE_URL?: string;
	/** Hyperdrive 数据库连接，优先用于 Worker 运行时。 */
	HYPERDRIVE?: {
		/** Hyperdrive 注入的 PostgreSQL 连接串。 */
		connectionString: string;
	};
	/** 平台级 fallback API key；不会注入容器，只在 Worker 转发时使用。 */
	ANTHROPIC_API_KEY?: string;
	/** 平台级 fallback Anthropic 兼容上游。 */
	ANTHROPIC_BASE_URL?: string;
	/** 平台级 fallback 鉴权头类型。 */
	AI_PROXY_AUTH_HEADER?: string;
	/** 用户级 AI Proxy credential 加密密钥。 */
	AI_PROXY_CREDENTIAL_SECRET?: string;
	/** AI Proxy payload 审计临时缓存，当前复用 Worker KV namespace。 */
	AUTH_KV: KVNamespace;
}

/** 上游 credential。 */
export type AiProxyCredential = {
	/** 用户 credential ID；平台 fallback 没有该字段。 */
	id?: string;
	/** credential 来源，用于审计与鉴权头选择。 */
	provider: string;
	/** 上游 base URL。 */
	baseUrl: string;
	/** 真实上游 API key。 */
	apiKey: string;
};

/** 可落库的 HTTP headers 快照。 */
type HeaderSnapshot = Array<[string, string]>;

/** 编码器复用，避免每次计算 body 字节数都重新实例化。 */
const textEncoder = new TextEncoder();

/** AI Proxy payload 临时缓存目录。 */
const AI_PROXY_PAYLOAD_CACHE_PREFIX = ["ai-proxy", "payload"] as const;

/** AI Proxy payload 临时缓存 TTL，单位秒。 */
const AI_PROXY_PAYLOAD_CACHE_TTL_SECONDS = 60 * 60;

/** 尚未完整落库的 AI Proxy payload 快照。 */
type AiProxyPendingPayload = {
	/** 容器原始请求头。 */
	requestHeaders: HeaderSnapshot;
	/** 容器原始请求体。 */
	requestBody: string | null;
	/** 实际转发上游请求头。 */
	upstreamRequestHeaders: HeaderSnapshot;
};

/** AI Proxy 转发链路依赖的 store 方法集合。 */
type AiProxyStore = Pick<
	CcrStore,
	| "authenticateAiProxyToken"
	| "getDefaultAiProxyCredential"
	| "createAiProxyRequestLog"
	| "completeAiProxyRequestLog"
>;

/** AI Proxy 请求处理测试注入项。 */
type AiProxyRequestOptions = {
	/** 测试或特殊运行时注入的 store；生产默认使用数据库 store。 */
	store?: AiProxyStore;
	/** 测试或特殊运行时注入的 fetch；生产默认使用全局 fetch。 */
	fetch?: typeof fetch;
};

/**
 * 创建 AI Proxy store。
 * @param env Worker 绑定
 * @returns CCR store
 */
function createAiProxyStore(env: AiProxyBindings): AiProxyStore {
	const databaseUrl = env.HYPERDRIVE?.connectionString ?? env.DATABASE_URL;
	if (!databaseUrl) {
		throw new Error("DATABASE_URL or HYPERDRIVE.connectionString is required");
	}
	return new CcrStore(createPrismaClient(databaseUrl), {
		aiProxyCredentialSecret: env.AI_PROXY_CREDENTIAL_SECRET,
	});
}

/**
 * 从 Anthropic 请求里读取容器 proxy token。
 * @param request 容器发起的原始请求
 * @returns token；不存在时返回 null
 */
export function readAiProxyToken(request: Request): string | null {
	const authorization = request.headers.get("authorization");
	const bearerMatch = authorization?.match(/^bearer\s+(.+)$/i);
	if (bearerMatch?.[1]) {
		return bearerMatch[1];
	}
	return request.headers.get("x-api-key");
}

/**
 * 判断路径是否允许被 AI Proxy 转发。
 * @param pathname 请求路径
 * @returns 是否允许
 */
export function isAllowedAnthropicApiPath(pathname: string): boolean {
	return ALLOWED_ANTHROPIC_API_PATHS.has(pathname);
}

/**
 * 按 base URL 和原始请求路径生成真实上游 URL。
 * @param baseUrl 上游 base URL，允许携带路径前缀
 * @param original 原始 Anthropic URL
 * @returns 真实上游 URL
 */
export function buildAiProxyUpstreamUrl(baseUrl: string, original: URL): URL {
	const normalizedBaseUrl = normalizeClaudeBaseUrl(baseUrl) ?? baseUrl;
	const target = new URL(normalizedBaseUrl);
	const basePath = target.pathname.replace(/\/$/, "");
	target.pathname = `${basePath}${original.pathname}`;
	target.search = original.search;
	return target;
}

/**
 * 覆盖请求头里的容器伪 key，避免把 proxy token 透传给上游。
 * @param headers 原始请求头
 * @param credential 上游 credential
 * @param authHeader 显式指定的鉴权头类型
 * @returns 转发请求头
 */
export function buildAiProxyHeaders(
	headers: Headers,
	credential: AiProxyCredential,
	authHeader?: string,
): Headers {
	const nextHeaders = new Headers(headers);
	nextHeaders.delete("host");
	nextHeaders.delete("cf-connecting-ip");
	nextHeaders.delete("cf-ew-via");
	nextHeaders.delete("cf-ray");
	nextHeaders.delete("x-api-key");
	nextHeaders.delete("authorization");

	const headerType = (authHeader || credential.provider).toLowerCase();
	if (headerType === "authorization" || headerType === "bearer") {
		nextHeaders.set("authorization", `Bearer ${credential.apiKey}`);
	} else {
		// Anthropic 官方 API 使用 x-api-key；这是默认路径。
		nextHeaders.set("x-api-key", credential.apiKey);
	}
	return nextHeaders;
}

/**
 * 将 Headers 转成稳定 JSON 数组，保留同名 header 合并后的最终值。
 * @param headers HTTP headers
 * @returns 可写入 Prisma Json 的 header 快照
 */
export function serializeHeaders(headers: Headers): HeaderSnapshot {
	return [...headers.entries()].sort(([left], [right]) => left.localeCompare(right));
}

/**
 * 读取请求体文本；GET/HEAD 没有可审计 body。
 * @param request 原始请求
 * @returns 请求体文本
 */
async function readRequestBodyText(request: Request): Promise<string | null> {
	if (request.method === "GET" || request.method === "HEAD") {
		return null;
	}
	// clone 会 tee 原始 body，读取审计副本不会消耗后续转发使用的 body。
	return request.clone().text();
}

/**
 * 计算字符串 UTF-8 字节数。
 * @param value 字符串或空值
 * @returns 字节数
 */
function byteLength(value: string | null | undefined): number {
	return value ? textEncoder.encode(value).byteLength : 0;
}

/**
 * 构造 AI Proxy payload 临时缓存 key。
 * @param logId AI Proxy 轻表日志 ID
 * @returns KV key 片段
 */
function buildAiProxyPayloadCacheKey(logId: string) {
	return [...AI_PROXY_PAYLOAD_CACHE_PREFIX, logId];
}

/**
 * 判断未知值是否是 header 快照。
 * @param value 原始值
 * @returns 是否是 header 快照
 */
function isHeaderSnapshot(value: unknown): value is HeaderSnapshot {
	return Array.isArray(value) &&
		value.every((item) =>
			Array.isArray(item) &&
			item.length === 2 &&
			typeof item[0] === "string" &&
			typeof item[1] === "string"
		);
}

/**
 * 解析 KV 中的待完成 payload。
 * @param value KV JSON 值
 * @returns payload 快照
 */
function parsePendingPayload(value: unknown): AiProxyPendingPayload {
	if (!value || typeof value !== "object") {
		throw new Error("Invalid AI proxy payload cache");
	}
	const payload = value as Partial<AiProxyPendingPayload>;
	if (
		!isHeaderSnapshot(payload.requestHeaders) ||
		!isHeaderSnapshot(payload.upstreamRequestHeaders) ||
		(payload.requestBody !== null && typeof payload.requestBody !== "string")
	) {
		throw new Error("Invalid AI proxy payload cache");
	}
	return {
		requestHeaders: payload.requestHeaders,
		requestBody: payload.requestBody,
		upstreamRequestHeaders: payload.upstreamRequestHeaders,
	};
}

/**
 * 补全数据库日志并清理临时 KV。
 * @param store CCR store
 * @param kv AI Proxy payload 临时缓存
 * @param logId AI Proxy 轻表日志 ID
 * @param cachedPayload 当前请求的本地 payload 兜底
 * @param response 上游响应；上游未返回时为空
 * @param responseBody 响应体文本
 * @param startedAt 请求开始时间
 * @param errorMessage 错误信息
 */
async function finalizeAiProxyAudit(
	store: AiProxyStore,
	kv: KVNamespace,
	logId: string,
	cachedPayload: AiProxyPendingPayload,
	response: Response | null,
	responseBody: string | null,
	startedAt: number,
	errorMessage?: string | null,
) {
	let pendingPayload = cachedPayload;
	try {
		pendingPayload = await readKvJsonCache(
			kv,
			buildAiProxyPayloadCacheKey(logId),
			{ deleteInvalid: true, parse: parsePendingPayload },
		) ?? cachedPayload;
	} catch {
		// KV 只是临时缓存，读取失败时用当前请求内存里的 payload 兜底完成审计。
	}
	await store.completeAiProxyRequestLog({
		logId,
		statusCode: response?.status,
		durationMs: Date.now() - startedAt,
		responseBytes: byteLength(responseBody),
		errorMessage: errorMessage ?? null,
		requestHeaders: pendingPayload.requestHeaders,
		requestBody: pendingPayload.requestBody,
		upstreamRequestHeaders: pendingPayload.upstreamRequestHeaders,
		responseHeaders: response ? serializeHeaders(response.headers) : null,
		responseBody,
	});
	try {
		await deleteKvCache(kv, buildAiProxyPayloadCacheKey(logId));
	} catch {
		// KV 删除失败由 TTL 兜底，不能影响数据库审计记录完成。
	}
}

/**
 * 将响应 chunk 合并为文本。
 * @param chunks 已收集的响应 chunk
 * @returns 响应体文本
 */
function decodeResponseChunks(chunks: Uint8Array[]): string {
	const decoder = new TextDecoder();
	return chunks.map((chunk) => decoder.decode(chunk, { stream: true })).join("") +
		decoder.decode();
}

/**
 * 包装响应体流，在转发给容器的同时收集响应并完成审计。
 * @param store CCR store
 * @param kv AI Proxy payload 临时缓存
 * @param logId AI Proxy 轻表日志 ID
 * @param cachedPayload 当前请求的本地 payload 兜底
 * @param response 上游响应
 * @param startedAt 请求开始时间
 * @returns 带审计收尾逻辑的响应体流
 */
function createAuditedResponseBody(
	store: AiProxyStore,
	kv: KVNamespace,
	logId: string,
	cachedPayload: AiProxyPendingPayload,
	response: Response,
	startedAt: number,
): ReadableStream<Uint8Array> {
	const reader = response.body!.getReader();
	const chunks: Uint8Array[] = [];
	let finalized = false;

	/**
	 * 完成一次审计收尾；多路径竞争时只允许执行一次。
	 * @param errorMessage 错误信息
	 */
	async function finalize(errorMessage?: string) {
		if (finalized) {
			return;
		}
		finalized = true;
		try {
			await finalizeAiProxyAudit(
				store,
				kv,
				logId,
				cachedPayload,
				response,
				decodeResponseChunks(chunks),
				startedAt,
				errorMessage,
			);
		} catch {
			// 审计失败不能反向破坏已经成功的上游响应。
		}
	}

	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				const { done, value } = await reader.read();
				if (done) {
					await finalize();
					controller.close();
					return;
				}
				// 复制 chunk，避免底层复用 buffer 时影响最终审计内容。
				chunks.push(new Uint8Array(value));
				controller.enqueue(value);
			} catch (error) {
				await finalize(error instanceof Error ? error.message : String(error));
				controller.error(error);
			}
		},
		async cancel(reason) {
			const message = reason instanceof Error
				? reason.message
				: reason === undefined
					? "AI proxy response stream canceled"
					: String(reason);
			try {
				await reader.cancel(reason);
			} finally {
				await finalize(message);
			}
		},
	});
}

/**
 * 读取当前请求应使用的真实上游 credential。
 * @param store CCR store
 * @param env Worker 绑定
 * @param userId 用户 ID
 * @returns credential；不存在时返回 null
 */
async function resolveAiProxyCredential(
	store: AiProxyStore,
	env: AiProxyBindings,
	userId: string,
): Promise<AiProxyCredential | null> {
	const userCredential = await store.getDefaultAiProxyCredential(userId);
	if (userCredential) {
		return userCredential;
	}
	if (!env.ANTHROPIC_API_KEY) {
		return null;
	}
	return {
		provider: env.AI_PROXY_AUTH_HEADER ?? "anthropic",
		baseUrl: normalizeClaudeBaseUrl(env.ANTHROPIC_BASE_URL) ?? "https://api.anthropic.com",
		apiKey: env.ANTHROPIC_API_KEY,
	};
}

/**
 * 处理被劫持的 Anthropic API 请求。
 * @param request 容器发出的官方 Anthropic 请求
 * @param env Worker 绑定
 * @returns 上游响应或鉴权错误
 */
export async function proxyAnthropicApiRequest(
	request: Request,
	env: AiProxyBindings,
	options: AiProxyRequestOptions = {},
): Promise<Response> {
	const url = new URL(request.url);
	if (!isAllowedAnthropicApiPath(url.pathname)) {
		return Response.json({ error: "AI proxy path is not allowed" }, { status: 403 });
	}

	const token = readAiProxyToken(request);
	if (!token) {
		return Response.json({ error: "AI proxy token is required" }, { status: 401 });
	}

	const store = options.store ?? createAiProxyStore(env);
	const auth = await store.authenticateAiProxyToken(token);
	if (!auth) {
		return Response.json({ error: "AI proxy token is invalid" }, { status: 401 });
	}

	const credential = await resolveAiProxyCredential(store, env, auth.userId);
	if (!credential) {
		return Response.json(
			{ error: "AI proxy credential is not configured" },
			{ status: 424 },
		);
	}

	const target = buildAiProxyUpstreamUrl(credential.baseUrl, url);
	const headers = buildAiProxyHeaders(request.headers, credential);
	const requestBody = await readRequestBodyText(request);
	const startedAt = Date.now();
	const pendingPayload: AiProxyPendingPayload = {
		requestHeaders: serializeHeaders(request.headers),
		requestBody,
		upstreamRequestHeaders: serializeHeaders(headers),
	};
	const logId = await store.createAiProxyRequestLog({
		userId: auth.userId,
		sessionId: auth.sessionId,
		tokenId: auth.tokenId,
		credentialId: credential.id ?? null,
		provider: credential.provider,
		requestMethod: request.method,
		requestUrl: url.toString(),
		requestPath: url.pathname,
		upstreamUrl: target.toString(),
		upstreamBaseUrl: credential.baseUrl,
		requestBytes: byteLength(requestBody),
	});
	try {
		try {
			await writeKvJsonCache(
				env.AUTH_KV,
				buildAiProxyPayloadCacheKey(logId),
				pendingPayload,
				{ expirationTtl: AI_PROXY_PAYLOAD_CACHE_TTL_SECONDS },
			);
		} catch {
			// KV 是降数据库写入成本的临时层，写入失败时继续用内存 payload 完成最终审计。
		}
		const response = await (options.fetch ?? fetch)(
			new Request(target, {
				method: request.method,
				headers,
				body: request.method === "GET" || request.method === "HEAD" ? null : request.body,
				redirect: "manual",
			}),
		);
		if (!response.body) {
			await finalizeAiProxyAudit(
				store,
				env.AUTH_KV,
				logId,
				pendingPayload,
				response,
				null,
				startedAt,
			);
			return response;
		}
		const auditedBody = createAuditedResponseBody(
			store,
			env.AUTH_KV,
			logId,
			pendingPayload,
			response,
			startedAt,
		);
		return new Response(auditedBody, response);
	} catch (error) {
		await finalizeAiProxyAudit(
			store,
			env.AUTH_KV,
			logId,
			pendingPayload,
			null,
			null,
			startedAt,
			error instanceof Error ? error.message : String(error),
		);
		return Response.json({ error: "AI proxy upstream request failed" }, { status: 502 });
	}
}
