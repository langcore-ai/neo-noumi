import { createEnv } from "@t3-oss/env-core";
import * as z from "zod";

/** route 侧 MCP server 默认名称，必须和 Claude Code 初始化注入保持一致。 */
export const DEFAULT_ROUTE_MCP_SERVER_NAME = "ccr-route";

/** 当前纳入统一校验的 Worker 环境变量输入。 */
export type WorkerEnvInput = {
	/** route 侧 MCP server 名称；为空时回退到默认值。 */
	ROUTE_MCP_SERVER_NAME?: string;
};

/**
 * 读取并校验 Worker 环境变量。
 * @param runtimeEnv Cloudflare Worker 运行时绑定，生产应传入 Hono 的 c.env
 * @returns 经过 t3-env 校验和默认值填充后的配置
 */
export function readWorkerEnv(runtimeEnv: WorkerEnvInput) {
	return createEnv({
		server: {
			ROUTE_MCP_SERVER_NAME: z
				.string()
				.trim()
				.min(1)
				.default(DEFAULT_ROUTE_MCP_SERVER_NAME),
		},
		// Worker 运行时没有 process.env，必须显式从 c.env 挑出字符串变量。
		runtimeEnv: {
			ROUTE_MCP_SERVER_NAME: runtimeEnv.ROUTE_MCP_SERVER_NAME,
		},
		emptyStringAsUndefined: true,
	});
}

/**
 * 获取 route 侧 MCP server 名称。
 * @param runtimeEnv Cloudflare Worker 运行时绑定
 * @returns 环境变量覆盖后的 MCP server 名称
 */
export function getRouteMcpServerName(runtimeEnv: WorkerEnvInput): string {
	return readWorkerEnv(runtimeEnv).ROUTE_MCP_SERVER_NAME;
}
