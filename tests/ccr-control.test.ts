import { describe, expect, test } from "bun:test";
import {
	buildCanUseToolDecisionResponse,
	buildRouteMcpInitializeRequest,
	buildSetMaxThinkingTokensRequest,
	buildSetModelRequest,
	buildSetPermissionModeRequest,
	handleControlRequest,
	isCcrPermissionMode,
} from "../src/worker/lib/ccr-control";
import {
	A_EXTERNAL_TOOL_TEST_NAME,
	callRouteTool,
	listRouteTools,
	ROUTE_MCP_SERVER_NAME,
} from "../src/worker/lib/ccr-route-tools";
import type { CcrStore } from "../src/worker/lib/ccr-store";
import { WORKSPACE_READ_MAX_FILE_SIZE } from "../src/worker/lib/project-workspace";

/**
 * 创建 workspace MCP 工具测试上下文。
 * @returns route-side 工具上下文
 */
function createWorkspaceToolContext(bucket?: R2Bucket) {
	const defaultBucket = {
		head: async () => null,
		list: async () => ({ objects: [], delimitedPrefixes: [], truncated: false }),
	} as unknown as R2Bucket;
	const store = {
		findUserSessionSummary: async () => ({
			id: "session-1",
			projectId: "project-1",
			deletedAt: null,
		}),
	} as unknown as CcrStore;
	return {
		env: { PROJECT_WORKSPACE_BUCKET: bucket ?? defaultBucket },
		sessionId: "session-1",
		store,
		userId: "user-1",
	};
}

