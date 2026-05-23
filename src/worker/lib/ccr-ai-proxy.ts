import { createPrismaClient } from "./prisma";
import { CcrStore } from "./ccr-store";
import { normalizeClaudeBaseUrl } from "./ccr-protocol";

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
}

/** 上游 credential。 */
export type AiProxyCredential = {
	/** credential 来源，用于审计与鉴权头选择。 */
	provider: string;
	/** 上游 base URL。 */
	baseUrl: string;
	/** 真实上游 API key。 */
	apiKey: string;
};

/**
 * 创建 AI Proxy store。
 * @param env Worker 绑定
 * @returns CCR store
 */
function createAiProxyStore(env: AiProxyBindings): CcrStore {
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
 * 读取当前请求应使用的真实上游 credential。
 * @param store CCR store
 * @param env Worker 绑定
 * @param userId 用户 ID
 * @returns credential；不存在时返回 null
 */
async function resolveAiProxyCredential(
	store: CcrStore,
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
): Promise<Response> {
	const url = new URL(request.url);
	if (!isAllowedAnthropicApiPath(url.pathname)) {
		return Response.json({ error: "AI proxy path is not allowed" }, { status: 403 });
	}

	const token = readAiProxyToken(request);
	if (!token) {
		return Response.json({ error: "AI proxy token is required" }, { status: 401 });
	}

	const store = createAiProxyStore(env);
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
	return fetch(
		new Request(target, {
			method: request.method,
			headers,
			body: request.method === "GET" || request.method === "HEAD" ? null : request.body,
			redirect: "manual",
		}),
	);
}
