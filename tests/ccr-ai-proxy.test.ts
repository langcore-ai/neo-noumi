import { describe, expect, test } from "bun:test";
import {
	buildAiProxyHeaders,
	buildAiProxyUpstreamUrl,
	isAllowedAnthropicApiPath,
	readAiProxyToken,
} from "../src/worker/lib/ccr-ai-proxy";

describe("AI proxy helpers", () => {
	test("reads proxy token from bearer auth or x-api-key", () => {
		expect(
			readAiProxyToken(
				new Request("https://api.anthropic.com/v1/messages", {
					headers: { authorization: "Bearer nnaip_token" },
				}),
			),
		).toBe("nnaip_token");
		expect(
			readAiProxyToken(
				new Request("https://api.anthropic.com/v1/messages", {
					headers: { authorization: "bearer nnaip_lower_token" },
				}),
			),
		).toBe("nnaip_lower_token");
		expect(
			readAiProxyToken(
				new Request("https://api.anthropic.com/v1/messages", {
					headers: { "x-api-key": "nnaip_key" },
				}),
			),
		).toBe("nnaip_key");
	});

	test("only allows required Anthropic API paths", () => {
		expect(isAllowedAnthropicApiPath("/v1/messages")).toBe(true);
		expect(isAllowedAnthropicApiPath("/v1/messages/count_tokens")).toBe(true);
		expect(isAllowedAnthropicApiPath("/v1/models")).toBe(false);
	});

	test("preserves upstream path prefix when rewriting official Anthropic URL", () => {
		const target = buildAiProxyUpstreamUrl(
			"https://gateway.example.com/anthropic",
			new URL("https://api.anthropic.com/v1/messages?beta=1"),
		);

		expect(target.toString()).toBe(
			"https://gateway.example.com/anthropic/v1/messages?beta=1",
		);
	});

	test("replaces container proxy token with real upstream credential", () => {
		const headers = buildAiProxyHeaders(
			new Headers({
				authorization: "Bearer nnaip_token",
				"x-api-key": "nnaip_token",
				"anthropic-version": "2023-06-01",
			}),
			{
				provider: "anthropic",
				baseUrl: "https://api.anthropic.com",
				apiKey: "real-key",
			},
		);

		expect(headers.get("x-api-key")).toBe("real-key");
		expect(headers.get("authorization")).toBeNull();
		expect(headers.get("anthropic-version")).toBe("2023-06-01");
	});

	test("supports bearer authorization for non-default channels", () => {
		const headers = buildAiProxyHeaders(new Headers(), {
			provider: "bearer",
			baseUrl: "https://gateway.example.com",
			apiKey: "real-key",
		});

		expect(headers.get("authorization")).toBe("Bearer real-key");
		expect(headers.get("x-api-key")).toBeNull();
	});
});
