import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../generated/prisma/client";

/**
 * 创建适配 Cloudflare Workers 的 Prisma Client。
 * Worker 属于短生命周期运行时，必须按请求创建客户端，避免复用 Node 长连接模式。
 * @param databaseUrl PostgreSQL 连接串
 * @returns 当前请求可用的 Prisma Client 实例
 */
export function createPrismaClient(databaseUrl: string) {
	// 通过 pg 驱动适配器接入 PostgreSQL，兼容 Workers 的运行时限制
	const adapter = new PrismaPg({
		connectionString: databaseUrl,
	});

	// 每次请求单独创建客户端，避免沿用传统服务端单例模式
	return new PrismaClient({
		adapter,
	});
}