describe("route MCP tools", () => {
	test("lists AExternalToolTest for Claude Code", () => {
		expect(listRouteTools()).toContainEqual(
			expect.objectContaining({ name: A_EXTERNAL_TOOL_TEST_NAME }),
		);
	});

	test("lists workspace MCP tools for Claude Code", () => {
		expect(listRouteTools()).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ name: "workspace_stat" }),
				expect.objectContaining({ name: "workspace_write_file" }),
				expect.objectContaining({ name: "workspace_delete" }),
				expect.objectContaining({ name: "workspace_move" }),
			]),
		);
	});

	test("builds the initial control request with route MCP server", () => {
		const payload = buildRouteMcpInitializeRequest();

		expect(payload.type).toBe("control_request");
		expect(payload.request).toEqual({
			subtype: "initialize",
			sdkMcpServers: [ROUTE_MCP_SERVER_NAME],
		});
	});

	test("builds permission mode control request for plan mode", () => {
		const payload = buildSetPermissionModeRequest("plan", { ultraplan: true });

		expect(payload.type).toBe("control_request");
		expect(String(payload.request_id)).toMatch(/^set-mode-/);
		expect(payload.request).toEqual({
			subtype: "set_permission_mode",
			mode: "plan",
			ultraplan: true,
		});
		expect(isCcrPermissionMode("plan")).toBe(true);
		expect(isCcrPermissionMode("auto")).toBe(false);
	});

	test("builds model and thinking control requests", () => {
		expect(buildSetModelRequest("opus").request).toEqual({
			subtype: "set_model",
			model: "opus",
		});
		expect(buildSetModelRequest().request).toEqual({
			subtype: "set_model",
		});
		expect(buildSetMaxThinkingTokensRequest(null).request).toEqual({
			subtype: "set_max_thinking_tokens",
			max_thinking_tokens: null,
		});
		expect(buildSetMaxThinkingTokensRequest(4096).request).toEqual({
			subtype: "set_max_thinking_tokens",
			max_thinking_tokens: 4096,
		});
	});

	test("handles tools/list MCP message", async () => {
		const response = await handleControlRequest(
			{
				type: "control_request",
				request_id: "request-1",
				request: {
					subtype: "mcp_message",
					server_name: ROUTE_MCP_SERVER_NAME,
					message: { jsonrpc: "2.0", id: 1, method: "tools/list" },
				},
			},
			{ sessionId: "session-1" },
		);

		expect(response?.response.subtype).toBe("success");
		expect(response?.response.response).toEqual({
			mcp_response: {
				jsonrpc: "2.0",
				id: 1,
				result: { tools: listRouteTools() },
			},
		});
	});

	test("handles AExternalToolTest tools/call MCP message", async () => {
		const response = await handleControlRequest(
			{
				type: "control_request",
				request_id: "request-2",
				request: {
					subtype: "mcp_message",
					server_name: ROUTE_MCP_SERVER_NAME,
					message: {
						jsonrpc: "2.0",
						id: 2,
						method: "tools/call",
						params: {
							name: A_EXTERNAL_TOOL_TEST_NAME,
							arguments: { message: "hello route" },
						},
					},
				},
			},
			{ sessionId: "session-1" },
		);

		const mcpResponse = response?.response.response?.mcp_response;
		expect(response?.response.subtype).toBe("success");
		expect(mcpResponse).toEqual(
			expect.objectContaining({
				jsonrpc: "2.0",
				id: 2,
				result: expect.objectContaining({
					content: expect.any(Array),
				}),
			}),
		);
		expect(JSON.stringify(mcpResponse)).toContain("hello route");
	});

	test("handles workspace stat tools/call MCP message", async () => {
		const response = await handleControlRequest(
			{
				type: "control_request",
				request_id: "request-workspace-stat",
				request: {
					subtype: "mcp_message",
					server_name: ROUTE_MCP_SERVER_NAME,
					message: {
						jsonrpc: "2.0",
						id: 20,
						method: "tools/call",
						params: {
							name: "workspace_stat",
							arguments: { path: "missing.txt" },
						},
					},
				},
			},
			createWorkspaceToolContext(),
		);

		const mcpResponse = response?.response.response?.mcp_response;
		expect(response?.response.subtype).toBe("success");
		expect(mcpResponse).toEqual(
			expect.objectContaining({
				jsonrpc: "2.0",
				id: 20,
				result: expect.objectContaining({
					content: expect.any(Array),
				}),
			}),
		);
		expect(mcpResponse?.result?.content?.[0]?.text).toContain("\"stat\":null");
	});

	test("rejects oversized workspace read_file route tool calls", async () => {
		const bucket = {
			head: async (key: string) =>
				({
					key,
					size: WORKSPACE_READ_MAX_FILE_SIZE + 1,
					etag: "etag-large",
					version: "version-large",
					uploaded: new Date("2026-05-26T00:00:00.000Z"),
					httpMetadata: { contentType: "text/plain" },
				}) as unknown as R2Object,
		} as unknown as R2Bucket;

		await expect(
			callRouteTool(
				"workspace_read_file",
				{ path: "large.txt" },
				createWorkspaceToolContext(bucket),
			),
		).resolves.toMatchObject({
			isError: true,
			content: [
				expect.objectContaining({
					text: expect.stringContaining("Workspace read file exceeds the maximum size"),
				}),
			],
		});
	});

	test("does not auto answer tool permission requests", async () => {
		await expect(
			handleControlRequest(
				{
					type: "control_request",
					request_id: "request-3",
					request: {
						subtype: "can_use_tool",
						tool_name: "mcp__ccr-route__AExternalToolTest",
						tool_use_id: "toolu_1",
						input: { message: "hello route" },
					},
				},
				{ sessionId: "session-1" },
			),
		).resolves.toBeNull();
	});

	test("builds allow response for user-approved tool permission", () => {
		const response = buildCanUseToolDecisionResponse(
			"request-4",
			{
				subtype: "can_use_tool",
				tool_name: "mcp__ccr-route__AExternalToolTest",
				tool_use_id: "toolu_1",
				input: { message: "hello route" },
			},
			"allow",
		);

		expect(response.response.response).toEqual({
			behavior: "allow",
			updatedInput: { message: "hello route" },
			message: "Allowed by user.",
			toolUseID: "toolu_1",
		});
	});

	test("builds deny response for user-rejected tool permission", () => {
		const response = buildCanUseToolDecisionResponse(
			"request-5",
			{
				subtype: "can_use_tool",
				tool_name: "Bash",
				tool_use_id: "toolu_2",
				input: { command: "echo nope" },
			},
			"deny",
		);

		expect(response.response.response).toEqual({
			behavior: "deny",
			message: "Denied by user.",
			toolUseID: "toolu_2",
		});
	});
});
