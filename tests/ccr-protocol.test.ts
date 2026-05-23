import { describe, expect, test } from "bun:test";
import {
	CCR_SDK_APPROVED_HOST,
	CLIENT_EVENT_STATUS_FAILED,
	CLIENT_EVENT_STATUS_PROCESSED,
	CLIENT_EVENT_STATUS_PROCESSING,
	CLIENT_EVENT_STATUS_QUEUED,
	CLIENT_EVENT_STATUS_RECEIVED,
	eventIdFromPayload,
	isKeepAlivePayload,
	isSystemInitPayload,
	isTerminalWorkerPayload,
	mergeClientEventDeliveryStatus,
	normalizeClaudeBaseUrl,
	readWorkerEpoch,
} from "../src/worker/lib/ccr-protocol";

describe("CCR protocol helpers", () => {
	test("uses a dedicated approved host for sdk-url so Anthropic API traffic is not intercepted", () => {
		expect(CCR_SDK_APPROVED_HOST).toBe("beacon.claude-ai.staging.ant.dev");
		expect(CCR_SDK_APPROVED_HOST).not.toBe("api.anthropic.com");
	});

	test("normalizes Anthropic base URL without duplicating /v1", () => {
		expect(normalizeClaudeBaseUrl("https://ai-api.example.com/v1")).toBe(
			"https://ai-api.example.com",
		);
		expect(normalizeClaudeBaseUrl("https://ai-api.example.com/v1/")).toBe(
			"https://ai-api.example.com",
		);
		expect(normalizeClaudeBaseUrl("https://ai-api.example.com/proxy/")).toBe(
			"https://ai-api.example.com/proxy",
		);
		expect(normalizeClaudeBaseUrl("not a url")).toBe("not a url");
	});

	test("parses worker epoch from numeric or string payloads", () => {
		expect(readWorkerEpoch({ worker_epoch: 3 })).toBe(3);
		expect(readWorkerEpoch({ worker_epoch: "4" })).toBe(4);
		expect(Number.isNaN(readWorkerEpoch({}))).toBe(true);
		expect(Number.isNaN(readWorkerEpoch({ worker_epoch: 0 }))).toBe(true);
		expect(Number.isNaN(readWorkerEpoch({ worker_epoch: "" }))).toBe(true);
		expect(Number.isNaN(readWorkerEpoch({ worker_epoch: null }))).toBe(true);
		expect(Number.isNaN(readWorkerEpoch({ worker_epoch: 1.5 }))).toBe(true);
	});

	test("classifies protocol-only worker payloads", () => {
		expect(isKeepAlivePayload({ type: "keep_alive" })).toBe(true);
		expect(isSystemInitPayload({ type: "system", subtype: "init" })).toBe(true);
		expect(isTerminalWorkerPayload({ type: "result" })).toBe(true);
		expect(isTerminalWorkerPayload({ type: "assistant" })).toBe(false);
	});

	test("keeps payload uuid as idempotency key and creates one only when absent", () => {
		expect(eventIdFromPayload({ uuid: "fixed-id" }, () => "generated")).toBe(
			"fixed-id",
		);
		expect(eventIdFromPayload({ type: "assistant" }, () => "generated")).toBe(
			"generated",
		);
	});

	test("delivery status only moves forward and never overrides failed events", () => {
		expect(
			mergeClientEventDeliveryStatus(
				CLIENT_EVENT_STATUS_QUEUED,
				CLIENT_EVENT_STATUS_RECEIVED,
			),
		).toBe(CLIENT_EVENT_STATUS_RECEIVED);
		expect(
			mergeClientEventDeliveryStatus(
				CLIENT_EVENT_STATUS_RECEIVED,
				CLIENT_EVENT_STATUS_PROCESSING,
			),
		).toBe(CLIENT_EVENT_STATUS_PROCESSING);
		expect(
			mergeClientEventDeliveryStatus(
				CLIENT_EVENT_STATUS_PROCESSED,
				CLIENT_EVENT_STATUS_RECEIVED,
			),
		).toBe(CLIENT_EVENT_STATUS_PROCESSED);
		expect(
			mergeClientEventDeliveryStatus(
				CLIENT_EVENT_STATUS_FAILED,
				CLIENT_EVENT_STATUS_PROCESSED,
			),
		).toBe(CLIENT_EVENT_STATUS_FAILED);
		expect(mergeClientEventDeliveryStatus(CLIENT_EVENT_STATUS_QUEUED, "bad")).toBeNull();
	});
});
