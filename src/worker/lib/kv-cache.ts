/** Redis 风格 key 分隔符，用于表达类似文件夹的层级。 */
const CACHE_KEY_SEPARATOR = ":";

/** Cloudflare KV key 最大 UTF-8 字节长度。 */
const CLOUDFLARE_KV_KEY_MAX_BYTES = 512;

/** KV key 片段允许的基础值类型。 */
export type CacheKeySegment = string | number | boolean | null | undefined;

/** KV key 输入，既支持完整字符串，也支持分层片段。 */
export type CacheKeyInput = string | CacheKeySegment[];

/** Cloudflare KV 写入选项。 */
export type KvCacheWriteOptions = {
	/** 过期秒数；Cloudflare KV 要求 expirationTtl 至少为 60 秒。 */
	expirationTtl?: number;
	/** 绝对过期 Unix 秒时间戳。 */
	expiration?: number;
	/** 可选 metadata，透传给 KV。 */
	metadata?: Record<string, unknown>;
};

/** Cloudflare KV 读取选项。 */
export type KvCacheReadOptions<T> = {
	/** 命中后对 JSON 值做业务校验或转换。 */
	parse?: (value: unknown) => T;
	/** JSON 解析失败或 parse hook 抛错时是否删除坏缓存。 */
	deleteInvalid?: boolean;
};

/**
 * 判断 key 片段是否需要跳过。
 * @param segment key 片段
 * @returns 是否为空片段
 */
function isEmptyKeySegment(segment: CacheKeySegment): boolean {
	return segment === null || segment === undefined || segment === "";
}

/**
 * 规范化单个 key 片段，避免调用方把 `/` 或重复冒号带入最终 key。
 * @param segment key 片段
 * @returns 可拼接的 Redis 风格 key 片段
 */
function normalizeCacheKeySegment(segment: Exclude<CacheKeySegment, null | undefined>): string {
	return String(segment)
		.trim()
		.replaceAll("/", CACHE_KEY_SEPARATOR)
		.split(CACHE_KEY_SEPARATOR)
		.map((part) => part.trim())
		.filter(Boolean)
		.join(CACHE_KEY_SEPARATOR);
}

/**
 * 生成 Redis 风格的 Cloudflare KV key。
 * @param input 完整 key 或分层片段，例如 `["ccr", "session", sessionId]`
 * @returns 冒号分隔 key
 */
export function buildKvCacheKey(input: CacheKeyInput): string {
	const segments = Array.isArray(input) ? input : [input];
	const key = segments
		.filter((segment) => !isEmptyKeySegment(segment))
		.flatMap((segment) => normalizeCacheKeySegment(segment as Exclude<CacheKeySegment, null | undefined>).split(CACHE_KEY_SEPARATOR))
		.filter(Boolean)
		.join(CACHE_KEY_SEPARATOR);

	if (!key) {
		throw new Error("Cache key is required");
	}

	// Cloudflare KV 按 UTF-8 字节限制 key 长度，提前校验能让错误靠近 key 构造处。
	if (new TextEncoder().encode(key).byteLength > CLOUDFLARE_KV_KEY_MAX_BYTES) {
		throw new Error("Cache key exceeds Cloudflare KV 512 byte limit");
	}

	return key;
}

/**
 * 从 Cloudflare KV 读取 JSON 缓存。
 * @param kv KV namespace
 * @param key Redis 风格 key 或分层片段
 * @param options 读取选项
 * @returns 命中的 JSON 值；不存在时返回 null
 */
export async function readKvJsonCache<T = unknown>(
	kv: KVNamespace,
	key: CacheKeyInput,
	options: KvCacheReadOptions<T> = {},
): Promise<T | null> {
	const cacheKey = buildKvCacheKey(key);
	const rawValue = await kv.get(cacheKey);
	if (rawValue === null) {
		return null;
	}

	try {
		const parsedValue = JSON.parse(rawValue) as unknown;
		return options.parse ? options.parse(parsedValue) : (parsedValue as T);
	} catch {
		if (options.deleteInvalid) {
			// 缓存不是事实源，坏缓存默认按 miss 处理；需要时顺手删除避免重复命中坏值。
			await kv.delete(cacheKey);
		}
		return null;
	}
}

/**
 * 写入 Cloudflare KV JSON 缓存。
 * @param kv KV namespace
 * @param key Redis 风格 key 或分层片段
 * @param value 可 JSON 序列化的值
 * @param options 写入选项
 */
export async function writeKvJsonCache(
	kv: KVNamespace,
	key: CacheKeyInput,
	value: unknown,
	options: KvCacheWriteOptions = {},
): Promise<void> {
	const cacheKey = buildKvCacheKey(key);
	const putOptions: KVNamespacePutOptions = {};

	if (options.expirationTtl !== undefined) {
		// Workers KV 低于 60 秒会报错，这里提前失败，避免写入行为不确定。
		if (options.expirationTtl < 60) {
			throw new Error("KV expirationTtl must be at least 60 seconds");
		}
		putOptions.expirationTtl = options.expirationTtl;
	}
	if (options.expiration !== undefined) {
		putOptions.expiration = options.expiration;
	}
	if (options.metadata) {
		putOptions.metadata = options.metadata;
	}

	await kv.put(cacheKey, JSON.stringify(value), putOptions);
}

/**
 * 删除 Cloudflare KV 缓存。
 * @param kv KV namespace
 * @param key Redis 风格 key 或分层片段
 */
export async function deleteKvCache(
	kv: KVNamespace,
	key: CacheKeyInput,
): Promise<void> {
	await kv.delete(buildKvCacheKey(key));
}
