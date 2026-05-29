import { describe, expect, test } from "bun:test";
import {
	DEFAULT_ROUTE_MCP_SERVER_NAME,
	getRouteMcpServerName,
	readWorkerEnv,
} from "../src/worker/lib/worker-env";

describe("worker env", () => {
	test("uses default route MCP server name when env is absent", () => {
		expect(getRouteMcpServerName({})).toBe(DEFAULT_ROUTE_MCP_SERVER_NAME);
	});

	test("allows ROUTE_MCP_SERVER_NAME to override the default", () => {
		expect(getRouteMcpServerName({ ROUTE_MCP_SERVER_NAME: "custom-route" })).toBe(
			"custom-route",
		);
	});

	test("treats an empty ROUTE_MCP_SERVER_NAME as missing", () => {
		expect(readWorkerEnv({ ROUTE_MCP_SERVER_NAME: "" }).ROUTE_MCP_SERVER_NAME).toBe(
			DEFAULT_ROUTE_MCP_SERVER_NAME,
		);
	});
});
