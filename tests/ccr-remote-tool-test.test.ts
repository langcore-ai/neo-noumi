import { describe, expect, test } from "bun:test";
import {
	buildRequiresActionTestPayload,
	parseArgs,
} from "../scripts/ccr-remote-tool-test";

describe("ccr remote tool test helper", () => {
	test("parses the minimal CLI options", () => {
		const options = parseArgs([
			"--session-id",
			"session-1",
			"--base-url",
			"https://example.com",
		]);

		expect(options).toMatchObject({
			sessionId: "session-1",
			baseUrl: "https://example.com",
			toolName: "AExternalToolTest",
			input: { message: "ccr remote tool ping" },
			leavePending: false,
		});
	});

	test("requires object input JSON", () => {
		expect(() =>
			parseArgs(["--session-id", "session-1", "--input-json", "[]"]),
		).toThrow("--input-json must be a JSON object");
	});

	test("builds matching visible, internal and worker pending action payloads", () => {
		const payload = buildRequiresActionTestPayload(
			{
				toolName: "AExternalToolTest",
				input: { value: 1 },
			},
			3,
		);

		expect(payload.workerState).toMatchObject({
			worker_epoch: 3,
			worker_status: "requires_action",
			external_metadata: {
				pending_action: {
					tool_name: "AExternalToolTest",
					tool_use_id: payload.toolUseId,
					request_id: payload.requestId,
					input: { value: 1 },
				},
			},
		});
		expect(payload.visibleEvent.payload).toMatchObject({
			type: "assistant",
			message: {
				content: [
					{
						type: "tool_use",
						id: payload.toolUseId,
						name: "AExternalToolTest",
						input: { value: 1 },
					},
				],
			},
		});
		expect(payload.internalEvent.event_metadata).toMatchObject({
			request_id: payload.requestId,
			tool_use_id: payload.toolUseId,
			tool_name: "AExternalToolTest",
			source: "ccr-remote-tool-test",
		});
	});
});
