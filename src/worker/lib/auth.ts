import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { username } from "better-auth/plugins";
import { deleteKvCache, readKvJsonCache, writeKvJsonCache } from "./kv-cache";
import { createPrismaClient } from "./prisma";

/** Better Auth session 缓存在 AUTH_KV 下使用的目录。 */
const BETTER_AUTH_CACHE_KEY_PREFIX = ["auth", "session"] as const;

/**
 * 生成 Better Auth session cache key。
 * @param key Better Auth secondary storage 传入的原始 key
 * @returns 去除重复 session 目录后的分层 key
 */
function buildBetterAuthCacheKey(key: string) {
	const normalizedKey = key.replace(/^session[:/]+/, "");
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
		secondaryStorage: createKvSecondaryStorage(env.AUTH_KV),
		plugins: [username()],
		trustedOrigins: [env.BETTER_AUTH_URL],
	});
}
