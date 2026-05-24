import { describe, expect, test } from "bun:test";
import { createKvSecondaryStorage } from "../src/worker/lib/auth";

/** 测试用 KV 写入记录。 */
type KvPutRecord = {
	/** KV key。 */
	key: string;
	/** 写入值。 */
	value: string;
	/** KV 写入选项。 */
	options?: KVNamespacePutOptions;
};

/**
 * 创建测试用 KV namespace。
 * @param initial 初始 key-value 数据
 * @returns fake KV 与操作记录
 */
function createFakeKv(initial: Record<string, string> = {}) {
	const data = new Map(Object.entries(initial));
	const puts: KvPutRecord[] = [];
	const deletes: string[] = [];
	const kv = {
		get: async (key: string) => data.get(key) ?? null,
		put: async (key: string, value: string, options?: KVNamespacePutOptions) => {
			puts.push({ key, value, options });
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

describe("createKvSecondaryStorage", () => {
	test("stores Better Auth cache under auth:session directory", async () => {
		const { kv, puts } = createFakeKv();
		const storage = createKvSecondaryStorage(kv);

		await storage.set("session/abc", "cached-session", 120);

		expect(puts).toEqual([
				{
					key: "auth:session:abc",
					value: JSON.stringify("cached-session"),
					options: { expirationTtl: 120 },
			},
		]);
		await expect(storage.get("session/abc")).resolves.toBe("cached-session");
	});

	test("keeps sub-minute ttl writes persistent to avoid Cloudflare KV errors", async () => {
		const { kv, puts } = createFakeKv();
		const storage = createKvSecondaryStorage(kv);

		await storage.set("short", "value", 10);

		expect(puts).toEqual([
			{
				key: "auth:session:short",
				value: JSON.stringify("value"),
				options: {},
			},
		]);
	});

	test("treats invalid cached value as miss and deletes it", async () => {
		const { kv, deletes } = createFakeKv({
			"auth:session:bad": JSON.stringify({ value: "not-string" }),
		});
		const storage = createKvSecondaryStorage(kv);

		await expect(storage.get("bad")).resolves.toBeNull();
		expect(deletes).toEqual(["auth:session:bad"]);
	});

	test("deletes cache under auth directory", async () => {
		const { kv, deletes } = createFakeKv({
			"auth:session:abc": JSON.stringify("cached-session"),
		});
		const storage = createKvSecondaryStorage(kv);

		await storage.delete("session/abc");

		expect(deletes).toEqual(["auth:session:abc"]);
		await expect(storage.get("session/abc")).resolves.toBeNull();
	});

	test("normalizes colon session prefix without duplicating directory", async () => {
		const { kv, puts } = createFakeKv();
		const storage = createKvSecondaryStorage(kv);

		await storage.set("session:def", "cached-session");

		expect(puts).toEqual([
			{
				key: "auth:session:def",
				value: JSON.stringify("cached-session"),
				options: {},
			},
		]);
	});

	test("keeps already-prefixed auth session keys idempotent", async () => {
		const { kv, puts } = createFakeKv();
		const storage = createKvSecondaryStorage(kv);

		await storage.set("auth:session:session:abc", "cached-session");

		expect(puts).toEqual([
			{
				key: "auth:session:abc",
				value: JSON.stringify("cached-session"),
				options: {},
			},
		]);
	});
});
