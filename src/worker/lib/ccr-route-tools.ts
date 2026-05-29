import { isJsonObject } from "./json";
import type { JsonObject } from "./json";
import {
	WORKSPACE_ROUTE_TOOLS,
	type RouteToolDefinition,
	type WorkspaceToolContext,
} from "./ccr-workspace-tools";

/** route 侧工具执行上下文。 */
export type RouteToolContext = WorkspaceToolContext;

/** route 侧内置工具列表。 */
const ROUTE_TOOLS: RouteToolDefinition[] = [...WORKSPACE_ROUTE_TOOLS];

/**
 * 列出 route 侧 MCP 工具。
 * @returns MCP tool definition 列表
 */
export function listRouteTools(): JsonObject[] {
	return ROUTE_TOOLS.map((tool) => ({
		name: tool.name,
		description: tool.description,
		inputSchema: tool.inputSchema,
	}));
}

/**
 * 执行 route 侧 MCP 工具。
 * @param name 工具名
 * @param input 工具输入
 * @param context 执行上下文
 * @returns MCP CallToolResult
 */
export async function callRouteTool(
	name: string,
	input: unknown,
	context: RouteToolContext,
): Promise<JsonObject> {
	const tool = ROUTE_TOOLS.find((item) => item.name === name);
	if (!tool) {
		return {
			content: [{ type: "text", text: `Unknown route tool: ${name}` }],
			isError: true,
		};
	}

	try {
		const text = await tool.call(isJsonObject(input) ? input : {}, context);
		return { content: [{ type: "text", text }] };
	} catch (error) {
		return {
			content: [{ type: "text", text: `Route tool failed: ${String(error)}` }],
			isError: true,
		};
	}
}
