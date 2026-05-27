import { describe, expect, test } from "bun:test";
import {
	DEFAULT_CONTAINER_TERMINAL_SESSION_ID,
	readTerminalSessionId,
} from "../src/worker/lib/container-terminal";
import {
	buildUserContainerId,
	USER_CONTAINER_SANDBOX_ID_PREFIX,
} from "../src/worker/lib/container-identity";

describe("container terminal route helpers", () => {
	test("uses the existing user-level sandbox id shape", () => {
		const userId = "user123";
		expect(buildUserContainerId(userId)).toBe(
			`${USER_CONTAINER_SANDBOX_ID_PREFIX}-${userId}`,
		);
	});

	test("defaults terminal session without requiring a query", () => {
		expect(readTerminalSessionId(undefined)).toBe(
			DEFAULT_CONTAINER_TERMINAL_SESSION_ID,
		);
	});

	test("rejects unsafe terminal session ids", () => {
		expect(() => readTerminalSessionId("../bad")).toThrow(
			"Invalid terminal sessionId",
		);
		expect(() => readTerminalSessionId("bad\nid")).toThrow(
			"Invalid terminal sessionId",
		);
	});
});
