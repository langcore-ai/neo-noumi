import { getStringField, isJsonObject } from "./ccr-json";
import {
	callRouteTool,
	listRouteTools,
	ROUTE_MCP_SERVER_NAME,
	type RouteToolContext,
} from "./ccr-route-tools";
import type { JsonObject } from "./ccr-types";

/** StructuredIO control_response payload。 */
export interface ControlResponsePayload extends JsonObject {
	/** 事件类型。 */
	type: "control_response";
	/** control response 内容。 */
	response: JsonObject;
}

/** 工具权限申请的用户决策。 */
export type ToolPermissionDecision = "allow" | "deny";

/**
 * 构造 route-side MCP 初始化 control_request。
 * @returns 下发给 Claude Code 的 control_request payload
 */
export function buildRouteMcpInitializeRequest(): JsonObject {
	return {
		type: "control_request",
		request_id: crypto.randomUUID(),
		request: { subtype: "initialize", sdkMcpServers: [ROUTE_MCP_SERVER_NAME] },
	};
}

/**
 * 构造成功 control_response。
 * @param requestId control request ID
 * @param response 响应体
 * @returns StructuredIO control_response payload
 */
export function buildControlSuccess(
	requestId: string,
	response: JsonObject = {},
): ControlResponsePayload {
	return {
		type: "control_response",
		response: {
			subtype: "success",
			request_id: requestId,
			response,
		},
	};
}

/**
 * 构造失败 control_response。
 * @param requestId control request ID
 * @param error 错误信息
 * @returns StructuredIO control_response payload
 */
export function buildControlError(
	requestId: string,
	error: string,
): ControlResponsePayload {
	return {
		type: "control_response",
		response: {
			subtype: "error",
			request_id: requestId,
			error,
		},
	};
}

/**
 * 处理 worker 写出的 control_request。
 * @param payload control_request payload
 * @param context route 工具执行上下文
 * @returns 需要回写给 worker 的 control_response；不支持自动响应时返回 null
 */
export async function handleControlRequest(
	payload: JsonObject,
	context: RouteToolContext,
): Promise<ControlResponsePayload | null> {
	const requestId = getStringField(payload, "request_id");
	const request = isJsonObject(payload.request) ? payload.request : undefined;
	const subtype = request ? getStringField(request, "subtype") : undefined;
	if (!requestId || !request || !subtype) {
		return null;
	}

	if (subtype === "mcp_message") {
		return buildControlSuccess(requestId, await handleMcpMessage(request, context));
	}

	if (subtype === "hook_callback") {
		// hook callback 没有 route 侧实现时返回空对象，避免 Claude Code 永久等待。
		return buildControlSuccess(requestId, {});
	}

	if (subtype === "elicitation") {
		// route 暂不接用户交互弹窗，默认取消。
		return buildControlSuccess(requestId, { action: "cancel" });
	}

	return null;
}

/**
 * 构造工具权限申请的用户决策响应。
 * @param requestId control request ID
 * @param request control request 内层 request
 * @param decision 用户权限决策
 * @returns 可回写给 Claude Code 的 control_response
 */
export function buildCanUseToolDecisionResponse(
	requestId: string,
	request: JsonObject,
	decision: ToolPermissionDecision,
): ControlResponsePayload {
	const toolInput = isJsonObject(request.input) ? request.input : {};
	const toolUseId = getStringField(request, "tool_use_id") ?? "";
	if (decision === "deny") {
		return buildControlSuccess(requestId, {
			behavior: "deny",
			message: "Denied by user.",
			toolUseID: toolUseId,
		});
	}

	return buildControlSuccess(requestId, {
		behavior: "allow",
		// Claude Code 的权限 schema 要求 allow 响应必须带 updatedInput。
		updatedInput: toolInput,
		message: "Allowed by user.",
		toolUseID: toolUseId,
	});
}

/**
 * 处理 MCP JSON-RPC 消息。
 * @param request control request 内层 request
 * @param context route 工具执行上下文
 * @returns control_response.response 所需对象
 */
async function handleMcpMessage(
	request: JsonObject,
	context: RouteToolContext,
): Promise<JsonObject> {
	const message = isJsonObject(request.message) ? request.message : {};
	const method = getStringField(message, "method");
	const id = message.id ?? null;
	const serverName = getStringField(request, "server_name");

	if (serverName && serverName !== ROUTE_MCP_SERVER_NAME) {
		return {
			mcp_response: {
				jsonrpc: "2.0",
				id,
				error: { code: -32601, message: `Unhandled MCP server: ${serverName}` },
			},
		};
	}

	if (method === "initialize") {
		return {
			mcp_response: {
				jsonrpc: "2.0",
				id,
				result: {
					protocolVersion: "2024-11-05",
					capabilities: { tools: {} },
					serverInfo: { name: ROUTE_MCP_SERVER_NAME, version: "0.1.0" },
				},
			},
		};
	}

	if (method === "tools/list") {
		return {
			mcp_response: {
				jsonrpc: "2.0",
				id,
				result: { tools: listRouteTools() },
			},
		};
	}

	if (method === "notifications/initialized") {
		return {
			mcp_response: {
				jsonrpc: "2.0",
				id,
				result: {},
			},
		};
	}

	if (method === "tools/call") {
		const params = isJsonObject(message.params) ? message.params : {};
		const name = getStringField(params, "name") ?? "";
		const args = isJsonObject(params.arguments) ? params.arguments : {};
		return {
			mcp_response: {
				jsonrpc: "2.0",
				id,
				result: await callRouteTool(name, args, context),
			},
		};
	}

	return {
		mcp_response: {
			jsonrpc: "2.0",
			id,
			error: { code: -32601, message: `Unknown route MCP method: ${method}` },
		},
	};
}
