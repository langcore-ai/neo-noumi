import { describe, expect, test } from "bun:test";
import {
	buildAiProxyHeaders,
	buildAiProxyUpstreamUrl,
	isAllowedAnthropicApiPath,
	proxyAnthropicApiRequest,
	readAiProxyToken,
	serializeHeaders,
} from "../src/worker/lib/ccr-ai-proxy";

/** 测试用 KV 行为配置。 */
type FakeKvOptions = {
	/** 是否让 put 抛错。 */
	failPut?: boolean;
};

/**
 * 创建测试用 KV namespace。
 * @param options KV 行为配置
 * @returns fake KV 与操作记录
 */
function createFakeKv(options: FakeKvOptions = {}) {
	const data = new Map<string, string>();
	const puts: Array<{ key: string; value: string }> = [];
	const deletes: string[] = [];
	const kv = {
		get: async (key: string) => data.get(key) ?? null,
		put: async (key: string, value: string) => {
			if (options.failPut) {
				throw new Error("kv put failed");
			}
			puts.push({ key, value });
			data.set(key, value);
		},
		delete: async (key: string) => {
			deletes.push(key);
			data.delete(key);
		},
	};

	return {
		kv: kv as unknown as KVNamespace,
		puts,
		deletes,
	};
}

/**
 * 创建 AI Proxy 测试 store。
 * @returns fake store 与完成记录
 */
function createFakeAiProxyStore() {
	const completions: unknown[] = [];
	const store = {
		authenticateAiProxyToken: async () => ({
			tokenId: "token-1",
			userId: "user-1",
			sessionId: "session-1",
			sandboxId: "sandbox-1",
		}),
		getDefaultAiProxyCredential: async () => null,
		createAiProxyRequestLog: async () => "log-1",
		completeAiProxyRequestLog: async (input: unknown) => {
			completions.push(input);
		},
	};

	return { store, completions };
}

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

	test("serializes headers into a stable audit snapshot", () => {
		const headers = new Headers({
			"z-request": "last",
			"content-type": "application/json",
		});

		expect(serializeHeaders(headers)).toEqual([
			["content-type", "application/json"],
			["z-request", "last"],
		]);
	});

	test("stores pending payload in KV and writes complete audit after response is read", async () => {
		const { kv, puts, deletes } = createFakeKv();
		const { store, completions } = createFakeAiProxyStore();
		const response = await proxyAnthropicApiRequest(
			new Request("https://api.anthropic.com/v1/messages", {
				method: "POST",
				headers: {
					"x-api-key": "nnaip_token",
					"content-type": "application/json",
				},
				body: "{\"message\":\"hi\"}",
			}),
			{
				DATABASE_URL: "postgres://unit-test",
				AUTH_KV: kv,
				ANTHROPIC_API_KEY: "real-key",
				ANTHROPIC_BASE_URL: "https://gateway.example.com",
			},
			{
				store,
				fetch: async () =>
					new Response("{\"ok\":true}", {
						status: 201,
						headers: { "content-type": "application/json" },
					}),
			},
		);

		expect(await response.text()).toBe("{\"ok\":true}");
		expect(puts).toHaveLength(1);
		expect(puts[0]?.key).toBe("ai-proxy:payload:log-1");
		expect(deletes).toEqual(["ai-proxy:payload:log-1"]);
		expect(completions).toHaveLength(1);
		expect(completions[0]).toMatchObject({
			logId: "log-1",
			statusCode: 201,
			responseBody: "{\"ok\":true}",
			requestBody: "{\"message\":\"hi\"}",
			upstreamRequestHeaders: [["content-type", "application/json"], ["x-api-key", "real-key"]],
			responseHeaders: [["content-type", "application/json"]],
		});
	});

	test("continues upstream request with local payload when KV write fails", async () => {
		const { kv } = createFakeKv({ failPut: true });
		const { store, completions } = createFakeAiProxyStore();
		let upstreamCalled = false;

		const response = await proxyAnthropicApiRequest(
			new Request("https://api.anthropic.com/v1/messages", {
				method: "POST",
				headers: { "x-api-key": "nnaip_token" },
				body: "{\"message\":\"hi\"}",
			}),
			{
				DATABASE_URL: "postgres://unit-test",
				AUTH_KV: kv,
				ANTHROPIC_API_KEY: "real-key",
			},
			{
				store,
				fetch: async () => {
					upstreamCalled = true;
					return new Response("{\"ok\":true}", { status: 200 });
				},
			},
		);

		expect(await response.text()).toBe("{\"ok\":true}");
		expect(upstreamCalled).toBe(true);
		expect(completions).toHaveLength(1);
		expect(completions[0]).toMatchObject({
			logId: "log-1",
			statusCode: 200,
			requestBody: "{\"message\":\"hi\"}",
			responseBody: "{\"ok\":true}",
			errorMessage: null,
		});
	});

	test("completes audit when client cancels the response stream", async () => {
		const { kv, deletes } = createFakeKv();
		const { store, completions } = createFakeAiProxyStore();
		let sentChunk = false;
		const response = await proxyAnthropicApiRequest(
			new Request("https://api.anthropic.com/v1/messages", {
				method: "POST",
				headers: { "x-api-key": "nnaip_token" },
				body: "{\"message\":\"hi\"}",
			}),
			{
				DATABASE_URL: "postgres://unit-test",
				AUTH_KV: kv,
				ANTHROPIC_API_KEY: "real-key",
			},
			{
				store,
				fetch: async () =>
					new Response(new ReadableStream<Uint8Array>({
						pull(controller) {
							if (!sentChunk) {
								sentChunk = true;
								controller.enqueue(new TextEncoder().encode("partial"));
							}
						},
						cancel() {
							// 测试容器端取消读取时的审计收尾。
						},
					}), { status: 200 }),
			},
		);

		const reader = response.body!.getReader();
		const firstChunk = await reader.read();
		expect(new TextDecoder().decode(firstChunk.value)).toBe("partial");
		await reader.cancel("client canceled");

		expect(deletes).toEqual(["ai-proxy:payload:log-1"]);
		expect(completions).toHaveLength(1);
		expect(completions[0]).toMatchObject({
			logId: "log-1",
			statusCode: 200,
			responseBody: "partial",
			errorMessage: "client canceled",
		});
	});
});
