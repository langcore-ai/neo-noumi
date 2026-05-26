import { describe, expect, test } from "bun:test";
import {
	buildCanUseToolDecisionResponse,
	buildRouteMcpInitializeRequest,
	handleControlRequest,
} from "../src/worker/lib/ccr-control";
import {
	A_EXTERNAL_TOOL_TEST_NAME,
	listRouteTools,
	ROUTE_MCP_SERVER_NAME,
} from "../src/worker/lib/ccr-route-tools";

describe("route MCP tools", () => {
	test("lists AExternalToolTest for Claude Code", () => {
		expect(listRouteTools()).toContainEqual(
			expect.objectContaining({ name: A_EXTERNAL_TOOL_TEST_NAME }),
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
