import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { username } from "better-auth/plugins";
import { deleteKvCache, readKvJsonCache, writeKvJsonCache } from "./kv-cache";
import { createPrismaClient } from "./prisma";

/** Better Auth session 缓存在 AUTH_KV 下使用的目录。 */
const BETTER_AUTH_CACHE_KEY_PREFIX = ["auth", "session"] as const;

/** Better Auth 数据库 ID 允许的字符集；保持小写以兼容 Sandbox hostname。 */
const BETTER_AUTH_ID_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

/** Better Auth 数据库 ID 默认长度；32 位 base36 具备足够的碰撞安全余量。 */
const BETTER_AUTH_ID_SIZE = 32;

/** Vite 本地开发常用 origin，避免端口漂移后注册和登录被 Better Auth 拦截。 */
const LOCAL_DEV_TRUSTED_ORIGINS = [
	"http://localhost:5173",
	"http://localhost:5174",
	"http://127.0.0.1:5173",
	"http://127.0.0.1:5174",
];

/**
 * 生成 Better Auth session cache key。
 * @param key Better Auth secondary storage 传入的原始 key
 * @returns 去除重复 session 目录后的分层 key
 */
function buildBetterAuthCacheKey(key: string) {
	let normalizedKey = key.trim();
	while (/^(auth[:/]+session|session)[:/]+/.test(normalizedKey)) {
		// Better Auth 可能传入裸 session key，也可能传入已带目录的 key；循环剥离避免重复目录。
		normalizedKey = normalizedKey
			.replace(/^auth[:/]+session[:/]+/, "")
			.replace(/^session[:/]+/, "");
	}
	return [...BETTER_AUTH_CACHE_KEY_PREFIX, normalizedKey];
}

/** Auth 运行所需的 Cloudflare Worker 绑定 */
export interface AuthBindings {
	/** PostgreSQL 连接串，未启用 Hyperdrive 时使用 */
	DATABASE_URL?: string;
	/** Better Auth 用于签名与加密的密钥 */
	BETTER_AUTH_SECRET: string;
	/** Better Auth 对外访问地址 */
	BETTER_AUTH_URL: string;
	/** Cloudflare KV，用于缓存 session 等短期认证数据 */
	AUTH_KV: KVNamespace;
	/** Hyperdrive 数据库连接，优先用于 Worker 运行时 */
	HYPERDRIVE?: {
		/** Hyperdrive 注入的 PostgreSQL 连接串 */
		connectionString: string;
	};
}

/**
 * 获取当前请求可用的数据库连接串。
 * @param env Worker 绑定
 * @returns PostgreSQL 连接串
 */
function getDatabaseUrl(env: AuthBindings): string {
	// Hyperdrive 已配置时优先使用它的连接池入口
	if (env.HYPERDRIVE?.connectionString) {
		return env.HYPERDRIVE.connectionString;
	}

	if (env.DATABASE_URL) {
		return env.DATABASE_URL;
	}

	throw new Error("DATABASE_URL or HYPERDRIVE.connectionString is required");
}

/**
 * 读取 Better Auth 可信 origin。
 * @param baseUrl Better Auth 对外 URL
 * @returns 去重后的可信 origin 列表
 */
export function readTrustedOrigins(baseUrl: string): string[] {
	const origins = new Set([baseUrl]);
	const url = new URL(baseUrl);
	if (url.hostname === "localhost" || url.hostname === "127.0.0.1") {
		// 本地 Vite 会在端口占用时自动递增端口，认证 origin 也要允许同机开发端口。
		for (const origin of LOCAL_DEV_TRUSTED_ORIGINS) {
			origins.add(origin);
		}
	}
	return [...origins];
}

/**
 * 生成 Better Auth 数据库记录 ID。
 * @param options Better Auth 传入的模型名和可选长度
 * @returns 仅包含数字和小写字母的随机 ID
 */
export function generateBetterAuthDatabaseId(options: {
	/** Better Auth 模型名，用于未来按模型分流；当前所有模型统一使用小写 ID。 */
	model: string;
	/** Better Auth 指定的 ID 长度；未指定时使用项目默认长度。 */
	size?: number;
}): string {
	const size = options.size ?? BETTER_AUTH_ID_SIZE;
	const bytes = new Uint8Array(size);
	crypto.getRandomValues(bytes);

	let id = "";
	for (const byte of bytes) {
		// 使用取模映射到 base36 字符集，确保不会产生大写字母或符号。
		id += BETTER_AUTH_ID_ALPHABET[byte % BETTER_AUTH_ID_ALPHABET.length];
	}
	return id;
}

/**
 * 创建 Cloudflare KV secondary storage。
 * @param kv Cloudflare KV namespace
 * @returns Better Auth secondary storage 实现
 */
export function createKvSecondaryStorage(kv: KVNamespace) {
	return {
		get: async (key: string) =>
			readKvJsonCache<string>(kv, buildBetterAuthCacheKey(key), {
				deleteInvalid: true,
				parse: (value) => {
					if (typeof value !== "string") {
						throw new Error("Invalid Better Auth cache value");
					}
					return value;
				},
			}),
		set: async (key: string, value: string, ttl?: number) => {
			// Workers KV 的 expirationTtl 最小值为 60 秒，低于该值时沿用旧行为按持久写入处理。
			const options = ttl && ttl >= 60 ? { expirationTtl: ttl } : undefined;
			await writeKvJsonCache(kv, buildBetterAuthCacheKey(key), value, options);
		},
		delete: async (key: string) => {
			await deleteKvCache(kv, buildBetterAuthCacheKey(key));
		},
	};
}

/**
 * 创建当前请求的 Better Auth 实例。
 * @param env Worker 绑定
 * @returns Better Auth 实例
 */
export function createAuth(env: AuthBindings) {
	const prisma = createPrismaClient(getDatabaseUrl(env));

	return betterAuth({
		baseURL: env.BETTER_AUTH_URL,
		secret: env.BETTER_AUTH_SECRET,
		database: prismaAdapter(prisma, {
			provider: "postgresql",
		}),
		emailAndPassword: {
			enabled: true,
		},
		advanced: {
			database: {
				generateId: generateBetterAuthDatabaseId,
			},
		},
		secondaryStorage: createKvSecondaryStorage(env.AUTH_KV),
		plugins: [username()],
		trustedOrigins: readTrustedOrigins(env.BETTER_AUTH_URL),
	});
}
