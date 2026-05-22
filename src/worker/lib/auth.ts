import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { username } from "better-auth/plugins";
import { createPrismaClient } from "./prisma";

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
function createKvSecondaryStorage(kv: KVNamespace) {
	return {
		get: async (key: string) => kv.get(`better-auth:${key}`),
		set: async (key: string, value: string, ttl?: number) => {
			const storageKey = `better-auth:${key}`;

			// Workers KV 的 expirationTtl 最小值为 60 秒，低于该值时按持久写入处理
			if (ttl && ttl >= 60) {
				await kv.put(storageKey, value, { expirationTtl: ttl });
				return;
			}

			await kv.put(storageKey, value);
		},
		delete: async (key: string) => {
			await kv.delete(`better-auth:${key}`);
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
