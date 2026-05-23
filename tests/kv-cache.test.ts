import { describe, expect, test } from "bun:test";
import {
	buildKvCacheKey,
	deleteKvCache,
	readKvJsonCache,
	writeKvJsonCache,
	type KvCacheWriteOptions,
} from "../src/worker/lib/kv-cache";

/** 测试用 KV 写入记录。 */
type KvPutRecord = {
	/** KV key。 */
	key: string;
	/** 写入的字符串值。 */
	value: string;
	/** 写入选项。 */
	options?: KvCacheWriteOptions;
};

/**
 * 创建测试用 KV namespace。
 * @param initial 初始 key-value 数据
 * @returns fake KV 与写入记录
 */
function createFakeKv(initial: Record<string, string | null> = {}) {
	const data = new Map(Object.entries(initial));
	const puts: KvPutRecord[] = [];
	const deletes: string[] = [];
	const kv = {
		get: async (key: string) => data.get(key) ?? null,
		put: async (key: string, value: string, options?: KvCacheWriteOptions) => {
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

describe("buildKvCacheKey", () => {
	test("builds redis-style folder keys from segments", () => {
		expect(buildKvCacheKey(["ccr", "session", 123, "events"])).toBe(
			"ccr:session:123:events",
		);
	});

	test("normalizes slash and colon separated folder fragments", () => {
		expect(buildKvCacheKey([" ccr/session ", " user:42 ", null, undefined, ""])).toBe(
			"ccr:session:user:42",
		);
	});

	test("rejects empty cache keys", () => {
		expect(() => buildKvCacheKey([null, undefined, ""])).toThrow(
			"Cache key is required",
		);
	});

	test("rejects keys over Cloudflare KV byte limit", () => {
		expect(() => buildKvCacheKey(["ccr", "键".repeat(256)])).toThrow(
			"Cache key exceeds Cloudflare KV 512 byte limit",
		);
	});
});

describe("KV JSON cache helpers", () => {
	test("writes and reads JSON values with normalized keys", async () => {
		const { kv, puts } = createFakeKv();

		await writeKvJsonCache(
			kv,
			["ccr", "session/abc", "snapshot"],
			{ ok: true },
			{ expirationTtl: 120, metadata: { module: "ccr" } },
		);

		expect(puts).toEqual([
			{
				key: "ccr:session:abc:snapshot",
				value: JSON.stringify({ ok: true }),
				options: {
					expirationTtl: 120,
					metadata: { module: "ccr" },
				},
			},
		]);
		await expect(
			readKvJsonCache<{ ok: boolean }>(kv, "ccr:session:abc:snapshot"),
		).resolves.toEqual({ ok: true });
	});

	test("returns null when key does not exist", async () => {
		const { kv } = createFakeKv();

		await expect(readKvJsonCache(kv, ["missing"])).resolves.toBeNull();
	});

	test("supports parse hook for typed reads", async () => {
		const { kv } = createFakeKv({
			"ccr:count": JSON.stringify({ count: 2 }),
		});

		await expect(
			readKvJsonCache(kv, ["ccr", "count"], {
				parse: (value) => {
					if (
						!value ||
						typeof value !== "object" ||
						!("count" in value) ||
						typeof value.count !== "number"
					) {
						throw new Error("Invalid count cache");
					}
					return value.count;
				},
			}),
		).resolves.toBe(2);
	});

	test("treats invalid JSON cache as miss and can delete it", async () => {
		const { kv, deletes } = createFakeKv({
			"ccr:broken": "{",
			"ccr:invalid-shape": JSON.stringify({ count: "2" }),
		});

		await expect(
			readKvJsonCache(kv, ["ccr", "broken"], { deleteInvalid: true }),
		).resolves.toBeNull();
		await expect(
			readKvJsonCache(kv, ["ccr", "invalid-shape"], {
				deleteInvalid: true,
				parse: () => {
					throw new Error("Invalid cache shape");
				},
			}),
		).resolves.toBeNull();
		expect(deletes).toEqual(["ccr:broken", "ccr:invalid-shape"]);
	});

	test("rejects unsupported Cloudflare KV ttl", async () => {
		const { kv } = createFakeKv();

		await expect(
			writeKvJsonCache(kv, ["ccr", "short"], true, { expirationTtl: 10 }),
		).rejects.toThrow("KV expirationTtl must be at least 60 seconds");
	});

	test("deletes normalized keys", async () => {
		const { kv, deletes } = createFakeKv({
			"ccr:session:abc": JSON.stringify({ ok: true }),
		});

		await deleteKvCache(kv, ["ccr/session", "abc"]);

		expect(deletes).toEqual(["ccr:session:abc"]);
		await expect(readKvJsonCache(kv, "ccr:session:abc")).resolves.toBeNull();
	});
});
